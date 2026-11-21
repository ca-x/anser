use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anser_store::manage::NewKey;
use anser_store::users::User;
use anser_store::{Store, new_id, now_ms};
use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use axum::Json;
use axum::extract::{ConnectInfo, FromRequest, FromRequestParts, State};
use axum::http::{StatusCode, header, request::Parts};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::api::{App, Pagination};
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery, ApiResult};
use crate::totp;

static PASSWORD_WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

const SESSION_TTL: i64 = 7 * 86_400_000;
const PAIR_TTL: i64 = 120_000;
const BOOTSTRAP_ID: &str = "00000000000000000000000000000000";

pub struct Identity {
    pub key_id: String,
    scopes: Vec<String>,
    pub topic_prefix: Option<String>,
    pub user: Option<User>,
    pub session: bool,
}

impl Identity {
    pub fn allows(&self, scope: &str) -> bool {
        self.scopes
            .iter()
            .any(|value| value == scope || value == "admin")
    }

    pub fn require(&self, scope: &str) -> ApiResult<()> {
        if self.allows(scope) {
            Ok(())
        } else {
            Err(ApiError::forbidden())
        }
    }

    pub fn admin(&self) -> bool {
        self.scopes.iter().any(|scope| scope == "admin")
    }

    pub fn admin_global(&self) -> ApiResult<()> {
        if self.admin() && self.topic_prefix.is_none() {
            Ok(())
        } else {
            Err(ApiError::forbidden())
        }
    }

    pub fn topic(&self, name: Option<&str>) -> ApiResult<()> {
        match &self.topic_prefix {
            Some(prefix) if !name.is_some_and(|name| name.starts_with(prefix)) => {
                Err(ApiError::forbidden())
            }
            _ => Ok(()),
        }
    }

    pub fn user(&self) -> ApiResult<&User> {
        self.user.as_ref().ok_or_else(ApiError::forbidden)
    }

    pub fn session_user(&self) -> ApiResult<&User> {
        if !self.session {
            return Err(ApiError::forbidden());
        }
        self.user()
    }

    pub fn message_owner(&self) -> Option<&str> {
        (!self.admin()).then_some(self.key_id.as_str())
    }
}

