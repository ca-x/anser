//! Durable SQLite queue, routing snapshots, leases and attempt history.

use std::collections::{HashMap, HashSet};

use anser_core::api::{
    Attempt, Delivery, MessageDetail, Page, Policy, Publish, Receipt, Selector, Target,
};
use anser_core::routing::{Candidate, Mode, plan_round};
use rand::Rng;
use sqlx::{Acquire, QueryBuilder, Sqlite, SqliteConnection};

use crate::manage::{self, StoredAccount};
use crate::plugin_market::MarketWrite;
use crate::{DataError, Result, Store, new_id, now_ms};

const MAX_TARGETS: usize = 256;
const LEASE_MS: i64 = 90_000;

pub struct Submission {
    pub key_id: String,
    pub available_channels: Vec<&'static str>,
    pub topic: Option<String>,
    pub idempotency_key: Option<String>,
    pub request: Publish,
    pub template: Option<anser_core::template::Usage>,
    pub ttl_limit_ms: i64,
    pub retention_ms: i64,
    pub queue_limit: u32,
    pub user_id: Option<String>,
    pub sender: Option<String>,
    pub topic_admin: bool,
    pub verified_password_hash: Option<String>,
    pub listing: Option<MarketWrite>,
    pub speech: Option<crate::speech::SpeechWrite>,
}

#[derive(sqlx::FromRow)]
struct CandidateRow {
    id: String,
    channel: String,
    tags: String,
    weight: u32,
    priority: i32,
}

struct Planned<'a> {
    account: &'a CandidateRow,
    weight: u32,
    priority: i32,
}

#[derive(sqlx::FromRow)]
pub struct Lease {
    pub id: i64,
    pub message_id: String,
    pub subscription_id: Option<String>,
    policy: String,
    pub deadline: i64,
    pub token: String,
}

impl Lease {
    pub fn policy(&self) -> Result<Policy> {
        Ok(serde_json::from_str(&self.policy)?)
    }
}

#[derive(sqlx::FromRow)]
pub struct PendingDelivery {
    pub id: String,
    pub account_id: String,
    pub channel: String,
    pub state: String,
    pub due_at: Option<i64>,
    pub attempts_in_round: u32,
    pub weight: u32,
    pub priority: i32,
    pub encrypted_target: Option<Vec<u8>>,
}

pub enum Slot {
    Started {
        n: i64,
        account: Box<StoredAccount>,
        proxy: Option<Vec<u8>>,
    },
    Deferred,
    Invalid,
    LeaseLost,
}

pub struct Outcome<'a> {
    pub state: &'a str,
    pub due_at: Option<i64>,
    pub error: Option<(&'a str, &'a str)>,
    pub retryable: bool,
}

#[derive(sqlx::FromRow)]
struct StoredMessage {
    inbox_recipient: Option<String>,
    inbox_deliveries: i64,
    id: String,
    topic: Option<String>,
    status: String,
    body: String,
    created_at: i64,
}

impl StoredMessage {
    fn detail(self) -> Result<MessageDetail> {
        Ok(MessageDetail {
            id: self.id,
            topic: self.topic,
            status: self.status,
            message: serde_json::from_str(&self.body)?,
            created_at: self.created_at,
            inbox_deliveries: self.inbox_deliveries,
            inbox_recipient: self.inbox_recipient,
            audio_path: None,
            deliveries: Vec::new(),
        })
    }
}

#[derive(sqlx::FromRow)]
struct DeliveryView {
    account_name: Option<String>,
    id: String,
    channel: String,
    account_id: String,
    subscription_id: Option<String>,
    state: String,
    due_at: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct AttemptView {
    delivery_id: String,
    n: i64,
    started_at: i64,
    finished_at: Option<i64>,
    error_code: Option<String>,
    error_msg: Option<String>,
}

#[derive(sqlx::FromRow)]
pub struct AccountStatistics {
    pub channel: String,
    pub account_id: String,
    pub attempts: i64,
    pub errors: i64,
    pub latency_ms: i64,
}

#[derive(sqlx::FromRow)]
pub struct Callback {
    pub message_id: String,
    pub url: String,
    pub attempts: u32,
    pub token: String,
}

impl Store {
    #[cfg(test)]
    async fn enqueue(&self, input: Submission) -> Result<Receipt> {
        let mut receipts = self.enqueue_batch(vec![input]).await?;
        receipts.pop().expect("one submission produces one result")
    }

    /// Each submission has a savepoint. All successful receipts become visible
    /// only after the outer WAL commit succeeds.
    pub async fn enqueue_batch(&self, inputs: Vec<Submission>) -> Result<Vec<Result<Receipt>>> {
        let _writer = self.2.lock().await;
        let mut transaction = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let mut results = Vec::with_capacity(inputs.len());
        for input in inputs {
            let mut savepoint = transaction.begin().await?;
            let result = enqueue_one(&mut savepoint, input).await;
            if result.is_ok() {
                savepoint.commit().await?;
            } else {
                savepoint.rollback().await?;
            }
            results.push(result);
        }
        transaction.commit().await?;
        Ok(results)
    }

