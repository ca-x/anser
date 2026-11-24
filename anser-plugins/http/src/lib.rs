//! Bounded, policy-checked HTTP transport shared by the built-in channels.

use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anser_core::{Message, MessageFormat};
use anser_plugin_api::SendError;
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, Options, Parser, TagEnd};
pub use reqwest;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{Client, Proxy, StatusCode, Url, redirect};
use serde::de::DeserializeOwned;
use serde_json::Value;
use zeroize::Zeroizing;
#[cfg(feature = "test-support")]
pub mod mock;
pub mod token;

const RESPONSE_LIMIT: usize = 256 * 1024;
const DNS_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct NetworkPolicy {
    allow_private: bool,
    trusted_hosts: Vec<String>,
    proxy_probe_host: Option<String>,
}

impl NetworkPolicy {
    #[must_use]
    pub fn new(allow_private: bool, trusted_hosts: Vec<String>) -> Self {
        Self {
            allow_private,
            trusted_hosts,
            proxy_probe_host: None,
        }
    }

    #[must_use]
    pub fn from_env() -> Self {
        let allow_private =
            std::env::var_os("ANSER_ALLOW_PRIVATE_NETWORK").is_some_and(|value| value == "1");
        let trusted_hosts = std::env::var("ANSER_OUTBOUND_ALLOW_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .map(str::to_owned)
            .collect();
        Self::new(allow_private, trusted_hosts)
    }

    /// Permit a server-owned probe destination without broadening the proxy allowlist.
    #[must_use]
    pub fn with_proxy_probe_host(mut self, host: &str) -> Self {
        self.proxy_probe_host = Some(host.to_owned());
        self
    }

    fn explicit_host(&self, host: &str) -> bool {
        self.trusted_hosts
            .iter()
            .any(|allowed| normalize_host(allowed).eq_ignore_ascii_case(normalize_host(host)))
    }

    fn permits(&self, address: IpAddr, host: &str) -> bool {
        let address = match address {
            IpAddr::V6(address) => address
                .to_ipv4_mapped()
                .map_or(IpAddr::V6(address), IpAddr::V4),
            address => address,
        };
        !address.is_unspecified()
            && !address.is_multicast()
            && (is_public_ip(address) || self.allow_private || self.explicit_host(host))
    }
}

fn normalize_host(host: &str) -> &str {
    host.trim_end_matches('.')
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or_else(|| host.trim_end_matches('.'))
}

pub fn validate_url(url: &Url) -> Result<(), SendError> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || url.port_or_known_default().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(SendError::new(
            "invalid_url",
            "configure an HTTP(S) URL without credentials or a fragment",
            false,
        ));
    }
    Ok(())
}

pub fn url(value: &str) -> Result<Url, SendError> {
    let url = Url::parse(value)
        .map_err(|_| SendError::new("invalid_url", "configure a valid HTTP(S) URL", false))?;
    validate_url(&url)?;
    Ok(url)
}

/// Validates a user-visible HTTP(S) link, which may include an anchor.
pub fn link(value: &str) -> Result<Url, SendError> {
    let bad_link = || {
        SendError::new(
            "invalid_link",
            "configure an HTTP(S) link without credentials",
            false,
        )
    };
    let parsed = Url::parse(value).map_err(|_| bad_link())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.as_str().len() > 4096
    {
        return Err(bad_link());
    }
    Ok(parsed)
}

/// Appends path segments with URL escaping and preserves a reverse proxy mount prefix.
pub fn append_path(mut base: Url, segments: &[&str]) -> Result<Url, SendError> {
    base.path_segments_mut()
        .map_err(|_| SendError::new("invalid_url", "URL has no path", false))?
        .pop_if_empty()
        .extend(segments.iter().copied());
    Ok(base)
}

pub fn validate_proxy(proxy: Option<&str>) -> Result<(), SendError> {
    if let Some(proxy) = proxy {
        proxy_url(proxy)?;
    }
    Ok(())
}

struct ProxyEndpoint {
    url: Url,
    credentials: Option<(Zeroizing<String>, Zeroizing<String>)>,
}

fn proxy_url(value: &str) -> Result<ProxyEndpoint, SendError> {
    let mut proxy = Url::parse(value).map_err(|_| invalid_proxy())?;
    let credentials = if proxy.username().is_empty() && proxy.password().is_none() {
        None
    } else {
        let username = decode_proxy_credential(proxy.username())?;
        let password = decode_proxy_credential(proxy.password().unwrap_or_default())?;
        if username.is_empty() || username.contains(':') {
            return Err(invalid_proxy());
        }
        proxy.set_password(None).map_err(|_| invalid_proxy())?;
        proxy.set_username("").map_err(|_| invalid_proxy())?;
        Some((username, password))
    };
    validate_url(&proxy).map_err(|_| invalid_proxy())?;
    if proxy.path() != "/" || proxy.query().is_some() {
        return Err(invalid_proxy());
    }
    Ok(ProxyEndpoint {
        url: proxy,
        credentials,
    })
}

