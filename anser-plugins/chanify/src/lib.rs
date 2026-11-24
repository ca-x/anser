//! Text notifications through the hosted Chanify API or a self-hosted node.

use anser_channel_http::{
    NetworkPolicy, append_path, client_with_policy, config, decode, link, network_error,
    plain_body, reqwest::header::HeaderValue, response, truncate_bytes, url, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use serde::Deserialize;
use serde_json::{Value, json};

const DEFAULT_URL: &str = "https://api.chanify.net";
const MAX_TITLE: usize = 240;
const MAX_TEXT: usize = 1500;

#[derive(Default)]
pub struct Chanify;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    server_url: Option<String>,
    token: String,
    #[serde(default)]
    sound: bool,
    priority: Option<u8>,
    proxy: Option<String>,
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        if url(config.server_url.as_deref().unwrap_or(DEFAULT_URL))?
            .query()
            .is_some()
            || config
                .priority
                .is_some_and(|priority| !matches!(priority, 5 | 10))
        {
            return Err(SendError::new(
                "chanify_config",
                "configure a Chanify server URL without a query and priority 5 or 10",
                false,
            ));
        }
        config.token_header()?;
        validate_proxy(config.proxy.as_deref())?;
        Ok(config)
    }

    fn token_header(&self) -> Result<HeaderValue, SendError> {
        if self.token.is_empty()
            || self.token.len() > 4096
            || !self.token.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(invalid_token());
        }
        let mut token = HeaderValue::from_str(&self.token).map_err(|_| invalid_token())?;
        token.set_sensitive(true);
        Ok(token)
    }
}

fn invalid_token() -> SendError {
    SendError::new(
        "chanify_token",
        "configure a valid Chanify sender token",
        false,
    )
}

impl ChannelService for Chanify {
    fn id(&self) -> &'static str {
        "chanify"
    }

    fn display_name(&self) -> &'static str {
        "Chanify"
    }

    fn config_schema(&self) -> Value {
        json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type":"object",
            "x-anser-ui": {"label":{"en":"Chanify","zh-CN":"Chanify"},"account_editor": {"fields":["server_url","sound","priority"],"credentials":{"token":["server_url"]}}},
            "properties":{
                "server_url":{"x-anser-ui":{"label":{"en":"Server URL","zh-CN":"服务器地址"}},"type":"string","format":"uri","default":DEFAULT_URL},
                "token":{"x-anser-ui":{"label":{"en":"Access token","zh-CN":"访问令牌"}},"type":"string","minLength":1,"maxLength":4096,"format":"password","writeOnly":true},
                "sound":{"x-anser-ui":{"label":{"en":"Play sound","zh-CN":"播放铃声"}},"type":"boolean","default":false},
                "priority":{"x-anser-ui":{"label":{"en":"Notification priority","zh-CN":"通知优先级"},"description":{"en":"Use 5 for low priority or 10 for normal priority.","zh-CN":"低优先级填 5，普通优先级填 10。"}},"type":"integer","enum":[5,10],"default":10,"description":"Use 5 for low priority or 10 for normal priority."},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required":["token"],"additionalProperties":false
        })
    }

    fn validate_config(&self, value: &Value) -> Result<(), SendError> {
        Config::parse(value).map(|_| ())
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text],
            max_title_chars: None,
            max_body_chars: None,
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
    #[serde(default)]
    res: u16,
    #[serde(rename = "request-uid")]
    request_uid: Option<String>,
}

async fn send(
    config: &Config,
    message: &Message,
    policy: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    let endpoint = append_path(
        url(config.server_url.as_deref().unwrap_or(DEFAULT_URL))?,
        &["v1", "sender"],
    )?;
    let title = truncate_bytes(message.title.trim(), MAX_TITLE);
    let body = plain_body(message, MAX_TEXT);
    let link = message.url.as_deref().map(link).transpose()?;
    let body = [body.trim(), link.as_ref().map_or("", |url| url.as_str())]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let text = truncate_bytes(if body.is_empty() { &title } else { &body }, MAX_TEXT);
    if text.is_empty() {
        return Err(SendError::new(
            "chanify_empty_text",
            "Chanify requires notification text",
            false,
        ));
    }

    let http = client_with_policy(&endpoint, config.proxy.as_deref(), policy).await?;
    let reply = http
        .post(endpoint)
        .header("token", config.token_header()?)
        .json(&json!({
            "title":title,"text":text,"sound":u8::from(config.sound),"priority":config.priority.unwrap_or(10)
        }))
        .send()
        .await
        .map_err(network_error)?;
    let reply: Reply = decode(&response(reply).await?)?;
    match reply.res {
        0 | 200
            if reply
                .request_uid
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty()) =>
        {
            Ok(SendOutcome::Delivered)
        }
        0 | 200 => Err(SendError::new(
            "chanify_unconfirmed",
            "Chanify did not confirm submission",
            false,
        )),
        code => Err(anser_channel_http::provider_error(
            "chanify",
            code,
            matches!(code, 408 | 429 | 500..=599),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock::serve;

    #[tokio::test]
    async fn confirms_submission_and_keeps_the_sender_token_out_of_the_url() {
        let (root, request) = serve("200 OK", "", r#"{"request-uid":"req-1"}"#).await;
        let config = Config::parse(&json!({
            "server_url":root.join("node/").unwrap().as_str(),
            "token":"test-token","sound":true,"priority":5
        }))
        .unwrap();
        let message = Message {
            title: "Alert".into(),
            body: "**Ready**".into(),
            format: MessageFormat::Markdown,
            url: Some("https://example.org/".into()),
            ..Message::default()
        };
        let policy = NetworkPolicy::new(true, vec![]);
        assert_eq!(
            send(&config, &message, &policy).await.unwrap(),
            SendOutcome::Delivered
        );
        let request = request.await.unwrap();
        assert!(request.headers.starts_with("POST /node/v1/sender HTTP/1.1"));
        assert!(request.headers.contains("token: test-token"));
        assert_eq!(
            decode::<Value>(&request.body).unwrap(),
            json!({
                "title":"Alert","text":"Ready\n\nhttps://example.org/","sound":1,"priority":5
            })
        );
    }

    #[tokio::test]
    async fn honors_rate_limits_and_requires_a_confirmation() {
        let message = Message {
            body: "Ready".into(),
            ..Message::default()
        };
        let policy = NetworkPolicy::new(true, vec![]);
        for (status, headers, body, code, retryable, retry_after) in [
            (
                "429 Too Many Requests",
                "Retry-After: 4\r\n",
                "",
                "http_rate_limited",
                true,
                Some(4000),
            ),
            (
                "401 Unauthorized",
                "",
                r#"{"msg":"test-token"}"#,
                "http_auth",
                false,
                None,
            ),
            ("200 OK", "", "{}", "chanify_unconfirmed", false, None),
        ] {
            let (root, request) = serve(status, headers, body).await;
            let config =
                Config::parse(&json!({"server_url":root.as_str(),"token":"test-token"})).unwrap();
            let error = send(&config, &message, &policy).await.unwrap_err();
            assert_eq!(
                (error.code.as_str(), error.retryable, error.retry_after_ms),
                (code, retryable, retry_after)
            );
            assert!(!error.message.contains("test-token"));
            request.await.unwrap();
        }
    }
}
