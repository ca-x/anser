//! Encrypted defaults and field options for content transforms that opt in.

use std::sync::Arc;
use std::time::Duration;

use anser_plugin_api::{PluginDescriptor, PluginKind};
use anser_store::DataError;
use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::api::{App, config_editor, config_revision, config_view, merge_account_config};
use crate::auth::Identity;
use crate::error::{ApiError, ApiJson, ApiPath, ApiResult};
use crate::plugins::{plugin_error, validate_config};

static OPTION_SLOTS: Semaphore = Semaphore::const_new(8);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SettingsDraft {
    config: Option<Value>,
    config_revision: Option<String>,
}

fn descriptor<'a>(app: &'a App, id: &str) -> ApiResult<&'a PluginDescriptor> {
    app.host
        .actions()
        .map(|(plugin, _)| plugin)
        .find(|plugin| {
            plugin.id == id
                && plugin.kind == PluginKind::ContentTransform
                && plugin.config_schema["x-anser-ui"]["persistent_settings"] == true
        })
        .ok_or_else(|| DataError::Missing.into())
}

fn context(id: &str) -> String {
    format!("anser:transform-settings:{id}")
}

fn check_revision(encrypted: Option<&[u8]>, supplied: Option<&str>) -> ApiResult<()> {
    if encrypted.map(config_revision).as_deref() != supplied {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "plugin_config_changed",
            "Plugin settings changed. Reload the settings and try again.",
        ));
    }
    Ok(())
}

pub(crate) async fn settings(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<impl IntoResponse> {
    identity.admin_global()?;
    let editor = config_editor(&descriptor(&app, &id)?.config_schema)?;
    let encrypted = app.store.transform_settings(&id).await?;
    let saved = match encrypted.as_deref() {
        Some(bytes) => app.cipher.open(&context(&id), bytes)?,
        None => json!({}),
    };
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(config_view(
            &editor,
            &saved,
            encrypted.as_deref().map(config_revision),
        )),
    ))
}

pub(crate) async fn save(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(draft): ApiJson<SettingsDraft>,
) -> ApiResult<impl IntoResponse> {
    identity.admin_global()?;
    let editor = config_editor(&descriptor(&app, &id)?.config_schema)?;
    let config = draft
        .config
        .ok_or_else(|| ApiError::bad("A plugin configuration is required"))?;
    validate_config(&config)?;
    let encrypted = app.store.transform_settings(&id).await?;
    check_revision(encrypted.as_deref(), draft.config_revision.as_deref())?;
    let binding = context(&id);
    let saved = match encrypted.as_deref() {
        Some(bytes) => app.cipher.open(&binding, bytes)?,
        None => json!({}),
    };
    let config = merge_account_config(&editor, &saved, config)?;
    validate_config(&config)?;
    app.host
        .validate_transform_settings(&id, &config)
        .await
        .map_err(plugin_error)?;
    let next = app.cipher.seal(&binding, &config)?;
    let revision = config_revision(&next);
    app.store
        .save_transform_settings(&id, encrypted, next)
        .await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(config_view(&editor, &config, Some(revision))),
    ))
}

pub(crate) async fn resolve(
    app: &App,
    id: &str,
    config: Option<Value>,
    revision: Option<&str>,
) -> ApiResult<Value> {
    let config = match (config, revision) {
        (Some(config), None) => {
            validate_config(&config)?;
            return Ok(config);
        }
        (config, _) => config,
    };
    let plugin = descriptor(app, id)?;
    let encrypted = app.store.transform_settings(id).await?;
    if revision.is_some() {
        check_revision(encrypted.as_deref(), revision)?;
    }
    let encrypted = encrypted
        .ok_or_else(|| ApiError::bad("Save plugin settings or provide a configuration."))?;
    let saved = app.cipher.open(&context(id), &encrypted)?;
    if let Some(config) = config {
        validate_config(&config)?;
        let config = merge_account_config(&config_editor(&plugin.config_schema)?, &saved, config)?;
        validate_config(&config)?;
        Ok(config)
    } else {
        Ok(saved)
    }
}

pub(crate) async fn options(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath((id, field)): ApiPath<(String, String)>,
    ApiJson(draft): ApiJson<SettingsDraft>,
) -> ApiResult<impl IntoResponse> {
    identity.admin_global()?;
    let plugin = descriptor(&app, &id)?;
    let fields =
        plugin.config_schema["properties"][&field]["x-anser-ui"]["dynamic_options"]["fields"]
            .as_array()
            .ok_or(DataError::Missing)?;
    let config = resolve(&app, &id, draft.config, draft.config_revision.as_deref()).await?;
    let config: serde_json::Map<String, Value> = fields
        .iter()
        .filter_map(|name| {
            let name = name.as_str()?;
            Some((name.to_owned(), config.get(name)?.clone()))
        })
        .collect();
    let config = Value::Object(config);
    let _permit = OPTION_SLOTS
        .try_acquire()
        .map_err(|_| ApiError::limited())?;
    let choices = tokio::time::timeout(
        Duration::from_secs(12),
        app.host.transform_options(&id, &field, &config),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "plugin_options_timeout",
            "Plugin options request timed out",
        )
    })?
    .map_err(plugin_error)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"items": choices})),
    ))
}
