//! Public provider-compatible endpoints. Authentication, policy and persistence stay here.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use anser_core::api::Publish;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::routing::any;
use axum::{Json, Router};
use serde_json::Value;

use crate::api::{App, Wait, enqueue_prepared};
use crate::auth::Identity;
use crate::error::{ApiError, ApiPath, ApiResult};

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/{plugin}", any(receive))
        .route("/{plugin}/", any(receive))
        .route("/{plugin}/{*path}", any(receive))
}

fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "not_found",
        "Receive endpoint not found",
    )
}

fn field<'a>(headers: &'a HeaderMap, name: &str) -> ApiResult<Option<&'a str>> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .map(|v| std::str::from_utf8(v.as_bytes()))
        .transpose()
        .map_err(|_| ApiError::bad("Header must contain UTF-8 text"))?;
    if values.next().is_some() {
        return Err(ApiError::bad("Ambiguous request header"));
    }
    Ok(value)
}

async fn receive(
    State(app): State<Arc<App>>,
    ApiPath(params): ApiPath<HashMap<String, String>>,
    request: Request,
) -> ApiResult<Json<Value>> {
    let id = &params["plugin"];
    let path = format!("/{}", params.get("path").map(String::as_str).unwrap_or(""));
    let (mut parts, body) = request.into_parts();
    {
        let session = app.host.receive(id).ok_or_else(not_found)?;
        let mut candidates = session
            .routes()
            .iter()
            .filter(|route| route.matches_path(&path))
            .peekable();
        if candidates.peek().is_none() {
            return Err(not_found());
        }
        if !candidates.any(|route| route.method == parts.method.as_str()) {
            return Err(ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "Method not supported for this endpoint",
            ));
        }
        if let Some(name) = session.token_header()
            && let Some(token) = field(&parts.headers, name)?
        {
            if parts.headers.contains_key(header::AUTHORIZATION) || token.len() > 256 {
                return Err(ApiError::auth());
            }
            let mut bearer =
                HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| ApiError::auth())?;
            bearer.set_sensitive(true);
            parts.headers.insert(header::AUTHORIZATION, bearer);
        }
    }
    field(&parts.headers, "authorization")?;
    let identity = Identity::from_request_parts(&mut parts, &app).await?;
    identity.require("send")?;
    if parts.uri.query().is_some() {
        return Err(ApiError::bad(
            "This endpoint does not accept query parameters",
        ));
    }
    field(&parts.headers, "idempotency-key")?;
    let header_topic = field(&parts.headers, "x-anser-topic")?;
    let password = field(&parts.headers, "x-anser-topic-password")?.map(str::to_owned);
    let body = axum::body::to_bytes(body, 512 * 1024).await.map_err(|_| {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_body",
            "Unable to read request within the receive size limit",
        )
    })?;
    // Re-admit after reading the body so a slow sender cannot block plugin suspension.
    let session = app.host.receive(id).ok_or_else(not_found)?;
    let mut headers = BTreeMap::new();
    for name in session.headers() {
        if let Some(value) = field(&parts.headers, name)? {
            headers.insert(name.clone(), value.to_owned());
        }
    }
    let mut incoming = session
        .decode(parts.method.as_str(), &path, headers, &body)
        .await
        .map_err(|err| match err {
            anser_host::HostError::Send(e) => {
                let mut error = ApiError::bad("Invalid request for the selected receive protocol");
                error.details = serde_json::json!({"reason":e.message});
                error
            }
            other => ApiError::channel(other),
        })?;
    if let Some(topic) = header_topic {
        if incoming.topic.as_ref().is_some_and(|t| t != topic) {
            return Err(ApiError::bad("Conflicting destination topics"));
        }
        incoming.topic = Some(topic.to_owned());
    }
    if password.is_some() && incoming.topic.is_none() {
        return Err(ApiError::bad("A topic password requires a topic"));
    }
    let input = Publish {
        message: incoming.message.clone(),
        topic_password: password,
        ..Default::default()
    };
    let (_, Json(receipt)) = enqueue_prepared(
        &app,
        &identity,
        incoming.topic.as_deref(),
        Wait::default(),
        &parts.headers,
        input.into(),
        None,
    )
    .await?;
    if parts.headers.contains_key("idempotency-key") {
        incoming.message = app
            .store
            .received_body(
                &receipt.message_id,
                &identity.key_id,
                incoming.topic.as_deref(),
            )
            .await?;
    }
    Ok(Json(
        session
            .response(incoming, receipt)
            .await
            .map_err(ApiError::channel)?,
    ))
}
