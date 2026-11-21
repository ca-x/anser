//! Server酱 Turbo and Server酱³ notification delivery.

use anser_channel_http::{
    NetworkPolicy, append_path, bounded_body, client_with_policy, config, decode, link,
    network_error, plain_body, provider_error, reqwest::Url, status_error, truncate, url,
    validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use serde::Deserialize;
use serde_json::{Value, json};

const TITLE_LIMIT: usize = 32;
const BODY_LIMIT: usize = 32768;

#[derive(Default)]
pub struct Serverchan;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    sendkey: String,
    version: Option<Version>,
    short: Option<String>,
    tags: Option<Vec<String>>,
    channel: Option<String>,
    openid: Option<String>,
    noip: Option<bool>,
    proxy: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Version {
    Turbo,
    #[serde(rename = "3", alias = "v3")]
    Three,
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        validate_proxy(config.proxy.as_deref())?;
        if config.sendkey.len() > 200
            || !config
                .sendkey
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(config_error());
        }
        let (inferred, _) = config.route()?;
        if config.version.is_some_and(|version| version != inferred)
            || config.tags.as_ref().is_some_and(|tags| {
                inferred != Version::Three
                    || tags.len() > 12
                    || tags.iter().any(|tag| {
                        tag.is_empty()
                            || tag.len() > 32
                            || tag.contains('|')
                            || tag.chars().any(char::is_control)
                    })
            })
            || (inferred == Version::Three
                && (config.channel.is_some() || config.openid.is_some() || config.noip.is_some()))
        {
            return Err(config_error());
        }
        Ok(config)
    }

    fn route(&self) -> Result<(Version, Option<&str>), SendError> {
        if let Some(key) = self.sendkey.strip_prefix("sctp") {
            let (uid, token) = key.split_once('t').ok_or_else(config_error)?;
            if uid.is_empty()
                || uid.len() > 20
                || !uid.bytes().all(|byte| byte.is_ascii_digit())
                || token.is_empty()
            {
                return Err(config_error());
            }
            return Ok((Version::Three, Some(uid)));
        }
        if self.sendkey.starts_with("SCT") && self.sendkey.len() > 3 {
            return Ok((Version::Turbo, None));
        }
        Err(config_error())
    }

    fn base_url(&self) -> Result<Url, SendError> {
        let (_, uid) = self.route()?;
        match uid {
            Some(uid) => url(&format!("https://{uid}.push.ft07.com/send/")),
            None => url("https://sctapi.ftqq.com/"),
        }
    }
}

fn config_error() -> SendError {
    SendError::new(
        "serverchan_config",
        "check the Server酱 sendkey, version and delivery options",
        false,
    )
}

impl ChannelService for Serverchan {
    fn id(&self) -> &'static str {
        "serverchan"
    }
    fn display_name(&self) -> &'static str {
        "Server酱"
    }

    fn config_schema(&self) -> Value {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "sendkey":{"type":"string","pattern":"^(SCT[A-Za-z0-9_-]+|sctp[0-9]+t[A-Za-z0-9_-]+)$","writeOnly":true},
                "version":{"enum":["turbo","3"],"description":"Optional. Inferred from the sendkey."},
                "short":{"type":"string","maxLength":128},
                "tags":{"type":"array","maxItems":12,"items":{"type":"string"},"description":"Server酱³ tags"},
                "channel":{"type":"string","description":"Server酱 Turbo channel codes separated by |"},
                "openid":{"type":"string","description":"Server酱 Turbo supported openids"},
                "noip":{"type":"boolean","description":"Hide the server IP with Server酱 Turbo"},
                "proxy": {"type":"string","format":"uri"}
            },
            "required":["sendkey"],
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
            user_target: false,
        }
    }

    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            let config = Config::parse(&account.config)?;
            let base = config.base_url()?;
            send(&config, message, base, &NetworkPolicy::from_env()).await
        })
    }
}

