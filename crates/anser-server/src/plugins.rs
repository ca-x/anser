//! Installed plugin inventory and bounded, on-demand invocations.

use std::sync::Arc;
use std::time::Duration;

use anser_core::Message;
use anser_core::api::Page;
use anser_host::HostError;
use anser_plugin_api::{
    MAX_TRANSFORM_ARTIFACT_BYTES, PluginDescriptor, PluginKind, TaskOutput, TransformOutput,
};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::api::{App, validate_message};
use crate::auth::Identity;
use crate::error::{ApiError, ApiJson, ApiPath, ApiResult};

const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CONFIG_BYTES: usize = 32 * 1024;
const MAX_ACTION_INPUT_BYTES: usize = 256 * 1024;
const MAX_TASK_NOTIFICATIONS: usize = 32;
const MAX_ARTIFACTS: usize = 8;
static ACTION_SLOTS: Semaphore = Semaphore::const_new(4);

#[derive(Serialize)]
pub(crate) struct InstalledPlugin {
    #[serde(flatten)]
    descriptor: PluginDescriptor,
    enabled: bool,
    available: bool,
}

pub(crate) async fn list(
    State(app): State<Arc<App>>,
    _identity: Identity,
) -> ApiResult<Json<Page<InstalledPlugin>>> {
    let settings = app.store.channel_settings().await?;
    let mut items = Vec::with_capacity(app.host.ids().len());
    for &id in app.host.ids() {
        let channel = app.host.describe(id).await.map_err(plugin_error)?;
        items.push(InstalledPlugin {
            descriptor: PluginDescriptor {
                kind: PluginKind::Channel,
                id: channel.id,
                display_name: channel.display_name,
                version: None,
                config_schema: channel.config_schema,
            },
            enabled: settings.get(id).copied().unwrap_or(true),
            available: app.host.available(id),
        });
    }
    items.extend(
        app.host
            .actions()
            .map(|(descriptor, available)| InstalledPlugin {
                descriptor: descriptor.clone(),
                enabled: true,
                available,
            }),
    );
    Ok(Json(Page {
        items,
        next_cursor: None,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskRequest {
    pub config: Value,
    #[serde(default)]
    pub input: Value,
}

pub(crate) async fn run_task(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<TaskRequest>,
) -> ApiResult<Json<TaskOutput>> {
    identity.admin_global()?;
    Ok(Json(execute_task(&app, &id, request).await?))
}

pub(crate) async fn execute_task(
    app: &App,
    id: &str,
    request: TaskRequest,
) -> ApiResult<TaskOutput> {
    validate_config(&request.config)?;
    require_encoded_limit(&request.input, MAX_ACTION_INPUT_BYTES)?;
    let _permit = acquire_slot()?;
    let output = tokio::time::timeout(
        TIMEOUT,
        app.host.run_task(id, request.config, request.input),
    )
    .await
    .map_err(|_| timed_out())?
    .map_err(plugin_error)?;
    if output.notifications.len() > MAX_TASK_NOTIFICATIONS
        || !serde_json::to_vec(&output).is_ok_and(|bytes| bytes.len() <= MAX_ACTION_INPUT_BYTES)
    {
        return Err(invalid_output());
    }
    for message in &output.notifications {
        validate_output_message(message)?;
    }
    Ok(output)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TransformRequest {
    config: Value,
    message: Message,
}

pub(crate) async fn transform(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<TransformRequest>,
) -> ApiResult<Json<TransformOutput>> {
    identity.admin_global()?;
    Ok(Json(
        transform_message(&app, &id, request.config, request.message).await?,
    ))
}

pub(crate) async fn transform_message(
    app: &App,
    id: &str,
    config: Value,
    message: Message,
) -> ApiResult<TransformOutput> {
    validate_config(&config)?;
    require_encoded_limit(&message, MAX_ACTION_INPUT_BYTES)?;
    validate_message(&message)?;
    let _permit = acquire_slot()?;
    let output = tokio::time::timeout(TIMEOUT, app.host.transform(id, config, message))
        .await
        .map_err(|_| timed_out())?
        .map_err(plugin_error)?;
    validate_output_message(&output.message)?;
    validate_artifacts(&output)?;
    Ok(output)
}

fn acquire_slot() -> ApiResult<SemaphorePermit<'static>> {
    ACTION_SLOTS.try_acquire().map_err(|_| ApiError::limited())
}

pub(crate) fn validate_config(config: &Value) -> ApiResult<()> {
    if !config.is_object() {
        return Err(ApiError::bad("Plugin configuration must be a JSON object"));
    }
    require_encoded_limit(config, MAX_CONFIG_BYTES)
}

pub(crate) fn require_encoded_limit(data: &impl Serialize, limit: usize) -> ApiResult<()> {
    if serde_json::to_vec(data).is_ok_and(|bytes| bytes.len() <= limit) {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "plugin_input_too_large",
            "Plugin input exceeds the allowed size",
        ))
    }
}

fn validate_output_message(message: &Message) -> ApiResult<()> {
    validate_message(message).map_err(|_| invalid_output())?;
    require_encoded_limit(message, MAX_ACTION_INPUT_BYTES).map_err(|_| invalid_output())
}

fn validate_artifacts(output: &TransformOutput) -> ApiResult<()> {
    if output.artifacts.len() > MAX_ARTIFACTS {
        return Err(invalid_output());
    }
    let mut remaining = MAX_TRANSFORM_ARTIFACT_BYTES;
    for artifact in &output.artifacts {
        if artifact.name.is_empty()
            || artifact.name.len() > 128
            || matches!(artifact.name.as_str(), "." | "..")
            || !artifact
                .name
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || b".-_".contains(&value))
            || !valid_media_type(&artifact.content_type)
            || artifact.content_base64.len() > remaining.div_ceil(3) * 4
        {
            return Err(invalid_output());
        }
        let decoded = STANDARD
            .decode(&artifact.content_base64)
            .map_err(|_| invalid_output())?;
        if decoded.is_empty() || decoded.len() > remaining {
            return Err(invalid_output());
        }
        remaining -= decoded.len();
    }
    Ok(())
}

fn valid_media_type(value: &str) -> bool {
    value.len() <= 96
        && value.split_once('/').is_some_and(|(kind, suffix)| {
            [kind, suffix].into_iter().all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
            })
        })
}

