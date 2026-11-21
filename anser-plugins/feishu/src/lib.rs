//! Feishu and Lark custom-bot webhook and application delivery.

use std::time::{SystemTime, UNIX_EPOCH};

use anser_channel_http::{
    NetworkPolicy, client, client_with_policy, network_error, plain_body, response,
    token::TokenCache, truncate, validate_proxy, validate_url,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const TITLE_LIMIT: usize = 200;
const BODY_LIMIT: usize = 4 * 1024;

#[derive(Default)]
pub struct Feishu {
    tokens: TokenCache,
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum Config {
    Webhook {
        webhook: String,
        signing_secret: Option<String>,
        proxy: Option<String>,
    },
    App {
        app_id: String,
        app_secret: String,
        receive_id: String,
        #[serde(default)]
        receive_id_type: ReceiveIdType,
        #[serde(default)]
        region: Region,
        proxy: Option<String>,
    },
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReceiveIdType {
    #[default]
    OpenId,
    UserId,
    UnionId,
    Email,
    ChatId,
}

impl ReceiveIdType {
    fn as_str(self) -> &'static str {
        match self {
            Self::OpenId => "open_id",
            Self::UserId => "user_id",
            Self::UnionId => "union_id",
            Self::Email => "email",
            Self::ChatId => "chat_id",
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Region {
    #[default]
    Feishu,
    Lark,
}

impl Region {
    fn url(self) -> &'static str {
        match self {
            Self::Feishu => "https://open.feishu.cn",
            Self::Lark => "https://open.larksuite.com",
        }
    }
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = serde_json::from_value(value.clone()).map_err(|_| invalid_config())?;
        match &config {
            Self::Webhook {
                webhook,
                signing_secret,
                proxy,
            } => {
                let url = Url::parse(webhook).map_err(|_| invalid_config())?;
                validate_url(&url)?;
                if url.scheme() != "https" {
                    return Err(invalid_config());
                }
                if signing_secret
                    .as_ref()
                    .is_some_and(|value| value.trim().is_empty() || value.len() > 512)
                {
                    return Err(invalid_config());
                }
                validate_proxy(proxy.as_deref())?;
            }
            Self::App {
                app_id,
                app_secret,
                receive_id,
                proxy,
                ..
            } => {
                if [app_id, app_secret, receive_id].iter().any(|value| {
                    value.is_empty()
                        || value.len() > 512
                        || value
                            .chars()
                            .any(|ch| ch.is_control() || ch.is_whitespace())
                }) {
                    return Err(invalid_config());
                }
                validate_proxy(proxy.as_deref())?;
            }
        }
        Ok(config)
    }
}

fn invalid_config() -> SendError {
    SendError::new(
        "feishu_invalid_config",
        "provide a valid HTTPS webhook or application credentials and recipient",
        false,
    )
}

impl ChannelService for Feishu {
    fn id(&self) -> &'static str {
        "feishu"
    }

    fn display_name(&self) -> &'static str {
        "飞书 / Lark"
    }

    fn config_schema(&self) -> Value {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "mode":{"type":"string","enum":["webhook","app"]},
                "webhook":{"type":"string","format":"uri","writeOnly":true},
                "signing_secret":{"type":"string","minLength":1,"maxLength":512,"format":"password","writeOnly":true},
                "app_id":{"type":"string","minLength":1,"maxLength":512},
                "app_secret":{"type":"string","minLength":1,"maxLength":512,"format":"password","writeOnly":true},
                "receive_id":{"type":"string","minLength":1,"maxLength":512},
                "receive_id_type":{"type":"string","enum":["open_id","user_id","union_id","email","chat_id"],"default":"open_id"},
                "region":{"type":"string","enum":["feishu","lark"],"default":"feishu"},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required":["mode"],
            "oneOf":[
                {"properties":{"mode":{"const":"webhook"}},"required":["webhook"],"not":{"anyOf":[{"required":["app_id"]},{"required":["app_secret"]},{"required":["receive_id"]},{"required":["receive_id_type"]},{"required":["region"]}]}},
                {"properties":{"mode":{"const":"app"}},"required":["app_id","app_secret","receive_id"],"not":{"anyOf":[{"required":["webhook"]},{"required":["signing_secret"]}]}}
            ],
            "additionalProperties":false
        })
    }

    fn validate_config(&self, config: &Value) -> Result<(), SendError> {
        Config::parse(config).map(|_| ())
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text, MessageFormat::Markdown],
            max_title_chars: Some(TITLE_LIMIT as u32),
            max_body_chars: Some(BODY_LIMIT as u32),
            attachments: false,
            user_target: true,
        }
    }

    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            self.send_at(&Config::parse(&account.config)?, message, None, None)
                .await
        })
    }
}

