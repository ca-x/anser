//! DingTalk custom group robot notifications.

use std::time::{SystemTime, UNIX_EPOCH};

use anser_channel_http::{
    NetworkPolicy, client_with_policy, config, decode, link, network_error, plain_notification,
    provider_error, reqwest::Url, response, truncate, truncate_bytes, url, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;

const MAX_TEXT: usize = 20000;
const MAX_TITLE: usize = 256;

#[derive(Default)]
pub struct Dingtalk;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    webhook: String,
    signing_secret: Option<String>,
    proxy: Option<String>,
}

fn invalid_config() -> SendError {
    SendError::new(
        "dingtalk_config",
        "provide a DingTalk group robot webhook and its optional signing secret",
        false,
    )
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        let endpoint = url(&config.webhook)?;
        let pairs = endpoint.query_pairs().collect::<Vec<_>>();
        if endpoint.scheme() != "https"
            || endpoint.port().is_some()
            || endpoint.host_str() != Some("oapi.dingtalk.com")
            || endpoint.path() != "/robot/send"
            || !matches!(pairs.as_slice(),[(key,token)] if key=="access_token" && valid_secret(token))
            || config
                .signing_secret
                .as_deref()
                .is_some_and(|secret| !valid_secret(secret))
        {
            return Err(invalid_config());
        }
        validate_proxy(config.proxy.as_deref())?;
        Ok(config)
    }
}

fn valid_secret(secret: &str) -> bool {
    !secret.is_empty()
        && secret.len() <= 512
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

impl ChannelService for Dingtalk {
    fn id(&self) -> &'static str {
        "dingtalk"
    }
    fn display_name(&self) -> &'static str {
        "钉钉"
    }
    fn config_schema(&self) -> Value {
        json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type":"object",
            "x-anser-ui": {"label":{"en":"DingTalk","zh-CN":"钉钉"},"account_editor": {"fields":[],"credentials":{"webhook":[],"signing_secret":["webhook"]}}},
            "properties":{
                "webhook":{"x-anser-ui":{"label":{"en":"Webhook URL","zh-CN":"机器人回调地址"}},"type":"string","format":"uri","writeOnly":true},
                "signing_secret":{"x-anser-ui":{"label":{"en":"Signing secret","zh-CN":"签名密钥"}},"type":"string","format":"password","writeOnly":true,"maxLength":512},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required":["webhook"],"additionalProperties":false
        })
    }
    fn validate_config(&self, value: &Value) -> Result<(), SendError> {
        Config::parse(value).map(|_| ())
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text, MessageFormat::Markdown],
            max_title_chars: Some(MAX_TITLE as u32),
            max_body_chars: None,
            attachments: false,
            user_target: false,
        }
    }
    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            let cfg = Config::parse(&account.config)?;
            send(
                &cfg,
                message,
                url(&cfg.webhook)?,
                &NetworkPolicy::from_env(),
            )
            .await
        })
    }
}

fn signature(timestamp: &str, secret: &str) -> Result<String, SendError> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| invalid_config())?;
    mac.update(timestamp.as_bytes());
    mac.update(b"\n");
    mac.update(secret.as_bytes());
    Ok(STANDARD.encode(mac.finalize().into_bytes()))
}

#[derive(Deserialize)]
struct Reply {
    errcode: i64,
}

async fn send(
    cfg: &Config,
    msg: &Message,
    mut endpoint: Url,
    policy: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    if let Some(secret) = &cfg.signing_secret {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| {
                SendError::new(
                    "dingtalk_clock",
                    "system time is before the Unix epoch",
                    false,
                )
            })?
            .as_millis()
            .to_string();
        let sign = signature(&timestamp, secret)?;
        endpoint
            .query_pairs_mut()
            .append_pair("timestamp", &timestamp)
            .append_pair("sign", &sign);
    }
    let payload = if msg.format == MessageFormat::Markdown {
        let href = msg.url.as_deref().map(link).transpose()?;
        let text = [
            msg.title.trim(),
            msg.body.trim(),
            href.as_ref().map_or("", Url::as_str),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        let title = if msg.title.trim().is_empty() {
            msg.body
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("Anser")
        } else {
            msg.title.trim()
        };
        json!({"msgtype":"markdown","markdown":{"title":truncate(title,MAX_TITLE),"text":truncate_bytes(&text,MAX_TEXT)}})
    } else {
        let text = plain_notification(msg, MAX_TEXT)?;
        json!({"msgtype":"text","text":{"content":truncate_bytes(&text,MAX_TEXT)}})
    };
    let http = client_with_policy(&endpoint, cfg.proxy.as_deref(), policy).await?;
    let reply = http
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(network_error)?;
    let reply: Reply = decode(&response(reply).await?)?;
    if reply.errcode == 0 {
        return Ok(SendOutcome::Delivered);
    }
    Err(provider_error(
        "dingtalk",
        reply.errcode,
        matches!(reply.errcode, 429 | 500..=599 | 130101 | 130102),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock::serve_sequence;

    #[tokio::test]
    async fn signs_the_webhook_and_checks_business_errors() {
        assert_eq!(
            signature("1700000000000", "secret").unwrap(),
            "OuzzJR5+xZ4/EYwqtNt6sMYZQMTa/HEGvc9miJe7XzY="
        );
        let (endpoint, requests) = serve_sequence(&[
            ("200 OK", "", "{\"errcode\":0}"),
            ("200 OK", "", "{\"errcode\":130101}"),
            ("200 OK", "", "{\"errcode\":310000}"),
        ])
        .await;
        let cfg=Config::parse(&json!({"webhook":"https://oapi.dingtalk.com/robot/send?access_token=token","signing_secret":"secret"})).unwrap();
        assert!(Config::parse(&json!({"webhook":"https://oapi.dingtalk.com/robot/send?access_token=token&sign=other"})).is_err());
        let msg = Message {
            title: "Build".into(),
            body: "**Ready**".into(),
            format: MessageFormat::Markdown,
            ..Message::default()
        };
        let policy = NetworkPolicy::new(true, vec![]);
        assert_eq!(
            send(&cfg, &msg, endpoint.clone(), &policy).await.unwrap(),
            SendOutcome::Delivered
        );
        assert!(
            send(&cfg, &msg, endpoint.clone(), &policy)
                .await
                .unwrap_err()
                .retryable
        );
        assert!(
            !send(&cfg, &msg, endpoint, &policy)
                .await
                .unwrap_err()
                .retryable
        );
        let request = &requests.await.unwrap()[0];
        assert!(request.headers.contains("timestamp=") && request.headers.contains("&sign="));
        assert_eq!(
            decode::<Value>(&request.body).unwrap()["markdown"]["text"],
            "Build\n\n**Ready**"
        );
    }
}
