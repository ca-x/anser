use std::sync::Arc;

use anser_store::history::HistoryRetention;
use axum::{Json, extract::State};

use crate::api::App;
use crate::auth::Identity;
use crate::error::{ApiError, ApiJson, ApiResult};

pub(crate) async fn history(
    State(app): State<Arc<App>>,
    identity: Identity,
) -> ApiResult<Json<HistoryRetention>> {
    identity.admin_global()?;
    Ok(Json(app.store.history_retention().await?.unwrap_or(
        HistoryRetention {
            enabled: true,
            days: (app.retention_ms / 86_400_000) as u32,
        },
    )))
}

pub(crate) async fn save_history(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(settings): ApiJson<HistoryRetention>,
) -> ApiResult<Json<HistoryRetention>> {
    identity.admin_global()?;
    if !(1..=3650).contains(&settings.days) {
        return Err(ApiError::bad("Retention must be between 1 and 3650 days"));
    }
    app.store.set_history_retention(settings).await?;
    Ok(Json(settings))
}
