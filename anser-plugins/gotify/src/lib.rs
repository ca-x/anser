//! Gotify application notifications.

use anser_channel_http::{
    NetworkPolicy, append_path, client_with_policy, config, decode, link, network_error,
    plain_body,
    reqwest::{Url, header::HeaderValue},
    response, truncate, url, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_TITLE: usize = 256;
const MAX_TEXT: usize = 16384;

#[derive(Default)]
pub struct Gotify;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    server_url: String,
    app_token: String,
    #[serde(default)]
    priority: i32,
    proxy: Option<String>,
}

fn invalid_config() -> SendError {
    SendError::new(
        "gotify_config",
        "provide a Gotify base URL and application token",
        false,
    )
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        let base = url(&config.server_url)?;
        if base.query().is_some()
            || config.app_token.is_empty()
            || config.app_token.len() > 512
            || !config
                .app_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        {
            return Err(invalid_config());
        }
        validate_proxy(config.proxy.as_deref())?;
        Ok(config)
    }
}

impl ChannelService for Gotify {
    fn id(&self) -> &'static str {
        "gotify"
    }
    fn display_name(&self) -> &'static str {
        "Gotify"
    }
    fn config_schema(&self) -> Value {
        json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type":"object",
            "x-anser-ui": {"label":{"en":"Gotify","zh-CN":"Gotify"},"account_editor": {"fields":["server_url","priority"],"credentials":{"app_token":["server_url"]}}},
            "properties":{
                "server_url":{"x-anser-ui":{"label":{"en":"Server URL","zh-CN":"服务器地址"}},"type":"string","format":"uri"},
                "app_token":{"x-anser-ui":{"label":{"en":"Application token","zh-CN":"应用令牌"}},"type":"string","maxLength":512,"format":"password","writeOnly":true},
                "priority":{"x-anser-ui":{"label":{"en":"Notification priority","zh-CN":"通知优先级"}},"type":"integer","default":0},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required":["server_url","app_token"],"additionalProperties":false
        })
    }
    fn validate_config(&self, value: &Value) -> Result<(), SendError> {
        Config::parse(value).map(|_| ())
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text, MessageFormat::Markdown],
            max_title_chars: Some(MAX_TITLE as u32),
            max_body_chars: Some(MAX_TEXT as u32),
            attachments: false,
            user_target: false,
        }
    }
    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            send(
                &Config::parse(&account.config)?,
                message,
                &NetworkPolicy::from_env(),
            )
            .await
        })
    }
}

#[derive(Deserialize)]
struct Reply {
    id: u64,
}

async fn send(
    config: &Config,
    message: &Message,
    policy: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    let endpoint: Url = append_path(url(&config.server_url)?, &["message"])?;
    let markdown = message.format == MessageFormat::Markdown;
    let title = truncate(message.title.trim(), MAX_TITLE);
    let mut body = if markdown {
        truncate(&message.body, MAX_TEXT)
    } else {
        plain_body(message, MAX_TEXT)
    };
    if body.trim().is_empty() {
        body.clone_from(&title);
    }
    let mut extras = json!({});
    if markdown {
        extras["client::display"] = json!({"contentType":"text/markdown"});
    }
    if let Some(value) = &message.url {
        extras["client::notification"] = json!({"click":{"url":link(value)?.as_str()}});
    }
    let mut token = HeaderValue::from_str(&config.app_token).map_err(|_| invalid_config())?;
    token.set_sensitive(true);
    let http = client_with_policy(&endpoint, config.proxy.as_deref(), policy).await?;
    let reply = http
        .post(endpoint)
        .header("X-Gotify-Key", token)
        .json(&json!({"title":title,"message":body,"priority":config.priority,"extras":extras}))
        .send()
        .await
        .map_err(network_error)?;
    let reply: Reply = decode(&response(reply).await?)?;
    if reply.id == 0 {
        return Err(SendError::new(
            "gotify_response",
            "Gotify returned an invalid message ID",
            true,
        ));
    }
    Ok(SendOutcome::Delivered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock::serve;

    #[tokio::test]
    async fn sends_markdown_to_a_self_hosted_mount_and_honors_http_errors() {
        let (root, request) = serve("200 OK", "", r#"{"id":13}"#).await;
        let cfg = Config::parse(&json!({"server_url":root.join("notify/").unwrap().as_str(),"app_token":"app_example-123","priority":7})).unwrap();
        let msg = Message {
            body: "**Ready**".into(),
            format: MessageFormat::Markdown,
            ..Message::default()
        };
        let policy = NetworkPolicy::new(true, vec![]);
        assert_eq!(
            send(&cfg, &msg, &policy).await.unwrap(),
            SendOutcome::Delivered
        );
        let request = request.await.unwrap();
        assert!(request.headers.starts_with("POST /notify/message HTTP/1.1"));
        assert!(
            request
                .headers
                .to_lowercase()
                .contains("x-gotify-key: app_example-123")
        );
        assert_eq!(
            decode::<Value>(&request.body).unwrap(),
            json!({"title":"","message":"**Ready**","priority":7,"extras":{"client::display":{"contentType":"text/markdown"}}})
        );

        let (root, request) = serve("401 Unauthorized", "", r#"{"error":"unauthorized"}"#).await;
        let cfg = Config {
            server_url: root.to_string(),
            ..cfg
        };
        assert!(!send(&cfg, &msg, &policy).await.unwrap_err().retryable);
        request.await.unwrap();
    }
}
