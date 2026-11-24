use std::sync::Arc;
use std::time::Instant;

use anser_channel_http::{NetworkPolicy, client_with_policy, network_error, status_error};
use anser_host::HostError;

use anser_core::api::Page;
use anser_store::new_id;
use anser_store::proxies::{ProxyConnection, ProxyProfile};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::api::{App, Pagination};
use crate::auth::Identity;
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery, ApiResult};

#[derive(Deserialize)]
pub struct NewProxy {
    name: String,
    url: String,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateProxy {
    name: String,
    url: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

pub async fn list(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<Json<Page<ProxyProfile>>> {
    identity.admin_global()?;
    Ok(Json(app.store.proxies(page.after(), page.limit()).await?))
}

pub async fn detail(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<ProxyProfile>> {
    identity.admin_global()?;
    Ok(Json(app.store.proxy(&id).await?))
}

pub async fn create(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(input): ApiJson<NewProxy>,
) -> ApiResult<(StatusCode, Json<ProxyProfile>)> {
    identity.admin_global()?;
    let name = proxy_name(&input.name)?;
    let id = new_id();
    let credentials = SealedConnection::new(&app, &id, &input.url, input.username, input.password)?;
    let profile = app
        .store
        .create_proxy(&id, name, credentials.as_connection())
        .await?;
    Ok((StatusCode::CREATED, Json(profile)))
}

pub async fn update(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<UpdateProxy>,
) -> ApiResult<Json<ProxyProfile>> {
    identity.admin_global()?;
    let name = proxy_name(&input.name)?;
    let connection = match input.url {
        Some(url) => Some(SealedConnection::new(
            &app,
            &id,
            &url,
            input.username,
            input.password,
        )?),
        None if input.username.is_some() || input.password.is_some() => {
            return Err(ApiError::bad(
                "A proxy URL is required when replacing credentials",
            ));
        }
        None => None,
    };
    Ok(Json(
        app.store
            .update_proxy(
                &id,
                name,
                connection.as_ref().map(SealedConnection::as_connection),
            )
            .await?,
    ))
}

pub async fn delete(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
    identity.admin_global()?;
    app.store.delete_proxy(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

const DEFAULT_PROBE: &str = "https://www.cloudflare.com/cdn-cgi/trace";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProxyTest {
    url: Option<String>,
}

#[derive(Serialize)]
pub struct ProxyTestResult {
    status: u16,
    latency_ms: u64,
}

pub async fn test_proxy(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<ProxyTest>,
) -> ApiResult<Json<ProxyTestResult>> {
    identity.admin_global()?;
    let target = probe_url(input.url.as_deref())?;
    let mut policy = NetworkPolicy::from_env();
    if target.as_str() == DEFAULT_PROBE {
        policy = policy.with_proxy_probe_host("www.cloudflare.com");
    }
    let encrypted = app.store.encrypted_proxy(&id).await?;
    let connection = app.cipher.open_proxy(&id, &encrypted)?;
    let start = Instant::now();
    let result = client_with_policy(&target, Some(&connection), &policy)
        .await
        .map_err(|error| ApiError::channel(HostError::Send(error)))?
        .get(target)
        .send()
        .await
        .map_err(|error| ApiError::channel(HostError::Send(network_error(error))))?;
    if let Some(error) = status_error(&result) {
        return Err(ApiError::channel(HostError::Send(error)));
    }
    Ok(Json(ProxyTestResult {
        status: result.status().as_u16(),
        latency_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
    }))
}

fn probe_url(value: Option<&str>) -> ApiResult<reqwest::Url> {
    let value = value.unwrap_or(DEFAULT_PROBE);
    const INVALID: &str = "Use an HTTPS test URL without credentials, query or fragment";
    if value.len() > 2048 {
        return Err(ApiError::bad(INVALID));
    }
    let target = anser_channel_http::url(value).map_err(|_| ApiError::bad(INVALID))?;
    if target.scheme() != "https" || target.query().is_some() {
        return Err(ApiError::bad(INVALID));
    }
    Ok(target)
}

fn proxy_name(name: &str) -> ApiResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
        return Err(ApiError::bad(
            "Proxy name must contain 1 to 128 UTF-8 bytes",
        ));
    }
    Ok(name)
}

struct SealedConnection {
    url: String,
    authenticated: bool,
    encrypted: Vec<u8>,
}

impl SealedConnection {
    fn new(
        app: &App,
        id: &str,
        input_url: &str,
        username: Option<String>,
        password: Option<String>,
    ) -> ApiResult<Self> {
        let username = username.map(Zeroizing::new);
        let password = password.map(Zeroizing::new);
        if input_url.len() > 4096 {
            return Err(invalid_url());
        }
        let mut url = anser_channel_http::url(input_url).map_err(|_| invalid_url())?;
        if url.path() != "/" || url.query().is_some() {
            return Err(invalid_url());
        }
        let sanitized = url.origin().ascii_serialization();
        if let (Some(username), Some(password)) = (&username, &password) {
            if username.trim().is_empty()
                || username.len() > 512
                || username.chars().any(|ch| ch.is_control() || ch == ':')
                || password.is_empty()
                || password.len() > 2048
                || password.chars().any(char::is_control)
            {
                return Err(ApiError::bad(
                    "Proxy Basic authentication credentials are invalid",
                ));
            }
            // URL setters preserve existing percent escapes, so escape literal percent
            // signs before storing a reversible URI representation for the channel.
            let username = Zeroizing::new(username.replace('%', "%25"));
            let password = Zeroizing::new(password.replace('%', "%25"));
            url.set_username(&username).map_err(|_| invalid_url())?;
            url.set_password(Some(password.as_str()))
                .map_err(|_| invalid_url())?;
        } else if username.is_some() || password.is_some() {
            return Err(ApiError::bad("Provide both a proxy username and password"));
        }
        let url = Zeroizing::new(String::from(url));
        let encrypted = app.cipher.seal_proxy(id, &url)?;
        Ok(Self {
            url: sanitized,
            authenticated: username.is_some(),
            encrypted,
        })
    }

    fn as_connection(&self) -> ProxyConnection<'_> {
        ProxyConnection {
            url: &self.url,
            authenticated: self.authenticated,
            encrypted: &self.encrypted,
        }
    }
}

fn invalid_url() -> ApiError {
    ApiError::bad(
        "Configure an HTTP(S) proxy origin without embedded credentials, path, query or fragment",
    )
}

#[cfg(test)]
mod probe_tests {
    use super::*;

    #[test]
    fn uses_cloudflare_and_rejects_unsafe_override_syntax() {
        assert_eq!(probe_url(None).unwrap().as_str(), DEFAULT_PROBE);
        assert!(probe_url(Some("https://example.org/health")).is_ok());
        for invalid in [
            "http://example.org/health",
            "https://someone:secret@example.org/health",
            "https://example.org/health?token=secret",
            "https://example.org/health#preview",
        ] {
            assert!(probe_url(Some(invalid)).is_err());
        }
    }
}