fn decode_proxy_credential(value: &str) -> Result<Zeroizing<String>, SendError> {
    let decoded = percent_decode_str(value)
        .decode_utf8()
        .map_err(|_| invalid_proxy())?;
    if decoded.chars().any(char::is_control) {
        return Err(invalid_proxy());
    }
    Ok(Zeroizing::new(decoded.into_owned()))
}

fn invalid_proxy() -> SendError {
    SendError::new(
        "invalid_proxy",
        "configure an HTTP(S) proxy origin with optional valid Basic credentials",
        false,
    )
}

/// Resolves and checks every candidate before returning addresses for a pinned connection.
pub async fn resolve_host(host: &str, port: u16) -> Result<Vec<SocketAddr>, SendError> {
    resolve_host_with_policy(host, port, &NetworkPolicy::from_env()).await
}

pub async fn resolve_host_with_policy(
    host: &str,
    port: u16,
    policy: &NetworkPolicy,
) -> Result<Vec<SocketAddr>, SendError> {
    let host = normalize_host(host);
    let addresses = if let Ok(address) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(address, port)]
    } else {
        tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host, port)))
            .await
            .map_err(|_| dns_error())?
            .map_err(|_| dns_error())?
            .collect()
    };
    if addresses.is_empty() {
        return Err(dns_error());
    }
    if addresses
        .iter()
        .any(|address| !policy.permits(address.ip(), host))
    {
        return Err(SendError::new(
            "outbound_blocked",
            "outbound policy denied the destination",
            false,
        ));
    }
    Ok(addresses)
}

fn dns_error() -> SendError {
    SendError::new("dns", "could not resolve the destination", true)
}

/// Creates a client pinned to the checked addresses for this request destination.
pub async fn client(url: &Url, proxy: Option<&str>) -> Result<Client, SendError> {
    client_with_policy(url, proxy, &NetworkPolicy::from_env()).await
}

/// Connect to a URL supplied by a publisher. Account SSL/proxy policy cannot
/// grant API callers access to destinations on a private network.
pub async fn request_destination_client(
    url: &Url,
    allowlist_env: &str,
) -> Result<Client, SendError> {
    let allowed = std::env::var(allowlist_env)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(str::to_owned)
        .collect();
    client_with_policy(url, None, &NetworkPolicy::new(false, allowed)).await
}

pub async fn client_with_policy(
    url: &Url,
    proxy: Option<&str>,
    policy: &NetworkPolicy,
) -> Result<Client, SendError> {
    validate_url(url)?;
    let host = url.host_str().expect("validated URL has a hostname");
    let port = url
        .port_or_known_default()
        .expect("validated URL has a port");
    let destination = resolve_host_with_policy(host, port, policy).await?;
    let mut pinned = vec![(host.to_owned(), destination)];
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .redirect(redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy();

    if let Some(proxy) = proxy {
        let proxy = proxy_url(proxy)?;
        let proxy_host = proxy
            .url
            .host_str()
            .expect("validated proxy has a hostname");
        let proxy_port = proxy
            .url
            .port_or_known_default()
            .expect("validated proxy has a port");
        // An HTTP proxy may resolve requests using its own DNS. Operators must
        // explicitly trust the target and the proxy before handing it routing.
        let authorized_target = policy.explicit_host(host)
            || policy
                .proxy_probe_host
                .as_deref()
                .is_some_and(|name| name == host);
        if !authorized_target || !policy.explicit_host(proxy_host) {
            return Err(SendError::new(
                "outbound_proxy_blocked",
                "allowlist the destination and proxy hosts to use an outbound proxy",
                false,
            ));
        }
        let proxy_addresses = resolve_host_with_policy(proxy_host, proxy_port, policy).await?;
        pinned.push((proxy_host.to_owned(), proxy_addresses));
        let outbound = if let Some((username, password)) = proxy.credentials {
            // Reqwest's custom proxy stores auth in a sensitive header, separate from its URL.
            Proxy::custom(move |_| Some(proxy.url.clone())).basic_auth(&username, &password)
        } else {
            Proxy::all(proxy.url).map_err(|_| invalid_proxy())?
        };
        builder = builder.proxy(outbound);
    }
    builder
        .dns_resolver(Arc::new(PinnedDns(pinned)))
        .build()
        .map_err(network_error)
}

struct PinnedDns(Vec<(String, Vec<SocketAddr>)>);

impl Resolve for PinnedDns {
    fn resolve(&self, name: Name) -> Resolving {
        let name = normalize_host(name.as_str());
        let addresses = self.0.iter().find_map(|(host, addresses)| {
            normalize_host(host)
                .eq_ignore_ascii_case(name)
                .then(|| addresses.clone())
        });
        Box::pin(async move {
            let addresses = addresses.ok_or_else(|| {
                io::Error::new(io::ErrorKind::PermissionDenied, "unapproved DNS target")
            })?;
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => {
            let segments = address.segments();
            // Global unicast, excluding IETF protocol assignments, documentation
            // prefixes and 6to4. Decline unsupported address translation ranges.
            segments[0] & 0xe000 == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] < 0x0200 || segments[1] == 0x0db8))
                && segments[0] != 0x2002
                && segments[0] & 0xfff0 != 0x3ff0
        }
    }
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    !matches!(
        address.octets(),
        [0 | 10 | 127 | 224..=255, ..]
            | [100, 64..=127, ..]
            | [169, 254, ..]
            | [172, 16..=31, ..]
            | [192, 0, 0 | 2, _]
            | [192, 88, 99, _]
            | [192, 168, ..]
            | [198, 18 | 19, ..]
            | [198, 51, 100, _]
            | [203, 0, 113, _]
    )
}

