use std::sync::Arc;
use std::time::Duration;

use anser_core::Message;
use anser_mcd::{Form, Reply};
use anser_store::interactions::{InboxInteraction, Interaction, NewInteraction};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};

use crate::api::{App, validate_message};
use crate::auth::{Identity, valid_username};
use crate::error::{ApiError, ApiJson, ApiPath, ApiResult};

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct Ask {
    /// Username of the Anser account that will receive the question.
    recipient: String,
    title: String,
    #[serde(default)]
    body: String,
    /// MCD button and/or input blocks.
    mcd: Option<String>,
    /// Structured form as an alternative to MCD.
    form: Option<Form>,
    /// Defaults to 3,600 seconds. Maximum 86,400 seconds.
    expires_in_seconds: Option<u32>,
    /// Optional stable key to reuse when retrying this submission.
    request_key: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct Status<T> {
    status: &'static str,
    #[serde(flatten)]
    data: T,
}

pub(crate) fn authorize(identity: &Identity) -> ApiResult<()> {
    identity.require("interact")?;
    identity.topic(None)
}

pub(crate) async fn ask(
    app: &App,
    identity: &Identity,
    input: Ask,
) -> ApiResult<Status<Interaction>> {
    authorize(identity)?;
    let recipient = input.recipient.trim();
    if !valid_username(recipient) {
        return Err(ApiError::bad("Invalid recipient"));
    }
    let expires = input.expires_in_seconds.unwrap_or(3600);
    if !(1..=86_400).contains(&expires) {
        return Err(ApiError::bad(
            "Interaction expiry must be between 1 and 86400 seconds",
        ));
    }
    if input.request_key.as_ref().is_some_and(|key| {
        key.is_empty() || key.len() > 128 || !key.bytes().all(|byte| byte.is_ascii_graphic())
    }) {
        return Err(ApiError::bad("Invalid interaction request key"));
    }
    let form = match (input.mcd, input.form) {
        (Some(source), None) => Form::parse(&source),
        (None, Some(form)) => form.validate().map(|()| form),
        _ => return Err(ApiError::bad("Provide either mcd or form")),
    }
    .map_err(|_| ApiError::bad("Invalid or unsupported MCD interaction"))?;
    let message = Message {
        title: input.title,
        body: input.body,
        ..Message::default()
    };
    validate_message(&message)?;
    let data = app
        .store
        .create_interaction(NewInteraction {
            key_id: &identity.key_id,
            sender: identity.user.as_ref().map(|user| user.username.as_str()),
            recipient,
            message: &message,
            request_key: input.request_key.as_deref(),
            form: &form,
            expires_in_ms: i64::from(expires) * 1000,
            retention_ms: app.retention_ms,
        })
        .await?;
    app.inbox_wakeup.notify_waiters();
    Ok(status(data))
}

static WAITERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(128);

pub(crate) async fn result(
    app: &App,
    identity: &Identity,
    id: &str,
    wait_seconds: u8,
) -> ApiResult<Status<Interaction>> {
    authorize(identity)?;
    if wait_seconds > 20 {
        return Err(ApiError::bad("Wait cannot exceed 20 seconds"));
    }
    let wait_until = tokio::time::Instant::now() + Duration::from_secs(u64::from(wait_seconds));
    let mut permit = None;
    loop {
        let notice = app.interaction_wakeup.notified();
        tokio::pin!(notice);
        notice.as_mut().enable();
        let data = app.store.interaction(&identity.key_id, id).await?;
        let state = data.status();
        if state != "pending" || tokio::time::Instant::now() >= wait_until {
            return Ok(Status {
                status: state,
                data,
            });
        }
        if permit.is_none() {
            permit = Some(WAITERS.try_acquire().map_err(|_| ApiError::limited())?);
        }
        let remaining =
            u64::try_from(data.expires_at.saturating_sub(anser_store::now_ms())).unwrap_or(0);
        let deadline =
            wait_until.min(tokio::time::Instant::now() + Duration::from_millis(remaining));
        let _ = tokio::time::timeout_at(deadline, notice).await;
    }
}

pub(crate) async fn create(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(input): ApiJson<Ask>,
) -> ApiResult<(StatusCode, Json<Status<Interaction>>)> {
    Ok((
        StatusCode::CREATED,
        Json(ask(&app, &identity, input).await?),
    ))
}

pub(crate) async fn read(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<Status<Interaction>>> {
    Ok(Json(result(&app, &identity, &id, 0).await?))
}

pub(crate) async fn inbox_form(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<i64>,
) -> ApiResult<Json<Status<InboxInteraction>>> {
    let data = app
        .store
        .inbox_interaction(&identity.session_user()?.id, id)
        .await?;
    Ok(Json(Status {
        status: data.interaction.status(),
        data,
    }))
}

pub(crate) async fn inbox_reply(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<i64>,
    ApiJson(reply): ApiJson<Reply>,
) -> ApiResult<Json<Status<Interaction>>> {
    let data = app
        .store
        .reply_to_interaction(&identity.session_user()?.id, id, &reply)
        .await?;
    app.interaction_wakeup.notify_waiters();
    Ok(Json(status(data)))
}

fn status(data: Interaction) -> Status<Interaction> {
    Status {
        status: data.status(),
        data,
    }
}
