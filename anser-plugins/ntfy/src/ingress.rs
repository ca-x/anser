use std::time::{SystemTime, UNIX_EPOCH};

use anser_channel_http::link;
use anser_core::{Attachment, Message, MessageFormat, api::Receipt};
use anser_plugin_api::{IngressMessage, IngressRequest, IngressRoute};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{MESSAGE_LIMIT, TITLE_LIMIT, valid_topic};

pub(super) const ROUTES: &[IngressRoute] = &[
    IngressRoute {
        method: "POST",
        path: "/",
        description: "Publish an ntfy JSON message",
        example: r#"curl "$ANSER_URL/v1/receive/ntfy/" -H "Authorization: Bearer $ANSER_KEY" --json '{"topic":"alerts","title":"Backup","message":"Done"}'"#,
    },
    IngressRoute {
        method: "POST",
        path: "/{topic}",
        description: "Publish UTF-8 text to a Topic",
        example: r#"curl "$ANSER_URL/v1/receive/ntfy/alerts" -H "Authorization: Bearer $ANSER_KEY" -H "Title: Backup" -d "Done""#,
    },
    IngressRoute {
        method: "PUT",
        path: "/{topic}",
        description: "Publish UTF-8 text to a Topic",
        example: r#"curl -X PUT "$ANSER_URL/v1/receive/ntfy/alerts" -H "Authorization: Bearer $ANSER_KEY" -d "Done""#,
    },
];

pub(super) const HEADERS: &[&str] = &[
    "content-type",
    "title",
    "x-title",
    "t",
    "tags",
    "x-tags",
    "ta",
    "priority",
    "x-priority",
    "prio",
    "p",
    "markdown",
    "x-markdown",
    "md",
    "click",
    "x-click",
    "attach",
    "x-attach",
    "a",
    "filename",
    "x-filename",
    "file",
    "f",
    "delay",
    "x-delay",
    "at",
    "x-at",
    "in",
    "x-in",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publish {
    topic: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    tags: Vec<String>,
    priority: Option<u8>,
    #[serde(default)]
    markdown: bool,
    click: Option<String>,
    attach: Option<String>,
    filename: Option<String>,
}

fn priority(value: &str) -> Result<u8, &'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "min" => Ok(1),
        "2" | "low" => Ok(2),
        "3" | "default" => Ok(3),
        "4" | "high" => Ok(4),
        "5" | "max" | "urgent" => Ok(5),
        _ => Err("Invalid ntfy priority"),
    }
}

pub(super) fn decode(request: IngressRequest<'_>) -> Result<IngressMessage, &'static str> {
    let header = |aliases: &[&str]| {
        aliases
            .iter()
            .find_map(|key| request.headers.get(*key).map(String::as_str))
    };
    if header(&["delay", "x-delay", "at", "x-at", "in", "x-in"]).is_some() {
        return Err("Scheduled ntfy publication is unsupported");
    }
    let data: Publish = match (request.method, request.path) {
        ("POST", "/") => serde_json::from_slice(request.body)
            .map_err(|_| "Invalid ntfy JSON payload or unsupported field")?,
        ("POST" | "PUT", path) => {
            let topic = path
                .strip_prefix('/')
                .filter(|topic| valid_topic(topic))
                .ok_or("Invalid ntfy topic")?;
            if request.body.len() > MESSAGE_LIMIT {
                return Err("ntfy message exceeds 4096 bytes");
            }
            let markdown = match header(&["x-markdown", "markdown", "md"])
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("true" | "yes" | "on" | "1") => true,
                Some("false" | "no" | "off" | "0") => false,
                None => header(&["content-type"]).is_some_and(|s| {
                    s.split(';')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .eq_ignore_ascii_case("text/markdown")
                }),
                _ => return Err("Invalid ntfy Markdown flag"),
            };
            Publish {
                topic: topic.into(),
                message: std::str::from_utf8(request.body)
                    .map_err(|_| "ntfy message must be UTF-8")?
                    .into(),
                title: header(&["x-title", "title", "t"])
                    .unwrap_or_default()
                    .into(),
                tags: header(&["x-tags", "tags", "ta"])
                    .into_iter()
                    .flat_map(|v| v.split(','))
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
                    .collect(),
                priority: header(&["x-priority", "priority", "prio", "p"])
                    .map(priority)
                    .transpose()?,
                markdown,
                click: header(&["x-click", "click"]).map(str::to_owned),
                attach: header(&["x-attach", "attach", "a"]).map(str::to_owned),
                filename: header(&["x-filename", "filename", "file", "f"]).map(str::to_owned),
            }
        }
        _ => return Err("Unsupported ntfy publish route"),
    };
    if !valid_topic(&data.topic)
        || data.title.len() > TITLE_LIMIT
        || data.message.len() > MESSAGE_LIMIT
    {
        return Err("Invalid ntfy topic, title or message length");
    }
    if data.priority.is_some_and(|p| !(1..=5).contains(&p)) {
        return Err("Invalid ntfy priority");
    }
    if data.filename.is_some() && data.attach.is_none() {
        return Err("ntfy filename requires an attachment URL");
    }
    for url in data.click.iter().chain(&data.attach) {
        link(url).map_err(|_| "Invalid ntfy link")?;
    }
    let level = data.priority.map(|p| {
        match p {
            1 | 2 => "debug",
            3 => "info",
            4 => "warn",
            _ => "error",
        }
        .to_owned()
    });
    Ok(IngressMessage {
        topic: Some(data.topic),
        message: Message {
            title: data.title,
            body: data.message,
            format: if data.markdown {
                MessageFormat::Markdown
            } else {
                MessageFormat::Text
            },
            tags: data.tags,
            url: data.click,
            level,
            attachments: data
                .attach
                .into_iter()
                .map(|url| Attachment {
                    url,
                    name: data.filename.clone(),
                    content_type: None,
                })
                .collect(),
            extras: data
                .priority
                .map_or(Value::Null, |priority| json!({"ntfy_priority":priority})),
        },
    })
}

