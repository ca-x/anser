//! LazyCat supplies a verified platform identity on this request at its authenticated ingress.
use std::sync::Arc;

use anser_core::api::{LAZYCAT_DEVICE_LIMIT, LazycatDevices};
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::Value;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::api::App;
use crate::auth::Identity;
use crate::error::{ApiError, ApiQuery, ApiResult};

fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(first)
}

fn ingress_uid<'a>(headers: &'a HeaderMap, secret: &str) -> ApiResult<&'a str> {
    if secret.len() != 64 || !secret.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "lazycat_identity_unavailable",
            "LazyCat device discovery is unavailable on this server",
        ));
    }
    let required = || {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "lazycat_identity_required",
            "Open Anser through your signed-in LazyCat application to select a device",
        )
    };
    let proof = one_header(headers, "x-anser-lazycat-proof").ok_or_else(required)?;
    if !bool::from(secret.as_bytes().ct_eq(proof.as_bytes())) {
        return Err(required());
    }
    one_header(headers, "x-anser-lazycat-uid")
        .filter(|uid| (1..=256).contains(&uid.len()) && uid.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or_else(required)
}

#[derive(Deserialize)]
pub struct DeviceQuery {
    account_id: Option<String>,
}

async fn configured_devices(app: &App, account_id: &str, user_id: &str) -> ApiResult<Vec<String>> {
    let account = app.store.account(account_id).await?;
    if account.channel != "lazycat" {
        return Err(ApiError::bad(
            "The account does not use the LazyCat channel",
        ));
    }
    let config = app.cipher.open(&account.id, &account.encrypted_config)?;
    if config["user_id"].as_str() != Some(user_id) {
        return Ok(Vec::new());
    }
    if let Some(ids) = config["device_ids"].as_array() {
        return Ok(ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect());
    }
    Ok(config["device_id"]
        .as_str()
        .map(str::to_owned)
        .into_iter()
        .collect())
}

pub async fn devices(
    State(app): State<Arc<App>>,
    identity: Identity,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<DeviceQuery>,
) -> ApiResult<impl IntoResponse> {
    identity.admin_global()?;
    let secret = Zeroizing::new(std::env::var("ANSER_LAZYCAT_INGRESS_SECRET").unwrap_or_default());
    let user_id = ingress_uid(&headers, &secret)?;
    let devices = app
        .host
        .lazycat_devices(user_id)
        .await
        .map_err(ApiError::channel)?;
    let configured_device_ids = match query.account_id {
        Some(account) => configured_devices(&app, &account, user_id).await?,
        None => Vec::new(),
    };
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(LazycatDevices {
            user_id: user_id.to_owned(),
            devices,
            max_selection: Some(LAZYCAT_DEVICE_LIMIT),
            configured_device_ids,
        }),
    ))
}
