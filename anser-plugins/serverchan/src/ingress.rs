use anser_core::{Message, MessageFormat};
use anser_plugin_api::{IngressMessage, IngressRequest, IngressRoute};
use serde::Deserialize;
use serde_json::json;

use crate::{BODY_LIMIT, TITLE_LIMIT};

pub(super) const ROUTES: &[IngressRoute] = &[
    IngressRoute {
        method: "POST",
        path: "/send",
        description: "Publish a ServerChan message using the default route",
        example: r#"curl "$ANSER_URL/v1/receive/serverchan/send" -H "Authorization: Bearer $ANSER_KEY" --data-urlencode "title=Backup" --data-urlencode "desp=Done""#,
    },
    IngressRoute {
        method: "POST",
        path: "/{topic}.send",
        description: "Publish a ServerChan message to a Topic",
        example: r#"curl "$ANSER_URL/v1/receive/serverchan/alerts.send" -H "Authorization: Bearer $ANSER_KEY" --json '{"title":"Backup","desp":"Done"}'"#,
    },
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publish {
    #[serde(alias = "text")]
    title: String,
    #[serde(default)]
    desp: String,
    short: Option<String>,
    tags: Option<String>,
}

pub(super) fn decode(request: IngressRequest<'_>) -> Result<IngressMessage, &'static str> {
    if request.method != "POST" {
        return Err("Unsupported ServerChan publish method");
    }
    let topic = if request.path == "/send" {
        None
    } else {
        let topic = request
            .path
            .strip_prefix('/')
            .and_then(|s| s.strip_suffix(".send"))
            .ok_or("Invalid ServerChan publish path")?;
        // Provider SendKeys belong only in outbound accounts. Never look one up
        // as an Anser Topic or propagate it to the notification record.
        let normalized = topic.to_ascii_uppercase();
        if normalized.starts_with("SCT") || normalized.starts_with("SCK") {
            return Err("Use a public Anser Topic name in the publish path");
        }
        if matches!(topic, "" | "." | "..")
            || topic.len() > 128
            || !topic
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        {
            return Err("Invalid ServerChan Topic name");
        }
        Some(topic.to_owned())
    };
    let content_type = request
        .headers
        .get("content-type")
        .and_then(|v| v.split(';').next())
        .unwrap_or_default()
        .trim();
    let data: Publish = if content_type.eq_ignore_ascii_case("application/json") {
        serde_json::from_slice(request.body)
            .map_err(|_| "Invalid ServerChan JSON or unsupported field")?
    } else if content_type.eq_ignore_ascii_case("application/x-www-form-urlencoded") {
        serde_urlencoded::from_bytes(request.body)
            .map_err(|_| "Invalid ServerChan form or unsupported field")?
    } else {
        return Err("ServerChan requires a JSON or URL-encoded form body");
    };
    if data.title.trim().is_empty()
        || data.title.chars().count() > TITLE_LIMIT
        || data.desp.len() > BODY_LIMIT
        || data
            .short
            .as_deref()
            .is_some_and(|v| v.chars().count() > 128)
    {
        return Err("Invalid ServerChan title, description or summary length");
    }
    let tags: Vec<_> = data
        .tags
        .as_deref()
        .filter(|v| !v.is_empty())
        .into_iter()
        .flat_map(|v| v.split('|'))
        .map(str::to_owned)
        .collect();
    if tags.len() > 12
        || tags
            .iter()
            .any(|v| v.is_empty() || v.len() > 32 || v.chars().any(char::is_control))
    {
        return Err("Invalid ServerChan tags");
    }
    Ok(IngressMessage {
        topic,
        message: Message {
            title: data.title,
            body: data.desp,
            tags,
            format: MessageFormat::Markdown,
            extras: data
                .short
                .map_or(serde_json::Value::Null, |v| json!({"serverchan_short":v})),
            ..Message::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Serverchan;
    use anser_core::api::Receipt;
    use anser_plugin_api::ChannelService;
    use std::collections::BTreeMap;

    fn receive(
        path: &str,
        content_type: &str,
        body: &[u8],
    ) -> Result<IngressMessage, &'static str> {
        let headers = BTreeMap::from([("content-type".to_owned(), content_type.to_owned())]);
        decode(IngressRequest {
            method: "POST",
            path,
            headers: &headers,
            body,
        })
    }

    #[test]
    fn accepts_forms_and_returns_native_success_with_anser_id() {
        let incoming = receive(
            "/weekly.ops.send",
            "application/x-www-form-urlencoded; charset=UTF-8",
            b"title=%E5%91%A8%E6%8A%A5&desp=build+finished&tags=a%7Cb&short=ready",
        )
        .unwrap();
        assert_eq!(incoming.topic.as_deref(), Some("weekly.ops"));
        assert_eq!(incoming.message.title, "周报");
        assert_eq!(incoming.message.body, "build finished");
        assert_eq!(incoming.message.tags, ["a", "b"]);
        assert_eq!(incoming.message.extras["serverchan_short"], "ready");
        let receipt = Receipt {
            message_id: "fixture-id".into(),
            status: "pending".into(),
        };
        let reply = Serverchan.ingress_response(&incoming, &receipt);
        assert_eq!(reply["data"]["pushid"], "fixture-id");
        assert_eq!(reply["code"], 0);
    }

    #[test]
    fn json_send_uses_default_routing_and_accepts_the_text_alias() {
        let incoming =
            receive("/send", "application/json", br#"{"text":"Build finished"}"#).unwrap();
        assert_eq!(incoming.message.title, "Build finished");
        assert!(incoming.topic.is_none());
    }

    #[test]
    fn rejects_provider_credentials_and_unsupported_destination_overrides() {
        for path in [
            "/SCTexample.send",
            "/sctp123texample.send",
            "/SCKexample.send",
            "/a/b.send",
        ] {
            assert!(receive(path, "application/json", br#"{"title":"ok"}"#).is_err());
        }
        assert!(
            receive(
                "/send",
                "application/x-www-form-urlencoded",
                b"title=first&title=second"
            )
            .is_err()
        );
        assert!(
            receive(
                "/send",
                "application/json",
                br#"{"title":"ok","openid":"private"}"#
            )
            .is_err()
        );
        assert!(receive("/send", "text/plain", b"title=ok").is_err());
        assert!(receive("/send", "application/json", br#"{"title":" "}"#).is_err());
    }
}
