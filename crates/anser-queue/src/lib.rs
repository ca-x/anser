//! Durable notification workers.

mod cipher;
mod ingest;
pub use cipher::{Cipher, CipherError};
pub use ingest::Enqueuer;

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anser_core::api::Policy;
use anser_core::routing::{AccountState, RouteStatus, decide};
use anser_core::{ChannelAccount, Message};
use anser_host::{ChannelHost, HostError};
use anser_plugin_api::{SendError, SendOutcome};
use anser_store::queue::{Lease, Outcome, PendingDelivery, Slot};
use anser_store::{Store, now_ms};
use rand::Rng;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};
pub use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub struct Limits {
    pub workers: usize,
    pub concurrency: usize,
    pub per_channel: usize,
    pub per_account: usize,
    pub retention_ms: i64,
}

pub struct Workers {
    stop: CancellationToken,
    tasks: Vec<JoinHandle<()>>,
}

impl Workers {
    pub fn start(
        store: Arc<Store>,
        host: Arc<ChannelHost>,
        cipher: Arc<Cipher>,
        limits: Limits,
    ) -> Self {
        let stop = CancellationToken::new();
        let context = Arc::new(Context {
            store,
            host,
            cipher,
            limits,
            total: Semaphore::new(limits.concurrency),
            per_account: Mutex::new(HashMap::new()),
            per_channel: Mutex::new(HashMap::new()),
        });
        let mut tasks = Vec::with_capacity(limits.workers + 1);
        for _ in 0..limits.workers {
            tasks.push(tokio::spawn(process_routes(context.clone(), stop.clone())));
        }
        tasks.push(tokio::spawn(maintenance(context, stop.clone())));
        Self { stop, tasks }
    }