impl Feishu {
    async fn send_at(
        &self,
        config: &Config,
        message: &Message,
        app_base: Option<&str>,
        policy: Option<&NetworkPolicy>,
    ) -> Result<SendOutcome, SendError> {
        let content = Content::new(message)?;
        match config {
            Config::Webhook {
                webhook,
                signing_secret,
                proxy,
            } => {
                let url = Url::parse(webhook).map_err(|_| invalid_config())?;
                let http = make_client(&url, proxy.as_deref(), policy).await?;
                let mut payload = content.webhook();
                if let Some(secret) = signing_secret {
                    let timestamp = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|_| {
                            SendError::new(
                                "feishu_clock",
                                "server clock cannot produce a webhook timestamp",
                                true,
                            )
                        })?
                        .as_secs();
                    payload["timestamp"] = json!(timestamp.to_string());
                    payload["sign"] = json!(sign(timestamp, secret));
                }
                let reply = http
                    .post(url)
                    .json(&payload)
                    .send()
                    .await
                    .map_err(network_error)?;
                delivery_result(reply_code(reply).await?)
            }
            Config::App {
                app_id,
                app_secret,
                receive_id,
                receive_id_type,
                region,
                proxy,
            } => {
                let root =
                    Url::parse(app_base.unwrap_or(region.url())).map_err(|_| invalid_config())?;
                let http = make_client(&root, proxy.as_deref(), policy).await?;
                let send_url = root
                    .join("/open-apis/im/v1/messages")
                    .map_err(|_| invalid_config())?;
                let content = content.app(receive_id);
                let token_key = token_key(&root, app_id, app_secret, proxy.as_deref());
                let token = self
                    .tokens
                    .get(token_key, fetch_token(&http, &root, app_id, app_secret))
                    .await?;
                let code = send_app(&http, &send_url, *receive_id_type, &content, &token).await?;
                if !matches!(code, 99991663 | 99991664 | 99991668) {
                    return delivery_result(code);
                }
                self.tokens.expire(token_key, &token).await;
                let renewed = self
                    .tokens
                    .get(token_key, fetch_token(&http, &root, app_id, app_secret))
                    .await?;
                delivery_result(
                    send_app(&http, &send_url, *receive_id_type, &content, &renewed).await?,
                )
            }
        }
    }
}

async fn make_client(
    url: &Url,
    proxy: Option<&str>,
    policy: Option<&NetworkPolicy>,
) -> Result<Client, SendError> {
    match policy {
        Some(policy) => client_with_policy(url, proxy, policy).await,
        None => client(url, proxy).await,
    }
}

fn sign(timestamp: u64, secret: &str) -> String {
    let key = format!("{timestamp}\n{secret}");
    // Feishu signs the empty message using the timestamp and secret as the key.
    let mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts all key lengths");
    STANDARD.encode(mac.finalize().into_bytes())
}

enum Content {
    Text(String),
    Card(Value),
}