/// Collects the body of a successful HTTP response, within the shared size limit.
pub async fn response(response: reqwest::Response) -> Result<Vec<u8>, SendError> {
    if let Some(error) = status_error(&response) {
        return Err(error);
    }
    bounded_body(response).await
}

pub fn status_error(response: &reqwest::Response) -> Option<SendError> {
    let status = response.status();
    if status.is_success() {
        return None;
    }
    let (code, description, retryable) = match status {
        StatusCode::TOO_MANY_REQUESTS => (
            "http_rate_limited",
            "provider rate limited the request",
            true,
        ),
        StatusCode::REQUEST_TIMEOUT => ("http_timeout", "provider timed out the request", true),
        StatusCode::PROXY_AUTHENTICATION_REQUIRED => (
            "proxy_auth",
            "outbound proxy rejected the credentials",
            false,
        ),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => (
            "http_auth",
            "provider rejected the credentials or permissions",
            false,
        ),
        status if status.is_server_error() => (
            "http_unavailable",
            "provider is temporarily unavailable",
            true,
        ),
        _ => ("http_rejected", "provider rejected the request", false),
    };
    let mut error = SendError::new(code, description, retryable);
    if error.retryable {
        error.retry_after_ms = retry_after(response.headers());
    }
    Some(error)
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let header = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let seconds = header.trim().parse::<u64>().ok();
    let delay = match seconds {
        Some(seconds) => Duration::from_secs(seconds),
        None => httpdate::parse_http_date(header)
            .ok()?
            .duration_since(SystemTime::now())
            .unwrap_or_default(),
    };
    Some(u64::try_from(delay.as_millis()).unwrap_or(u64::MAX))
}

pub async fn bounded_body(mut response: reqwest::Response) -> Result<Vec<u8>, SendError> {
    let too_large = || {
        SendError::new(
            "http_response_too_large",
            "provider response exceeded its size limit",
            false,
        )
    };
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_LIMIT as u64)
    {
        return Err(too_large());
    }
    let mut payload = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if payload.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(too_large());
        }
        payload.extend_from_slice(&chunk);
    }
    Ok(payload)
}

pub fn network_error(error: reqwest::Error) -> SendError {
    if error.is_timeout() {
        SendError::new("http_timeout", "provider request timed out", true)
    } else if error.is_builder() {
        SendError::new(
            "http_config",
            "provider request configuration is invalid",
            false,
        )
    } else {
        SendError::new(
            "http_transport",
            "could not communicate with the provider",
            true,
        )
    }
}

pub fn config<T: DeserializeOwned>(value: &Value) -> Result<T, SendError> {
    serde_json::from_value(value.clone()).map_err(|_| {
        SendError::new(
            "invalid_config",
            "channel configuration does not match its schema",
            false,
        )
    })
}

pub fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, SendError> {
    serde_json::from_slice(body).map_err(|_| {
        SendError::new(
            "invalid_provider_response",
            "provider returned an unexpected response",
            true,
        )
    })
}

pub fn provider_error(provider: &str, code: impl fmt::Display, retryable: bool) -> SendError {
    SendError::new(
        &format!("{provider}_{code}"),
        "provider rejected the request",
        retryable,
    )
}

/// Truncates by Unicode scalar value, including an ellipsis in the limit.
#[must_use]
pub fn truncate(input: &str, max: usize) -> String {
    let Some((index, _)) = input.char_indices().nth(max) else {
        return input.to_owned();
    };
    if max == 0 {
        return String::new();
    }
    let end = input[..index]
        .char_indices()
        .next_back()
        .map_or(0, |(end, _)| end);
    format!("{}…", &input[..end])
}