    pub async fn stop(self) {
        self.stop.cancel();
        for mut task in self.tasks {
            if tokio::time::timeout(Duration::from_secs(70), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

struct Context {
    store: Arc<Store>,
    host: Arc<ChannelHost>,
    cipher: Arc<Cipher>,
    limits: Limits,
    total: Semaphore,
    per_account: Mutex<HashMap<String, Weak<Semaphore>>>,
    per_channel: Mutex<HashMap<String, Weak<Semaphore>>>,
}

async fn process_routes(context: Arc<Context>, stop: CancellationToken) {
    loop {
        if stop.is_cancelled() {
            break;
        }
        match context.store.claim(now_ms()).await {
            Ok(Some(lease)) => {
                match tokio::time::timeout(
                    Duration::from_secs(65),
                    run_route(context.clone(), Arc::new(lease)),
                )
                .await
                {
                    Ok(Ok(())) => continue,
                    Ok(Err(error)) => {
                        tracing::error!(%error, "route worker could not persist its result")
                    }
                    Err(_) => tracing::warn!("route worker timed out; the lease will recover"),
                }
            }
            Ok(None) => {}
            Err(error) => tracing::error!(%error, "route worker could not claim work"),
        }
        if pause(&stop).await {
            break;
        }
    }
}

async fn pause(stop: &CancellationToken) -> bool {
    tokio::select! {
        _ = stop.cancelled() => true,
        _ = tokio::time::sleep(Duration::from_millis(150)) => false,
    }
}

async fn run_route(context: Arc<Context>, lease: Arc<Lease>) -> anser_store::Result<()> {
    let policy = Arc::new(lease.policy()?);
    let deliveries = context.store.deliveries(lease.id).await?;
    let now = now_ms();
    let plan = decision(&policy, &deliveries, now, lease.deadline, |channel| {
        context.host.egress_available(channel)
    });
    if plan.send.is_empty() {
        return settle(&context, &lease, &policy, &deliveries).await;
    }

    let message = Arc::new(context.store.message_body(&lease.message_id).await?);
    let selected: std::collections::HashSet<_> = plan
        .send
        .into_iter()
        .take(context.limits.concurrency.min(16))
        .collect();
    let mut jobs = JoinSet::new();
    for (index, delivery) in deliveries.into_iter().enumerate() {
        if selected.contains(&index) {
            jobs.spawn(send_one(
                context.clone(),
                lease.clone(),
                policy.clone(),
                message.clone(),
                delivery,
            ));
        }
    }
    while let Some(joined) = jobs.join_next().await {
        match joined {
            Ok(result) => result?,
            Err(_) => tracing::error!("delivery task stopped unexpectedly"),
        }
    }
    let deliveries = context.store.deliveries(lease.id).await?;
    settle(&context, &lease, &policy, &deliveries).await
}

async fn settle(
    context: &Context,
    lease: &Lease,
    policy: &Policy,
    deliveries: &[PendingDelivery],
) -> anser_store::Result<()> {
    let now = now_ms();
    let plan = decision(policy, deliveries, now, lease.deadline, |channel| {
        context.host.egress_available(channel)
    });
    let next = if !plan.restart.is_empty() {
        let candidates: Vec<_> = plan
            .restart
            .iter()
            .map(|&index| &deliveries[index])
            .collect();
        let delay = i64::try_from(policy.retry.base_delay).unwrap_or(i64::MAX);
        let retry = now.saturating_add(delay).min(lease.deadline);
        context
            .store
            .restart(lease, &candidates, policy.mode, retry)
            .await?;
        let existing = if plan.send.is_empty() {
            plan.wake_at.map(milliseconds)
        } else {
            Some(now)
        };
        Some(existing.map_or(retry, |value| value.min(retry)))
    } else if !plan.send.is_empty() {
        Some(now)
    } else {
        plan.wake_at.map(milliseconds)
    };
    let status = match plan.status {
        RouteStatus::Pending => "pending",
        RouteStatus::Success => "success",
        RouteStatus::Failed => "failed",
        RouteStatus::Dead => "dead",
    };
    context.store.release(lease, next, status).await
}

fn decision(
    policy: &Policy,
    deliveries: &[PendingDelivery],
    now: i64,
    deadline: i64,
    available: impl Fn(&str) -> bool,
) -> anser_core::routing::Decision {
    let mut paused = false;
    let states: Vec<_> = deliveries
        .iter()
        .map(|delivery| {
            if matches!(delivery.state.as_str(), "ready" | "waiting")
                && !available(&delivery.channel)
            {
                paused = true;
                return AccountState::PermanentFailure;
            }
            match delivery.state.as_str() {
                "ready" => AccountState::Ready,
                "waiting" => AccountState::Waiting {
                    until: duration(delivery.due_at.unwrap_or(now)),
                },
                "sending" => AccountState::Sending,
                "success" => AccountState::Succeeded,
                "exhausted" => AccountState::Exhausted,
                _ => AccountState::PermanentFailure,
            }
        })
        .collect();
    let mut plan = decide(
        policy.mode,
        policy.success_criteria,
        &states,
        policy.retry.until_success,
        duration(now),
        duration(deadline),
    );
    if paused
        && now < deadline
        && (policy.mode == anser_core::routing::Mode::Broadcast
            || plan.status != RouteStatus::Success)
    {
        if plan.status == RouteStatus::Failed {
            plan.status = RouteStatus::Pending;
        }
        let probe = duration(now.saturating_add(500).min(deadline));
        plan.wake_at = Some(plan.wake_at.map_or(probe, |wake| probe.min(wake)));
    }
    plan
}

async fn send_one(
    context: Arc<Context>,
    lease: Arc<Lease>,
    policy: Arc<Policy>,
    message: Arc<Message>,
    delivery: PendingDelivery,
) -> anser_store::Result<()> {
    if !context.host.egress_available(&delivery.channel) {
        return context.store.defer(&lease, &delivery, 500).await;
    }
    let channel = limiter(
        &context.per_channel,
        &delivery.channel,
        context.limits.per_channel,
    );
    let account = limiter(
        &context.per_account,
        &delivery.account_id,
        context.limits.per_account,
    );
    let (Ok(_account_permit), Ok(_channel_permit), Ok(_permit)) = (
        account.try_acquire(),
        channel.try_acquire(),
        context.total.try_acquire(),
    ) else {
        return context.store.defer(&lease, &delivery, 50).await;
    };

    let now = now_ms();
    if now >= lease.deadline {
        return Ok(());
    }
    let Slot::Started { n, account, proxy } = context.store.reserve(&lease, &delivery).await?
    else {
        return Ok(());
    };
    let timeout = duration((lease.deadline - now_ms()).min(15_000));
    let send = async {
        let mut config = context
            .cipher
            .open_channel_config(&account, proxy.as_deref())
            .map_err(|_| {
                SendError::new(
                    "credential_error",
                    "Channel credentials could not be decrypted",
                    false,
                )
            })?;
        if let (Some(data), Some(subscription)) =
            (&delivery.encrypted_target, &lease.subscription_id)
        {
            let target = context.cipher.open(subscription, data).map_err(|_| {
                SendError::new(
                    "credential_error",
                    "Subscription credentials could not be decrypted",
                    false,
                )
            })?;
            if let (Some(config), Some(target)) = (config.as_object_mut(), target.as_object()) {
                anser_core::api::apply_recipient_override(&delivery.channel, config, target);
            }
        }
        if now_ms() >= lease.deadline {
            return Err(SendError::new(
                "delivery_expired",
                "Delivery expired before sending",
                true,
            ));
        }
        match context
            .host
            .test_send(
                &delivery.channel,
                ChannelAccount { config },
                (*message).clone(),
            )
            .await
        {
            Ok(SendOutcome::Delivered) => Ok(()),
            Ok(SendOutcome::Accepted { .. }) => Err(SendError::new(
                "missing_receipt_handler",
                "Channel did not report a terminal result",
                false,
            )),
            Err(HostError::Send(error)) => Err(error),
            Err(_) => Err(SendError::new(
                "channel_unavailable",
                "Channel is unavailable",
                true,
            )),
        }
    };
    let result = tokio::time::timeout(timeout, send)
        .await
        .unwrap_or_else(|_| {
            Err(SendError::new(
                "delivery_timeout",
                "Channel request exceeded its deadline",
                true,
            ))
        });
    let now = now_ms();
    let outcome = match &result {
        Ok(()) => Outcome {
            state: "success",
            due_at: None,
            error: None,
            retryable: false,
        },
        Err(error) => {
            let retry_after = error.retry_after_ms.map(Duration::from_millis);
            let retry = policy.retry.timing().retry_at(
                NonZeroU32::new(delivery.attempts_in_round.saturating_add(1)).unwrap(),
                error.retryable,
                retry_after,
                duration(now),
                duration(lease.deadline),
                |upper| rand::thread_rng().gen_range(0..upper.get()),
            );
            let state = if retry.is_some() {
                "waiting"
            } else if error.retryable {
                "exhausted"
            } else {
                "permanent"
            };
            if !error.retryable {
                tracing::warn!(channel = %delivery.channel, delivery = %delivery.id, code = %error.code, "channel permanently rejected a delivery");
            }
            Outcome {
                state,
                due_at: retry
                    .map(milliseconds)
                    .or_else(|| retry_after.map(|value| now.saturating_add(milliseconds(value)))),
                error: Some((&error.code, &error.message)),
                retryable: error.retryable,
            }
        }
    };
    context
        .store
        .record(&lease, &delivery, n, now, outcome)
        .await
}

fn limiter(
    map: &Mutex<HashMap<String, Weak<Semaphore>>>,
    key: &str,
    maximum: usize,
) -> Arc<Semaphore> {
    let mut map = map.lock().expect("worker limiter mutex poisoned");
    if let Some(semaphore) = map.get(key).and_then(Weak::upgrade) {
        return semaphore;
    }
    map.retain(|_, semaphore| semaphore.strong_count() > 0);
    let semaphore = Arc::new(Semaphore::new(maximum));
    map.insert(key.into(), Arc::downgrade(&semaphore));
    semaphore
}

fn duration(value: i64) -> Duration {
    Duration::from_millis(u64::try_from(value).unwrap_or_default())
}

fn milliseconds(value: Duration) -> i64 {
    value.as_millis().try_into().unwrap_or(i64::MAX)
}

async fn maintenance(context: Arc<Context>, stop: CancellationToken) {
    let mut maintenance_due = 0;
    loop {
        if stop.is_cancelled() {
            break;
        }
        let now = now_ms();
        if now >= maintenance_due {
            if let Err(error) = context
                .store
                .maintain(now, context.limits.retention_ms)
                .await
            {
                tracing::error!(%error, "retention cleanup failed");
            }
            maintenance_due = now + 60_000;
        }
        match context.store.claim_callback(now).await {
            Ok(Some(callback)) => {
                let succeeded = tokio::time::timeout(
                    Duration::from_secs(10),
                    post_callback(&context.store, &callback),
                )
                .await
                .unwrap_or(false);
                let next = (!succeeded && callback.attempts < 5)
                    .then(|| now_ms() + 1_000 * (1_i64 << callback.attempts));
                if let Err(error) = context.store.finish_callback(&callback, next).await {
                    tracing::error!(%error, "could not persist callback result");
                }
            }
            Ok(None) => {}
            Err(error) => tracing::error!(%error, "could not claim callback"),
        }
        if pause(&stop).await {
            break;
        }
    }
}

async fn post_callback(store: &Store, callback: &anser_store::queue::Callback) -> bool {
    let Ok(url) = anser_channel_http::reqwest::Url::parse(&callback.url) else {
        return false;
    };
    let Ok(client) =
        anser_channel_http::request_destination_client(&url, "ANSER_CALLBACK_ALLOW_HOSTS").await
    else {
        return false;
    };
    let Ok(detail) = store.message(&callback.message_id, None, None).await else {
        return false;
    };
    // Publish outcome metadata only. The original message may contain sensitive content.
    let result = serde_json::json!({
        "message_id": detail.id,
        "status": detail.status,
        "deliveries": detail.deliveries.into_iter().map(|delivery| serde_json::json!({
            "id": delivery.id, "channel": delivery.channel,
            "account_id": delivery.account_id, "status": delivery.status,
        })).collect::<Vec<_>>(),
    });
    client
        .post(url)
        .json(&result)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_core::routing::Mode;

    fn route(channel: &str) -> PendingDelivery {
        PendingDelivery {
            id: channel.into(),
            account_id: channel.into(),
            channel: channel.into(),
            state: "ready".into(),
            due_at: None,
            attempts_in_round: 0,
            weight: 1,
            priority: 0,
            encrypted_target: None,
        }
    }

    #[test]
    fn paused_channels_are_skipped_for_failover_and_retained_until_deadline() {
        let policy = Policy {
            mode: Mode::Failover,
            ..Policy::default()
        };
        let deliveries = [route("paused"), route("live")];
        assert_eq!(
            decision(&policy, &deliveries, 0, 10_000, |channel| channel == "live").send,
            [1]
        );
        let paused = decision(&policy, &deliveries, 0, 10_000, |_| false);
        assert_eq!(paused.status, RouteStatus::Pending);
        assert_eq!(paused.wake_at, Some(Duration::from_millis(500)));
        assert_eq!(
            decision(&policy, &deliveries, 10_000, 10_000, |_| false).status,
            RouteStatus::Dead
        );
    }
}
