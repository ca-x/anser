//! WeCom application notifications, including image upload and remote deduplication.

use anser_channel_http::{
    NetworkPolicy, client, client_with_policy, network_error, plain_body, response, status_error,
    token::TokenCache, truncate_bytes, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use reqwest::{Client, Url, multipart};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const BASE: &str = "https://qyapi.weixin.qq.com";
const TEXT_BYTES: usize = 2048;
const MARKDOWN_BYTES: usize = 4096;
const IMAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub struct Wecom {
    tokens: TokenCache,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    corpid: String,
    agentid: u64,
    secret: String,
    #[serde(default = "everyone")]
    touser: String,
    proxy: Option<String>,
}

fn everyone() -> String {
    "@all".into()
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = serde_json::from_value(value.clone()).map_err(|_| invalid_config())?;
        if config.corpid.is_empty()
            || config.corpid.len() > 128
            || !config
                .corpid
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            || config.agentid == 0
            || config.agentid > i32::MAX as u64
            || config.secret.trim().is_empty()
            || config.secret.len() > 512
            || config.touser.is_empty()
            || config.touser.len() > 2048
            || config.touser.split('|').any(|user| {
                user.is_empty() || user.chars().any(|ch| ch.is_whitespace() || ch.is_control())
            })
        {
            return Err(invalid_config());
        }
        validate_proxy(config.proxy.as_deref())?;
        Ok(config)
    }
}

fn invalid_config() -> SendError {
    SendError::new(
        "wecom_invalid_config",
        "provide valid corpid, agentid, secret and touser",
        false,
    )
}

impl ChannelService for Wecom {
    fn id(&self) -> &'static str {
        "wecom"
    }

    fn display_name(&self) -> &'static str {
        "企业微信应用"
    }

    fn config_schema(&self) -> Value {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "corpid":{"type":"string","minLength":1,"maxLength":128},
                "agentid":{"type":"integer","minimum":1,"maximum":2147483647},
                "secret":{"type":"string","minLength":1,"maxLength":512,"format":"password","writeOnly":true},
                "touser":{"type":"string","minLength":1,"maxLength":2048,"default":"@all"},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required": ["corpid", "agentid", "secret"],
            "additionalProperties":false
        })
    }

    fn validate_config(&self, config: &Value) -> Result<(), SendError> {
        Config::parse(config).map(|_| ())
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text, MessageFormat::Markdown],
            max_title_chars: None,
            max_body_chars: None,
            attachments: true,
            user_target: true,
        }
    }

    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            self.send_at(&Config::parse(&account.config)?, message, BASE, None)
                .await
        })
    }
}

impl Wecom {
    async fn send_at(
        &self,
        config: &Config,
        message: &Message,
        base: &str,
        policy: Option<&NetworkPolicy>,
    ) -> Result<SendOutcome, SendError> {
        let content = Content::prepare(message, config.proxy.as_deref(), policy).await?;
        let root = Url::parse(base).map_err(|_| invalid_config())?;
        let proxy = config.proxy.as_deref();
        let http = match policy {
            Some(policy) => client_with_policy(&root, proxy, policy).await?,
            None => client(&root, proxy).await?,
        };
        let key = token_key(base, config);
        let token = self
            .tokens
            .get(key, fetch_token(&http, &root, config))
            .await?;
        let result = attempt(&http, &root, config, &token, &content).await;
        if !matches!(&result, Err(error) if matches!(error.code.as_str(), "wecom_40001" | "wecom_40014" | "wecom_42001"))
        {
            return result;
        }

        self.tokens.expire(key, &token).await;
        let renewed = self
            .tokens
            .get(key, fetch_token(&http, &root, config))
            .await?;
        attempt(&http, &root, config, &renewed, &content).await
    }
}