pub(super) fn response(input: &IngressMessage, receipt: &Receipt) -> Value {
    let message = &input.message;
    let mut body = json!({
        "id": receipt.message_id, "time": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        "event": "message", "topic": input.topic, "message": message.body
    });
    if !message.title.is_empty() {
        body["title"] = json!(message.title);
    }
    if !message.tags.is_empty() {
        body["tags"] = json!(message.tags);
    }
    if let Some(priority) = message.extras.get("ntfy_priority") {
        body["priority"] = priority.clone();
    }
    if let Some(click) = &message.url {
        body["click"] = json!(click);
    }
    if message.format == MessageFormat::Markdown {
        body["content_type"] = json!("text/markdown");
    }
    if let Some(attachment) = message.attachments.first() {
        body["attachment"] = json!({"url": attachment.url, "name": attachment.name});
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn receive(
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<IngressMessage, &'static str> {
        let headers: BTreeMap<_, _> = headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        decode(IngressRequest {
            method,
            path,
            headers: &headers,
            body,
        })
    }

    #[test]
    fn decodes_json_and_returns_an_ntfy_event_with_the_queue_id() {
        let incoming = receive("POST", "/", &[], br#"{"topic":"deploy","title":"Ready","message":"**Built**","markdown":true,"priority":4,"tags":["done"],"attach":"https://example.org/log","filename":"build.log","click":"https://example.org/"}"#).unwrap();
        assert_eq!(incoming.message.format, MessageFormat::Markdown);
        assert_eq!(incoming.message.level.as_deref(), Some("warn"));
        let receipt = Receipt {
            message_id: "queue-id".into(),
            status: "pending".into(),
        };
        let reply = response(&incoming, &receipt);
        assert_eq!(reply["id"], "queue-id");
        assert_eq!(reply["event"], "message");
        assert_eq!(reply["topic"], "deploy");
        assert_eq!(reply["attachment"]["name"], "build.log");
        assert_eq!(reply["priority"], 4);
        assert!(reply["time"].as_u64().unwrap() > 0);
    }

    #[test]
    fn accepts_topic_posts_and_puts_with_ntfy_header_aliases() {
        for method in ["POST", "PUT"] {
            let incoming = receive(
                method,
                "/deploy",
                &[
                    ("t", "发布"),
                    ("p", "high"),
                    ("x-tags", "a, b"),
                    ("content-type", "text/markdown; charset=utf-8"),
                ],
                "已完成".as_bytes(),
            )
            .unwrap();
            assert_eq!(incoming.topic.as_deref(), Some("deploy"));
            assert_eq!(incoming.message.body, "已完成");
            assert_eq!(incoming.message.title, "发布");
            assert_eq!(incoming.message.tags, ["a", "b"]);
            assert_eq!(incoming.message.format, MessageFormat::Markdown);
            assert_eq!(incoming.message.extras["ntfy_priority"], 4);
        }
    }

    #[test]
    fn invalid_messages_do_not_generate_drafts() {
        assert!(receive("GET", "/topic", &[], b"text").is_err());
        assert!(receive("PUT", "/topic", &[], &[0xff]).is_err());
        assert!(receive("PUT", "/a/b", &[], b"text").is_err());
        assert!(receive("POST", "/topic", &[("delay", "1h")], b"sensitive").is_err());
        assert!(
            receive(
                "POST",
                "/topic",
                &[("x-click", "file:///tmp/file")],
                b"text"
            )
            .is_err()
        );
        assert!(receive("POST", "/topic", &[("p", "6")], b"text").is_err());
        assert!(receive("POST", "/topic", &[], &[b'X'; MESSAGE_LIMIT + 1]).is_err());
        assert!(
            receive(
                "POST",
                "/",
                &[],
                br#"{"topic":"news","message":"hello","email":"x@y.test"}"#
            )
            .is_err()
        );
    }
}