    pub async fn claim(&self, now: i64) -> Result<Option<Lease>> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let lease = sqlx::query_as::<_, Lease>(
            "UPDATE routes SET lease_token=?,lease_until=? WHERE id=(SELECT id FROM routes WHERE finished=0 AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at,id LIMIT 1) RETURNING id,message_id,subscription_id,policy,deadline,lease_token AS token",
        ).bind(new_id()).bind(now + LEASE_MS).bind(now).bind(now).fetch_optional(&mut *tx).await?;
        if let Some(lease) = &lease {
            sqlx::query("UPDATE attempts SET finished_at=?,error_code='interrupted',error_msg='Previous worker did not record a result' WHERE finished_at IS NULL AND delivery_id IN(SELECT id FROM deliveries WHERE route_id=? AND state='sending')")
                .bind(now).bind(lease.id).execute(&mut *tx).await?;
            sqlx::query("UPDATE deliveries SET state='ready', attempts_in_round=MAX(attempts_in_round-1,0) WHERE route_id=? AND state='sending'")
                .bind(lease.id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(lease)
    }

    pub async fn deliveries(&self, route_id: i64) -> Result<Vec<PendingDelivery>> {
        Ok(sqlx::query_as("SELECT id,account_id,channel,state,due_at,attempts_in_round,weight,priority,encrypted_target FROM deliveries WHERE route_id=? ORDER BY position,id")
            .bind(route_id).fetch_all(&self.0).await?)
    }

    pub async fn defer(&self, lease: &Lease, delivery: &PendingDelivery, delay: i64) -> Result<()> {
        let now = now_ms();
        sqlx::query("UPDATE deliveries SET state='waiting',due_at=? WHERE id=? AND EXISTS(SELECT 1 FROM routes WHERE id=? AND lease_token=? AND lease_until>? AND finished=0)")
            .bind(now.saturating_add(delay).min(lease.deadline)).bind(&delivery.id).bind(lease.id).bind(&lease.token).bind(now)
            .execute(&self.0).await?;
        Ok(())
    }

    pub async fn reserve(&self, lease: &Lease, delivery: &PendingDelivery) -> Result<Slot> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let now = now_ms();
        if now >= lease.deadline || !owns(&mut tx, lease, now).await? {
            return Ok(Slot::LeaseLost);
        }
        let account: Option<StoredAccount> = sqlx::query_as("SELECT id,channel,name,tags,weight,priority,enabled,rate_limit,proxy_id,encrypted_config,circuit_until FROM accounts WHERE id=? AND channel=? AND enabled=1")
            .bind(&delivery.account_id).bind(&delivery.channel).fetch_optional(&mut *tx).await?;
        let Some(account) = account else {
            sqlx::query("UPDATE deliveries SET state='permanent',due_at=NULL WHERE id=?")
                .bind(&delivery.id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(Slot::Invalid);
        };
        if account.circuit_until > now {
            sqlx::query("UPDATE deliveries SET state='exhausted',due_at=? WHERE id=?")
                .bind(account.circuit_until)
                .bind(&delivery.id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(Slot::Deferred);
        }
        if let Some(rate) = account.rate_limit {
            let next: i64 = sqlx::query_scalar("SELECT next_send_at FROM accounts WHERE id=?")
                .bind(&delivery.account_id)
                .fetch_one(&mut *tx)
                .await?;
            if next > now {
                sqlx::query("UPDATE deliveries SET state='waiting',due_at=? WHERE id=?")
                    .bind(next)
                    .bind(&delivery.id)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                return Ok(Slot::Deferred);
            }
            let delay = (59_999 + i64::from(rate)) / i64::from(rate);
            sqlx::query("UPDATE accounts SET next_send_at=? WHERE id=?")
                .bind(now + delay)
                .bind(&delivery.account_id)
                .execute(&mut *tx)
                .await?;
        }
        // Reserve the sole half-open probe after cooldown.
        if account.circuit_until != 0 {
            sqlx::query("UPDATE accounts SET circuit_until=? WHERE id=?")
                .bind(now + LEASE_MS)
                .bind(&account.id)
                .execute(&mut *tx)
                .await?;
        }
        let n: i64 = sqlx::query_scalar("INSERT INTO attempts(delivery_id,n,started_at) SELECT ?,COALESCE(MAX(n),0)+1,? FROM attempts WHERE delivery_id=? RETURNING n")
            .bind(&delivery.id).bind(now).bind(&delivery.id).fetch_one(&mut *tx).await?;
        sqlx::query("UPDATE deliveries SET state='sending',attempts_in_round=attempts_in_round+1,due_at=NULL WHERE id=?")
            .bind(&delivery.id).execute(&mut *tx).await?;
        let proxy = super::proxies::proxy_credentials(&mut tx, account.proxy_id.as_deref()).await?;
        tx.commit().await?;
        Ok(Slot::Started {
            n,
            account: Box::new(account),
            proxy,
        })
    }

    pub async fn record(
        &self,
        lease: &Lease,
        delivery: &PendingDelivery,
        n: i64,
        now: i64,
        result: Outcome<'_>,
    ) -> Result<()> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        if !owns(&mut tx, lease, now_ms()).await? {
            return Ok(());
        }
        let (code, message) = result.error.unzip();
        sqlx::query("UPDATE attempts SET finished_at=?,error_code=?,error_msg=? WHERE delivery_id=? AND n=? AND finished_at IS NULL")
            .bind(now).bind(code).bind(message).bind(&delivery.id).bind(n).execute(&mut *tx).await?;
        sqlx::query("UPDATE deliveries SET state=?,due_at=? WHERE id=?")
            .bind(result.state)
            .bind(result.due_at)
            .bind(&delivery.id)
            .execute(&mut *tx)
            .await?;
        if result.state == "success" {
            sqlx::query("UPDATE accounts SET consecutive_failures=0,circuit_until=0 WHERE id=?")
                .bind(&delivery.account_id)
                .execute(&mut *tx)
                .await?;
            let early = sqlx::query("UPDATE routes SET state='success' WHERE id=? AND state='pending' AND json_extract(policy,'$.mode')='broadcast' AND json_extract(policy,'$.success_criteria')='any'")
                .bind(lease.id).execute(&mut *tx).await?;
            if early.rows_affected() != 0 {
                update_message(&mut tx, &lease.message_id).await?;
            }
        } else if result.retryable {
            sqlx::query("UPDATE accounts SET consecutive_failures=consecutive_failures+1,circuit_until=CASE WHEN consecutive_failures+1>=5 THEN ? ELSE circuit_until END WHERE id=?")
                .bind(now + 30_000).bind(&delivery.account_id).execute(&mut *tx).await?;
        } else {
            sqlx::query("UPDATE accounts SET circuit_until=0,consecutive_failures=0 WHERE id=? AND circuit_until>0")
                .bind(&delivery.account_id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn restart(
        &self,
        lease: &Lease,
        deliveries: &[&PendingDelivery],
        mode: Mode,
        next_at: i64,
    ) -> Result<()> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        if !owns(&mut tx, lease, now_ms()).await? {
            return Ok(());
        }
        let candidates: Vec<_> = deliveries
            .iter()
            .map(|delivery| Candidate {
                account_id: &delivery.id,
                priority: delivery.priority,
                weight: delivery.weight,
                available: true,
            })
            .collect();
        for (position, id) in plan_round(mode, &candidates, |bound| {
            rand::thread_rng().gen_range(0..bound.get())
        })
        .into_iter()
        .enumerate()
        {
            sqlx::query("UPDATE deliveries SET state='waiting',attempts_in_round=0,due_at=MAX(COALESCE(due_at,0),?),position=CASE WHEN ? THEN position ELSE ? END WHERE id=?")
                .bind(next_at).bind(mode == Mode::Broadcast).bind(position as i64).bind(id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn release(&self, lease: &Lease, next_at: Option<i64>, state: &str) -> Result<()> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let now = now_ms();
        if !owns(&mut tx, lease, now).await? {
            return Ok(());
        }
        if next_at.is_none() {
            let final_state = if now >= lease.deadline {
                "dead"
            } else {
                "cancelled"
            };
            sqlx::query("UPDATE deliveries SET state=?,due_at=NULL WHERE route_id=? AND state IN('ready','waiting','sending')")
                .bind(final_state).bind(lease.id).execute(&mut *tx).await?;
            if state == "dead" {
                sqlx::query("UPDATE deliveries SET state='dead',due_at=NULL WHERE route_id=? AND state='exhausted'")
                    .bind(lease.id).execute(&mut *tx).await?;
            }
        }
        sqlx::query("UPDATE routes SET state=?,next_at=?,lease_token=NULL,lease_until=NULL,finished=? WHERE id=?")
            .bind(state).bind(next_at.unwrap_or(now)).bind(next_at.is_none()).bind(lease.id).execute(&mut *tx).await?;
        update_message(&mut tx, &lease.message_id).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Recover the payload acknowledged for a keyed receive request without
    /// exposing a receipt from another key or destination on a key collision.
    pub async fn received_body(
        &self,
        id: &str,
        key_id: &str,
        topic: Option<&str>,
    ) -> Result<anser_core::Message> {
        let body: String =
            sqlx::query_scalar("SELECT body FROM messages WHERE id=? AND key_id=? AND topic IS ?")
                .bind(id)
                .bind(key_id)
                .bind(topic)
                .fetch_optional(&self.0)
                .await?
                .ok_or(DataError::Conflict)?;
        Ok(serde_json::from_str(&body)?)
    }

    pub async fn message_body(&self, id: &str) -> Result<anser_core::Message> {
        let body: String = sqlx::query_scalar("SELECT body FROM messages WHERE id=?")
            .bind(id)
            .fetch_optional(&self.0)
            .await?
            .ok_or(DataError::Missing)?;
        Ok(serde_json::from_str(&body)?)
    }

    pub async fn message_status(
        &self,
        id: &str,
        key_id: Option<&str>,
        prefix: Option<&str>,
    ) -> Result<String> {
        sqlx::query_scalar("SELECT status FROM messages WHERE id=? AND (? IS NULL OR key_id=? OR (SELECT user_id FROM api_keys WHERE id=messages.key_id)=(SELECT user_id FROM api_keys WHERE id=?)) AND (? IS NULL OR substr(topic,1,length(?))=?)")
            .bind(id).bind(key_id).bind(key_id).bind(key_id).bind(prefix).bind(prefix).bind(prefix)
            .fetch_optional(&self.0).await?.ok_or(DataError::Missing)
    }

    pub async fn message(
        &self,
        id: &str,
        key_id: Option<&str>,
        prefix: Option<&str>,
    ) -> Result<MessageDetail> {
        let mut tx = self.0.begin().await?;
        let row: StoredMessage = sqlx::query_as("SELECT id,topic,status,body,created_at,inbox_deliveries,inbox_recipient FROM messages WHERE id=? AND (? IS NULL OR key_id=? OR (SELECT user_id FROM api_keys WHERE id=messages.key_id)=(SELECT user_id FROM api_keys WHERE id=?)) AND (? IS NULL OR substr(topic,1,length(?))=?)")
            .bind(id).bind(key_id).bind(key_id).bind(key_id).bind(prefix).bind(prefix).bind(prefix)
            .fetch_optional(&mut *tx).await?.ok_or(DataError::Missing)?;
        let mut message = row.detail()?;
        message.audio_path = sqlx::query_scalar(
            "SELECT '/v1/speech/audio/' || token || '.mp3'
             FROM notification_audio WHERE message_id=? AND expires_at>?",
        )
        .bind(id)
        .bind(now_ms())
        .fetch_optional(&mut *tx)
        .await?;
        // Only the unrestricted admin history view has access to account display names.
        let show_account_names = key_id.is_none() && prefix.is_none();
        let deliveries: Vec<DeliveryView> = sqlx::query_as("SELECT d.id,d.channel,d.account_id,r.subscription_id,d.state,d.due_at,
            CASE WHEN ? THEN (SELECT name FROM accounts WHERE id=d.account_id) END AS account_name
            FROM deliveries d JOIN routes r ON r.id=d.route_id WHERE r.message_id=? ORDER BY r.id,d.position,d.id")
            .bind(show_account_names).bind(id).fetch_all(&mut *tx).await?;
        let attempts: Vec<AttemptView> = sqlx::query_as("SELECT a.delivery_id,a.n,a.started_at,a.finished_at,a.error_code,a.error_msg FROM attempts a JOIN deliveries d ON d.id=a.delivery_id JOIN routes r ON r.id=d.route_id WHERE r.message_id=? ORDER BY a.delivery_id,a.n")
            .bind(id).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        let mut by_delivery: HashMap<_, Vec<_>> = HashMap::new();
        for attempt in attempts {
            by_delivery
                .entry(attempt.delivery_id)
                .or_default()
                .push(Attempt {
                    n: attempt.n,
                    started_at: attempt.started_at,
                    finished_at: attempt.finished_at,
                    error_code: attempt.error_code,
                    error_msg: attempt.error_msg,
                    latency: attempt
                        .finished_at
                        .map(|end| end.saturating_sub(attempt.started_at)),
                });
        }
        message.deliveries = deliveries
            .into_iter()
            .map(|delivery| Delivery {
                attempts: by_delivery.remove(&delivery.id).unwrap_or_default(),
                id: delivery.id,
                account_id: delivery.account_id,
                account_name: delivery.account_name,
                channel: delivery.channel,
                subscription_id: delivery.subscription_id,
                next_retry_at: (delivery.state == "waiting")
                    .then_some(delivery.due_at)
                    .flatten(),
                status: match delivery.state.as_str() {
                    "ready" | "waiting" => "pending".into(),
                    "permanent" | "exhausted" => "failed".into(),
                    _ => delivery.state,
                },
            })
            .collect();
        Ok(message)
    }

    pub async fn messages(
        &self,
        after: Option<&str>,
        limit: u32,
        key_id: Option<&str>,
        prefix: Option<&str>,
    ) -> Result<Page<MessageDetail>> {
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT id,topic,status,body,created_at,inbox_deliveries,inbox_recipient FROM messages WHERE 1=1",
        );
        if let Some(cursor) = after {
            // Resolve the opaque cursor in the same snapshot as the page query.
            query
                .push(" AND (created_at,id)<(SELECT created_at,id FROM messages WHERE id=")
                .push_bind(cursor)
                .push(")");
        }
        if let Some(key) = key_id {
            // Match historical sessions for this user, and still allow a machine
            // key (which has no user) to read its own messages.
            query
                .push(" AND key_id IN (SELECT ")
                .push_bind(key)
                .push(" UNION ALL SELECT id FROM api_keys WHERE user_id=(SELECT user_id FROM api_keys WHERE id=")
                .push_bind(key)
                .push("))");
        }
        if let Some(prefix) = prefix {
            query
                .push(" AND substr(topic,1,length(")
                .push_bind(prefix)
                .push("))=")
                .push_bind(prefix);
        }
        let mut values = query
            .push(" ORDER BY created_at DESC,id DESC LIMIT ")
            .push_bind(i64::from(limit) + 1)
            .build_query_as::<StoredMessage>()
            .fetch_all(&self.0)
            .await?
            .into_iter()
            .map(StoredMessage::detail)
            .collect::<Result<Vec<_>>>()?;
        Ok(manage::page(&mut values, limit, |value| &value.id))
    }

    pub async fn original(&self, id: &str) -> Result<(Option<String>, Publish)> {
        let (topic, body): (Option<String>, String) = sqlx::query_as(
            "SELECT topic,request FROM messages WHERE id=? AND status IN('failed','dead')",
        )
        .bind(id)
        .fetch_optional(&self.0)
        .await?
        .ok_or(DataError::Missing)?;
        Ok((topic, serde_json::from_str(&body)?))
    }

    pub async fn claim_callback(&self, now: i64) -> Result<Option<Callback>> {
        Ok(sqlx::query_as("UPDATE callbacks SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE message_id=(SELECT message_id FROM callbacks WHERE finished=0 AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at LIMIT 1) RETURNING message_id,url,attempts,lease_token AS token")
            .bind(new_id()).bind(now + LEASE_MS).bind(now).bind(now).fetch_optional(&self.0).await?)
    }

    pub async fn finish_callback(&self, callback: &Callback, next: Option<i64>) -> Result<()> {
        sqlx::query("UPDATE callbacks SET next_at=?,finished=?,lease_token=NULL,lease_until=NULL WHERE message_id=? AND lease_token=?")
            .bind(next).bind(next.is_none()).bind(&callback.message_id).bind(&callback.token).execute(&self.0).await?;
        Ok(())
    }

    pub async fn maintain(&self, now: i64, inbox_retention_ms: i64) -> Result<()> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("DELETE FROM pair_codes WHERE expires_at<=?")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM user_totp WHERE setup_expires_at<=?")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM inbox WHERE created_at<?")
            .bind(now.saturating_sub(inbox_retention_ms))
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM api_keys WHERE session=1 AND (enabled=0 OR expires_at<=?) AND NOT EXISTS(SELECT 1 FROM messages WHERE key_id=api_keys.id)")
            .bind(now).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM idempotency WHERE expires_at<=?")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM notification_audio WHERE expires_at<=?")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        let settings: Option<crate::history::HistoryRetention> =
            sqlx::query_as("SELECT enabled,days FROM history_retention WHERE id=1")
                .fetch_optional(&mut *tx)
                .await?;
        // Keep receipt keys and all in-flight routes and callbacks, even past the history cutoff.
        match settings {
            Some(settings) if settings.enabled => {
                sqlx::query(
                    "DELETE FROM messages WHERE id IN(
                    SELECT m.id FROM messages m
                    LEFT JOIN topics t ON t.space_id='default' AND t.name=m.topic
                    WHERE m.created_at<=? - min(?,coalesce((SELECT min(retention) FROM topics WHERE space_id='default'),?))*86400000
                      AND m.created_at<=? - coalesce(t.retention,?)*86400000
                      AND NOT EXISTS(SELECT 1 FROM idempotency i WHERE i.message_id=m.id)
                      AND NOT EXISTS(SELECT 1 FROM routes r WHERE r.message_id=m.id AND r.finished=0)
                      AND NOT EXISTS(SELECT 1 FROM callbacks c WHERE c.message_id=m.id AND c.finished=0)
                    ORDER BY m.created_at,m.id LIMIT 500)"
                )
                .bind(now)
                .bind(settings.days)
                .bind(settings.days)
                .bind(now)
                .bind(settings.days)
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query(
                    "DELETE FROM messages WHERE id IN(SELECT m.id FROM messages m
                     WHERE m.retain_until<=?
                       AND NOT EXISTS(SELECT 1 FROM idempotency i WHERE i.message_id=m.id)
                       AND NOT EXISTS(SELECT 1 FROM routes r WHERE r.message_id=m.id AND r.finished=0)
                       AND NOT EXISTS(SELECT 1 FROM callbacks c WHERE c.message_id=m.id AND c.finished=0)
                     ORDER BY m.retain_until,m.id LIMIT 500)"
                )
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }
            Some(_) => {}
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn account_statistics(&self) -> Result<Vec<AccountStatistics>> {
        Ok(sqlx::query_as("SELECT d.channel,d.account_id,count(*) AS attempts,count(*) FILTER(WHERE a.error_code IS NOT NULL) AS errors,COALESCE(sum(max(0,a.finished_at-a.started_at)),0) AS latency_ms FROM attempts a JOIN deliveries d ON d.id=a.delivery_id WHERE a.finished_at IS NOT NULL GROUP BY d.channel,d.account_id")
            .fetch_all(&self.0).await?)
    }

    pub async fn statistics(&self) -> Result<Vec<(String, i64)>> {
        Ok(sqlx::query_as("SELECT 'queue_depth',count(*) FROM routes WHERE finished=0 UNION ALL SELECT 'delivery_' || state,count(*) FROM deliveries GROUP BY state UNION ALL SELECT 'attempts',count(*) FROM attempts UNION ALL SELECT 'retries',count(*) FROM attempts WHERE n>1 UNION ALL SELECT 'latency_ms_total',COALESCE(sum(max(0,finished_at-started_at)),0) FROM attempts UNION ALL SELECT 'callback_attempts',COALESCE(sum(attempts),0) FROM callbacks UNION ALL SELECT 'callback_pending',count(*) FROM callbacks WHERE finished=0")
            .fetch_all(&self.0).await?)
    }
}

pub(crate) async fn remember_receipt(
    tx: &mut SqliteConnection,
    key_id: &str,
    request_key: &str,
    message_id: &str,
    inbox_id: Option<i64>,
    now: i64,
) -> Result<()> {
    sqlx::query("INSERT INTO idempotency(key_id,request_key,message_id,inbox_id,expires_at) VALUES(?,?,?,?,?)
        ON CONFLICT(key_id,request_key) DO UPDATE SET message_id=excluded.message_id,inbox_id=excluded.inbox_id,expires_at=excluded.expires_at")
        .bind(key_id).bind(request_key).bind(message_id).bind(inbox_id).bind(now.saturating_add(86_400_000)).execute(tx).await?;
    Ok(())
}

pub(crate) async fn enqueue_one(tx: &mut SqliteConnection, input: Submission) -> Result<Receipt> {
    let now = now_ms();
    if let Some(key) = input.idempotency_key.as_deref() {
        let existing: Option<(String, String)> = sqlx::query_as(
                "SELECT m.id,m.status FROM idempotency i JOIN messages m ON m.id=i.message_id WHERE i.key_id=? AND i.request_key=? AND i.expires_at>?",
            ).bind(&input.key_id).bind(key).bind(now).fetch_optional(&mut *tx).await?;
        if let Some((message_id, status)) = existing {
            return Ok(Receipt { message_id, status });
        }
    }

    let depth: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM routes WHERE finished=0)+(SELECT count(*) FROM callbacks WHERE finished=0)")
            .fetch_one(&mut *tx)
            .await?;
    if depth >= i64::from(input.queue_limit) {
        return Err(DataError::QueueFull);
    }

    let mut request = input.request;
    let mut listing_topic_id = None;
    if let Some(template) = input.template {
        crate::templates::render(tx, input.user_id.as_deref(), template, &mut request.message)
            .await?;
    }
    let (mut policy, subscriptions, retention) = if let Some(name) = input.topic.as_deref() {
        let row = manage::topic(tx, name).await?;
        let topic = row.value()?;
        if !input.topic_admin && topic.protected {
            let allowed: i64 = sqlx::query_scalar("SELECT password_hash IS ? OR EXISTS(SELECT 1 FROM subscriptions WHERE topic_id=topics.id AND user_id=?) FROM topics WHERE id=?")
                    .bind(input.verified_password_hash.as_deref()).bind(input.user_id.as_deref()).bind(&row.id)
                    .fetch_one(&mut *tx).await?;
            if allowed == 0 {
                return Err(DataError::Forbidden);
            }
        }
        if !topic.enabled {
            return Err(DataError::NoTargets);
        }
        if input.listing.is_some() {
            listing_topic_id = Some(row.id.clone());
        }
        for tag in topic.default_tags {
            if !request.message.tags.contains(&tag) {
                request.message.tags.push(tag);
            }
        }
        let subs = manage::subscriptions(tx, &row.id).await?;
        let retention = topic
            .retention
            .map_or(input.retention_ms, |days| i64::from(days) * 86_400_000);
        (topic.policy, subs, retention)
    } else {
        let policy: String =
            sqlx::query_scalar("SELECT default_policy FROM spaces WHERE id='default'")
                .fetch_one(&mut *tx)
                .await?;
        (
            serde_json::from_str(&policy)?,
            Vec::new(),
            input.retention_ms,
        )
    };
    let mut candidates: Vec<CandidateRow> = sqlx::query_as(
            "SELECT id,channel,tags,weight,priority FROM accounts WHERE space_id='default' AND enabled=1 AND circuit_until<=? AND NOT EXISTS(SELECT 1 FROM channel_settings WHERE channel=accounts.channel AND (enabled=0 OR egress_enabled=0)) ORDER BY created_at,id",
        ).bind(now).fetch_all(&mut *tx).await?;
    candidates.retain(|row| input.available_channels.contains(&row.channel.as_str()));
    if let Some(strategy) = &request.strategy {
        policy.mode = strategy.mode.unwrap_or(policy.mode);
        policy.success_criteria = strategy.success_criteria.unwrap_or(policy.success_criteria);
        policy.retry = strategy.retry.clone().unwrap_or(policy.retry);
    }
    let explicit = request.channels.as_ref().map(|selectors| {
        selectors
            .iter()
            .map(|selector| match selector {
                Selector::Target(target) => target.clone(),
                Selector::Name(name) if candidates.iter().any(|account| account.id == *name) => {
                    Target {
                        account_id: Some(name.clone()),
                        ..Target::default()
                    }
                }
                Selector::Name(name) if name.starts_with("tag:") => Target {
                    tag_selector: vec![name[4..].to_owned()],
                    ..Target::default()
                },
                Selector::Name(name) => Target {
                    channel: Some(name.clone()),
                    ..Target::default()
                },
            })
            .collect::<Vec<_>>()
    });
    let mut groups = Vec::new();
    let mut native = HashSet::new();
    if subscriptions.is_empty() {
        groups.push((
            None,
            expand(
                &candidates,
                explicit.as_deref().unwrap_or(&policy.targets),
                input.topic.is_none() && explicit.is_none(),
            )?,
        ));
    } else {
        for subscription in &subscriptions {
            let filter: Vec<String> = serde_json::from_str(&subscription.filter)?;
            if !filter.iter().all(|tag| request.message.tags.contains(tag)) {
                continue;
            }
            if explicit.is_none()
                && subscription.account_id.is_none()
                && let Some(owner) = &subscription.user_id
            {
                native.insert(owner.as_str());
                if policy.targets.is_empty() {
                    continue;
                }
            }
            let own = subscription.account_id.as_ref().map(|id| {
                [Target {
                    account_id: Some(id.clone()),
                    ..Target::default()
                }]
            });
            let configured = own.as_ref().map(|targets| targets.as_slice());
            let targets = explicit
                .as_deref()
                .or(configured)
                .unwrap_or(&policy.targets);
            groups.push((Some(subscription), expand(&candidates, targets, false)?));
        }
    }
    if groups.iter().map(|(_, group)| group.len()).sum::<usize>() > MAX_TARGETS {
        return Err(DataError::QueueFull);
    }
    if native.is_empty() && groups.iter().all(|(_, group)| group.is_empty()) {
        if input.listing.is_some() {
            groups.clear();
        } else if !groups.is_empty() {
            return Err(DataError::NoTargets);
        }
    }
    if depth + groups.len() as i64 + i64::from(request.callback_url.is_some())
        > i64::from(input.queue_limit)
    {
        return Err(DataError::QueueFull);
    }

    let ttl = i64::try_from(policy.retry.ttl)
        .unwrap_or(i64::MAX)
        .min(input.ttl_limit_ms);
    let deadline = now
        .saturating_add(ttl)
        .min(request.expire_at.unwrap_or(i64::MAX));
    if deadline <= now {
        return Err(DataError::NoTargets);
    }
    let id = new_id();
    let mut status = if groups.is_empty() && input.listing.is_some() {
        "success"
    } else if groups.is_empty() {
        "cancelled"
    } else if groups.iter().all(|(_, group)| group.is_empty()) {
        "failed"
    } else {
        "pending"
    };
    sqlx::query("INSERT INTO messages(id,key_id,topic,body,request,status,created_at,retain_until) VALUES(?,?,?,?,?,?,?,?)")
            .bind(&id).bind(&input.key_id).bind(input.topic.as_deref()).bind(serde_json::to_string(&request.message)?)
            .bind(serde_json::to_string(&request)?).bind(status).bind(now).bind(now.saturating_add(retention))
            .execute(&mut *tx).await?;
    if let Some(speech) = input.speech {
        speech.insert(tx, &id, now, retention).await?;
    }
    if let Some(listing) = input.listing {
        let topic_id = listing_topic_id.ok_or(DataError::Missing)?;
        sqlx::query("INSERT INTO plugin_market_listings(message_id,topic_id,kind,manifest,created_at) VALUES(?,?,?,?,?)")
            .bind(&id).bind(topic_id).bind(listing.kind).bind(serde_json::to_string(&listing.manifest)?).bind(now)
            .execute(&mut *tx).await?;
    }
    if let Some(key) = input.idempotency_key.as_deref() {
        remember_receipt(tx, &input.key_id, key, &id, None, now).await?;
    }
    if !native.is_empty() {
        let format = serde_json::to_value(request.message.format)?;
        let count = sqlx::query("INSERT INTO inbox(user_id,message_id,from_username,topic,title,body,format,created_at)
            SELECT id,?,?,?,?,?,?,? FROM users WHERE enabled=1 AND id IN (SELECT value FROM json_each(?))")
            .bind(&id).bind(input.sender.as_deref()).bind(input.topic.as_deref()).bind(&request.message.title)
            .bind(&request.message.body).bind(format.as_str().unwrap_or("text")).bind(now)
            .bind(serde_json::to_string(&native)?).execute(&mut *tx).await?.rows_affected();
        if count > 0 {
            if groups.is_empty() {
                status = "success";
            }
            sqlx::query("UPDATE messages SET inbox_deliveries=?,status=? WHERE id=?")
                .bind(count as i64)
                .bind(status)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
    }
    if let Some(callback) = request.callback_url {
        sqlx::query("INSERT INTO callbacks(message_id,url,next_at) VALUES(?,?,?)")
            .bind(&id)
            .bind(callback)
            .bind((status != "pending").then_some(now))
            .execute(&mut *tx)
            .await?;
    }
    let policy_json = serde_json::to_string(&policy)?;
    for (subscription, group) in groups {
        let empty = group.is_empty();
        let route_id: i64 = sqlx::query_scalar("INSERT INTO routes(message_id,subscription_id,policy,state,next_at,deadline,finished) VALUES(?,?,?,?,?,?,?) RETURNING id")
                .bind(&id).bind(subscription.map(|sub| &sub.id)).bind(&policy_json)
                .bind(if empty { "failed" } else { "pending" })
                .bind(now).bind(deadline).bind(empty).fetch_one(&mut *tx).await?;
        let data: Vec<_> = group
            .iter()
            .map(|target| Candidate {
                account_id: &target.account.id,
                weight: target.weight,
                priority: target.priority,
                available: true,
            })
            .collect();
        let order = plan_round(policy.mode, &data, |bound| {
            rand::thread_rng().gen_range(0..bound.get())
        });
        let by_id: HashMap<_, _> = group
            .iter()
            .map(|target| (target.account.id.as_str(), target))
            .collect();
        for (position, account_id) in order.into_iter().enumerate() {
            let target = by_id[account_id];
            let overrides = subscription
                .filter(|sub| sub.account_id.as_deref() == Some(account_id) && explicit.is_none())
                .and_then(|sub| sub.encrypted_target.as_deref());
            sqlx::query("INSERT INTO deliveries(id,route_id,account_id,channel,position,weight,priority,encrypted_target) VALUES(?,?,?,?,?,?,?,?)")
                    .bind(new_id()).bind(route_id).bind(account_id).bind(&target.account.channel)
                    .bind(position as i64).bind(target.weight).bind(target.priority).bind(overrides)
                    .execute(&mut *tx).await?;
        }
    }
    Ok(Receipt {
        message_id: id,
        status: status.into(),
    })
}

fn expand<'a>(
    candidates: &'a [CandidateRow],
    targets: &[Target],
    allow_all: bool,
) -> Result<Vec<Planned<'a>>> {
    if targets.is_empty() && !allow_all {
        return Ok(Vec::new());
    }
    let mut selected = HashSet::new();
    let mut output = Vec::new();
    let default = Target::default();
    let targets = if targets.is_empty() {
        std::slice::from_ref(&default)
    } else {
        targets
    };
    for target in targets {
        for candidate in candidates {
            if target
                .account_id
                .as_ref()
                .is_some_and(|id| id != &candidate.id)
                || target
                    .channel
                    .as_ref()
                    .is_some_and(|name| name != &candidate.channel)
                || selected.contains(candidate.id.as_str())
            {
                continue;
            }
            let tags: Vec<String> = serde_json::from_str(&candidate.tags)?;
            if target.tag_selector.iter().all(|tag| tags.contains(tag)) {
                selected.insert(candidate.id.as_str());
                output.push(Planned {
                    account: candidate,
                    priority: target.priority.unwrap_or(candidate.priority),
                    weight: target.weight.unwrap_or(candidate.weight),
                });
                if output.len() > MAX_TARGETS {
                    return Err(DataError::QueueFull);
                }
            }
        }
    }
    Ok(output)
}

async fn owns(tx: &mut SqliteConnection, lease: &Lease, now: i64) -> Result<bool> {
    let owned: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM routes WHERE id=? AND lease_token=? AND lease_until>? AND finished=0)")
        .bind(lease.id).bind(&lease.token).bind(now).fetch_one(tx).await?;
    Ok(owned != 0)
}

pub(crate) async fn cancel(tx: &mut SqliteConnection, subscription: &str) -> Result<()> {
    let now = now_ms();
    sqlx::query("UPDATE attempts SET finished_at=?,error_code='cancelled',error_msg='Subscription cancelled during attempt' WHERE finished_at IS NULL AND delivery_id IN(SELECT d.id FROM deliveries d JOIN routes r ON r.id=d.route_id WHERE r.subscription_id=? AND r.finished=0)")
        .bind(now).bind(subscription).execute(&mut *tx).await?;
    sqlx::query("UPDATE deliveries SET state='cancelled',due_at=NULL WHERE route_id IN(SELECT id FROM routes WHERE subscription_id=? AND finished=0) AND state IN('ready','waiting','sending','exhausted')")
        .bind(subscription).execute(&mut *tx).await?;
    let messages: Vec<String> = sqlx::query_scalar("UPDATE routes SET state=CASE WHEN state='success' THEN 'success' ELSE 'cancelled' END,finished=1,lease_token=NULL,lease_until=NULL WHERE subscription_id=? AND finished=0 RETURNING message_id")
        .bind(subscription).fetch_all(&mut *tx).await?;
    for id in messages {
        update_message(tx, &id).await?;
    }
    Ok(())
}

async fn update_message(tx: &mut SqliteConnection, id: &str) -> Result<()> {
    // Every independently routed subscription must meet its own success criterion.
    let status: String = sqlx::query_scalar("UPDATE messages SET status=(SELECT CASE WHEN count(*) FILTER(WHERE state='pending')>0 THEN 'pending' WHEN count(*) FILTER(WHERE state='dead')>0 THEN 'dead' WHEN count(*) FILTER(WHERE state='failed')>0 THEN 'failed' WHEN count(*) FILTER(WHERE state='success')>0 OR messages.inbox_deliveries>0 THEN 'success' ELSE 'cancelled' END FROM routes WHERE message_id=?) WHERE id=? RETURNING status")
        .bind(id).bind(id).fetch_one(&mut *tx).await?;
    if status != "pending" {
        sqlx::query("UPDATE callbacks SET next_at=? WHERE message_id=? AND finished=0 AND next_at IS NULL AND NOT EXISTS(SELECT 1 FROM routes WHERE message_id=? AND finished=0)")
            .bind(now_ms()).bind(id).bind(id).execute(&mut *tx).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::manage::NewKey;
    use anser_core::{Account, Message};

    use super::*;

    async fn fixture() -> (tempfile::TempDir, Store) {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("test.sqlite3"))
            .await
            .unwrap();
        store
            .insert_key(
                NewKey {
                    id: "sender",
                    hash: &[7; 32],
                    name: "test",
                    scopes: &["send".into()],
                    topic_prefix: None,
                    expires_at: None,
                },
                false,
            )
            .await
            .unwrap();
        store
            .create_account(
                &Account {
                    id: "account".into(),
                    channel: "ntfy".into(),
                    name: "test".into(),
                    tags: Vec::new(),
                    weight: 1,
                    priority: 0,
                    enabled: true,
                    rate_limit: None,
                    proxy_id: None,
                },
                &[1],
            )
            .await
            .unwrap();
        (temp, store)
    }

    fn submission(key: Option<&str>) -> Submission {
        Submission {
            key_id: "sender".into(),
            available_channels: vec!["ntfy"],
            topic: None,
            idempotency_key: key.map(ToOwned::to_owned),
            request: Publish {
                message: Message {
                    title: "test".into(),
                    ..Message::default()
                },
                ..Publish::default()
            },
            template: None,
            ttl_limit_ms: 60_000,
            retention_ms: 86_400_000,
            queue_limit: 100,
            user_id: None,
            sender: None,
            topic_admin: false,
            verified_password_hash: None,
            listing: None,
            speech: None,
        }
    }

    #[tokio::test]
    async fn schedule_recovers_and_commit_is_atomic_and_fenced() {
        use crate::scheduled_tasks::NewSchedule;

        let (temp, store) = fixture().await;
        store
            .create_schedule(NewSchedule {
                id: "weather",
                name: "Weather",
                plugin_id: "wttr-weather",
                encrypted_input: &[1],
                topic: None,
                rule: &anser_core::schedule::Rule::Interval { minutes: 60 },
                next_at: 0,
            })
            .await
            .unwrap();
        let stale = store.claim_schedule(now_ms()).await.unwrap().unwrap();
        assert!(store.claim_schedule(now_ms()).await.unwrap().is_none());
        let (schedule, encrypted) = store.schedule_detail("weather").await.unwrap();
        assert!(matches!(
            store
                .edit_schedule(crate::scheduled_tasks::ScheduleEdit {
                    id: &schedule.id,
                    name: "Edited",
                    plugin_id: &schedule.plugin_id,
                    topic: None,
                    expected_input: &encrypted,
                    encrypted_input: None,
                    timing: None,
                })
                .await,
            Err(DataError::Conflict)
        ));
        store.change_schedule("weather", false).await.unwrap();
        store.change_schedule("weather", true).await.unwrap();
        assert!(
            !store
                .finish_schedule(&stale, vec![submission(None)], None)
                .await
                .unwrap()
        );
        drop(store);

        let store = Store::open(&temp.path().join("test.sqlite3"))
            .await
            .unwrap();
        let run = store.claim_schedule(now_ms()).await.unwrap().unwrap();
        let mut bad = submission(None);
        bad.available_channels.clear();
        assert!(matches!(
            store
                .finish_schedule(&run, vec![submission(None), bad], None)
                .await,
            Err(DataError::NoTargets)
        ));
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
            .fetch_one(&store.0)
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert!(
            store
                .finish_schedule(&run, vec![submission(None), submission(None)], None)
                .await
                .unwrap()
        );
        assert!(
            !store
                .finish_schedule(&run, vec![submission(None)], None)
                .await
                .unwrap()
        );
        let schedules = store.schedules("", 50).await.unwrap();
        assert_eq!(schedules.items[0].last_count, 2);
        assert_eq!(schedules.items[0].last_status.as_deref(), Some("success"));
        assert!(store.claim_schedule(now_ms()).await.unwrap().is_none());
        assert_eq!(store.keys("", 50).await.unwrap().items.len(), 1);
    }

    #[tokio::test]
    async fn one_time_schedule_cannot_enqueue_again_after_completion() {
        use crate::scheduled_tasks::NewSchedule;
        use anser_core::schedule::Rule;

        let (temp, store) = fixture().await;
        let at = now_ms() + 60_000;
        store
            .create_schedule(NewSchedule {
                id: "once",
                name: "Once",
                plugin_id: "wttr-weather",
                encrypted_input: &[1],
                topic: None,
                rule: &Rule::Once { at },
                next_at: at,
            })
            .await
            .unwrap();
        assert!(store.claim_schedule(at - 1).await.unwrap().is_none());
        store.run_schedule_now("once").await.unwrap();
        let run = store.claim_schedule(now_ms()).await.unwrap().unwrap();
        assert!(
            store
                .finish_schedule(&run, vec![submission(None)], None)
                .await
                .unwrap()
        );
        drop(store);

        let store = Store::open(&temp.path().join("test.sqlite3"))
            .await
            .unwrap();
        let page = store.schedules("", 50).await.unwrap();
        let completed = &page.items[0];
        assert!(completed.completed);
        assert!(!completed.enabled);
        assert_eq!(completed.next_at, None);
        assert_eq!(completed.last_count, 1);
        assert_eq!(completed.rule, Rule::Once { at });
        assert!(store.change_schedule("once", true).await.is_err());
        assert!(store.run_schedule_now("once").await.is_err());
        assert!(store.claim_schedule(at).await.unwrap().is_none());
        assert!(
            !store
                .finish_schedule(&run, vec![submission(None)], None)
                .await
                .unwrap()
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
            .fetch_one(&store.0)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn direct_template_content_survives_restart_and_is_used_for_replay() {
        use anser_core::template::{Format, Reference, Usage};

        let (temp, store) = fixture().await;
        let admin = crate::templates::Access {
            owner: None,
            admin: true,
        };
        let template = store
            .create_template(
                admin,
                crate::templates::Definition {
                    name: "direct".into(),
                    title: "{{service}} deployed".into(),
                    body: "Pipeline completed".into(),
                    format: Format::Text,
                    shared: Some(true),
                },
            )
            .await
            .unwrap();
        let mut input = submission(None);
        input.request.message = Message::default();
        input.template = Some(Usage {
            reference: Reference::Id(template.id.clone()),
            variables: [("service".into(), "雁字".into())].into(),
        });
        let receipt = store.enqueue(input).await.unwrap();
        assert_eq!(receipt.status, "pending");
        store.delete_template(admin, &template.id).await.unwrap();
        store.0.close().await;

        let store = Store::open(&temp.path().join("test.sqlite3"))
            .await
            .unwrap();
        let lease = store.claim(now_ms()).await.unwrap().unwrap();
        assert_eq!(lease.message_id, receipt.message_id);
        let saved = store.message_body(&lease.message_id).await.unwrap();
        assert_eq!(saved.title, "雁字 deployed");
        store.release(&lease, None, "dead").await.unwrap();
        let (topic, replay) = store.original(&lease.message_id).await.unwrap();
        assert!(topic.is_none());
        assert_eq!(replay.message.title, saved.title);
        assert_eq!(replay.message.body, saved.body);
    }

    #[tokio::test]
    async fn account_display_names_follow_admin_access_and_account_lifetime() {
        let (_temp, store) = fixture().await;
        let published = store.enqueue(submission(None)).await.unwrap();
        let id = &published.message_id;
        let sender = store.message(id, Some("sender"), None).await.unwrap();
        assert!(sender.deliveries[0].account_name.is_none());
        let admin = store.message(id, None, None).await.unwrap();
        assert_eq!(admin.deliveries[0].account_name.as_deref(), Some("test"));
        store.delete_account("account").await.unwrap();
        let archived = store.message(id, None, None).await.unwrap();
        assert_eq!(archived.deliveries[0].account_id, "account");
        assert!(archived.deliveries[0].account_name.is_none());
    }

    #[tokio::test]
    async fn history_retention_is_optional_and_keeps_active_and_topic_history() {
        use crate::history::HistoryRetention;

        let (temp, store) = fixture().await;
        let now = now_ms();
        let day = 86_400_000;
        assert!(store.history_retention().await.unwrap().is_none());
        sqlx::query("INSERT INTO topics(id,space_id,name,retention) VALUES('daily','default','daily',1),('extended','default','extended',30)")
            .execute(&store.0).await.unwrap();
        for (id, topic, created) in [
            ("old", None, now - 8 * day),
            ("fresh", None, now - day),
            ("extended", Some("extended"), now - 8 * day),
            ("daily", Some("daily"), now - 2 * day),
        ] {
            sqlx::query("INSERT INTO messages(id,key_id,topic,body,request,status,created_at,retain_until) VALUES(?,'sender',?,'{}','{}','success',?,?)")
                .bind(id).bind(topic).bind(created).bind(now - 1).execute(&store.0).await.unwrap();
        }
        let active = store.enqueue(submission(None)).await.unwrap().message_id;
        sqlx::query("UPDATE messages SET created_at=?,retain_until=? WHERE id=?")
            .bind(now - 8 * day)
            .bind(now - 1)
            .bind(&active)
            .execute(&store.0)
            .await
            .unwrap();
        store
            .set_history_retention(HistoryRetention {
                enabled: false,
                days: 7,
            })
            .await
            .unwrap();
        store.maintain(now, day).await.unwrap();
        drop(store);

        let store = Store::open(&temp.path().join("test.sqlite3"))
            .await
            .unwrap();
        let saved = store.history_retention().await.unwrap().unwrap();
        assert!(!saved.enabled);
        assert_eq!(saved.days, 7);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
            .fetch_one(&store.0)
            .await
            .unwrap();
        assert_eq!(count, 5);
        store
            .set_history_retention(HistoryRetention {
                enabled: true,
                days: 7,
            })
            .await
            .unwrap();
        store.maintain(now, day).await.unwrap();
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM messages")
            .fetch_all(&store.0)
            .await
            .unwrap();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&active));
        assert!(ids.iter().any(|id| id == "fresh"));
        assert!(ids.iter().any(|id| id == "extended"));
    }

    #[tokio::test]
    async fn native_receipt_survives_inbox_retention_and_shares_no_publish_keys() {
        let (_temp, store) = fixture().await;
        let recipient = store
            .create_user("recipient", "hash", false, false)
            .await
            .unwrap()
            .unwrap();
        let message = submission(None).request.message;
        let send = || {
            store.send_inbox(
                "sender",
                None,
                "recipient",
                &message,
                Some("same"),
                86_400_000,
            )
        };
        let receipt = send().await.unwrap();
        let published = store.enqueue(submission(Some("same"))).await.unwrap();
        assert_ne!(published.message_id, receipt.message_id);

        let now = now_ms() + 1;
        store.maintain(now, 0).await.unwrap();
        assert!(
            store
                .inbox(&recipient.id, None, 10)
                .await
                .unwrap()
                .items
                .is_empty()
        );
        let replay = send().await.unwrap();
        assert_eq!(replay.id, receipt.id);
        assert_eq!(replay.message_id, receipt.message_id);
        let history = store
            .message(&receipt.message_id, None, None)
            .await
            .unwrap();
        assert_eq!(history.inbox_deliveries, 1);
        assert_eq!(history.inbox_recipient.as_deref(), Some("recipient"));
        assert!(
            store
                .inbox(&recipient.id, None, 10)
                .await
                .unwrap()
                .items
                .is_empty()
        );

        // An expired key can be used for a genuinely new send.
        sqlx::query("UPDATE idempotency SET expires_at=0 WHERE message_id=?")
            .bind(&receipt.message_id)
            .execute(&store.0)
            .await
            .unwrap();
        let next = send().await.unwrap();
        assert_ne!(next.message_id, receipt.message_id);
        assert_ne!(next.id, receipt.id);
    }

    #[tokio::test]
    async fn native_topic_counts_only_enabled_recipients() {
        let (_temp, store) = fixture().await;
        sqlx::raw_sql("INSERT INTO topics(id,space_id,name) VALUES('t','default','t');
            INSERT INTO users(id,username,password_hash,admin,created_at) VALUES('u','reader','hash',0,0);
            INSERT INTO subscriptions(id,topic_id,subscriber_ref,filter,user_id,created_at)
            VALUES('s','t','reader','[]','u',0),('s2','t','other-device','[]','u',0);")
            .execute(&store.0).await.unwrap();
        let send = || {
            let mut input = submission(None);
            input.topic = Some("t".into());
            store.enqueue(input)
        };
        let original = send().await.unwrap();
        assert_eq!(original.status, "success");
        assert_eq!(
            store
                .message(&original.message_id, None, None)
                .await
                .unwrap()
                .inbox_deliveries,
            1
        );
        store
            .update_user("u", Some(false), None, None)
            .await
            .unwrap();
        let disabled = send().await.unwrap();
        assert_eq!(disabled.status, "cancelled");
        assert_eq!(
            store
                .message(&disabled.message_id, None, None)
                .await
                .unwrap()
                .inbox_deliveries,
            0
        );
    }

    #[tokio::test]
    async fn concurrent_idempotent_requests_commit_only_one_delivery_plan() {
        let (_temp, store) = fixture().await;
        let (one, two) = tokio::join!(
            store.enqueue(submission(Some("same"))),
            store.enqueue(submission(Some("same")))
        );
        let id = one.unwrap().message_id;
        assert_eq!(two.unwrap().message_id, id);
        assert_eq!(
            store
                .message(&id, Some("sender"), None)
                .await
                .unwrap()
                .deliveries
                .len(),
            1
        );
        let counts = store.statistics().await.unwrap();
        assert!(counts.contains(&("queue_depth".to_owned(), 1)));
    }

    #[tokio::test]
    async fn one_rejected_submission_does_not_rollback_its_batch_neighbors() {
        let (_temp, store) = fixture().await;
        let mut rejected = submission(Some("rejected"));
        rejected.request.channels = Some(vec![Selector::Name("missing".into())]);
        let results = store
            .enqueue_batch(vec![
                submission(Some("good")),
                rejected,
                submission(Some("good")),
            ])
            .await
            .unwrap();
        assert_eq!(
            results[0].as_ref().unwrap().message_id,
            results[2].as_ref().unwrap().message_id
        );
        assert!(matches!(results[1], Err(DataError::NoTargets)));
        assert!(
            store
                .statistics()
                .await
                .unwrap()
                .contains(&("queue_depth".into(), 1))
        );
    }

    #[tokio::test]
    async fn history_cursor_keeps_timestamp_ties_and_session_visibility() {
        let (_temp, store) = fixture().await;
        sqlx::raw_sql(
            r#"INSERT INTO users (id,username,password_hash,admin,created_at)
                VALUES ('u','user','hash',0,0);
             INSERT INTO api_keys (id,secret_hash,name,scopes,created_at,user_id,session,enabled)
                VALUES ('old',zeroblob(32),'old','[]',0,'u',1,0),
                       ('new',zeroblob(32),'new','[]',0,'u',1,1);
             INSERT INTO messages (id,key_id,topic,body,request,created_at,retain_until)
                VALUES ('e','sender','ops/private','{"title":"test","body":"test"}','{}',4,99),
                       ('d','old','ops/team','{"title":"test","body":"test"}','{}',3,99),
                       ('c','new','ops/team','{"title":"test","body":"test"}','{}',3,99),
                       ('b','new','operations','{"title":"test","body":"test"}','{}',3,99),
                       ('a','old',NULL,'{"title":"test","body":"test"}','{}',2,99);"#,
        )
        .execute(&store.0)
        .await
        .unwrap();

        let first = store
            .messages(None, 1, Some("new"), Some("ops/"))
            .await
            .unwrap();
        assert_eq!(first.items[0].id, "d");
        let second = store
            .messages(first.next_cursor.as_deref(), 1, Some("new"), Some("ops/"))
            .await
            .unwrap();
        assert_eq!(second.items[0].id, "c");
        assert!(second.next_cursor.is_none());
        assert_eq!(
            store
                .messages(None, 10, Some("sender"), None)
                .await
                .unwrap()
                .items[0]
                .id,
            "e"
        );
        assert_eq!(
            store
                .messages(None, 10, None, None)
                .await
                .unwrap()
                .items
                .len(),
            5
        );
        assert!(
            store
                .messages(Some("removed"), 10, None, None)
                .await
                .unwrap()
                .items
                .is_empty()
        );
    }

    #[tokio::test]
    async fn reclaimed_lease_fences_the_interrupted_worker() {
        let (_temp, store) = fixture().await;
        let id = store.enqueue(submission(None)).await.unwrap().message_id;
        let old = store.claim(now_ms()).await.unwrap().unwrap();
        let pending = store.deliveries(old.id).await.unwrap().pop().unwrap();
        let Slot::Started { n, .. } = store.reserve(&old, &pending).await.unwrap() else {
            panic!("the first worker must hold a lease");
        };
        sqlx::query("UPDATE routes SET lease_until=? WHERE id=?")
            .bind(now_ms() - 1)
            .bind(old.id)
            .execute(&store.0)
            .await
            .unwrap();
        let new = store.claim(now_ms()).await.unwrap().unwrap();
        assert_ne!(new.token, old.token);
        store
            .record(
                &old,
                &pending,
                n,
                now_ms(),
                Outcome {
                    state: "success",
                    due_at: None,
                    error: None,
                    retryable: false,
                },
            )
            .await
            .unwrap();
        let detail = store.message(&id, Some("sender"), None).await.unwrap();
        assert_eq!(detail.status, "pending");
        assert_eq!(detail.deliveries[0].status, "pending");
        assert_eq!(
            detail.deliveries[0].attempts[0].error_code.as_deref(),
            Some("interrupted")
        );
    }
}
