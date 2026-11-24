//! A speech notification stores one audio snapshot and reuses normal delivery.

use std::sync::Arc;

use anser_core::Message;
use anser_core::api::{DEFAULT_AUDIO_RETENTION_DAYS, Publish, Receipt, audio_retention_ms};
use anser_store::speech::SpeechWrite;
use anser_store::users::InboxSpeech;
use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::api::{App, Wait, enqueue_prepared, idempotency_key};
use crate::auth::{Identity, random_secret};
use crate::error::{ApiError, ApiJson, ApiPath, ApiResult};

static AUDIO_READERS: Semaphore = Semaphore::const_new(16);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Input {
    config: Option<Value>,
    config_revision: Option<String>,
    message: Message,
    destination: Destination,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Destination {
    Inbox { username: String },
    Topic { name: String },
    Channels,
}

pub(crate) async fn send(
    State(app): State<Arc<App>>,
    identity: Identity,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Input>,
) -> ApiResult<(StatusCode, Json<Receipt>)> {
    identity.admin_global()?;
    let key = idempotency_key(&headers)?;
    let inbox = matches!(input.destination, Destination::Inbox { .. });
    let status = if inbox {
        StatusCode::CREATED
    } else {
        StatusCode::ACCEPTED
    };
    if let Some(key) = key
        && let Some(receipt) = app
            .store
            .speech_receipt(&identity.key_id, key, inbox)
            .await?
    {
        return Ok((status, Json(receipt)));
    }
    let external = match &input.destination {
        Destination::Inbox { username } => {
            if username.trim().is_empty() || username.len() > 64 {
                return Err(ApiError::bad("Invalid recipient"));
            }
            if !app.store.user_named(username).await?.enabled {
                return Err(anser_store::DataError::Missing.into());
            }
            false
        }
        Destination::Topic { name } => {
            // Reject unknown or disabled topics before calling the speech provider.
            if !app.store.topic(name).await?.enabled {
                return Err(ApiError::bad("The topic is disabled"));
            }
            true
        }
        Destination::Channels => true,
    };
    let (message, speech) = synthesize(
        &app,
        input.message,
        input.config,
        input.config_revision.as_deref(),
        external,
    )
    .await?;

    if let Destination::Inbox { username } = input.destination {
        let receipt = app
            .store
            .send_inbox_with_speech(
                &identity.key_id,
                identity.user.as_ref().map(|user| user.username.as_str()),
                &username,
                InboxSpeech {
                    message: &message,
                    speech: Some(speech),
                },
                key,
                app.retention_ms,
            )
            .await?;
        app.inbox_wakeup.notify_waiters();
        return Ok((
            StatusCode::CREATED,
            Json(Receipt {
                message_id: receipt.message_id,
                status: "success".into(),
            }),
        ));
    }
    let topic = match input.destination {
        Destination::Topic { ref name } => Some(name.as_str()),
        _ => None,
    };
    enqueue_prepared(
        &app,
        &identity,
        topic,
        Wait::default(),
        &headers,
        Publish {
            message,
            ..Publish::default()
        }
        .into(),
        Some(speech),
    )
    .await
}

pub(crate) async fn synthesize(
    app: &App,
    message: Message,
    config: Option<Value>,
    config_revision: Option<&str>,
    external: bool,
) -> ApiResult<(Message, SpeechWrite)> {
    crate::api::validate_message(&message)?;
    let mut config =
        crate::transform_settings::resolve(app, "openai-tts", config, config_revision).await?;
    let fields = config
        .as_object_mut()
        .ok_or_else(|| ApiError::bad("Plugin configuration must be a JSON object"))?;
    let retention_days = fields
        .get("audio_retention_days")
        .filter(|value| !value.is_null())
        .map_or(Some(DEFAULT_AUDIO_RETENTION_DAYS), |value| {
            value.as_u64().and_then(|days| u16::try_from(days).ok())
        });
    let retention_ms = retention_days
        .and_then(audio_retention_ms)
        .ok_or_else(|| ApiError::bad("Audio retention must be between 1 and 365 days"))?;
    fields.insert("response_format".into(), "mp3".into());
    let speech = SpeechWrite {
        token: random_secret().to_string(),
        bytes: Vec::new(),
        retention_ms,
    };
    let link = if external {
        Some(public_link(app, &speech)?)
    } else {
        None
    };
    let output = crate::plugins::transform_message(app, "openai-tts", config, message).await?;
    let artifact = output
        .artifacts
        .into_iter()
        .next()
        .filter(|artifact| artifact.content_type == "audio/mpeg")
        .ok_or_else(ApiError::internal)?;
    let speech = SpeechWrite {
        bytes: STANDARD
            .decode(artifact.content_base64)
            .map_err(|_| ApiError::internal())?,
        ..speech
    };
    let mut message = output.message;
    if let Some(link) = link {
        // Keep audio available on channels that omit Message.url.
        let body = anser_channel_http::plain_body(&message, 4096);
        message.body = format!("{link}\n\n{body}");
        message.format = anser_core::MessageFormat::Text;
        if message.url.is_none() {
            message.url = Some(link);
        }
    }
    Ok((message, speech))
}

fn public_link(app: &App, speech: &SpeechWrite) -> ApiResult<String> {
    let url = app
        .public_url
        .as_deref()
        .and_then(|value| reqwest::Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "https"
                && url.host().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url.path() == "/"
        })
        .ok_or_else(|| {
            ApiError::bad(
                "Configure an HTTPS ANSER_PUBLIC_URL before sending speech to topics or channels",
            )
        })?;
    Ok(format!(
        "{}{}",
        url.origin().ascii_serialization(),
        speech.path()
    ))
}

