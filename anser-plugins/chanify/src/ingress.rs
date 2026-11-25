use anser_core::Message;
use anser_plugin_api::{IngressMessage, IngressRequest, IngressRoute};
use serde::Deserialize;
use serde_json::json;

use crate::{MAX_TEXT, MAX_TITLE};

pub(super) const ROUTES: &[IngressRoute] = &[IngressRoute {
    method: "POST",
    path: "/v1/sender",
    description: "Send a Chanify text notification through the default route",
    example: r#"curl "$ANSER_URL/v1/receive/chanify/v1/sender" -H "token: $ANSER_KEY" --json '{"text":"Build finished","title":"CI"}'"#,
}];

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Publish {
    #[serde(default)]
    title: String,
    text: String,
    sound: Option<u8>,
    priority: Option<u8>,
}

pub(super) fn decode(request: IngressRequest<'_>) -> Result<IngressMessage, &'static str> {
    if request.method != "POST" || request.path != "/v1/sender" {
        return Err("Unsupported Chanify sender route");
    }
    let kind = request
        .headers
        .get("content-type")
        .and_then(|v| v.split(';').next())
        .unwrap_or("text/plain")
        .trim();
    let publish: Publish = if kind.eq_ignore_ascii_case("application/json") {
        serde_json::from_slice(request.body)
            .map_err(|_| "Invalid Chanify JSON or unsupported field")?
    } else if kind.eq_ignore_ascii_case("application/x-www-form-urlencoded") {
        serde_urlencoded::from_bytes(request.body)
            .map_err(|_| "Invalid Chanify form or unsupported field")?
    } else if kind.eq_ignore_ascii_case("text/plain") {
        if request.body.len() > MAX_TEXT {
            return Err("Chanify text exceeds 1500 bytes");
        }
        Publish {
            text: std::str::from_utf8(request.body)
                .map_err(|_| "Chanify text must be UTF-8")?
                .to_owned(),
            ..Publish::default()
        }
    } else {
        return Err("Chanify requires UTF-8 text, JSON or a URL-encoded form");
    };
    if publish.text.trim().is_empty()
        || publish.text.len() > MAX_TEXT
        || publish.title.len() > MAX_TITLE
    {
        return Err("Invalid Chanify text or title length");
    }
    if publish.sound.is_some_and(|s| s > 1)
        || publish.priority.is_some_and(|v| !matches!(v, 5 | 10))
    {
        return Err("Invalid Chanify sound or priority");
    }
    let mut extras = json!({});
    if let Some(sound) = publish.sound {
        extras["chanify_sound"] = json!(sound);
    }
    if let Some(priority) = publish.priority {
        extras["chanify_priority"] = json!(priority);
    }
    Ok(IngressMessage {
        topic: None,
        message: Message {
            title: publish.title,
            body: publish.text,
            level: publish
                .priority
                .map(|v| if v == 5 { "debug" } else { "info" }.to_owned()),
            extras,
            ..Message::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Chanify;
    use anser_core::api::Receipt;
    use anser_plugin_api::ChannelService;
    use std::collections::BTreeMap;
    fn receive(kind: &str, body: &[u8]) -> Result<IngressMessage, &'static str> {
        let headers = BTreeMap::from([("content-type".into(), kind.into())]);
        decode(IngressRequest {
            method: "POST",
            path: "/v1/sender",
            headers: &headers,
            body,
        })
    }

    #[test]
    fn parses_native_text_json_and_form_with_default_routing() {
        let text = receive("text/plain; charset=utf-8", "完成".as_bytes()).unwrap();
        assert!(text.topic.is_none());
        assert_eq!(text.message.body, "完成");
        let json = receive(
            "application/json",
            br#"{"title":"CI","text":"Test","priority":5,"sound":1}"#,
        )
        .unwrap();
        assert_eq!(json.message.title, "CI");
        assert_eq!(json.message.extras["chanify_sound"], 1);
        assert_eq!(json.message.level.as_deref(), Some("debug"));
        let form = receive(
            "application/x-www-form-urlencoded",
            b"title=CI&text=build+done&sound=0",
        )
        .unwrap();
        assert_eq!(form.message.body, "build done");
        let reply = Chanify.ingress_response(
            &text,
            &Receipt {
                message_id: "queue-id".into(),
                status: "pending".into(),
            },
        );
        assert_eq!(reply["request-uid"], "queue-id");
        assert_eq!(reply["res"], 0);
    }

    #[test]
    fn rejects_secret_fields_unknown_destinations_and_invalid_text() {
        for body in [
            r#"{"text":"ok","token":"private"}"#,
            r#"{"text":"ok","topic":"other"}"#,
            r#"{"text":"ok","priority":2}"#,
        ] {
            assert!(receive("application/json", body.as_bytes()).is_err());
        }
        assert!(receive("application/x-www-form-urlencoded", b"text=ok&token=secret").is_err());
        assert!(receive("text/plain", &[0xff]).is_err());
        assert!(receive("text/plain", &[b'x'; MAX_TEXT + 1]).is_err());
        assert!(receive("image/jpeg", b"text").is_err());
    }
}
