//! WeChat Official Account template notification delivery.

use anser_channel_http::{
    NetworkPolicy, client, client_with_policy, network_error, plain_body, response,
    token::TokenCache, truncate, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const BASE: &str = "https://api.weixin.qq.com";
const TITLE_LIMIT: usize = 200;
const BODY_LIMIT: usize = 1024;

#[derive(Default)]
pub struct WechatMp {
    tokens: TokenCache,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    appid: String,
    secret: String,
    template_id: String,
    openid: String,
    proxy: Option<String>,
    #[serde(default = "default_title_field")]
    title_field: String,
    #[serde(default = "default_body_field")]
    body_field: String,
}

fn default_title_field() -> String {
    "first".into()
}

fn default_body_field() -> String {
    "remark".into()
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = serde_json::from_value(value.clone()).map_err(|_| invalid_config())?;
        let identifiers = [
            &config.appid,
            &config.template_id,
            &config.openid,
            &config.title_field,
            &config.body_field,
        ];
        if identifiers.iter().any(|id| !provider_id(id))
            || config.secret.trim().is_empty()
            || config.secret.len() > 512
            || config.title_field == config.body_field
        {
            return Err(invalid_config());
        }
        validate_proxy(config.proxy.as_deref())?;
        Ok(config)
    }
}

fn provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.@".contains(&byte))
}

fn invalid_config() -> SendError {
    SendError::new(
        "wechat_mp_invalid_config",
        "provide valid appid, secret, template_id, openid and distinct template fields",
        false,
    )
}

impl ChannelService for WechatMp {
    fn id(&self) -> &'static str {
        "wechat-mp"
    }

    fn display_name(&self) -> &'static str {
        "微信公众号"
    }

    fn config_schema(&self) -> Value {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type": "object",
            "x-anser-ui": {"label":{"en":"WeChat Official Account","zh-CN":"微信公众号"},"account_editor": {"fields":["appid","template_id","openid","title_field","body_field"],"credentials":{"secret":["appid"]}}},
            "properties": {
                "appid":{"x-anser-ui":{"label":{"en":"Application ID","zh-CN":"应用 ID"}},"type":"string","minLength":1,"maxLength":256},
                "secret":{"x-anser-ui":{"label":{"en":"Application secret","zh-CN":"应用密钥"}},"type":"string","minLength":1,"maxLength":512,"format":"password","writeOnly":true},
                "template_id":{"x-anser-ui":{"label":{"en":"Template ID","zh-CN":"模板 ID"}},"type":"string","minLength":1,"maxLength":256},
                "openid":{"x-anser-ui":{"label":{"en":"OpenID","zh-CN":"用户 OpenID"}},"type":"string","minLength":1,"maxLength":256},
                "title_field":{"x-anser-ui":{"label":{"en":"Template title field","zh-CN":"模板标题字段"}},"type":"string","default":"first"},
                "body_field":{"x-anser-ui":{"label":{"en":"Template body field","zh-CN":"模板正文字段"}},"type":"string","default":"remark"},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required": ["appid", "secret", "template_id", "openid"],
            "additionalProperties": false
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
            self.send_at(&Config::parse(&account.config)?, message, BASE, None)
                .await
        })
    }
}

impl WechatMp {
    async fn send_at(
        &self,
        config: &Config,
        message: &Message,
        base: &str,
        policy: Option<&NetworkPolicy>,
    ) -> Result<SendOutcome, SendError> {
        let payload = template_payload(config, message)?;
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
        let code = send_template(&http, &root, &payload, &token).await?;
        if !matches!(code, 40001 | 40014 | 42001) {
            return delivery_result(code);
        }

        self.tokens.expire(key, &token).await;
        let renewed = self
            .tokens
            .get(key, fetch_token(&http, &root, config))
            .await?;
        delivery_result(send_template(&http, &root, &payload, &renewed).await?)
    }
}