impl FromRequestParts<Arc<App>> for Identity {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> ApiResult<Self> {
        let header = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(ApiError::auth)?;
        let token = header
            .split_once(' ')
            .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
            .map(|(_, token)| token)
            .ok_or_else(ApiError::auth)?;
        if token.len() > 256 {
            return Err(ApiError::auth());
        }
        let id = token
            .split_once('.')
            .map(|(id, _)| id.to_owned())
            .filter(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .unwrap_or_else(|| BOOTSTRAP_ID.into());
        let key = app.store.key(&id).await.map_err(|error| match error {
            anser_store::DataError::Missing => ApiError::auth(),
            _ => error.into(),
        })?;
        let now = now_ms();
        if !bool::from(key.secret_hash.as_slice().ct_eq(&hash(token)))
            || !key.enabled
            || key.expires_at.is_some_and(|expires_at| expires_at <= now)
        {
            return Err(ApiError::auth());
        }
        let user = match key.user_id.as_deref() {
            Some(id) => {
                let user = app.store.user(id).await?;
                if !user.enabled {
                    return Err(ApiError::auth());
                }
                Some(user)
            }
            None => None,
        };
        if !app.requests.hit(&key.id, app.requests_per_minute) {
            return Err(ApiError::limited());
        }
        let scopes = key.scopes()?;
        if key
            .last_used_at
            .is_none_or(|previous| previous < now - 60_000)
        {
            app.store.touch_key(&key.id, now).await?;
        }
        Ok(Self {
            key_id: key.id,
            scopes,
            topic_prefix: key.topic_prefix,
            user,
            session: key.session,
        })
    }
}

pub async fn bootstrap(store: &Store) -> anyhow::Result<()> {
    let username = std::env::var("ANSER_BOOTSTRAP_USERNAME")
        .ok()
        .filter(|value| !value.is_empty());
    let password = std::env::var("ANSER_BOOTSTRAP_PASSWORD")
        .ok()
        .filter(|value| !value.is_empty());
    match (username, password) {
        (Some(username), Some(password)) => {
            if !valid_username(&username) || !valid_password(&password) {
                anyhow::bail!("invalid ANSER_BOOTSTRAP_USERNAME or ANSER_BOOTSTRAP_PASSWORD");
            }
            let password = hash_password(password)
                .await
                .map_err(|_| anyhow::anyhow!("could not hash bootstrap password"))?;
            if store
                .create_user(&username, &password, true, true)
                .await?
                .is_some()
            {
                tracing::info!("initial administrator has been created");
            }
        }
        (None, None) => {}
        _ => anyhow::bail!("set both ANSER_BOOTSTRAP_USERNAME and ANSER_BOOTSTRAP_PASSWORD"),
    }
    if let Ok(token) = std::env::var("ANSER_BOOTSTRAP_API_KEY") {
        if token.len() < 32
            || token.len() > 256
            || !token.bytes().all(|byte| byte.is_ascii_graphic())
        {
            anyhow::bail!("ANSER_BOOTSTRAP_API_KEY requires 32–256 visible ASCII characters");
        }
        let id = token
            .split_once('.')
            .filter(|(id, _)| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map_or(BOOTSTRAP_ID, |(id, _)| id);
        store
            .insert_key(
                NewKey {
                    id,
                    hash: &hash(&token),
                    name: "bootstrap",
                    scopes: &["admin".into()],
                    topic_prefix: None,
                    expires_at: None,
                },
                true,
            )
            .await?;
    }
    Ok(())
}

#[derive(Default)]
pub struct Rate(Mutex<HashMap<String, (Instant, u32)>>);

impl Rate {
    pub fn hit(&self, key: &str, limit: u32) -> bool {
        let Ok(mut limits) = self.0.lock() else {
            return false;
        };
        let now = Instant::now();
        let minute = Duration::from_secs(60);
        if limits.len() >= 4096 {
            limits.retain(|_, (first, _)| now.duration_since(*first) < minute);
            if limits.len() >= 4096 && !limits.contains_key(key) {
                return false;
            }
        }
        let (first, count) = limits.entry(key.into()).or_insert((now, 0));
        if now.duration_since(*first) >= minute {
            *first = now;
            *count = 0;
        }
        if *count >= limit {
            return false;
        }
        *count += 1;
        true
    }
}

#[derive(Deserialize)]
pub struct Credentials {
    username: String,
    password: String,
    code: Option<String>,
}

#[derive(Serialize)]
pub struct Session {
    #[serde(serialize_with = "serialize_secret")]
    token: Zeroizing<String>,
    user: User,
}

pub async fn login(
    State(app): State<Arc<App>>,
    request: axum::extract::Request,
) -> ApiResult<Json<Session>> {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|peer| peer.0.ip());
    check_login_rate(&app, peer)?;
    let ApiJson(input) = ApiJson::<Credentials>::from_request(request, &app).await?;
    let code = input.code.map(Zeroizing::new);
    let user = match app.store.user_named(&input.username).await {
        Ok(user) => Some(user),
        Err(anser_store::DataError::Missing) => None,
        Err(error) => return Err(error.into()),
    };
    let hash = user.as_ref().map_or_else(
        || app.dummy_password.clone(),
        |user| user.password_hash.clone(),
    );
    if !verify_password(input.password, hash.clone()).await? {
        return Err(ApiError::auth());
    }
    let user = user
        .filter(|user| user.enabled)
        .ok_or_else(ApiError::auth)?;
    let factor = app.store.active_totp(&user.id).await?;
    let proof = if let Some(factor) = &factor {
        let code = code
            .as_ref()
            .filter(|code| !code.trim().is_empty())
            .ok_or_else(totp::required)?;
        if !app.totp_requests.hit(&format!("login:{}", user.id), 12) {
            return Err(ApiError::limited());
        }
        Some(
            totp::verify_factor(&app, &user.id, factor, code)?
                .ok_or_else(|| totp::invalid_totp(StatusCode::UNAUTHORIZED))?,
        )
    } else {
        None
    };
    let (id, token) = new_token(None);
    let user = app
        .store
        .create_session(
            &id,
            &self::hash(&token),
            &user.id,
            now_ms() + SESSION_TTL,
            &hash,
            proof,
        )
        .await
        .map_err(|error| match error {
            anser_store::DataError::Missing => ApiError::auth(),
            anser_store::DataError::InvalidFactor if factor.is_none() => totp::required(),
            anser_store::DataError::InvalidFactor => totp::invalid_totp(StatusCode::UNAUTHORIZED),
            _ => error.into(),
        })?;
    Ok(Json(Session { token, user }))
}

pub async fn me(identity: Identity) -> ApiResult<Json<User>> {
    Ok(Json(identity.user()?.clone()))
}

pub async fn logout(State(app): State<Arc<App>>, identity: Identity) -> ApiResult<StatusCode> {
    if !identity.session {
        return Err(ApiError::forbidden());
    }
    app.store.revoke_session(&identity.key_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct PairOptions {
    server: Option<String>,
}

pub async fn pair(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(options): ApiJson<PairOptions>,
) -> ApiResult<Json<Value>> {
    let user = identity.user()?;
    let server = app
        .public_url
        .as_deref()
        .or(options.server.as_deref())
        .ok_or_else(|| ApiError::bad("Server address is required"))?;
    let parsed = Url::parse(server).map_err(|_| ApiError::bad("Invalid server address"))?;
    let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (parsed.scheme() != "https" && !(loopback && parsed.scheme() == "http"))
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.query().is_some()
        || parsed.path() != "/"
    {
        return Err(ApiError::bad("Pairing requires an HTTPS server origin"));
    }
    // Untrusted clients cannot generate credentials tied to a different origin
    // if the operator pins the public URL. Web and NSH also confirm the origin.
    let code = random_secret();
    let expires_at = now_ms() + PAIR_TTL;
    app.store
        .make_pair(&user.id, &identity.key_id, &hash(&code), expires_at)
        .await?;
    let mut url = Url::parse("anser://connect").unwrap();
    url.query_pairs_mut()
        .append_pair("server", parsed.as_str())
        .append_pair("code", &code);
    Ok(Json(json!({"url": url.as_str(), "expires_at": expires_at})))
}

#[derive(Deserialize)]
pub struct PairCode {
    code: String,
}

pub async fn exchange(
    State(app): State<Arc<App>>,
    request: axum::extract::Request,
) -> ApiResult<Json<Session>> {
    check_login_rate(
        &app,
        request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|peer| peer.0.ip()),
    )?;
    let ApiJson(input) = ApiJson::<PairCode>::from_request(request, &app).await?;
    if input.code.len() != 43 {
        return Err(ApiError::auth());
    }
    let (id, token) = new_token(None);
    let user = app
        .store
        .exchange_pair(
            &hash(&input.code),
            &id,
            &hash(&token),
            now_ms() + SESSION_TTL,
        )
        .await
        .map_err(|error| match error {
            anser_store::DataError::Missing => ApiError::auth(),
            _ => error.into(),
        })?;
    Ok(Json(Session { token, user }))
}

fn check_login_rate(app: &App, ip: Option<IpAddr>) -> ApiResult<()> {
    if app.login_requests.hit("all", 120)
        && app.login_requests.hit(
            &ip.map_or_else(|| "unknown".into(), |ip| ip.to_string()),
            12,
        )
    {
        Ok(())
    } else {
        Err(ApiError::limited())
    }
}

#[derive(Deserialize)]
pub struct NewUser {
    username: String,
    password: String,
    #[serde(default)]
    admin: bool,
}

#[derive(Deserialize)]
pub struct UserUpdate {
    password: Option<String>,
    admin: Option<bool>,
    enabled: Option<bool>,
}

pub async fn users(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<impl axum::response::IntoResponse> {
    identity.admin_global()?;
    Ok(Json(app.store.users(page.after(), page.limit()).await?))
}

pub async fn add_user(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(input): ApiJson<NewUser>,
) -> ApiResult<(StatusCode, Json<User>)> {
    identity.admin_global()?;
    if !valid_username(&input.username) {
        return Err(ApiError::bad("Invalid username"));
    }
    let password = hash_password(input.password).await?;
    let user = app
        .store
        .create_user(&input.username, &password, input.admin, false)
        .await?
        .ok_or_else(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(user)))
}

pub async fn update_user(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<UserUpdate>,
) -> ApiResult<Json<User>> {
    identity.admin_global()?;
    let password = match input.password {
        Some(password) => Some(hash_password(password).await?),
        None => None,
    };
    Ok(Json(
        app.store
            .update_user(&id, input.enabled, input.admin, password.as_deref())
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct KeyInput {
    name: String,
    scopes: Vec<String>,
    topic_prefix: Option<String>,
    expires_at: Option<i64>,
}

pub async fn keys(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<impl axum::response::IntoResponse> {
    identity.admin_global()?;
    Ok(Json(app.store.keys(page.after(), page.limit()).await?))
}

#[derive(Serialize)]
pub struct IssuedKey {
    #[serde(serialize_with = "serialize_secret")]
    token: Zeroizing<String>,
    key: Value,
}

pub async fn add_key(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(input): ApiJson<KeyInput>,
) -> ApiResult<(StatusCode, Json<IssuedKey>)> {
    identity.admin_global()?;
    if input.name.trim().is_empty()
        || input.name.len() > 128
        || input.scopes.is_empty()
        || input.scopes.len() > 3
        || input
            .scopes
            .iter()
            .any(|scope| !matches!(scope.as_str(), "send" | "subscribe" | "admin"))
        || input.expires_at.is_some_and(|value| value <= now_ms())
        || input
            .topic_prefix
            .as_ref()
            .is_some_and(|prefix| !crate::api::valid_topic_name(prefix))
    {
        return Err(ApiError::bad("Invalid API key settings"));
    }
    let (id, token) = new_token(None);
    app.store
        .insert_key(
            NewKey {
                id: &id,
                hash: &hash(&token),
                name: &input.name,
                scopes: &input.scopes,
                topic_prefix: input.topic_prefix.as_deref(),
                expires_at: input.expires_at,
            },
            false,
        )
        .await?;
    let key = app.store.key(&id).await?.view()?;
    Ok((StatusCode::CREATED, Json(IssuedKey { token, key })))
}

pub async fn delete_key(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
    identity.admin_global()?;
    if id == identity.key_id {
        return Err(ApiError::bad("Cannot disable the current key"));
    }
    if app.store.key(&id).await?.session {
        return Err(ApiError::forbidden());
    }
    app.store.disable_key(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn rotate_key(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<IssuedKey>> {
    identity.admin_global()?;
    if app.store.key(&id).await?.session {
        return Err(ApiError::forbidden());
    }
    let (_, token) = new_token(Some(&id));
    app.store.rotate_key(&id, &hash(&token)).await?;
    let key = app.store.key(&id).await?.view()?;
    Ok(Json(IssuedKey { token, key }))
}

fn valid_username(username: &str) -> bool {
    (1..=64).contains(&username.len())
        && username
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-' | b'.'))
}

fn valid_password(password: &str) -> bool {
    (8..=256).contains(&password.len())
}

pub async fn hash_password(password: String) -> ApiResult<String> {
    let password = Zeroizing::new(password);
    if !valid_password(&password) {
        return Err(ApiError::bad("Password must contain 8 to 256 UTF-8 bytes"));
    }
    let permit = PASSWORD_WORK
        .try_acquire()
        .map_err(|_| ApiError::limited())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| ApiError::internal())
    })
    .await
    .map_err(|_| ApiError::internal())?
}

pub async fn verify_password(password: String, hash: String) -> ApiResult<bool> {
    let password = Zeroizing::new(password);
    if password.len() > 256 {
        return Ok(false);
    }
    let permit = PASSWORD_WORK
        .try_acquire()
        .map_err(|_| ApiError::limited())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let hash = PasswordHash::new(&hash).map_err(|_| ApiError::internal())?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok())
    })
    .await
    .map_err(|_| ApiError::internal())?
}

pub fn random_secret() -> Zeroizing<String> {
    let mut bytes = Zeroizing::new([0_u8; 32]);
    rand::rngs::OsRng.fill_bytes(&mut *bytes);
    Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_slice()))
}

fn new_token(id: Option<&str>) -> (String, Zeroizing<String>) {
    let id = id.map_or_else(new_id, ToOwned::to_owned);
    let token = Zeroizing::new(format!("{id}.{}", &*random_secret()));
    (id, token)
}

fn hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

pub(crate) fn serialize_secret<S: serde::Serializer>(
    value: &Zeroizing<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(value)
}
