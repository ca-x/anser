//! Proactive messages using the QQ Bot OpenAPI.

use anser_channel_http::{
    NetworkPolicy, append_path, client_with_policy, config, decode, network_error,
    plain_notification, provider_error,
    reqwest::{
        Client, StatusCode, Url,
        header::{AUTHORIZATION, HeaderValue},
    },
    response,
    token::TokenCache,
    url, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_TEXT: usize = 2000;

#[derive(Default)]
pub struct Qqbot {
    tokens: TokenCache,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    app_id: String,
    app_secret: String,
    #[serde(default)]
    recipient_kind: RecipientKind,
    recipient_id: String,
    #[serde(default)]
    sandbox: bool,
    proxy: Option<String>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RecipientKind {
    User,
    #[default]
    Group,
    GuildChannel,
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let cfg: Self = config(value)?;
        if cfg.app_id.is_empty()
            || cfg.app_id.len() > 32
            || !cfg.app_id.bytes().all(|b| b.is_ascii_digit())
            || cfg.app_secret.is_empty()
            || cfg.app_secret.len() > 512
            || !cfg.app_secret.bytes().all(|b| b.is_ascii_graphic())
            || cfg.recipient_id.is_empty()
            || cfg.recipient_id.len() > 128
            || !cfg
                .recipient_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err(SendError::new(
                "qqbot_config",
                "provide the QQ Bot AppID, AppSecret and recipient ID",
                false,
            ));
        }
        validate_proxy(cfg.proxy.as_deref())?;
        Ok(cfg)
    }
}

impl ChannelService for Qqbot {
    fn id(&self) -> &'static str {
        "qqbot"
    }
    fn display_name(&self) -> &'static str {
        "QQ 机器人"
    }
    fn config_schema(&self) -> Value {
        json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type":"object",
            "x-anser-ui": {"label":{"en":"QQ Bot","zh-CN":"QQ 机器人"},"account_editor": {"fields":["app_id","recipient_kind","recipient_id","sandbox"],"credentials":{"app_secret":["app_id","sandbox"]}}},
            "properties":{
                "app_id":{"x-anser-ui":{"label":{"en":"Application ID","zh-CN":"应用 ID"}},"type":"string","pattern":"^[0-9]+$","maxLength":32},
                "app_secret":{"x-anser-ui":{"label":{"en":"Application secret","zh-CN":"应用密钥"}},"type":"string","format":"password","writeOnly":true,"maxLength":512},
                "recipient_kind":{"x-anser-ui":{"label":{"en":"Recipient type","zh-CN":"接收方类型"},"option_labels":{"group":{"en":"Group","zh-CN":"群聊"},"guild_channel":{"en":"Guild channel","zh-CN":"频道子频道"},"user":{"en":"User","zh-CN":"用户"}}},"type":"string","enum":["user","group","guild_channel"],"default":"group"},
                "recipient_id":{"x-anser-ui":{"label":{"en":"Recipient ID","zh-CN":"接收方 ID"}},"type":"string","pattern":"^[A-Za-z0-9_-]+$","maxLength":128},
                "sandbox":{"x-anser-ui":{"label":{"en":"Use sandbox","zh-CN":"使用沙箱"}},"type":"boolean","default":false},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required":["app_id","app_secret","recipient_id"],"additionalProperties":false
        })
    }
    fn validate_config(&self, value: &Value) -> Result<(), SendError> {
        Config::parse(value).map(|_| ())
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text],
            max_title_chars: None,
            max_body_chars: Some(MAX_TEXT as u32),
            attachments: false,
            user_target: true,
        }
    }
    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            let cfg = Config::parse(&account.config)?;
            let api = if cfg.sandbox {
                "https://sandbox.api.sgroup.qq.com/"
            } else {
                "https://api.sgroup.qq.com/"
            };
            self.send_at(
                &cfg,
                message,
                url("https://bots.qq.com/app/getAppAccessToken")?,
                url(api)?,
                &NetworkPolicy::from_env(),
            )
            .await
        })
    }
}

#[derive(Deserialize)]
struct QqReply {
    code: Option<i64>,
    id: Option<String>,
    access_token: Option<String>,
    expires_in: Option<Value>,
}

impl QqReply {
    fn ensure_success(&self) -> Result<(), SendError> {
        match self.code {
            Some(code) if code != 0 => Err(provider_error(
                "qqbot",
                code,
                matches!(code, 429 | 500..=599),
            )),
            _ => Ok(()),
        }
    }
}

impl Qqbot {
    async fn send_at(
        &self,
        cfg: &Config,
        msg: &Message,
        token_url: Url,
        api: Url,
        policy: &NetworkPolicy,
    ) -> Result<SendOutcome, SendError> {
        let endpoint = match cfg.recipient_kind {
            RecipientKind::User => {
                append_path(api.clone(), &["v2", "users", &cfg.recipient_id, "messages"])
            }
            RecipientKind::Group => append_path(
                api.clone(),
                &["v2", "groups", &cfg.recipient_id, "messages"],
            ),
            RecipientKind::GuildChannel => {
                append_path(api.clone(), &["channels", &cfg.recipient_id, "messages"])
            }
        }?;
        let content = plain_notification(msg, MAX_TEXT)?;
        let payload = match cfg.recipient_kind {
            RecipientKind::GuildChannel => json!({"content":content}),
            _ => json!({"content":content,"msg_type":0}),
        };
        let http = client_with_policy(&endpoint, cfg.proxy.as_deref(), policy).await?;
        let key = token_key(cfg, &token_url, &api);
        let fetch = || fetch_token(cfg, token_url.clone(), policy);
        let token = self.tokens.get(key, fetch()).await?;
        let result = attempt(&http, endpoint.clone(), &token, &payload).await;
        if !matches!(&result,Err(error) if error.code=="qqbot_token_rejected") {
            return result;
        }
        self.tokens.expire(key, &token).await;
        let renewal = self.tokens.get(key, fetch()).await?;
        attempt(&http, endpoint, &renewal, &payload).await
    }
}

