//! LazyCat supplies a verified platform identity on this request at its authenticated ingress.
use std::sync::Arc;

use anser_core::api::LazycatDevices;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::api::App;
use crate::auth::Identity;
use crate::error::{ApiError, ApiResult};

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

pub async fn devices(
    State(app): State<Arc<App>>,
    identity: Identity,
    headers: HeaderMap,
) -> ApiResult<impl IntoResponse> {
    identity.admin_global()?;
    let secret = Zeroizing::new(std::env::var("ANSER_LAZYCAT_INGRESS_SECRET").unwrap_or_default());
    let user_id = ingress_uid(&headers, &secret)?;
    let devices = app
        .host
        .lazycat_devices(user_id)
        .await
        .map_err(ApiError::channel)?;
    Ok((
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(LazycatDevices {
            user_id: user_id.to_owned(),
            devices,
        }),
    ))
}
