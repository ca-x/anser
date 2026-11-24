//! Telegram Bot API notification delivery.

use anser_channel_http::{
    NetworkPolicy, append_path, bounded_body, client_with_policy, config, decode, link,
    network_error, plain_body, provider_error, reqwest::Url, status_error, truncate, url,
    validate_proxy,
};
use anser_core::{ChannelAccount, Message, MessageFormat};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendFuture, SendOutcome};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_TEXT: usize = 4096;

#[derive(Default)]
pub struct Telegram;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    bot_token: String,
    chat_id: ChatId,
    parse_mode: Option<ParseMode>,
    proxy: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum ChatId {
    Numeric(i64),
    Text(String),
}

#[derive(Clone, Copy, Deserialize, Serialize)]
enum ParseMode {
    #[serde(rename = "html", alias = "HTML")]
    Html,
    #[serde(rename = "markdown", alias = "Markdown")]
    Markdown,
    #[serde(rename = "markdown_v2", alias = "MarkdownV2")]
    MarkdownV2,
}

impl ParseMode {
    fn as_api_str(self) -> &'static str {
        match self {
            Self::Html => "HTML",
            Self::Markdown => "Markdown",
            Self::MarkdownV2 => "MarkdownV2",
        }
    }

    fn matches(self, format: MessageFormat) -> bool {
        matches!(
            (self, format),
            (Self::Html, MessageFormat::Html)
                | (Self::Markdown | Self::MarkdownV2, MessageFormat::Markdown)
        )
    }
}

impl Config {
    fn parse(value: &Value) -> Result<Self, SendError> {
        let config: Self = config(value)?;
        validate_proxy(config.proxy.as_deref())?;
        let valid_token = config
            .bot_token
            .split_once(':')
            .is_some_and(|(bot, secret)| {
                !bot.is_empty()
                    && bot.len() <= 32
                    && bot.bytes().all(|byte| byte.is_ascii_digit())
                    && !secret.is_empty()
                    && secret.len() <= 128
                    && secret
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            });
        let valid_chat = match &config.chat_id {
            ChatId::Numeric(chat) => *chat != 0,
            ChatId::Text(chat) => {
                chat.parse::<i64>().is_ok_and(|chat| chat != 0)
                    || chat.strip_prefix('@').is_some_and(|name| {
                        !name.is_empty()
                            && name.len() <= 64
                            && name
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    })
            }
        };
        if !valid_token || !valid_chat {
            return Err(SendError::new(
                "telegram_config",
                "configure a Bot API token and a chat ID or @channel username",
                false,
            ));
        }
        Ok(config)
    }
}

impl ChannelService for Telegram {
    fn id(&self) -> &'static str {
        "telegram"
    }
    fn display_name(&self) -> &'static str {
        "Telegram"
    }

    fn config_schema(&self) -> Value {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "x-anser-version": env!("CARGO_PKG_VERSION"),
            "type": "object",
            "x-anser-ui": {"label":{"en":"Telegram","zh-CN":"Telegram"},"account_editor": {"fields":["chat_id","parse_mode"],"credentials":{"bot_token":[]}}},
            "properties": {
                "bot_token": {"x-anser-ui":{"label":{"en":"Bot token","zh-CN":"机器人令牌"}},"type": "string", "pattern":"^[0-9]+:[A-Za-z0-9_-]+$", "writeOnly": true},
                "chat_id": {"x-anser-ui":{"label":{"en":"Chat ID or username","zh-CN":"会话 ID 或用户名"}},"oneOf":[{"type":"integer"},{"type":"string","pattern":"^(-?[0-9]+|@[A-Za-z0-9_]+)$"}]},
                "parse_mode": {"x-anser-ui":{"label":{"en":"Formatting mode","zh-CN":"格式解析方式"},"option_labels":{"html":{"en":"HTML","zh-CN":"HTML"},"markdown":{"en":"Markdown","zh-CN":"Markdown"},"markdown_v2":{"en":"Markdown V2","zh-CN":"Markdown V2"}}},"enum":["html","markdown","markdown_v2"]},
                "proxy": {"type": "string", "format": "uri", "writeOnly": true}
            },
            "required": ["bot_token", "chat_id"],
            "additionalProperties": false
        })
    }

    fn validate_config(&self, config: &Value) -> Result<(), SendError> {
        Config::parse(config).map(|_| ())
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![
                MessageFormat::Text,
                MessageFormat::Markdown,
                MessageFormat::Html,
            ],
            max_title_chars: None,
            max_body_chars: Some(MAX_TEXT as u32),
            attachments: false,
            user_target: true,
        }
    }

    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a> {
        Box::pin(async move {
            let config = Config::parse(&account.config)?;
            send(
                &config,
                message,
                url("https://api.telegram.org/")?,
                &NetworkPolicy::from_env(),
            )
            .await
        })
    }
}

fn compose(title: &str, body: &str) -> String {
    match (title.is_empty(), body.is_empty()) {
        (_, true) => title.into(),
        (true, false) => body.into(),
        (false, false) => format!("{title}\n\n{body}"),
    }
}

