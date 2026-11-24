use std::sync::Arc;
use std::time::Duration;

use anser_core::api::{Page, Publish};
use anser_plugin_api::PluginKind;
use anser_queue::CancellationToken;
use anser_store::queue::Submission;
use anser_store::scheduled_tasks::{NewSchedule, Schedule, ScheduledRun};
use anser_store::{new_id, now_ms};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{App, Pagination};
use crate::auth::Identity;
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery, ApiResult};
use crate::plugins::{self, TaskRequest};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Create {
    name: String,
    plugin_id: String,
    interval_minutes: i64,
    topic: Option<String>,
    start_at: Option<i64>,
    config: Value,
    #[serde(default)]
    input: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StateChange {
    enabled: bool,
}

pub(crate) async fn list(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<Json<Page<Schedule>>> {
    identity.admin_global()?;
    Ok(Json(app.store.schedules(page.after(), page.limit()).await?))
}

pub(crate) async fn create(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(request): ApiJson<Create>,
) -> ApiResult<(StatusCode, Json<Schedule>)> {
    identity.admin_global()?;
    let name = request.name.trim();
    if name.is_empty()
        || name.len() > 128
        || name.chars().any(char::is_control)
        || !(1..=43_200).contains(&request.interval_minutes)
    {
        return Err(ApiError::bad("Invalid schedule name or interval"));
    }
    if !app.host.actions().any(|(descriptor, _)| {
        descriptor.kind == PluginKind::Task && descriptor.id == request.plugin_id
    }) {
        return Err(ApiError::bad("Select an installed task plugin"));
    }
    plugins::validate_config(&request.config)?;
    plugins::require_encoded_limit(&request.input, 32 * 1024)?;
    let now = now_ms();
    let next_at = request
        .start_at
        .unwrap_or(now.saturating_add(request.interval_minutes * 60_000));
    if next_at < 0 || next_at > now.saturating_add(366 * 86_400_000) {
        return Err(ApiError::bad("Invalid schedule start time"));
    }
    let id = new_id();
    let encrypted_input = app.cipher.seal(
        &schedule_context(&id),
        &json!({"config":request.config,"input":request.input}),
    )?;
    let schedule = app
        .store
        .create_schedule(NewSchedule {
            id: &id,
            name,
            plugin_id: &request.plugin_id,
            encrypted_input: &encrypted_input,
            topic: request.topic.as_deref(),
            interval_minutes: request.interval_minutes,
            next_at: next_at.max(now),
        })
        .await?;
    Ok((StatusCode::CREATED, Json(schedule)))
}

pub(crate) async fn change(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(change): ApiJson<StateChange>,
) -> ApiResult<StatusCode> {
    identity.admin_global()?;
    app.store.change_schedule(&id, change.enabled).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn run_now(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    identity.admin_global()?;
    app.store.run_schedule_now(&id).await?;
    Ok((StatusCode::ACCEPTED, Json(json!({"queued":true}))))
}

pub(crate) async fn delete(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
    identity.admin_global()?;
    app.store.delete_schedule(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn schedule_context(id: &str) -> String {
    format!("scheduled-task:{id}")
}

pub(crate) async fn work(app: Arc<App>, stop: CancellationToken) {
    loop {
        if stop.is_cancelled() {
            return;
        }
        match app.store.claim_schedule(now_ms()).await {
            Ok(Some(run)) => {
                complete_run(&app, &run).await;
                continue;
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "scheduled task claim failed"),
        }
        tokio::select! {
            () = stop.cancelled() => return,
            () = tokio::time::sleep(Duration::from_secs(1)) => {},
        }
    }
}

async fn complete_run(app: &App, run: &ScheduledRun) {
    let result = execute(app, run).await;
    let (items, error) = match result {
        Ok(items) => (items, None),
        Err(error) => (Vec::new(), Some(error.code)),
    };
    match app.store.finish_schedule(run, items, error).await {
        Ok(true) => app.inbox_wakeup.notify_waiters(),
        Ok(false) => {}
        Err(error) => {
            let status = match error {
                anser_store::DataError::NoTargets => "no_available_targets",
                anser_store::DataError::QueueFull => "queue_full",
                _ => "enqueue_failed",
            };
            if let Err(error) = app
                .store
                .finish_schedule(run, Vec::new(), Some(status))
                .await
            {
                tracing::warn!(%error, "failed to persist scheduled task result");
            }
        }
    }
}

async fn execute(app: &App, run: &ScheduledRun) -> ApiResult<Vec<Submission>> {
    let stored = app
        .cipher
        .open(&schedule_context(&run.id), &run.encrypted_input)?;
    let request: TaskRequest = serde_json::from_value(stored).map_err(|_| ApiError::internal())?;
    let output = plugins::execute_task(app, &run.plugin_id, request).await?;
    let available_channels: Vec<_> = app
        .host
        .ids()
        .iter()
        .copied()
        .filter(|id| app.host.available(id))
        .collect();
    Ok(output
        .notifications
        .into_iter()
        .map(|message| Submission {
            key_id: String::new(),
            available_channels: available_channels.clone(),
            topic: None,
            idempotency_key: None,
            request: Publish {
                message,
                ..Publish::default()
            },
            template: None,
            ttl_limit_ms: app.ttl_limit_ms,
            retention_ms: app.retention_ms,
            queue_limit: app.queue_limit,
            user_id: None,
            sender: None,
            topic_admin: true,
            verified_password_hash: None,
            listing: None,
            speech: None,
        })
        .collect())
}
