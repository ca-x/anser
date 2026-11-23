//! Slack Web API notifications.

use anser_channel_http::{
    NetworkPolicy, client_with_policy, config, decode, network_error, plain_notification,
    reqwest::Url, response, url, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_TEXT: usize = 4000;

#[derive(Default)]
pub struct Slack;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    bot_token: String,
    channel_id: String,
    proxy: Option<String>,
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        if !config.bot_token.starts_with("xoxb-")
            || config.bot_token.len() <= 5
            || config.bot_token.len() > 512
            || !config
                .bot_token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || config.channel_id.len() < 2
            || config.channel_id.len() > 64
            || !config.channel_id.starts_with(['C', 'G', 'D', 'U'])
            || !config
                .channel_id
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            return Err(SendError::new(
                "slack_config",
                "provide a Slack bot token and conversation ID",
                false,
            ));
        }
        validate_proxy(config.proxy.as_deref())?;
        Ok(config)
    }
}

impl ChannelService for Slack {
    fn id(&self) -> &'static str {
        "slack"
    }
    fn display_name(&self) -> &'static str {
        "Slack"
    }
    fn config_schema(&self) -> Value {
        json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "type":"object",
            "properties":{
                "bot_token":{"type":"string","pattern":"^xoxb-[A-Za-z0-9-]+$","maxLength":512,"writeOnly":true,"format":"password"},
                "channel_id":{"type":"string","pattern":"^[CGDU][A-Z0-9]+$","maxLength":64},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required":["bot_token","channel_id"],"additionalProperties":false
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
            send(
                &Config::parse(&account.config)?,
                message,
                url("https://slack.com/api/chat.postMessage")?,
                &NetworkPolicy::from_env(),
            )
            .await
        })
    }
}

#[derive(Deserialize)]
struct Reply {
    ok: bool,
    error: Option<String>,
}

async fn send(
    config: &Config,
    message: &Message,
    endpoint: Url,
    policy: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    let text = plain_notification(message, MAX_TEXT)?;
    let http = client_with_policy(&endpoint, config.proxy.as_deref(), policy).await?;
    let reply = http.post(endpoint).bearer_auth(&config.bot_token)
        .json(&json!({"channel":config.channel_id,"text":text,"mrkdwn":false,"parse":"none","unfurl_links":false,"unfurl_media":false}))
        .send().await.map_err(network_error)?;
    let reply: Reply = decode(&response(reply).await?)?;
    if reply.ok {
        return Ok(SendOutcome::Delivered);
    }
    let (code, message, retryable) = match reply.error.as_deref() {
        Some("ratelimited" | "rate_limited") => {
            ("slack_rate_limited", "Slack rate limited the request", true)
        }
        Some("internal_error" | "fatal_error" | "service_unavailable" | "request_timeout") => (
            "slack_unavailable",
            "Slack could not process the request",
            true,
        ),
        Some(
            "invalid_auth" | "token_revoked" | "account_inactive" | "not_authed" | "missing_scope",
        ) => (
            "slack_auth",
            "check the Slack bot token and chat:write permission",
            false,
        ),
        Some("channel_not_found" | "not_in_channel" | "is_archived") => (
            "slack_channel",
            "check the conversation ID and bot membership",
            false,
        ),
        _ => ("slack_rejected", "Slack rejected the notification", false),
    };
    Err(SendError::new(code, message, retryable))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock::serve_sequence;

    #[tokio::test]
    async fn posts_plain_text_and_classifies_rate_and_permission_errors() {
        let (endpoint, requests) = serve_sequence(&[
            ("200 OK", "", r#"{"ok":true,"ts":"123.45"}"#),
            (
                "429 Too Many Requests",
                "Retry-After: 3\r\n",
                r#"{"ok":false,"error":"ratelimited"}"#,
            ),
            ("200 OK", "", r#"{"ok":false,"error":"missing_scope"}"#),
        ])
        .await;
        let cfg = Config::parse(&json!({"bot_token":"xoxb-example","channel_id":"C123"})).unwrap();
        let message = Message {
            title: "Build".into(),
            body: "**Passed** <!everyone>".into(),
            format: MessageFormat::Markdown,
            ..Message::default()
        };
        let policy = NetworkPolicy::new(true, vec![]);
        assert_eq!(
            send(&cfg, &message, endpoint.clone(), &policy)
                .await
                .unwrap(),
            SendOutcome::Delivered
        );
        let limited = send(&cfg, &message, endpoint.clone(), &policy)
            .await
            .unwrap_err();
        assert_eq!(limited.retry_after_ms, Some(3000));
        let denied = send(&cfg, &message, endpoint, &policy).await.unwrap_err();
        assert_eq!(denied.code, "slack_auth");
        assert!(!denied.retryable);
        let request = &requests.await.unwrap()[0];
        assert!(
            request
                .headers
                .to_lowercase()
                .contains("authorization: bearer xoxb-example")
        );
        let body: Value = decode(&request.body).unwrap();
        assert_eq!(body["mrkdwn"], false);
        assert_eq!(body["channel"], "C123");
        assert!(
            body["text"]
                .as_str()
                .unwrap()
                .starts_with("Build\n\nPassed")
        );
    }
}
