//! Check the expiration of a website's TLS certificate without sending an HTTP request.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use anser_channel_http::{NetworkPolicy, resolve_host_with_policy};
use anser_core::Message;
use anser_plugin_api::{
    PluginDescriptor, PluginError, PluginFuture, PluginKind, TaskOutput, TaskService,
};
use futures_util::{StreamExt, stream};
use rustls::pki_types::{ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, RootCertStore};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use url::{Host, Url};
use x509_parser::parse_x509_certificate;

const TIMEOUT: Duration = Duration::from_secs(10);
const SECONDS_PER_DAY: u64 = 86_400;
const MAX_WARNING_DAYS: u16 = 365;
const MAX_WEBSITES: usize = 16;
const MAX_PARALLEL_CHECKS: usize = 4;

#[derive(Debug, Default)]
pub struct CertificateExpiration;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    urls: Vec<String>,
    #[serde(default = "default_warning_days")]
    warning_days: u16,
}

fn default_warning_days() -> u16 {
    30
}

struct Target {
    host: String,
    port: u16,
    server_name: ServerName<'static>,
}

impl Target {
    fn parse(value: &str) -> Result<Self, PluginError> {
        if value.len() > 2048 {
            return Err(invalid_url());
        }
        let url = Url::parse(value).map_err(|_| invalid_url())?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid_url());
        }
        let (host, server_name) = match url.host().ok_or_else(invalid_url)? {
            Host::Domain(host) => {
                let host = host.trim_end_matches('.').to_owned();
                let name = ServerName::try_from(host.clone()).map_err(|_| invalid_url())?;
                (host, name)
            }
            Host::Ipv4(ip) => (ip.to_string(), ServerName::from(std::net::IpAddr::from(ip))),
            Host::Ipv6(ip) => (ip.to_string(), ServerName::from(std::net::IpAddr::from(ip))),
        };
        let port = url
            .port_or_known_default()
            .filter(|number| *number > 0)
            .ok_or_else(invalid_url)?;
        Ok(Self {
            host,
            port,
            server_name,
        })
    }
}

impl TaskService for CertificateExpiration {
    fn descriptor(&self) -> PluginDescriptor {
        PluginDescriptor {
            kind: PluginKind::Task,
            id: "certificate-expiration".into(),
            display_name: "TLS certificate expiration".into(),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            config_schema: json!({
                "type": "object",
                "required": ["urls"],
                "additionalProperties": false,
                "x-anser-ui": {"label":{"en":"TLS certificate expiration","zh-CN":"网站证书到期检查"},"task_input":"none"},
                "properties": {
                    "urls": {
                        "type": "array", "items": {"type": "string", "format": "uri", "maxLength": 2048},
                        "minItems": 1, "maxItems": MAX_WEBSITES, "uniqueItems": true,
                        "x-anser-ui": {
                            "label": {"en":"Website URLs","zh-CN":"网站地址"},
                            "description": {
                                "en":"Enter HTTPS origins separated by commas. Include a port if needed.",
                                "zh-CN":"输入 HTTPS 网站地址，多个地址以逗号分隔，可带端口。"
                            }
                        }
                    },
                    "warning_days": {
                        "type": "integer", "minimum": 0, "maximum": MAX_WARNING_DAYS, "default": default_warning_days(),
                        "x-anser-ui": {"label": {"en":"Warn before expiry (days)","zh-CN":"到期前提醒天数"}}
                    }
                }
            }),
        }
    }

    fn run<'a>(&'a self, config: &'a Value, input: &'a Value) -> PluginFuture<'a, TaskOutput> {
        Box::pin(async move {
            if !(input.is_null() || input.as_object().is_some_and(serde_json::Map::is_empty)) {
                return Err(PluginError::new(
                    "certificate_input",
                    "Configure websites in the task options",
                    false,
                ));
            }
            let config = Config::deserialize(config).map_err(|_| {
                PluginError::new(
                    "certificate_config",
                    "Invalid certificate check configuration",
                    false,
                )
            })?;
            if config.warning_days > MAX_WARNING_DAYS {
                return Err(PluginError::new(
                    "certificate_warning_days",
                    "Warning days must be between 0 and 365",
                    false,
                ));
            }
            let targets = parse_targets(&config.urls)?;
            let roots = RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            let connector = connector(roots)?;
            Ok(check_targets(
                targets,
                &NetworkPolicy::from_env(),
                &connector,
                config.warning_days,
            )
            .await)
        })
    }
}

enum Expiration {
    Authenticated { expires_at: u64 },
    ExpiredTls { observed_not_after: Option<u64> },
}

fn parse_targets(urls: &[String]) -> Result<Vec<Target>, PluginError> {
    if !(1..=MAX_WEBSITES).contains(&urls.len()) {
        return Err(PluginError::new(
            "certificate_websites",
            "Configure between one and sixteen HTTPS websites",
            false,
        ));
    }
    let mut unique = std::collections::HashSet::new();
    let targets = urls
        .iter()
        .map(|url| Target::parse(url))
        .collect::<Result<Vec<_>, _>>()?;
    if !targets
        .iter()
        .all(|target| unique.insert((&target.host, target.port)))
    {
        return Err(PluginError::new(
            "certificate_websites",
            "Remove duplicate HTTPS websites",
            false,
        ));
    }
    Ok(targets)
}

fn connector(roots: RootCertStore) -> Result<TlsConnector, PluginError> {
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| {
                PluginError::new("certificate_tls_setup", "TLS configuration failed", false)
            })?
            .with_root_certificates(roots)
            .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

