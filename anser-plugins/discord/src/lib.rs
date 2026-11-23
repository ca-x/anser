//! Discord incoming webhook notifications.

use anser_channel_http::{
    NetworkPolicy, client_with_policy, config, decode, network_error, plain_notification,
    reqwest::Url, response, url, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_CONTENT: usize = 2000;

#[derive(Default)]
pub struct Discord;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    webhook: String,
    proxy: Option<String>,
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        let endpoint = url(&config.webhook)?;
        let valid_path = endpoint.path_segments().is_some_and(|mut segments| {
            segments.next() == Some("api")
                && segments.next() == Some("webhooks")
                && segments.next().is_some_and(|id| {
                    !id.is_empty() && id.len() <= 32 && id.bytes().all(|byte| byte.is_ascii_digit())
                })
                && segments.next().is_some_and(|token| {
                    !token.is_empty()
                        && token.len() <= 256
                        && token
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
                })
                && segments.next().is_none()
        });
        if endpoint.scheme() != "https"
            || endpoint.port().is_some()
            || !matches!(endpoint.host_str(), Some("discord.com" | "discordapp.com"))
            || endpoint.query().is_some()
            || !valid_path
        {
            return Err(SendError::new(
                "discord_config",
                "provide an official Discord channel webhook URL",
                false,
            ));
        }
        validate_proxy(config.proxy.as_deref())?;
        Ok(config)
    }
}

impl ChannelService for Discord {
    fn id(&self) -> &'static str {
        "discord"
    }
    fn display_name(&self) -> &'static str {
        "Discord"
    }
    fn config_schema(&self) -> Value {
        json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "type":"object",
            "properties":{
                "webhook":{"type":"string","format":"uri","writeOnly":true},
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
            formats: vec![MessageFormat::Text],
            max_title_chars: None,
            max_body_chars: Some(MAX_CONTENT as u32),
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

#[derive(Deserialize)]
struct Reply {
    id: String,
}

async fn send(
    cfg: &Config,
    msg: &Message,
    mut endpoint: Url,
    policy: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    endpoint.query_pairs_mut().append_pair("wait", "true");
    let content = plain_notification(msg, MAX_CONTENT)?;
    let http = client_with_policy(&endpoint, cfg.proxy.as_deref(), policy).await?;
    let reply = http
        .post(endpoint)
        .json(&json!({"content":content,"allowed_mentions":{"parse":[]}}))
        .send()
        .await
        .map_err(network_error)?;
    let reply: Reply = decode(&response(reply).await?)?;
    if reply.id.is_empty() {
        return Err(SendError::new(
            "discord_response",
            "Discord did not return a message ID",
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
    async fn waits_for_a_message_and_suppresses_mentions() {
        let (endpoint, requests) = serve_sequence(&[
            ("200 OK", "", "{\"id\":\"11\"}"),
            ("429 Too Many Requests", "Retry-After: 2\r\n", "{}"),
            ("404 Not Found", "", "{}"),
        ])
        .await;
        let cfg = Config::parse(&json!({"webhook":"https://discord.com/api/webhooks/123/Token-x"}))
            .unwrap();
        assert!(
            Config::parse(
                &json!({"webhook":"https://discord.com.example.org/api/webhooks/123/Token-x"})
            )
            .is_err()
        );
        let msg = Message {
            body: "@everyone **Ready**".into(),
            format: MessageFormat::Markdown,
            ..Message::default()
        };
        let policy = NetworkPolicy::new(true, vec![]);
        assert_eq!(
            send(&cfg, &msg, endpoint.clone(), &policy).await.unwrap(),
            SendOutcome::Delivered
        );
        assert_eq!(
            send(&cfg, &msg, endpoint.clone(), &policy)
                .await
                .unwrap_err()
                .retry_after_ms,
            Some(2000)
        );
        assert!(
            !send(&cfg, &msg, endpoint, &policy)
                .await
                .unwrap_err()
                .retryable
        );
        let request = &requests.await.unwrap()[0];
        assert_eq!(Discord.capabilities().formats, [MessageFormat::Text]);
        assert!(request.headers.starts_with("POST /?wait=true HTTP/1.1"));
        assert_eq!(
            decode::<Value>(&request.body).unwrap(),
            json!({"content":"@everyone Ready","allowed_mentions":{"parse":[]}})
        );
    }
}