pub(crate) async fn media(
    State(app): State<Arc<App>>,
    ApiPath(file): ApiPath<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let token = file
        .strip_suffix(".mp3")
        .filter(|value| {
            value.len() == 43
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        })
        .ok_or(anser_store::DataError::Missing)?;
    let permit = AUDIO_READERS
        .try_acquire()
        .map_err(|_| ApiError::limited())?;
    let audio = Bytes::from(app.store.speech_audio(token).await?);
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    Ok(media_reply(audio, range, permit))
}

fn media_reply(audio: Bytes, range: Option<&str>, permit: SemaphorePermit<'static>) -> Response {
    let len = audio.len();
    let (status, body, content_range) = match range {
        None => (StatusCode::OK, audio, None),
        Some(value) => match byte_range(value, len) {
            Some((start, end)) => (
                StatusCode::PARTIAL_CONTENT,
                audio.slice(start..=end),
                Some(format!("bytes {start}-{end}/{len}")),
            ),
            None => (
                StatusCode::RANGE_NOT_SATISFIABLE,
                Bytes::new(),
                Some(format!("bytes */{len}")),
            ),
        },
    };
    let length = body.len();
    let chunks = futures_util::stream::unfold((body, permit), |(mut bytes, permit)| async move {
        if bytes.is_empty() {
            return None;
        }
        let chunk = bytes.split_to(bytes.len().min(64 * 1024));
        Some((Ok::<_, std::convert::Infallible>(chunk), (bytes, permit)))
    });
    let mut reply = (
        status,
        [
            (header::CONTENT_TYPE, "audio/mpeg"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::ACCEPT_RANGES, "bytes"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Body::from_stream(chunks),
    )
        .into_response();
    reply
        .headers_mut()
        .insert(header::CONTENT_LENGTH, length.into());
    if let Some(value) = content_range {
        reply.headers_mut().insert(
            header::CONTENT_RANGE,
            value.parse().expect("numeric byte range"),
        );
    }
    reply
}

fn byte_range(range: &str, len: usize) -> Option<(usize, usize)> {
    let (start, end) = range.strip_prefix("bytes=")?.split_once('-')?;
    let last = len.checked_sub(1)?;
    if start.is_empty() {
        let suffix: usize = end.parse().ok()?;
        return (suffix > 0).then_some((len.saturating_sub(suffix), last));
    }
    let start: usize = start.parse().ok()?;
    let end = if end.is_empty() {
        last
    } else {
        end.parse::<usize>().ok()?.min(last)
    };
    (start <= end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_single_byte_range_for_media_players() {
        assert_eq!(byte_range("bytes=0-", 12), Some((0, 11)));
        assert_eq!(byte_range("bytes=1-2", 12), Some((1, 2)));
        assert_eq!(byte_range("bytes=-4", 12), Some((8, 11)));
        assert_eq!(byte_range("bytes=1-10,11-12", 12), None);
        assert_eq!(byte_range("bytes=12-", 12), None);
    }
}