impl Content {
    fn new(message: &Message) -> Result<Self, SendError> {
        if let Some(card) = message.extras.get("feishu_card") {
            if !card.is_object() || card.to_string().len() > 24 * 1024 {
                return Err(invalid_message());
            }
            return Ok(Self::Card(card.clone()));
        }

        let title = truncate(&message.title, TITLE_LIMIT);
        let body = plain_body(message, BODY_LIMIT);
        let mut text = String::new();
        for line in [title.as_str(), body.as_str()] {
            if !line.trim().is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(line);
            }
        }
        if let Some(raw_url) = &message.url {
            let url = Url::parse(raw_url).map_err(|_| invalid_message())?;
            if !matches!(url.scheme(), "https" | "http")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(invalid_message());
            }
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(url.as_str());
        }
        if text.is_empty() {
            return Err(invalid_message());
        }
        Ok(Self::Text(text))
    }

    fn webhook(&self) -> Value {
        match self {
            Self::Text(text) => json!({"msg_type":"text","content":{"text":text}}),
            Self::Card(card) => json!({"msg_type":"interactive","card":card}),
        }
    }

    fn app(&self, receive_id: &str) -> Value {
        let (kind, content) = match self {
            Self::Text(text) => ("text", json!({"text":text}).to_string()),
            Self::Card(card) => ("interactive", card.to_string()),
        };
        json!({"msg_type":kind,"receive_id":receive_id,"content":content})
    }
}

async fn fetch_token(
    client: &Client,
    root: &Url,
    app_id: &str,
    app_secret: &str,
) -> Result<(String, u64), SendError> {
    let url = root
        .join("/open-apis/auth/v3/tenant_access_token/internal")
        .map_err(|_| invalid_config())?;
    let response = client
        .post(url)
        .json(&json!({"app_id":app_id,"app_secret":app_secret}))
        .send()
        .await
        .map_err(network_error)?;
    let reply = provider_reply(response).await?;
    delivery_result(parse_code(&reply)?)?;
    reply
        .get("tenant_access_token")
        .and_then(Value::as_str)
        .zip(reply.get("expire").and_then(Value::as_u64))
        .map(|(token, expires)| (token.to_owned(), expires))
        .ok_or_else(invalid_reply)
}

async fn send_app(
    client: &Client,
    url: &Url,
    recipient_type: ReceiveIdType,
    body: &Value,
    token: &str,
) -> Result<i64, SendError> {
    let response = client
        .post(url.clone())
        .query(&[("receive_id_type", recipient_type.as_str())])
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(network_error)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(99991668);
    }
    reply_code(response).await
}

async fn reply_code(result: reqwest::Response) -> Result<i64, SendError> {
    parse_code(&provider_reply(result).await?)
}

fn parse_code(reply: &Value) -> Result<i64, SendError> {
    reply
        .get("code")
        .or_else(|| reply.get("StatusCode"))
        .and_then(Value::as_i64)
        .ok_or_else(invalid_reply)
}

async fn provider_reply(result: reqwest::Response) -> Result<Value, SendError> {
    serde_json::from_slice(&response(result).await?).map_err(|_| invalid_reply())
}

fn token_key(root: &Url, app_id: &str, app_secret: &str, proxy: Option<&str>) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in [root.as_str(), app_id, app_secret, proxy.unwrap_or("")] {
        hash.update(part.len().to_le_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

fn delivery_result(code: i64) -> Result<SendOutcome, SendError> {
    if code == 0 {
        return Ok(SendOutcome::Delivered);
    }
    let retryable = matches!(
        code,
        11232 | 230020 | 230049 | 99991400 | 99991401 | 99991500 | 99991600
    );
    Err(SendError::new(
        &format!("feishu_{code}"),
        "Feishu rejected the request",
        retryable,
    ))
}

fn invalid_message() -> SendError {
    SendError::new(
        "feishu_invalid_message",
        "provide notification text or a valid interactive card",
        false,
    )
}

fn invalid_reply() -> SendError {
    SendError::new(
        "feishu_invalid_response",
        "Feishu returned an invalid response",
        true,
    )
}

#[cfg(test)]
mod tests;
