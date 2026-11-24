//! SMTP delivery with enforced TLS and network-policy-aware DNS resolution.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use anser_channel_http::{plain_body, resolve_host, truncate};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use lettre::message::{Mailbox, MultiPart, header::ContentType};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde::Deserialize;
use serde_json::{Value, json};

mod template;

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

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EmailStyle {
    #[default]
    Styled,
    Plain,
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
    from_name: Option<String>,
    to: Vec<String>,
    #[serde(default)]
    email_style: EmailStyle,
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
        config.sender()?;
        for address in &config.to {
            mailbox(address)?;
        }
        Ok(config)
    }

    fn sender(&self) -> Result<Mailbox, SendError> {
        let mut sender = mailbox(&self.from)?;
        if let Some(name) = &self.from_name {
            if name.chars().count() > 128 || name.chars().any(char::is_control) {
                return Err(invalid_config());
            }
            let name = name.trim();
            sender.name = (!name.is_empty()).then(|| name.to_owned());
        }
        Ok(sender)
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

fn smtp_preset(
    id: &str,
    labels: (&str, &str),
    transport: (&str, u16, &str),
    hints: (&str, &str),
) -> Value {
    let (host, port, encryption) = transport;
    json!({
        "id":id, "label":{"en":labels.0,"zh-CN":labels.1},
        "description":{"en":hints.0,"zh-CN":hints.1},
        "values":{"host":host,"port":port,"encryption":encryption}
    })
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
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type": "object",
            "x-anser-ui": {"label":{"en":"SMTP email","zh-CN":"SMTP 邮件"},
                "account_editor": {"fields":["host","port","encryption","username","from","from_name","to","email_style"],"credentials":{"password":["host","port","encryption","username"]}},
                "presets": [
                    smtp_preset("qq", ("QQ Mail", "QQ 邮箱"), ("smtp.qq.com", 465, "tls"), ("Use an SMTP authorization code.", "请使用 SMTP 授权码。")),
                    smtp_preset("163", ("NetEase 163", "网易 163 邮箱"), ("smtp.163.com", 465, "tls"), ("Use the client authorization code.", "请使用客户端授权码。")),
                    smtp_preset("126", ("NetEase 126", "网易 126 邮箱"), ("smtp.126.com", 465, "tls"), ("Use the client authorization code.", "请使用客户端授权码。")),
                    smtp_preset("tencent_exmail", ("Tencent Exmail", "腾讯企业邮"), ("smtp.exmail.qq.com", 465, "tls"), ("Use a client password if required by your organization.", "如组织要求，请使用客户端专用密码。")),
                    smtp_preset("gmail", ("Gmail", "Gmail"), ("smtp.gmail.com", 465, "tls"), ("Use a Google app password with 2-step verification enabled.", "开启两步验证后，使用 Google 应用专用密码。")),
                    smtp_preset("icloud", ("iCloud Mail", "iCloud 邮件"), ("smtp.mail.me.com", 587, "starttls"), ("Use an Apple app-specific password.", "请使用 Apple 应用专用密码。")),
                    smtp_preset("yahoo", ("Yahoo Mail", "Yahoo 邮箱"), ("smtp.mail.yahoo.com", 465, "tls"), ("Use a Yahoo app password.", "请使用 Yahoo 应用专用密码。"))
                ]
            },
            "properties": {
                "host": {"x-anser-ui":{"label":{"en":"SMTP host","zh-CN":"SMTP 主机"}},"type": "string", "minLength": 1},
                "port": {"x-anser-ui":{"label":{"en":"SMTP port","zh-CN":"SMTP 端口"}},"type": "integer", "minimum": 1, "maximum": 65535},
                "encryption": {"x-anser-ui":{"label":{"en":"Connection encryption","zh-CN":"连接加密"},"option_labels":{"none":{"en":"None","zh-CN":"无加密"},"starttls":{"en":"STARTTLS","zh-CN":"STARTTLS"},"tls":{"en":"TLS","zh-CN":"TLS"}}},"type": "string", "enum": ["starttls", "tls", "none"], "default": "starttls"},
                "username": {"x-anser-ui":{"label":{"en":"Username","zh-CN":"用户名"}},"type": "string", "minLength": 1},
                "password": {"x-anser-ui":{"label":{"en":"Password","zh-CN":"密码"}},"type": "string", "minLength": 1, "writeOnly": true, "format": "password"},
                "from": {"x-anser-ui":{"label":{"en":"Sender address","zh-CN":"发件地址"}},"type": "string", "minLength": 1},
                "from_name": {"type": "string", "maxLength": 128, "x-anser-ui": {
                    "label": {"en":"Sender display name", "zh-CN":"发件人显示名称"},
                    "description": {"en":"Shown beside the From address in most mail apps.", "zh-CN":"显示在邮件的发件人地址旁。"}
                }},
                "to": {"x-anser-ui":{"label":{"en":"Recipient addresses","zh-CN":"收件地址列表"}},"type": "array", "minItems": 1, "maxItems": 100, "items": {"type": "string", "minLength": 1}},
                "email_style": {"type": "string", "enum": ["styled", "plain"], "default": "styled", "x-anser-ui": {
                    "label": {"en":"Email style", "zh-CN":"邮件样式"},
                    "description": {"en":"Applies to text and Markdown notifications. HTML messages keep their own layout.", "zh-CN":"适用于文本和 Markdown 通知。HTML 消息沿用其原有排版。"},
                    "option_labels": {
                        "styled": {"en":"Anser template", "zh-CN":"雁字模板"},
                        "plain": {"en":"Plain text", "zh-CN":"纯文本"}
                    }
                }}
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
        .from(config.sender()?)
        .subject(&subject);
    for address in &config.to {
        builder = builder.to(mailbox(address)?);
    }
    match message.format {
        MessageFormat::Html => builder
            .header(ContentType::TEXT_HTML)
            .body(truncate(&message.body, BODY_LIMIT)),
        MessageFormat::Text | MessageFormat::Markdown => {
            let text = plain_body(message, BODY_LIMIT);
            match config.email_style {
                EmailStyle::Plain => builder.header(ContentType::TEXT_PLAIN).body(text),
                EmailStyle::Styled => {
                    let html = template::render(&subject, &text).map_err(|_| invalid_message())?;
                    builder.multipart(MultiPart::alternative_plain_html(text, html))
                }
            }
        }
    }
    .map_err(|_| invalid_message())
}

fn invalid_message() -> SendError {
    SendError::new(
        "smtp_invalid_message",
        "could not format SMTP message",
        false,
    )
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