fn invalid_output() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "invalid_plugin_output",
        "Plugin returned an invalid result",
    )
}

fn timed_out() -> ApiError {
    ApiError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "plugin_timed_out",
        "Plugin execution exceeded its deadline",
    )
}

fn plugin_error(error: HostError) -> ApiError {
    match error {
        HostError::PluginNotFound => anser_store::DataError::Missing.into(),
        HostError::Send(error) => {
            let mut response = ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "plugin_error",
                "Plugin rejected the request",
            );
            response.details = json!({
                "provider_code": error.code,
                "message": error.message,
                "retryable": error.retryable,
                "retry_after_ms": error.retry_after_ms,
            });
            response
        }
        _ => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "plugin_unavailable",
            "Plugin is unavailable",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_plugin_api::TransformArtifact;

    #[test]
    fn validates_inline_media_results() {
        let mut output = TransformOutput {
            message: Message::default(),
            artifacts: vec![TransformArtifact {
                name: "speech.mp3".into(),
                content_type: "audio/mpeg".into(),
                content_base64: "YWJj".into(),
            }],
        };
        assert!(validate_artifacts(&output).is_ok());
        output.artifacts[0].content_type = "audio/mpeg; unsafe".into();
        assert!(validate_artifacts(&output).is_err());
        output.artifacts[0].content_type = "audio/mpeg".into();
        output.artifacts[0].name = "../speech.mp3".into();
        assert!(validate_artifacts(&output).is_err());
        output.artifacts[0].name = "speech.mp3".into();
        output.artifacts[0].content_base64 =
            "x".repeat(MAX_TRANSFORM_ARTIFACT_BYTES.div_ceil(3) * 4 + 1);
        assert!(validate_artifacts(&output).is_err());
    }
}