fn token_key(cfg: &Config, token_url: &Url, api: &Url) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in [
        &cfg.app_id,
        &cfg.app_secret,
        token_url.as_str(),
        api.as_str(),
        cfg.proxy.as_deref().unwrap_or(""),
    ] {
        hash.update(part.len().to_le_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

async fn fetch_token(
    cfg: &Config,
    endpoint: Url,
    policy: &NetworkPolicy,
) -> Result<(String, u64), SendError> {
    let http = client_with_policy(&endpoint, cfg.proxy.as_deref(), policy).await?;
    let reply = http
        .post(endpoint)
        .json(&json!({"appId":cfg.app_id,"clientSecret":cfg.app_secret}))
        .send()
        .await
        .map_err(network_error)?;
    let reply: QqReply = decode(&response(reply).await?)?;
    reply.ensure_success()?;
    let rejected = || {
        SendError::new(
            "qqbot_auth",
            "QQ Bot did not issue a usable access token",
            false,
        )
    };
    let token = reply
        .access_token
        .filter(|token| {
            !token.is_empty() && token.len() <= 4096 && token.bytes().all(|b| b.is_ascii_graphic())
        })
        .ok_or_else(rejected)?;
    let ttl = reply
        .expires_in
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|ttl| *ttl > 0)
        .ok_or_else(rejected)?;
    Ok((token, ttl))
}

async fn attempt(
    http: &Client,
    endpoint: Url,
    token: &str,
    payload: &Value,
) -> Result<SendOutcome, SendError> {
    let mut header = HeaderValue::from_str(&format!("QQBot {token}")).map_err(|_| {
        SendError::new("qqbot_auth", "QQ Bot issued an invalid access token", false)
    })?;
    header.set_sensitive(true);
    let reply = http
        .post(endpoint)
        .header(AUTHORIZATION, header)
        .json(payload)
        .send()
        .await
        .map_err(network_error)?;
    if reply.status() == StatusCode::UNAUTHORIZED {
        return Err(SendError::new(
            "qqbot_token_rejected",
            "QQ Bot rejected the access token",
            false,
        ));
    }
    let reply: QqReply = decode(&response(reply).await?)?;
    reply.ensure_success()?;
    if reply.id.is_none_or(|id| id.is_empty()) {
        return Err(SendError::new(
            "qqbot_response",
            "QQ Bot returned no message ID",
            true,
        ));
    }
    Ok(SendOutcome::Delivered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock::serve_sequence;

    #[tokio::test]
    async fn refreshes_a_rejected_token_and_reuses_the_renewed_token_for_another_recipient() {
        let (root, requests) = serve_sequence(&[
            (
                "200 OK",
                "",
                r#"{"access_token":"old","expires_in":"7200"}"#,
            ),
            ("401 Unauthorized", "", "{}"),
            ("200 OK", "", r#"{"access_token":"new","expires_in":7200}"#),
            ("200 OK", "", r#"{"id":"group-msg"}"#),
            ("200 OK", "", r#"{"id":"user-msg"}"#),
            ("403 Forbidden", "", "{}"),
        ])
        .await;
        let token_url = root.join("app/getAppAccessToken").unwrap();
        let bot = Qqbot::default();
        let mut cfg = Config::parse(
            &json!({"app_id":"123","app_secret":"private","recipient_id":"group-id"}),
        )
        .unwrap();
        let msg = Message {
            body: "Hello".into(),
            ..Message::default()
        };
        let policy = NetworkPolicy::new(true, vec![]);
        assert_eq!(
            bot.send_at(&cfg, &msg, token_url.clone(), root.clone(), &policy)
                .await
                .unwrap(),
            SendOutcome::Delivered
        );
        cfg.recipient_kind = RecipientKind::User;
        cfg.recipient_id = "user-id".into();
        assert_eq!(
            bot.send_at(&cfg, &msg, token_url.clone(), root.clone(), &policy)
                .await
                .unwrap(),
            SendOutcome::Delivered
        );
        assert!(
            !bot.send_at(&cfg, &msg, token_url, root, &policy)
                .await
                .unwrap_err()
                .retryable
        );

        let requests = requests.await.unwrap();
        assert!(
            requests[0]
                .headers
                .starts_with("POST /app/getAppAccessToken HTTP/1.1")
        );
        assert_eq!(
            decode::<Value>(&requests[0].body).unwrap(),
            json!({"appId":"123","clientSecret":"private"})
        );
        assert!(
            requests[1]
                .headers
                .starts_with("POST /v2/groups/group-id/messages HTTP/1.1")
        );
        assert!(
            requests[3]
                .headers
                .to_lowercase()
                .contains("authorization: qqbot new")
        );
        assert!(
            requests[4]
                .headers
                .starts_with("POST /v2/users/user-id/messages HTTP/1.1")
        );
        assert_eq!(
            decode::<Value>(&requests[4].body).unwrap(),
            json!({"content":"Hello","msg_type":0})
        );
    }
}
