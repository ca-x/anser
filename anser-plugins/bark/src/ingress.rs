//! Bark's JSON push envelope, routed by the Anser host.
use anser_core::Message;
use anser_plugin_api::{IngressMessage, IngressRequest, IngressRoute};
use serde::Deserialize;

pub(super) const ROUTES: &[IngressRoute] = &[IngressRoute {
    method: "POST",
    path: "/push",
    description: "Publish a Bark JSON notification using the default route or X-Anser-Topic.",
    example: r#"curl "$ANSER_URL/v1/receive/bark/push" -H "Authorization: Bearer $ANSER_KEY" -H "Content-Type: application/json" -d '{"title":"Backup","body":"Complete"}'"#,
}];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Push {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    url: Option<String>,
    group: Option<String>,
    level: Option<String>,
    device_key: Option<String>,
}

pub(super) fn decode(request: IngressRequest<'_>) -> Result<IngressMessage, &'static str> {
    let input: Push =
        serde_json::from_slice(request.body).map_err(|_| "Expected a supported Bark JSON push")?;
    if input
        .device_key
        .as_deref()
        .is_some_and(|key| key != "default")
    {
        return Err("Use the placeholder default or omit device_key");
    }
    if input.title.trim().is_empty() && input.body.trim().is_empty() {
        return Err("A title or body is required");
    }
    Ok(IngressMessage {
        topic: None,
        message: Message {
            title: input.title,
            body: input.body,
            url: input.url,
            level: input.level,
            tags: input.group.into_iter().collect(),
            ..Default::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_device_credentials_and_preserves_group() {
        let headers = Default::default();
        let parse = |body| {
            decode(IngressRequest {
                headers: &headers,
                method: "POST",
                path: "/push",
                body,
            })
        };
        assert!(parse(br#"{"device_key":"provider-key","body":"hello"}"#).is_err());
        let parsed = parse(br#"{"body":"hello","group":"backup","device_key":"default"}"#).unwrap();
        assert_eq!(parsed.message.tags, ["backup"]);
        assert!(parsed.topic.is_none());
    }
}
