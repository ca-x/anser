//! SMTP delivery with enforced TLS and network-policy-aware DNS resolution.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use anser_channel_http::{plain_body, resolve_host, truncate};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use lettre::message::{Mailbox, header::ContentType};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde::Deserialize;
use serde_json::{Value, json};

const TITLE_LIMIT: usize = 200;
const BODY_LIMIT: usize = 64 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct Email;

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Encryption {
    #[default]
    Starttls,
    Tls,
    None,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    host: String,
    port: Option<u16>,
    #[serde(default)]
    encryption: Encryption,
    username: Option<String>,
    password: Option<String>,
    from: String,
    to: Vec<String>,
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let mut config: Self =
            serde_json::from_value(value.clone()).map_err(|_| invalid_config())?;
        if let Ok(ip) = config.host.parse::<IpAddr>() {
            config.host = ip.to_string();
        } else {
            let host = url::Host::parse(&config.host).map_err(|_| invalid_config())?;
            config.host = match host {
                url::Host::Domain(host)
                    if !host.is_empty()
                        && host.split('.').all(|label| {
                            !label.is_empty()
                                && label
                                    .as_bytes()
                                    .iter()
                                    .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
                        }) =>
                {
                    host
                }
                url::Host::Ipv4(ip) => ip.to_string(),
                url::Host::Ipv6(ip) => ip.to_string(),
                _ => return Err(invalid_config()),
            };
        }

        if config.port == Some(0) || config.to.is_empty() || config.to.len() > 100 {
            return Err(invalid_config());
        }
        match (&config.username, &config.password) {
            (None, None) => {}
            (Some(username), Some(password))
                if !username.is_empty()
                    && !password.is_empty()
                    && config.encryption != Encryption::None => {}
            _ => return Err(invalid_config()),
        }
        mailbox(&config.from)?;
        for address in &config.to {
            mailbox(address)?;
        }
        Ok(config)
    }

    fn port(&self) -> u16 {
        self.port.unwrap_or(match self.encryption {
            Encryption::Starttls => 587,
            Encryption::Tls => 465,
            Encryption::None => 25,
        })
    }

    fn transport(
        &self,
        address: SocketAddr,
    ) -> Result<AsyncSmtpTransport<Tokio1Executor>, SendError> {
        let tls = match self.encryption {
            Encryption::Starttls => Tls::Required(self.tls_parameters()?),
            Encryption::Tls => Tls::Wrapper(self.tls_parameters()?),
            Encryption::None => Tls::None,
        };
        // Connect to the exact address selected by policy. Rustls independently
        // verifies the original SMTP host as the peer identity.
        let mut builder =
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(address.ip().to_string())
                .port(address.port())
                .tls(tls)
                .timeout(Some(SEND_TIMEOUT));
        if let (Some(username), Some(password)) = (&self.username, &self.password) {
            builder = builder.credentials(Credentials::new(username.clone(), password.clone()));
        }
        Ok(builder.build())
    }

    fn tls_parameters(&self) -> Result<TlsParameters, SendError> {
        TlsParameters::builder(self.host.clone())
            .build_rustls()
            .map_err(|_| invalid_config())
    }
}

fn mailbox(value: &str) -> Result<Mailbox, SendError> {
    if value.contains(['\r', '\n']) {
        return Err(invalid_config());
    }
    value.parse().map_err(|_| invalid_config())
}

fn invalid_config() -> SendError {
    SendError::new(
        "smtp_invalid_config",
        "provide a valid SMTP host, port, encryption and mail addresses; credentials require TLS",
        false,
    )
}

impl ChannelService for Email {
    fn id(&self) -> &'static str {
        "email"
    }

    fn display_name(&self) -> &'static str {
        "SMTP 邮件"
    }

    fn config_schema(&self) -> Value {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "host": {"type": "string", "minLength": 1},
                "port": {"type": "integer", "minimum": 1, "maximum": 65535},
                "encryption": {"type": "string", "enum": ["starttls", "tls", "none"], "default": "starttls"},
                "username": {"type": "string", "minLength": 1},
                "password": {"type": "string", "minLength": 1, "writeOnly": true, "format": "password"},
                "from": {"type": "string", "minLength": 1},
                "to": {"type": "array", "minItems": 1, "maxItems": 100, "items": {"type": "string", "minLength": 1}}
            },
            "required": ["host", "from", "to"],
            "dependentRequired": {"username": ["password"], "password": ["username"]},
            "additionalProperties": false
        })
    }

    fn validate_config(&self, config: &Value) -> Result<(), SendError> {
        Config::parse(config).map(|_| ())
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![
                MessageFormat::Text,
                MessageFormat::Markdown,
                MessageFormat::Html,
            ],
            max_title_chars: Some(TITLE_LIMIT as u32),
            max_body_chars: Some(BODY_LIMIT as u32),
            attachments: false,
            user_target: true,
        }
    }

    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            let config = Config::parse(&account.config)?;
            let address = resolve_host(&config.host, config.port())
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    SendError::new("smtp_no_address", "SMTP host has no address", true)
                })?;
            deliver(&config, address, message).await
        })
    }
}

async fn deliver(
    config: &Config,
    address: SocketAddr,
    message: &Message,
) -> Result<SendOutcome, SendError> {
    let email = build_email(config, message)?;
    let transport = config.transport(address)?;
    tokio::time::timeout(SEND_TIMEOUT, transport.send(email))
        .await
        .map_err(|_| SendError::new("smtp_timeout", "SMTP delivery timed out", true))?
        .map_err(smtp_error)?;
    Ok(SendOutcome::Delivered)
}

fn build_email(config: &Config, message: &Message) -> Result<lettre::Message, SendError> {
    let subject = truncate(&message.title.replace(['\r', '\n'], " "), TITLE_LIMIT);
    let mut builder = lettre::Message::builder()
        .from(mailbox(&config.from)?)
        .subject(subject);
    for address in &config.to {
        builder = builder.to(mailbox(address)?);
    }
    let (content_type, body) = match message.format {
        MessageFormat::Html => (ContentType::TEXT_HTML, truncate(&message.body, BODY_LIMIT)),
        MessageFormat::Text | MessageFormat::Markdown => {
            (ContentType::TEXT_PLAIN, plain_body(message, BODY_LIMIT))
        }
    };
    builder.header(content_type).body(body).map_err(|_| {
        SendError::new(
            "smtp_invalid_message",
            "could not format SMTP message",
            false,
        )
    })
}

fn smtp_error(error: lettre::transport::smtp::Error) -> SendError {
    match error.status() {
        Some(code) => SendError::new(
            &format!("smtp_{code}"),
            "SMTP relay rejected the command",
            error.is_transient(),
        ),
        None => SendError::new(
            "smtp_transport",
            "could not communicate with the SMTP relay",
            true,
        ),
    }
}

#[cfg(test)]
mod tests;