fn token_key(base: &str, config: &Config) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in [
        base,
        &config.appid,
        &config.secret,
        config.proxy.as_deref().unwrap_or(""),
    ] {
        hash.update(part.len().to_le_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

fn template_payload(config: &Config, message: &Message) -> Result<Value, SendError> {
    let mut data = Map::new();
    if let Some(fields) = message.extras.get("wechat_mp_data") {
        let fields = fields
            .as_object()
            .filter(|fields| !fields.is_empty() && fields.len() <= 50)
            .ok_or_else(invalid_message)?;
        for (key, value) in fields {
            let value = value.as_object().ok_or_else(invalid_message)?;
            let content = value
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(invalid_message)?;
            if !provider_id(key)
                || content.trim().is_empty()
                || value.keys().any(|key| key != "value" && key != "color")
            {
                return Err(invalid_message());
            }
            let mut field = json!({"value":truncate(content, BODY_LIMIT)});
            if let Some(color) = value.get("color") {
                let color = color
                    .as_str()
                    .filter(|color| {
                        color.starts_with('#')
                            && color.len() == 7
                            && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
                    .ok_or_else(invalid_message)?;
                field["color"] = json!(color);
            }
            data.insert(key.clone(), field);
        }
    } else {
        data.insert(
            config.title_field.clone(),
            json!({"value":truncate(&message.title, TITLE_LIMIT)}),
        );
        data.insert(
            config.body_field.clone(),
            json!({"value":plain_body(message, BODY_LIMIT)}),
        );
    }

    let mut payload = json!({"touser":config.openid,"template_id":config.template_id,"data":data});
    if let Some(url) = &message.url {
        let parsed = Url::parse(url).map_err(|_| invalid_message())?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(invalid_message());
        }
        payload["url"] = json!(url);
    }
    Ok(payload)
}

async fn fetch_token(
    client: &Client,
    root: &Url,
    config: &Config,
) -> Result<(String, u64), SendError> {
    let url = root.join("/cgi-bin/token").map_err(|_| invalid_config())?;
    let result = client
        .get(url)
        .query(&[
            ("grant_type", "client_credential"),
            ("appid", config.appid.as_str()),
            ("secret", config.secret.as_str()),
        ])
        .send()
        .await
        .map_err(network_error)?;
    let value = provider_reply(result).await?;
    delivery_result(value.get("errcode").and_then(Value::as_i64).unwrap_or(0))?;
    value
        .get("access_token")
        .and_then(Value::as_str)
        .zip(value.get("expires_in").and_then(Value::as_u64))
        .map(|(token, expires)| (token.to_owned(), expires))
        .ok_or_else(invalid_reply)
}

async fn send_template(
    client: &Client,
    root: &Url,
    payload: &Value,
    token: &str,
) -> Result<i64, SendError> {
    let url = root
        .join("/cgi-bin/message/template/send")
        .map_err(|_| invalid_config())?;
    let result = client
        .post(url)
        .query(&[("access_token", token)])
        .json(payload)
        .send()
        .await
        .map_err(network_error)?;
    provider_reply(result)
        .await?
        .get("errcode")
        .and_then(Value::as_i64)
        .ok_or_else(invalid_reply)
}

async fn provider_reply(result: reqwest::Response) -> Result<Value, SendError> {
    serde_json::from_slice(&response(result).await?).map_err(|_| invalid_reply())
}

fn invalid_reply() -> SendError {
    SendError::new(
        "wechat_mp_invalid_response",
        "WeChat returned an invalid response",
        true,
    )
}

fn invalid_message() -> SendError {
    SendError::new(
        "wechat_mp_invalid_message",
        "invalid template data or message URL",
        false,
    )
}

fn delivery_result(code: i64) -> Result<SendOutcome, SendError> {
    match code {
        0 => Ok(SendOutcome::Delivered),
        -1 | 45009 | 45011 => Err(SendError::new(
            &format!("wechat_mp_{code}"),
            "WeChat is busy or throttled the request",
            true,
        )),
        _ => Err(SendError::new(
            &format!("wechat_mp_{code}"),
            "WeChat rejected the credentials, recipient, template or request",
            false,
        )),
    }
}

#[cfg(test)]
mod tests;
