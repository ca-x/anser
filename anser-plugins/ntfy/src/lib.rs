//! ntfy JSON publishing for hosted and self-managed servers.

use anser_channel_http::{
    NetworkPolicy, client_with_policy, config, link, network_error, plain_body, response,
    truncate_bytes, url,
};
mod ingress;

use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{
    Capabilities, ChannelDirection, ChannelService, IngressMessage, IngressRequest, IngressRoute,
    SendError, SendFuture, SendOutcome,
};
use serde::Deserialize;
use serde_json::{Value, json};

const TITLE_LIMIT: usize = 256;
const MESSAGE_LIMIT: usize = 4096;

#[derive(Default)]
pub struct Ntfy;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default = "default_server")]
    server_url: String,
    topic: String,
    token: Option<String>,
    username: Option<String>,
    password: Option<String>,
    #[serde(default = "default_priority")]
    priority: u8,
    proxy: Option<String>,
}

fn default_server() -> String {
    "https://ntfy.sh".into()
}

fn default_priority() -> u8 {
    3
}

fn valid_topic(topic: &str) -> bool {
    !topic.is_empty()
        && topic.len() <= 64
        && topic
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        let server = url(&config.server_url)?;
        anser_channel_http::validate_proxy(config.proxy.as_deref())?;
        if server.query().is_some()
            || !valid_topic(&config.topic)
            || !(1..=5).contains(&config.priority)
            || config.token.as_ref().is_some_and(|token| {
                token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_graphic())
            })
            || config
                .username
                .as_ref()
                .is_some_and(|user| user.is_empty() || user.contains(':'))
            || config.username.is_some() != config.password.is_some()
            || (config.token.is_some() && config.username.is_some())
        {
            return Err(SendError::new(
                "ntfy_config",
                "check the ntfy topic, priority and credentials",
                false,
            ));
        }
        Ok(config)
    }
}