/// Truncates by byte length without splitting a Unicode scalar value.
#[must_use]
pub fn truncate_bytes(input: &str, max: usize) -> String {
    if input.len() <= max {
        return input.to_owned();
    }
    if max < '…'.len_utf8() {
        return input[..input.floor_char_boundary(max)].to_owned();
    }
    let end = input.floor_char_boundary(max - '…'.len_utf8());
    format!("{}…", &input[..end])
}

#[must_use]
pub fn plain_body(message: &Message, max: usize) -> String {
    if message.format == MessageFormat::Text {
        return truncate(&message.body, max);
    }
    if message.format == MessageFormat::Html {
        return truncate(&html_text(&message.body), max);
    }
    let mut text = String::new();
    for event in Parser::new_ext(&message.body, Options::ENABLE_STRIKETHROUGH) {
        match event {
            Event::Text(part) | Event::Code(part) => text.push_str(&part),
            Event::SoftBreak
            | Event::HardBreak
            | Event::End(TagEnd::Paragraph | TagEnd::Item | TagEnd::Heading(_)) => text.push('\n'),
            Event::Html(part) | Event::InlineHtml(part) => text.push_str(&html_text(&part)),
            _ => {}
        }
    }
    truncate(text.trim(), max)
}

/// Joins the title and rendered body, optionally including a validated HTTP(S) link.
pub fn plain_notification(message: &Message, max: usize) -> Result<String, SendError> {
    let body = plain_body(message, max);
    let link = message.url.as_deref().map(link).transpose()?;
    let text = [
        message.title.trim(),
        body.trim(),
        link.as_ref().map_or("", Url::as_str),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    Ok(truncate(&text, max))
}

fn html_text(html: &str) -> String {
    // Converting to text is a display fallback. It does not pass HTML to a renderer.
    let mut output = String::new();
    let mut remaining = html;
    while let Some((before, after)) = remaining.split_once('<') {
        output.push_str(before);
        let Some((tag, rest)) = after.split_once('>') else {
            output.push('<');
            output.push_str(after);
            return output;
        };
        let name = tag.split_whitespace().next().unwrap_or("");
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "br" | "br/" | "/p" | "/div" | "/li"
        ) {
            output.push('\n');
        }
        remaining = rest;
    }
    output.push_str(remaining);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn blocks_private_and_mapped_literals_by_default() {
        let policy = NetworkPolicy::new(false, vec![]);
        for address in [
            "127.0.0.1",
            "169.254.169.254",
            "100.64.1.2",
            "::ffff:127.0.0.1",
            "::1",
            "64:ff9b::a00:1",
        ] {
            assert!(
                !resolve_host_with_policy(address, 443, &policy)
                    .await
                    .unwrap_err()
                    .retryable
            );
        }
        let policy = NetworkPolicy::new(false, vec!["127.0.0.1".to_owned()]);
        assert_eq!(
            resolve_host_with_policy("127.0.0.1", 80, &policy)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            resolve_host_with_policy("9.9.9.9", 443, &policy)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn truncates_at_character_boundaries() {
        assert_eq!(truncate("雁字通知", 3), "雁字…");
        assert_eq!(truncate_bytes("雁字通知", 7), "雁…");
        assert_eq!(truncate("hello", 0), "");
    }

    #[tokio::test]
    async fn pinned_resolver_only_returns_preapproved_names() {
        let address = SocketAddr::new(Ipv4Addr::new(192, 0, 2, 9).into(), 443);
        let resolver = PinnedDns(vec![("fixture.invalid".into(), vec![address])]);
        let resolved = resolver
            .resolve("FIXTURE.invalid.".parse().unwrap())
            .await
            .unwrap()
            .collect::<Vec<_>>();
        assert_eq!(resolved, [address]);
        assert!(
            resolver
                .resolve("other.invalid".parse().unwrap())
                .await
                .is_err()
        );
    }

    #[cfg(feature = "test-support")]
    #[tokio::test]
    async fn refuses_redirects_and_observes_retry_after() {
        let policy = NetworkPolicy::new(true, vec![]);
        let (endpoint, request) =
            mock::serve("302 Found", "Location: http://unapproved.invalid/\r\n", "").await;
        let client = client_with_policy(&endpoint, None, &policy).await.unwrap();
        let reply = client.get(endpoint).send().await.unwrap();
        assert_eq!(reply.status(), StatusCode::FOUND);
        assert!(!response(reply).await.unwrap_err().retryable);
        request.await.unwrap();

        let (endpoint, request) =
            mock::serve("429 Too Many Requests", "Retry-After: 3\r\n", "").await;
        let client = client_with_policy(&endpoint, None, &policy).await.unwrap();
        let reply = client.get(endpoint).send().await.unwrap();
        let error = response(reply).await.unwrap_err();
        assert!(error.retryable);
        assert_eq!(error.retry_after_ms, Some(3000));
        request.await.unwrap();
    }
}
