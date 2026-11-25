//! Channel-owned compatibility protocols. Routing and credentials belong to the host.
use std::collections::BTreeMap;

use anser_core::Message;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelDirection {
    Ingress,
    #[default]
    Egress,
    Bidirectional,
}

impl ChannelDirection {
    pub fn supports_ingress(self) -> bool {
        self != Self::Egress
    }
    pub fn supports_egress(self) -> bool {
        self != Self::Ingress
    }
}

pub struct IngressRoute {
    pub method: &'static str,
    pub path: &'static str,
    pub description: &'static str,
    pub example: &'static str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RouteInfo {
    pub method: String,
    pub path: String,
    pub description: String,
    pub example: Option<String>,
}

impl From<&IngressRoute> for RouteInfo {
    fn from(route: &IngressRoute) -> Self {
        Self {
            method: route.method.into(),
            path: route.path.into(),
            description: route.description.into(),
            example: Some(route.example.into()),
        }
    }
}

impl RouteInfo {
    /// A placeholder consumes a nonempty portion of exactly one path segment.
    pub fn matches_path(&self, path: &str) -> bool {
        let mut actual = path.split('/');
        for pattern in self.path.split('/') {
            let Some(value) = actual.next() else {
                return false;
            };
            if let Some((prefix, rest)) = pattern.split_once('{')
                && let Some((_, suffix)) = rest.split_once('}')
            {
                if value
                    .strip_prefix(prefix)
                    .and_then(|v| v.strip_suffix(suffix))
                    .is_none_or(str::is_empty)
                {
                    return false;
                }
            } else if value != pattern {
                return false;
            }
        }
        actual.next().is_none()
    }
}

pub struct IngressRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: &'a BTreeMap<String, String>,
    pub body: &'a [u8],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IngressMessage {
    pub topic: Option<String>,
    pub message: Message,
}

/// Immutable discovery data exchanged across the named rutis service boundary.
#[derive(Default, Deserialize, Serialize)]
pub struct ReceiveProtocol {
    pub direction: ChannelDirection,
    pub routes: Vec<RouteInfo>,
    pub headers: Vec<String>,
    pub token_header: Option<String>,
}

impl ReceiveProtocol {
    /// Only declared message headers may cross the rutis boundary. Require a
    /// canonical spelling before comparing any credential or reserved name.
    pub fn valid_headers(&self) -> bool {
        fn permitted(name: &str) -> bool {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && !name.starts_with("x-anser-")
                && !name.starts_with("proxy-")
                && !name.starts_with("x-forwarded-")
                && !matches!(
                    name,
                    "authorization"
                        | "cookie"
                        | "set-cookie"
                        | "idempotency-key"
                        | "connection"
                        | "host"
                        | "upgrade"
                        | "forwarded"
                        | "transfer-encoding"
                        | "content-length"
                )
        }
        self.token_header.as_deref().is_none_or(permitted)
            && self
                .headers
                .iter()
                .all(|name| permitted(name) && Some(name) != self.token_header.as_ref())
    }

    pub fn of(channel: &dyn crate::ChannelService) -> Self {
        Self {
            direction: channel.direction(),
            routes: channel
                .ingress_routes()
                .iter()
                .map(RouteInfo::from)
                .collect(),
            headers: channel
                .ingress_headers()
                .iter()
                .map(|h| (*h).into())
                .collect(),
            token_header: channel.ingress_token_header().map(str::to_owned),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_headers_cannot_include_host_credentials() {
        for header in [
            "Authorization",
            "authorization",
            "cookie",
            "X-Anser-Topic-Password",
            "proxy-authorization",
            "token",
        ] {
            let protocol = ReceiveProtocol {
                headers: vec![header.into()],
                token_header: Some("token".into()),
                ..Default::default()
            };
            assert!(!protocol.valid_headers(), "{header}");
        }
        let invalid_alias = ReceiveProtocol {
            token_header: Some("cookie".into()),
            ..Default::default()
        };
        assert!(!invalid_alias.valid_headers());
    }
}