fn token_key(base: &str, config: &Config) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in [
        base,
        &config.corpid,
        &config.secret,
        config.proxy.as_deref().unwrap_or(""),
    ] {
        hash.update(part.len().to_le_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

enum Content {
    Text(String),
    Markdown(String),
    Image {
        bytes: Vec<u8>,
        filename: String,
        mime: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageRequest {
    base64: String,
    filename: Option<String>,
    content_type: Option<String>,
}

impl Content {
    async fn prepare(
        message: &Message,
        proxy: Option<&str>,
        policy: Option<&NetworkPolicy>,
    ) -> Result<Self, SendError> {
        if let [attachment] = message.attachments.as_slice() {
            if message.extras.get("wecom_image").is_some() {
                return Err(invalid_image());
            }
            let url = Url::parse(&attachment.url).map_err(|_| invalid_image())?;
            let client = match policy {
                Some(policy) => client_with_policy(&url, proxy, policy).await?,
                None => {
                    anser_channel_http::request_destination_client(
                        &url,
                        "ANSER_ATTACHMENT_ALLOW_HOSTS",
                    )
                    .await?
                }
            };
            let mut response = client.get(url).send().await.map_err(network_error)?;
            if let Some(error) = status_error(&response) {
                return Err(error);
            }
            if response
                .content_length()
                .is_some_and(|length| length > IMAGE_BYTES as u64)
            {
                return Err(invalid_image());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network_error)? {
                if chunk.len() > IMAGE_BYTES - bytes.len() {
                    return Err(invalid_image());
                }
                bytes.extend_from_slice(&chunk);
            }
            return Self::image(
                bytes,
                attachment.name.clone(),
                attachment.content_type.clone(),
            );
        }
        if !message.attachments.is_empty() {
            return Err(invalid_image());
        }
        Self::parse(message)
    }

    fn image(
        bytes: Vec<u8>,
        filename: Option<String>,
        content_type: Option<String>,
    ) -> Result<Self, SendError> {
        if bytes.len() > IMAGE_BYTES {
            return Err(invalid_image());
        }
        let detected = match bytes.as_slice() {
            [0xff, 0xd8, 0xff, ..] => ("image/jpeg", "image.jpg"),
            [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => ("image/png", "image.png"),
            [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => ("image/gif", "image.gif"),
            _ => return Err(invalid_image()),
        };
        let mime = content_type.unwrap_or_else(|| detected.0.into());
        let filename = filename.unwrap_or_else(|| detected.1.into());
        if mime != detected.0
            || filename.is_empty()
            || filename.len() > 80
            || !filename
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err(invalid_image());
        }
        Ok(Self::Image {
            bytes,
            filename,
            mime,
        })
    }

    fn parse(message: &Message) -> Result<Self, SendError> {
        if let Some(value) = message.extras.get("wecom_image") {
            let image: ImageRequest =
                serde_json::from_value(value.clone()).map_err(|_| invalid_image())?;
            if image.base64.len() > IMAGE_BYTES.div_ceil(3) * 4 {
                return Err(invalid_image());
            }
            let bytes = STANDARD.decode(image.base64).map_err(|_| invalid_image())?;
            return Self::image(bytes, image.filename, image.content_type);
        }

        let markdown = message.format == MessageFormat::Markdown;
        let body = if markdown {
            message.body.clone()
        } else {
            plain_body(message, TEXT_BYTES)
        };
        let title = message.title.trim();
        let mut content = [title, body.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(raw_url) = &message.url {
            let url = Url::parse(raw_url).map_err(|_| invalid_message())?;
            if !matches!(url.scheme(), "https" | "http")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(invalid_message());
            }
            if !content.is_empty() {
                content.push('\n');
            }
            content.push_str(url.as_str());
        }
        if content.is_empty() {
            return Err(invalid_message());
        }

        if markdown {
            Ok(Self::Markdown(truncate_bytes(&content, MARKDOWN_BYTES)))
        } else {
            Ok(Self::Text(truncate_bytes(&content, TEXT_BYTES)))
        }
    }
}

async fn fetch_token(
    client: &Client,
    root: &Url,
    config: &Config,
) -> Result<(String, u64), SendError> {
    let url = root
        .join("/cgi-bin/gettoken")
        .map_err(|_| invalid_config())?;
    let response = client
        .get(url)
        .query(&[("corpid", &config.corpid), ("corpsecret", &config.secret)])
        .send()
        .await
        .map_err(network_error)?;
    let reply = checked_reply(response).await?;
    reply
        .get("access_token")
        .and_then(Value::as_str)
        .zip(reply.get("expires_in").and_then(Value::as_u64))
        .map(|(token, expires)| (token.to_owned(), expires))
        .ok_or_else(invalid_reply)
}

async fn attempt(
    client: &Client,
    root: &Url,
    config: &Config,
    token: &str,
    content: &Content,
) -> Result<SendOutcome, SendError> {
    let mut payload = json!({
        "touser": config.touser,
        "agentid": config.agentid,
        "enable_duplicate_check": 1,
        "duplicate_check_interval": 600
    });
    match content {
        Content::Text(content) => {
            payload["msgtype"] = json!("text");
            payload["text"] = json!({"content":content});
        }
        Content::Markdown(content) => {
            payload["msgtype"] = json!("markdown");
            payload["markdown"] = json!({"content":content});
        }
        Content::Image {
            bytes,
            filename,
            mime,
        } => {
            let url = root
                .join("/cgi-bin/media/upload")
                .map_err(|_| invalid_config())?;
            let part = multipart::Part::bytes(bytes.clone())
                .file_name(filename.clone())
                .mime_str(mime)
                .map_err(|_| invalid_image())?;
            let result = client
                .post(url)
                .query(&[("access_token", token), ("type", "image")])
                .multipart(multipart::Form::new().part("media", part))
                .send()
                .await
                .map_err(network_error)?;
            let reply = checked_reply(result).await?;
            let media_id = reply
                .get("media_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(invalid_reply)?;
            payload["msgtype"] = json!("image");
            payload["image"] = json!({"media_id":media_id});
        }
    }

    let url = root
        .join("/cgi-bin/message/send")
        .map_err(|_| invalid_config())?;
    let result = client
        .post(url)
        .query(&[("access_token", token)])
        .json(&payload)
        .send()
        .await
        .map_err(network_error)?;
    let reply = checked_reply(result).await?;
    if ["invaliduser", "unlicenseduser"].iter().any(|key| {
        reply
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    }) {
        return Err(SendError::new(
            "wecom_invalid_recipient",
            "WeCom did not accept one or more recipients",
            false,
        ));
    }
    Ok(SendOutcome::Delivered)
}

async fn checked_reply(result: reqwest::Response) -> Result<Value, SendError> {
    let value: Value =
        serde_json::from_slice(&response(result).await?).map_err(|_| invalid_reply())?;
    let code = value
        .get("errcode")
        .and_then(Value::as_i64)
        .ok_or_else(invalid_reply)?;
    if code == 0 {
        // WeCom's duplicate check acknowledges a suppressed duplicate with success.
        return Ok(value);
    }
    let (hint, retryable) = match code {
        60020 | 301013 => (
            "configure the server egress IP in the WeCom app trusted-IP list",
            false,
        ),
        -1 | 45009 | 45011 | 45033 => ("WeCom is busy or throttled the request", true),
        _ => (
            "WeCom rejected the credentials, recipients or request",
            false,
        ),
    };
    Err(SendError::new(&format!("wecom_{code}"), hint, retryable))
}

fn invalid_reply() -> SendError {
    SendError::new(
        "wecom_invalid_response",
        "WeCom returned an invalid response",
        true,
    )
}

fn invalid_image() -> SendError {
    SendError::new(
        "wecom_invalid_image",
        "provide one JPG, PNG or GIF no larger than 2 MiB",
        false,
    )
}

fn invalid_message() -> SendError {
    SendError::new(
        "wecom_invalid_message",
        "provide notification text and an optional HTTP(S) URL",
        false,
    )
}

#[cfg(test)]
mod tests;
