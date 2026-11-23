//! IFTTT Maker Webhooks notifications.

use anser_channel_http::{
    NetworkPolicy, append_path, client_with_policy, config, link, network_error, plain_body,
    reqwest::Url, response, truncate, url, validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_VALUE: usize = 4096;

#[derive(Default)]
pub struct Ifttt;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    event_name: String,
    webhook_key: String,
    proxy: Option<String>,
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        for (value, max) in [(&config.event_name, 64), (&config.webhook_key, 256)] {
            if value.is_empty()
                || value.len() > max
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            {
                return Err(SendError::new(
                    "ifttt_config",
                    "provide an IFTTT event name and Webhooks key",
                    false,
                ));
            }
        }
        validate_proxy(config.proxy.as_deref())?;
        Ok(config)
    }
}

impl ChannelService for Ifttt {
    fn id(&self) -> &'static str {
        "ifttt"
    }
    fn display_name(&self) -> &'static str {
        "IFTTT"
    }
    fn config_schema(&self) -> Value {
        json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "type":"object",
            "properties":{
                "event_name":{"type":"string","pattern":"^[A-Za-z0-9_-]+$","maxLength":64},
                "webhook_key":{"type":"string","pattern":"^[A-Za-z0-9_-]+$","maxLength":256,"format":"password","writeOnly":true},
                "proxy":{"type":"string","format":"uri","writeOnly":true}
            },
            "required":["event_name","webhook_key"],"additionalProperties":false
        })
    }
    fn validate_config(&self, value: &Value) -> Result<(), SendError> {
        Config::parse(value).map(|_| ())
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text],
            max_title_chars: Some(MAX_VALUE as u32),
            max_body_chars: Some(MAX_VALUE as u32),
            attachments: false,
            user_target: false,
        }
    }
    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            send(
                &Config::parse(&account.config)?,
                message,
                url("https://maker.ifttt.com/")?,
                &NetworkPolicy::from_env(),
            )
            .await
        })
    }
}

async fn send(
    cfg: &Config,
    msg: &Message,
    base: Url,
    policy: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    let endpoint = append_path(
        base,
        &["trigger", &cfg.event_name, "with", "key", &cfg.webhook_key],
    )?;
    let href = msg.url.as_deref().map(link).transpose()?;
    let http = client_with_policy(&endpoint, cfg.proxy.as_deref(), policy).await?;
    let reply = http
        .post(endpoint)
        .json(&json!({
            "value1":truncate(msg.title.trim(),MAX_VALUE),
            "value2":plain_body(msg,MAX_VALUE),
            "value3":href.as_ref().map_or("",Url::as_str)
        }))
        .send()
        .await
        .map_err(network_error)?;
    response(reply).await?;
    Ok(SendOutcome::Delivered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::{decode, mock::serve_sequence};
    #[tokio::test]
    async fn sends_the_three_webhook_values_and_keeps_the_key_out_of_errors() {
        let (root, requests) = serve_sequence(&[
            (
                "200 OK",
                "",
                "Congratulations! You've fired the notification event",
            ),
            ("403 Forbidden", "", "key=private_fixture"),
        ])
        .await;
        let cfg =
            Config::parse(&json!({"event_name":"notification","webhook_key":"private_fixture"}))
                .unwrap();
        let msg = Message {
            title: "Build".into(),
            body: "Ready".into(),
            url: Some("https://example.com/build".into()),
            ..Message::default()
        };
        let policy = NetworkPolicy::new(true, vec![]);
        assert_eq!(
            send(&cfg, &msg, root.clone(), &policy).await.unwrap(),
            SendOutcome::Delivered
        );
        let error = send(&cfg, &msg, root, &policy).await.unwrap_err();
        assert!(!error.retryable);
        assert!(!error.message.contains("private_fixture"));
        let request = &requests.await.unwrap()[0];
        assert!(
            request
                .headers
                .starts_with("POST /trigger/notification/with/key/private_fixture HTTP/1.1")
        );
        assert_eq!(
            decode::<Value>(&request.body).unwrap(),
            json!({"value1":"Build","value2":"Ready","value3":"https://example.com/build"})
        );
    }
}
