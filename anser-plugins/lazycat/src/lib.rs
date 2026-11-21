//! LazyCat application-to-device notifications.

#![cfg(unix)]

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use lzc_sdk::proto::common::{EndDevice, ListEndDeviceRequest};
use lzc_sdk::proto::localdevice::{
    NotifyRequest, notification_service_client::NotificationServiceClient,
};
use lzc_sdk::{ApiGateway, ClientCredentials, CredentialPaths, TokenProvider, with_real_uid};
use pulldown_cmark::{Event, Options, Parser, TagEnd};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, OnceCell};
use tonic::transport::{Certificate, ClientTlsConfig, Endpoint, Identity};
use tonic::{Code, Request};
use url::Url;
use zeroize::Zeroizing;

const TITLE_LIMIT: u32 = 80;
const BODY_LIMIT: u32 = 240;
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CACHED_DEVICES: usize = 256;

#[derive(Default)]
pub struct Lazycat {
    runtime: OnceCell<Runtime>,
}

struct Runtime {
    gateway: ApiGateway,
    credentials: ClientCredentials,
    devices: Mutex<HashMap<String, Arc<TokenProvider>>>,
    device_tls: Option<ClientTlsConfig>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    user_id: String,
    device_id: String,
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = serde_json::from_value(value.clone()).map_err(|_| invalid_config())?;
        if [&config.user_id, &config.device_id].iter().any(|id| {
            id.is_empty() || id.len() > 256 || !id.bytes().all(|byte| byte.is_ascii_graphic())
        }) {
            return Err(invalid_config());
        }
        Ok(config)
    }
}

fn invalid_config() -> SendError {
    SendError::new(
        "lazycat_invalid_config",
        "provide a valid user_id and device_id",
        false,
    )
}

impl ChannelService for Lazycat {
    fn id(&self) -> &'static str {
        "lazycat"
    }

    fn display_name(&self) -> &'static str {
        "懒猫微服通知"
    }

    fn config_schema(&self) -> Value {
        let id = json!({"type": "string", "minLength": 1, "maxLength": 256, "pattern": "^[!-~]+$"});
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {"user_id": id, "device_id": id},
            "required": ["user_id", "device_id"],
            "additionalProperties": false
        })
    }

    fn validate_config(&self, config: &Value) -> Result<(), SendError> {
        Config::parse(config).map(|_| ())
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text, MessageFormat::Markdown],
            max_title_chars: Some(TITLE_LIMIT),
            max_body_chars: Some(BODY_LIMIT),
            attachments: false,
            user_target: true,
        }
    }

    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            let config = Config::parse(&account.config)?;
            let request = notification(message)?;
            tokio::time::timeout(TIMEOUT, self.deliver(config, request))
                .await
                .map_err(|_| {
                    SendError::new("lazycat_timeout", "LazyCat delivery timed out", true)
                })??;
            // A successful Notify RPC means the device accepted the notification.
            Ok(SendOutcome::Delivered)
        })
    }
}

impl Lazycat {
    async fn deliver(&self, config: Config, request: NotifyRequest) -> Result<(), SendError> {
        let runtime = self
            .runtime
            .get_or_try_init(|| async {
                let paths = CredentialPaths::runtime();
                let legacy =
                    std::env::var_os("ANSER_LAZYCAT_LEGACY_TLS").is_some_and(|value| value == "1");
                let device_tls = if legacy {
                    None
                } else {
                    if std::env::var_os("LZCAPP_API_GATEWAY_ADDRESS")
                        .is_some_and(|value| !value.is_empty())
                    {
                        return Err(SendError::new(
                            "lazycat_insecure_gateway",
                            "the LazyCat gateway address override requires legacy compatibility",
                            false,
                        ));
                    }
                    let ca = std::env::var_os("ANSER_LAZYCAT_DEVICE_CA")
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| paths.box_certificate.clone());
                    Some(verified_tls(&paths, &ca).await?)
                };
                let credentials = ClientCredentials::load(paths).await.map_err(sdk_error)?;
                let gateway = ApiGateway::connect_with(credentials.clone())
                    .await
                    .map_err(sdk_error)?;
                Ok(Runtime {
                    gateway,
                    credentials,
                    devices: Mutex::new(HashMap::new()),
                    device_tls,
                })
            })
            .await?;

        let mut list_request = Request::new(ListEndDeviceRequest {
            uid: config.user_id.clone(),
        });
        with_real_uid(&mut list_request, &config.user_id).map_err(sdk_error)?;
        let devices = runtime
            .gateway
            .devices()
            .list_end_devices(list_request)
            .await
            .map_err(|status| grpc_error(status.code()))?
            .into_inner()
            .devices;