fn escape_title(title: &str, mode: ParseMode) -> String {
    let mut escaped = String::with_capacity(title.len());
    let reserved = match mode {
        ParseMode::Html => "",
        ParseMode::Markdown => "_*`[",
        ParseMode::MarkdownV2 => "_*[]()~`>#+-=|{}.!\\",
    };
    for ch in title.chars() {
        match (mode, ch) {
            (ParseMode::Html, '&') => escaped.push_str("&amp;"),
            (ParseMode::Html, '<') => escaped.push_str("&lt;"),
            (ParseMode::Html, '>') => escaped.push_str("&gt;"),
            _ => {
                if reserved.contains(ch) {
                    escaped.push('\\');
                }
                escaped.push(ch);
            }
        }
    }
    escaped
}

fn payload(config: &Config, message: &Message) -> Result<Value, SendError> {
    let marked = config
        .parse_mode
        .filter(|mode| mode.matches(message.format))
        .and_then(|mode| {
            let text = compose(&escape_title(&message.title, mode), &message.body);
            (text.encode_utf16().count() <= MAX_TEXT).then_some((mode, text))
        });
    let (mode, text) = if let Some((mode, marked)) = marked {
        (Some(mode.as_api_str()), marked)
    } else {
        let body = plain_body(message, MAX_TEXT);
        // Leave room for a truncation mark and honor the stricter UTF-16 count.
        let full = compose(&message.title, &body);
        let count = full
            .char_indices()
            .scan(0usize, |used, (index, ch)| {
                *used += ch.len_utf16();
                Some((index, *used))
            })
            .take_while(|(_, used)| *used < MAX_TEXT)
            .count();
        let text = if full.encode_utf16().count() > MAX_TEXT {
            truncate(&full, count + 1)
        } else {
            full
        };
        (None, text)
    };
    if text.trim().is_empty() {
        return Err(SendError::new(
            "telegram_message",
            "Telegram requires a title or message body",
            false,
        ));
    }
    let mut payload = json!({"chat_id": config.chat_id, "text": text});
    if let Some(mode) = mode {
        payload["parse_mode"] = json!(mode);
    }
    if let Some(target) = &message.url {
        let target = link(target)?;
        payload["reply_markup"] =
            json!({"inline_keyboard": [[{"text": "Open", "url": target.as_str()}]]});
    }
    Ok(payload)
}

async fn send(
    config: &Config,
    message: &Message,
    base: Url,
    network: &NetworkPolicy,
) -> Result<SendOutcome, SendError> {
    let endpoint = append_path(base, &[&format!("bot{}", config.bot_token), "sendMessage"])?;
    let payload = payload(config, message)?;
    let client = client_with_policy(&endpoint, config.proxy.as_deref(), network).await?;
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(network_error)?;
    let http_error = status_error(&response);
    let body = bounded_body(response).await;
    if let Some(mut error) = http_error {
        if let Ok(body) = body {
            let parsed: Result<Reply, _> = decode(&body);
            if let Ok(reply) = parsed {
                if error.retry_after_ms.is_none() {
                    error.retry_after_ms = reply.retry_after_ms();
                }
                if let Some(code) = reply.error_code {
                    error.code = format!("telegram_{code}");
                }
            }
        }
        return Err(error);
    }
    let reply: Reply = decode(&body?)?;
    if !reply.ok {
        let code = reply.error_code.unwrap_or_default();
        let mut error = provider_error("telegram", code, matches!(code, 408 | 429 | 500..=599));
        error.retry_after_ms = reply.retry_after_ms();
        return Err(error);
    }
    Ok(SendOutcome::Delivered)
}

#[derive(Deserialize)]
struct Reply {
    ok: bool,
    error_code: Option<i64>,
    parameters: Option<Parameters>,
}

#[derive(Deserialize)]
struct Parameters {
    retry_after: Option<u64>,
}

impl Reply {
    fn retry_after_ms(&self) -> Option<u64> {
        self.parameters
            .as_ref()?
            .retry_after
            .map(|seconds| seconds.saturating_mul(1000))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anser_channel_http::mock;

    #[tokio::test]
    async fn recognizes_rate_limit_metadata_from_the_bot_api() {
        let (base, received) = mock::serve("429 Too Many Requests", "", r#"{"ok":false,"error_code":429,"parameters":{"retry_after":7},"description":"do not leak"}"#).await;
        let config =
            Config::parse(&json!({"bot_token":"1:fixture","chat_id":-123,"parse_mode":"html"}))
                .unwrap();
        let message = Message {
            title: "A & B".into(),
            body: "<b>hello</b>".into(),
            format: MessageFormat::Html,
            ..Message::default()
        };
        let error = send(&config, &message, base, &NetworkPolicy::new(true, vec![]))
            .await
            .unwrap_err();
        assert!(error.retryable);
        assert_eq!(error.code, "telegram_429");
        assert_eq!(error.retry_after_ms, Some(7000));
        assert!(!error.to_string().contains("do not leak"));
        let received = received.await.unwrap();
        assert!(
            received
                .headers
                .starts_with("POST /bot1:fixture/sendMessage ")
        );
        let body: Value = decode(&received.body).unwrap();
        assert_eq!(body["text"], "A &amp; B\n\n<b>hello</b>");
        assert_eq!(body["parse_mode"], "HTML");
    }
}