fn payload(config: &Config, message: &Message) -> Result<Value, SendError> {
    let title = truncate(&message.title, TITLE_LIMIT);
    if title.trim().is_empty() {
        return Err(SendError::new(
            "serverchan_message",
            "Server酱 requires a title",
            false,
        ));
    }
    let mut body = if message.format == MessageFormat::Markdown {
        message.body.clone()
    } else {
        plain_body(message, BODY_LIMIT)
    };
    if let Some(target) = &message.url {
        let target = link(target)?;
        body.push_str(&format!("\n\n[Open](<{target}>)"));
    }

    let mut payload = json!({"title":title, "desp":truncate(&body, BODY_LIMIT)});
    if let Some(short) = &config.short {
        payload["short"] = json!(truncate(short, 128));
    }
    if let Some(tags) = &config.tags {
        payload["tags"] = json!(tags.join("|"));
    }
    if let Some(channel) = &config.channel {
        payload["channel"] = json!(channel);
    }
    if let Some(openid) = &config.openid {
        payload["openid"] = json!(openid);
    }
    if config.noip == Some(true) {
        payload["noip"] = json!(1);
    }
    Ok(payload)
}

async fn send(
    config: &Config,
    message: &Message,
    base: Url,
    network: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    let destination = append_path(base, &[&format!("{}.send", config.sendkey)])?;
    let payload = payload(config, message)?;
    let client = client_with_policy(&destination, config.proxy.as_deref(), network).await?;
    let response = client
        .post(destination)
        .json(&payload)
        .send()
        .await
        .map_err(network_error)?;
    let http_error = status_error(&response);
    let body = bounded_body(response).await;
    if let Some(mut error) = http_error {
        if let Ok(body) = body
            && let Ok(reply) = decode::<Reply>(&body)
            && reply.code != 0
        {
            error.code = format!("serverchan_{}", reply.code);
        }
        return Err(error);
    }
    let reply: Reply = decode(&body?)?;
    if reply.code != 0 {
        return Err(provider_error(
            "serverchan",
            reply.code,
            matches!(reply.code, 408 | 429 | 500..=599),
        ));
    }
    Ok(SendOutcome::Delivered)
}

#[derive(Deserialize)]
struct Reply {
    code: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock;

    #[test]
    fn routes_turbo_and_three_keys_to_their_documented_hosts() {
        let turbo = Config::parse(&json!({"sendkey":"SCTexample","version":"turbo"})).unwrap();
        assert_eq!(
            turbo.base_url().unwrap().as_str(),
            "https://sctapi.ftqq.com/"
        );
        let v3 = Config::parse(&json!({"sendkey":"sctp456tsecret","version":"3"})).unwrap();
        assert_eq!(
            v3.base_url().unwrap().as_str(),
            "https://456.push.ft07.com/send/"
        );
        assert!(Config::parse(&json!({"sendkey":"sctpfoo.exampletsecret"})).is_err());
        assert!(Config::parse(&json!({"sendkey":"SCTexample","version":"3"})).is_err());
    }

    #[tokio::test]
    async fn checks_provider_codes_even_when_the_status_is_successful() {
        let (base, received) = mock::serve(
            "200 OK",
            "",
            r#"{"code":40001,"message":"fixture credential"}"#,
        )
        .await;
        let config =
            Config::parse(&json!({"sendkey":"sctp42tfixture","tags":["red","blue"]})).unwrap();
        let base = append_path(base, &["send", ""]).unwrap();
        let message = Message {
            title: "雁字".into(),
            body: "**Anser**".into(),
            format: MessageFormat::Markdown,
            ..Message::default()
        };
        let error = send(&config, &message, base, &NetworkPolicy::new(true, vec![]))
            .await
            .unwrap_err();
        assert!(!error.retryable);
        assert_eq!(error.code, "serverchan_40001");
        assert!(!error.to_string().contains("fixture credential"));
        let received = received.await.unwrap();
        assert!(
            received
                .headers
                .starts_with("POST /send/sctp42tfixture.send ")
        );
        let body: Value = decode(&received.body).unwrap();
        assert_eq!(body["title"], "雁字");
        assert_eq!(body["desp"], "**Anser**");
        assert_eq!(body["tags"], "red|blue");
    }
}