        let address = device_address(&devices, &config.device_id)?;
        let provider = runtime.provider(address).await?;
        if let Err(error) = notify(&provider, request.clone()).await {
            if error.code != "lazycat_auth_expired" {
                return Err(error);
            }
            let mut devices = runtime.devices.lock().await;
            if devices
                .get(address)
                .is_some_and(|current| Arc::ptr_eq(current, &provider))
            {
                devices.remove(address);
            }
            drop(devices);
            // Retry only an explicit authentication rejection, which did not send a notification.
            let provider = runtime.provider(address).await?;
            notify(&provider, request).await?;
        }
        Ok(())
    }
}

async fn notify(provider: &TokenProvider, request: NotifyRequest) -> Result<(), SendError> {
    // Fetch the token first so SDK authentication errors retain their status.
    provider.token().await.map_err(sdk_error)?;
    NotificationServiceClient::new(provider.authenticated_service())
        .notify(request)
        .await
        .map_err(|status| {
            if status.code() == Code::Unauthenticated {
                SendError::new(
                    "lazycat_auth_expired",
                    "device rejected the LazyCat authorization token",
                    false,
                )
            } else {
                grpc_error(status.code())
            }
        })?;
    Ok(())
}

impl Runtime {
    async fn provider(&self, address: &str) -> Result<Arc<TokenProvider>, SendError> {
        if let Some(provider) = self.devices.lock().await.get(address).cloned() {
            return Ok(provider);
        }
        let provider = match &self.device_tls {
            Some(tls) => {
                let channel = verified_endpoint(address, tls.clone())?
                    .connect()
                    .await
                    .map_err(|_| {
                        SendError::new(
                            "lazycat_device_tls",
                            "could not establish verified TLS to the LazyCat device",
                            true,
                        )
                    })?;
                TokenProvider::new(channel, self.credentials.clone())
            }
            None => TokenProvider::connect(address, self.credentials.clone())
                .await
                .map_err(sdk_error)?,
        };
        let mut devices = self.devices.lock().await;
        if let Some(existing) = devices.get(address) {
            return Ok(existing.clone());
        }
        let provider = Arc::new(provider);
        if devices.len() < MAX_CACHED_DEVICES {
            devices.insert(address.to_owned(), provider.clone());
        }
        Ok(provider)
    }
}

async fn verified_tls(
    paths: &CredentialPaths,
    ca_path: &std::path::Path,
) -> Result<ClientTlsConfig, SendError> {
    let ca = tokio::fs::read(ca_path)
        .await
        .map_err(|_| credential_error())?;
    let cert = tokio::fs::read(&paths.application_certificate)
        .await
        .map_err(|_| credential_error())?;
    let key = Zeroizing::new(
        tokio::fs::read(&paths.application_private_key)
            .await
            .map_err(|_| credential_error())?,
    );
    Ok(ClientTlsConfig::new()
        .ca_certificate(Certificate::from_pem(ca))
        .identity(Identity::from_pem(cert, &*key)))
}

fn verified_endpoint(address: &str, tls: ClientTlsConfig) -> Result<Endpoint, SendError> {
    let invalid_address = || {
        SendError::new(
            "lazycat_device_address",
            "invalid LazyCat device API address",
            false,
        )
    };
    let url = Url::parse(address).map_err(|_| invalid_address())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid_address());
    }
    let host = url.host().ok_or_else(invalid_address)?;
    let port = url.port_or_known_default().ok_or_else(invalid_address)?;
    Endpoint::from_shared(format!("https://{host}:{port}"))
        .and_then(|endpoint| endpoint.tls_config(tls))
        .map_err(|_| invalid_address())
}

fn credential_error() -> SendError {
    SendError::new(
        "lazycat_runtime_config",
        "check LazyCat application credentials and runtime configuration",
        false,
    )
}

fn device_address<'a>(devices: &'a [EndDevice], id: &str) -> Result<&'a str, SendError> {
    let device = devices
        .iter()
        .find(|device| device.unique_deivce_id == id)
        .ok_or_else(|| {
            SendError::new(
                "lazycat_device_not_found",
                "device is not registered for the user",
                false,
            )
        })?;
    let address = device.device_api_url.trim();
    if !device.is_online || address.is_empty() {
        return Err(SendError::new(
            "lazycat_device_unavailable",
            "device is offline or its API is unavailable",
            true,
        ));
    }
    Ok(address)
}