impl ChannelService for Ntfy {
    fn id(&self) -> &'static str {
        "ntfy"
    }

    fn display_name(&self) -> &'static str {
        "ntfy"
    }

    fn direction(&self) -> ChannelDirection {
        ChannelDirection::Bidirectional
    }

    fn ingress_routes(&self) -> &'static [IngressRoute] {
        ingress::ROUTES
    }

    fn ingress_headers(&self) -> &'static [&'static str] {
        ingress::HEADERS
    }

    fn decode_ingress(&self, request: IngressRequest<'_>) -> Result<IngressMessage, &'static str> {
        ingress::decode(request)
    }

    fn ingress_response(
        &self,
        message: &IngressMessage,
        receipt: &anser_core::api::Receipt,
    ) -> Value {
        ingress::response(message, receipt)
    }

    fn config_schema(&self) -> Value {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type": "object",
            "x-anser-ui": {"help":{"en":"Publish JSON or send UTF-8 text to a Topic with an Anser send key. Set a title, tags, priority, Markdown, click URL or attachment URL. The Topic routes the message; configure an ntfy account to deliver to an external ntfy server.","zh-CN":"使用具有发送权限的雁字密钥，以 JSON 或 UTF-8 文本发布到主题。支持标题、标签、优先级、Markdown、点击链接和附件链接。收件人由主题路由决定；向外部 ntfy 服务投递时再配置渠道账号。"},"label":{"en":"ntfy","zh-CN":"ntfy"},"account_editor": {"fields":["server_url","topic","username","priority"],"credentials":{"token":["server_url","username"],"password":["server_url","username","token"]}}},
            "properties": {
                "server_url": {"x-anser-ui":{"label":{"en":"Server URL","zh-CN":"服务器地址"}},"type": "string", "format": "uri", "default": default_server()},
                "topic": {"x-anser-ui":{"label":{"en":"Topic","zh-CN":"主题"}},"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
                "token": {"x-anser-ui":{"label":{"en":"Access token","zh-CN":"访问令牌"}},"type": "string", "minLength": 1, "writeOnly": true},
                "username": {"x-anser-ui":{"label":{"en":"Username","zh-CN":"用户名"}},"type": "string", "minLength": 1},
                "password": {"x-anser-ui":{"label":{"en":"Password","zh-CN":"密码"}},"type": "string", "writeOnly": true},
                "priority": {"x-anser-ui":{"label":{"en":"Notification priority","zh-CN":"通知优先级"}},"type": "integer", "minimum": 1, "maximum": 5, "default": default_priority()},
                "proxy": {"type": "string", "format": "uri", "writeOnly": true}
            },
            "required": ["topic"],
            "dependentRequired": {"username": ["password"], "password": ["username"]},
            "not": {"required": ["token", "username"]},
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
            max_body_chars: Some(MESSAGE_LIMIT as u32),
            attachments: true,
            user_target: true,
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

async fn send(
    config: &Config,
    message: &Message,
    network: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    let endpoint = url(&config.server_url)?;
    let body = match message.format {
        MessageFormat::Html => plain_body(message, MESSAGE_LIMIT),
        _ => message.body.clone(),
    };
    let mut payload = json!({
        "topic": config.topic,
        "title": truncate_bytes(&message.title, TITLE_LIMIT),
        "message": truncate_bytes(&body, MESSAGE_LIMIT),
        "tags": message.tags,
        "priority": config.priority,
        "markdown": message.format == MessageFormat::Markdown
    });
    if let Some(click) = &message.url {
        payload["click"] = json!(link(click)?.as_str());
    }
    if let Some(attachment) = message.attachments.first() {
        payload["attach"] = json!(link(&attachment.url)?.as_str());
        if let Some(name) = &attachment.name {
            payload["filename"] = json!(truncate_bytes(name, 256));
        }
    } else if let Some(attachment) = message.extras.get("attach").and_then(Value::as_str) {
        payload["attach"] = json!(link(attachment)?.as_str());
    }
    let client = client_with_policy(&endpoint, config.proxy.as_deref(), network).await?;
    let mut request = client.post(endpoint).json(&payload);
    if let Some(token) = &config.token {
        request = request.bearer_auth(token);
    } else if let Some(username) = &config.username {
        request = request.basic_auth(username, config.password.as_ref());
    }
    let body = response(request.send().await.map_err(network_error)?).await?;
    let reply: Value = anser_channel_http::decode(&body)?;
    if reply.get("event").and_then(Value::as_str) != Some("message")
        || reply
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(SendError::new(
            "ntfy_response",
            "ntfy did not acknowledge publication",
            true,
        ));
    }
    Ok(SendOutcome::Delivered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock;

    #[tokio::test]
    async fn publishes_json_with_sensitive_bearer_and_markdown() {
        let (endpoint, received) =
            mock::serve("200 OK", "", r#"{"id":"fixture-id","event":"message"}"#).await;
        let config = Config::parse(&json!({
            "server_url": endpoint.as_str(), "topic":"alerts", "token":"fixture-token", "priority":5
        }))
        .unwrap();
        let message = Message {
            title: "雁字".into(),
            body: "**Alert**".into(),
            format: MessageFormat::Markdown,
            url: Some("https://example.com/alert".into()),
            attachments: vec![anser_core::Attachment {
                url: "https://example.com/log.txt".into(),
                name: Some("log.txt".into()),
                content_type: Some("text/plain".into()),
            }],
            tags: vec!["warning".into()],
            ..Message::default()
        };
        assert_eq!(
            send(&config, &message, &NetworkPolicy::new(true, vec![]))
                .await
                .unwrap(),
            SendOutcome::Delivered
        );
        let received = received.await.unwrap();
        let payload: Value = serde_json::from_slice(&received.body).unwrap();
        assert!(
            received
                .headers
                .to_ascii_lowercase()
                .contains("authorization: bearer fixture-token")
        );
        assert_eq!(payload["topic"], "alerts");
        assert_eq!(payload["priority"], 5);
        assert_eq!(payload["markdown"], true);
        assert_eq!(payload["title"], "雁字");
        assert_eq!(payload["attach"], "https://example.com/log.txt");
        assert_eq!(payload["filename"], "log.txt");
    }
}