async fn check_targets(
    targets: Vec<Target>,
    policy: &NetworkPolicy,
    connector: &TlsConnector,
    warning_days: u16,
) -> TaskOutput {
    let mut websites = Vec::with_capacity(targets.len());
    let mut results = stream::iter(targets)
        .map(|target| async move {
            let result = tokio::time::timeout(TIMEOUT, check_tls(&target, policy, connector))
                .await
                .unwrap_or_else(|_| {
                    Err(PluginError::new(
                        "certificate_timeout",
                        "TLS check timed out",
                        true,
                    ))
                });
            result.map_or_else(
                |error| (failure(&target, error), None),
                |expiration| output(&target, expiration, warning_days, UnixTime::now().as_secs()),
            )
        })
        .buffered(MAX_PARALLEL_CHECKS);
    let mut notifications = Vec::new();
    while let Some((website, notification)) = results.next().await {
        websites.push(website);
        notifications.extend(notification);
    }
    TaskOutput {
        notifications,
        details: Some(json!({"warning_days": warning_days, "websites": websites})),
    }
}

async fn check_tls(
    target: &Target,
    policy: &NetworkPolicy,
    connector: &TlsConnector,
) -> Result<Expiration, PluginError> {
    // Every DNS result is checked before the connection. Rustls validates
    // the original DNS name or IP as the certificate identity.
    let addresses = resolve_host_with_policy(&target.host, target.port, policy).await?;
    let socket = TcpStream::connect(addresses.as_slice())
        .await
        .map_err(|_| {
            PluginError::new(
                "certificate_connect",
                "Could not connect to the HTTPS endpoint",
                true,
            )
        })?;
    let connection = match connector.connect(target.server_name.clone(), socket).await {
        Ok(connection) => connection,
        Err(error) => return classify_handshake_error(&error),
    };
    let certificate = connection
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|chain| chain.first())
        .ok_or_else(invalid_certificate)?;
    let (_, parsed) =
        parse_x509_certificate(certificate.as_ref()).map_err(|_| invalid_certificate())?;
    let expires_at = u64::try_from(parsed.validity().not_after.timestamp())
        .map_err(|_| invalid_certificate())?;
    Ok(Expiration::Authenticated { expires_at })
}

fn classify_handshake_error(error: &io::Error) -> Result<Expiration, PluginError> {
    match error
        .get_ref()
        .and_then(|source| source.downcast_ref::<rustls::Error>())
    {
        Some(rustls::Error::InvalidCertificate(CertificateError::ExpiredContext {
            not_after,
            ..
        })) => Ok(Expiration::ExpiredTls {
            observed_not_after: Some(not_after.as_secs()),
        }),
        Some(rustls::Error::InvalidCertificate(CertificateError::Expired)) => {
            Ok(Expiration::ExpiredTls {
                observed_not_after: None,
            })
        }
        Some(rustls::Error::InvalidCertificate(_)) => Err(PluginError::new(
            "certificate_untrusted",
            "TLS certificate chain or hostname verification failed",
            false,
        )),
        Some(_) => Err(PluginError::new(
            "certificate_handshake",
            "TLS handshake failed",
            false,
        )),
        None => Err(PluginError::new(
            "certificate_io",
            "TLS connection was interrupted",
            true,
        )),
    }
}

fn endpoint(target: &Target) -> String {
    match &target.server_name {
        ServerName::IpAddress(rustls::pki_types::IpAddr::V6(_)) => {
            format!("[{}]:{}", target.host, target.port)
        }
        _ => format!("{}:{}", target.host, target.port),
    }
}

fn failure(target: &Target, error: PluginError) -> Value {
    json!({
        "endpoint": endpoint(target),
        "status": "error",
        "error": error,
    })
}

fn output(
    target: &Target,
    expiration: Expiration,
    warning_days: u16,
    now: u64,
) -> (Value, Option<Message>) {
    let endpoint = endpoint(target);
    let (status, notification, metadata) = match expiration {
        Expiration::Authenticated { expires_at } => {
            let remaining = expires_at.saturating_sub(now);
            let alert = remaining <= u64::from(warning_days) * SECONDS_PER_DAY;
            let days_remaining = remaining.div_ceil(SECONDS_PER_DAY);
            let notification = alert.then(|| (
                format!("TLS certificate expires soon: {endpoint}"),
                format!("The verified TLS certificate for {endpoint} expires in {days_remaining} day(s)."),
            ));
            (
                if alert { "expiring" } else { "healthy" },
                notification,
                json!({"expires_at": expires_at, "days_remaining": days_remaining}),
            )
        }
        Expiration::ExpiredTls { observed_not_after } => (
            "expired",
            Some((
                format!("TLS certificate expired: {endpoint}"),
                format!(
                    "The TLS handshake with {endpoint} was rejected because a certificate in the chain has expired."
                ),
            )),
            // A failed handshake does not authenticate the endpoint or prove
            // that this date belongs to the leaf certificate.
            json!({"observed_not_after": observed_not_after, "authenticated": false}),
        ),
    };
    let details = json!({
        "endpoint": endpoint,
        "status": status,
        "warning_days": warning_days,
        "certificate": metadata
    });
    let notification = notification.map(|(title, body)| Message {
        title,
        body,
        level: Some("warn".into()),
        extras: details.clone(),
        ..Message::default()
    });
    (details, notification)
}

fn invalid_url() -> PluginError {
    PluginError::new(
        "certificate_url",
        "Configure an HTTPS origin without credentials or a path",
        false,
    )
}

fn invalid_certificate() -> PluginError {
    PluginError::new(
        "certificate_invalid",
        "Could not read the server certificate expiration",
        false,
    )
}

#[cfg(test)]
mod tests;