fn notification(message: &Message) -> Result<NotifyRequest, SendError> {
    let text = match message.format {
        MessageFormat::Text => Cow::Borrowed(message.body.as_str()),
        MessageFormat::Markdown => {
            let mut text = String::new();
            for event in Parser::new_ext(&message.body, Options::empty()) {
                match event {
                    Event::Text(part) | Event::Code(part) => text.push_str(&part),
                    Event::SoftBreak
                    | Event::HardBreak
                    | Event::End(TagEnd::Paragraph | TagEnd::Item | TagEnd::Heading(_)) => {
                        text.push('\n')
                    }
                    _ => {}
                }
                if text.len() >= BODY_LIMIT as usize * 4 {
                    break;
                }
            }
            Cow::Owned(text)
        }
        MessageFormat::Html => {
            return Err(SendError::new(
                "lazycat_unsupported_format",
                "use text or Markdown",
                false,
            ));
        }
    };
    let title = limit(&message.title, TITLE_LIMIT);
    let title = if title.is_empty() {
        limit(
            text.trim_start().lines().next().unwrap_or_default(),
            TITLE_LIMIT,
        )
    } else {
        title
    };
    if title.is_empty() {
        return Err(SendError::new(
            "lazycat_invalid_message",
            "notification needs a title or a line of readable text",
            false,
        ));
    }
    Ok(NotifyRequest {
        title,
        body: limit(&text, BODY_LIMIT),
        deeplink_url: None,
    })
}

fn limit(value: &str, max_chars: u32) -> String {
    let mut text = String::new();
    let mut pending_space = false;
    let mut count = 0;
    for ch in value.chars() {
        if ch.is_whitespace() {
            pending_space = !text.is_empty();
        } else if !ch.is_control() {
            if pending_space {
                text.push(' ');
                count += 1;
                pending_space = false;
            }
            text.push(ch);
            count += 1;
            if count > max_chars {
                // Include an ellipsis within the provider's character limit.
                return text
                    .chars()
                    .take(max_chars as usize - 1)
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
                    + "…";
            }
        }
    }
    text
}

fn sdk_error(error: lzc_sdk::Error) -> SendError {
    match error {
        lzc_sdk::Error::GrpcStatus(status) => grpc_error(status.code()),
        lzc_sdk::Error::Transport(_) => {
            SendError::new("lazycat_transport", "could not connect to LazyCat", true)
        }
        _ => credential_error(),
    }
}

fn grpc_error(code: Code) -> SendError {
    let (code, message, retryable) = match code {
        Code::Unauthenticated | Code::PermissionDenied => (
            "lazycat_auth",
            "LazyCat rejected the application identity or permissions",
            false,
        ),
        Code::InvalidArgument | Code::NotFound | Code::Unimplemented => (
            "lazycat_rejected",
            "LazyCat rejected the target or notification",
            false,
        ),
        Code::ResourceExhausted => ("lazycat_rate_limited", "LazyCat rate limit reached", true),
        Code::Cancelled
        | Code::Unavailable
        | Code::DeadlineExceeded
        | Code::Aborted
        | Code::Unknown
        | Code::Internal => (
            "lazycat_unavailable",
            "LazyCat temporarily failed to process the request",
            true,
        ),
        _ => ("lazycat_rejected", "LazyCat rejected the request", false),
    };
    SendError::new(code, message, retryable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_target_without_allowing_custom_urls() {
        let channel = Lazycat::default();
        assert!(
            channel
                .validate_config(&json!({"user_id": "alice", "device_id": "device-1"}))
                .is_ok()
        );
        assert!(channel.validate_config(&json!({"user_id": "alice", "device_id": "device-1", "url": "http://example.invalid"})).is_err());
        assert!(
            channel
                .validate_config(&json!({"user_id": "alice\n", "device_id": "device-1"}))
                .is_err()
        );
    }

    #[test]
    fn picks_only_the_configured_online_device() {
        let devices = [
            EndDevice {
                unique_deivce_id: "offline".into(),
                ..Default::default()
            },
            EndDevice {
                unique_deivce_id: "active".into(),
                is_online: true,
                device_api_url: "https://device.invalid".into(),
                ..Default::default()
            },
        ];
        assert_eq!(
            device_address(&devices, "active").unwrap(),
            "https://device.invalid"
        );
        assert!(!device_address(&devices, "missing").unwrap_err().retryable);
        assert!(device_address(&devices, "offline").unwrap_err().retryable);
    }

    #[test]
    fn renders_markdown_and_limits_unicode() {
        let result = notification(&Message {
            title: "雁".repeat(81),
            format: MessageFormat::Markdown,
            body: "**hello**\n\n[world](https://example.invalid)".into(),
            ..Message::default()
        })
        .unwrap();
        assert_eq!(result.title.chars().count(), 80);
        assert!(result.title.ends_with('…'));
        assert_eq!(result.body, "hello world");
    }

    #[test]
    fn classifies_provider_failures_without_echoing_provider_text() {
        let error = sdk_error(lzc_sdk::Error::GrpcStatus(
            tonic::Status::permission_denied("secret fixture"),
        ));
        assert!(!error.retryable);
        assert!(!error.to_string().contains("secret fixture"));
        assert!(grpc_error(Code::ResourceExhausted).retryable);
        assert!(grpc_error(Code::Unavailable).retryable);
    }
}

#[cfg(test)]
mod transport_test;
