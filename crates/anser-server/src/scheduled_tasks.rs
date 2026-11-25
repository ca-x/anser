use std::sync::Arc;
use std::time::Duration;

use anser_core::api::{Page, Publish};
use anser_core::schedule::Rule;
use anser_plugin_api::PluginKind;
use anser_queue::CancellationToken;
use anser_store::queue::Submission;
use anser_store::scheduled_tasks::{NewSchedule, Schedule, ScheduleEdit, ScheduledRun};
use anser_store::{new_id, now_ms};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
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
    interval_minutes: Option<i64>,
    rule: Option<Rule>,
    topic: Option<String>,
    start_at: Option<i64>,
    config: Value,
    #[serde(default)]
    input: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Edit {
    name: String,
    plugin_id: String,
    topic: Option<String>,
    rule: Option<Rule>,
    start_at: Option<i64>,
    config: Option<Value>,
    input: Option<Value>,
}

#[derive(Serialize)]
pub(crate) struct Detail {
    #[serde(flatten)]
    schedule: Schedule,
    config: Option<Value>,
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
    let name = schedule_name(&request.name)?;
    require_task(&app, &request.plugin_id)?;
    plugins::validate_config(&request.config)?;
    plugins::require_encoded_limit(&request.input, 32 * 1024)?;
    let now = now_ms();
    let (rule, next_at) = schedule_timing(
        request.rule,
        request.interval_minutes,
        request.start_at,
        now,
    )?;
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
            rule: &rule,
            next_at,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(schedule)))
}

pub(crate) async fn detail(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<Detail>> {
    identity.admin_global()?;
    let (schedule, encrypted) = app.store.schedule_detail(&id).await?;
    // Task input is arbitrary JSON. Only expose options declared safe for the built-in editors.
    let config = match schedule.plugin_id.as_str() {
        "wttr-weather" => Some(&["location", "language", "units", "forecast", "forecast_days"][..]),
        "open-meteo-weather" => Some(
            &[
                "location",
                "country_code",
                "language",
                "units",
                "forecast",
                "forecast_days",
            ][..],
        ),
        "certificate-expiration" => Some(&["urls", "warning_days"][..]),
        _ => None,
    }
    .map(|fields| {
        let mut task = open_task(&app, &id, &encrypted)?;
        let values = task.config.as_object_mut().ok_or_else(ApiError::internal)?;
        values.retain(|field, _| fields.contains(&field.as_str()));
        Ok::<_, ApiError>(task.config)
    })
    .transpose()?;
    Ok(Json(Detail { schedule, config }))
}

pub(crate) async fn edit(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<Edit>,
) -> ApiResult<Json<Schedule>> {
    identity.admin_global()?;
    let name = schedule_name(&request.name)?;
    let (schedule, encrypted) = app.store.schedule_detail(&id).await?;
    let changed_plugin = request.plugin_id != schedule.plugin_id;
    let replacement = if changed_plugin {
        require_task(&app, &request.plugin_id)?;
        let config = request
            .config
            .ok_or_else(|| ApiError::bad("Supply configuration for the new task plugin"))?;
        Some(TaskRequest {
            config,
            input: request.input.unwrap_or(Value::Null),
        })
    } else if request.config.is_some() || request.input.is_some() {
        let old = open_task(&app, &id, &encrypted)?;
        Some(TaskRequest {
            config: request.config.unwrap_or(old.config),
            input: request.input.unwrap_or(old.input),
        })
    } else {
        None
    };
    let replacement = replacement
        .map(|task| {
            plugins::validate_config(&task.config)?;
            plugins::require_encoded_limit(&task.input, 32 * 1024)?;
            Ok::<_, ApiError>(app.cipher.seal(
                &schedule_context(&id),
                &json!({"config":task.config,"input":task.input}),
            )?)
        })
        .transpose()?;
    let timing = if request.rule.is_some() || request.start_at.is_some() {
        Some(schedule_timing(
            request.rule.or(Some(schedule.rule)),
            None,
            request.start_at,
            now_ms(),
        )?)
    } else {
        None
    };
    let updated = app
        .store
        .edit_schedule(ScheduleEdit {
            id: &id,
            name,
            plugin_id: &request.plugin_id,
            topic: request.topic.as_deref(),
            expected_input: &encrypted,
            encrypted_input: replacement.as_deref(),
            timing: timing.as_ref().map(|(rule, next)| (rule, *next)),
        })
        .await
        .map_err(|error| match error {
            anser_store::DataError::Conflict => ApiError::new(
                StatusCode::CONFLICT,
                "schedule_edit_conflict",
                "The schedule is running or changed. Reopen the editor and try again.",
            ),
            other => other.into(),
        })?;
    Ok(Json(updated))
}

fn open_task(app: &App, id: &str, encrypted: &[u8]) -> ApiResult<TaskRequest> {
    let stored = app.cipher.open(&schedule_context(id), encrypted)?;
    serde_json::from_value(stored).map_err(|_| ApiError::internal())
}

fn schedule_name(name: &str) -> ApiResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
        return Err(ApiError::bad("Invalid schedule name"));
    }
    Ok(name)
}

fn require_task(app: &App, id: &str) -> ApiResult<()> {
    if !app
        .host
        .actions()
        .any(|(descriptor, _)| descriptor.kind == PluginKind::Task && descriptor.id == id)
    {
        return Err(ApiError::bad("Select an installed task plugin"));
    }
    Ok(())
}

fn schedule_timing(
    rule: Option<Rule>,
    interval_minutes: Option<i64>,
    start_at: Option<i64>,
    now: i64,
) -> ApiResult<(Rule, i64)> {
    let rule = match (rule, interval_minutes) {
        (Some(rule), None) => rule,
        (None, Some(minutes)) => Rule::Interval { minutes },
        _ => return Err(ApiError::bad("Specify a schedule rule or an interval")),
    };
    let next = rule
        .next_after(now)
        .ok_or_else(|| ApiError::bad("Invalid schedule rule or date is in the past"))?;
    let next = match start_at {
        Some(start)
            if rule.interval_minutes().is_some()
                && (0..=now.saturating_add(366 * 86_400_000)).contains(&start) =>
        {
            start.max(now)
        }
        Some(_) => return Err(ApiError::bad("Invalid first run time for this schedule")),
        None => next,
    };
    Ok((rule, next))
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
    let request = open_task(app, &run.id, &run.encrypted_input)?;
    let output = plugins::execute_task(app, &run.plugin_id, request).await?;
    let available_channels: Vec<_> = app
        .host
        .ids()
        .iter()
        .copied()
        .filter(|id| app.host.egress_available(id))
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
