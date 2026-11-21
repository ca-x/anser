use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anser_core::api::{
    MessageDetail, Page, Policy, Publish, Receipt, Selector, Subscription, SubscriptionInput,
    Target, Topic,
};
use anser_core::{Account, ChannelAccount, Message};
use anser_host::{ChannelDescription, ChannelHost};
use anser_queue::{Cipher, Enqueuer};
use anser_store::queue::Submission;
use anser_store::{DataError, Store, new_id, now_ms};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{self, Identity, Rate};
use crate::channel_runtime::{Change, ChannelRuntime, RuntimeState};
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery, ApiResult};

pub struct App {
    pub store: Arc<Store>,
    pub enqueuer: Enqueuer,
    pub host: Arc<ChannelHost>,
    pub channel_runtime: ChannelRuntime,
    pub cipher: Arc<Cipher>,
    pub requests: Rate,
    pub login_requests: Rate,
    pub totp_requests: Rate,
    pub dummy_password: String,
    pub public_url: Option<String>,
    pub requests_per_minute: u32,
    pub queue_limit: u32,
    pub ttl_limit_ms: i64,
    pub retention_ms: i64,
    pub inbox_wakeup: tokio::sync::Notify,
    pub inbox_waiters: tokio::sync::Semaphore,
    pub send_waiters: tokio::sync::Semaphore,
}

#[derive(Deserialize)]
pub struct Pagination {
    cursor: Option<String>,
    limit: Option<u32>,
    channel: Option<String>,
}

impl Pagination {
    pub fn after(&self) -> &str {
        self.cursor.as_deref().unwrap_or_default()
    }
    pub fn limit(&self) -> u32 {
        self.limit.unwrap_or(50).clamp(1, 100)
    }
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/health", get(health))
        .route("/v1/openapi.json", get(crate::openapi::document))
        .route("/v1/auth/login", post(auth::login))
        .route("/v1/auth/totp", get(crate::totp::status))
        .route("/v1/auth/totp/setup", post(crate::totp::setup))
        .route("/v1/auth/totp/confirm", post(crate::totp::confirm))
        .route("/v1/auth/totp/disable", post(crate::totp::disable))
        .route("/v1/auth/me", get(auth::me))
        .route("/v1/auth/logout", post(auth::logout))
        .route("/v1/auth/pair", post(auth::pair))
        .route("/v1/auth/pair/exchange", post(auth::exchange))
        .route("/v1/users", get(auth::users).post(auth::add_user))
        .route("/v1/users/{id}", axum::routing::put(auth::update_user))
        .route("/v1/api-keys", get(auth::keys).post(auth::add_key))
        .route("/v1/api-keys/{id}", delete(auth::delete_key))
        .route("/v1/api-keys/{id}/rotate", post(auth::rotate_key))
        .route("/v1/accounts", get(accounts).post(create_account))
        .route(
            "/v1/accounts/{id}",
            get(account).put(update_account).delete(delete_account),
        )
        .route("/v1/accounts/{id}/test", post(test_account))
        .route(
            "/v1/proxies",
            get(crate::proxies::list).post(crate::proxies::create),
        )
        .route(
            "/v1/proxies/{id}",
            get(crate::proxies::detail)
                .put(crate::proxies::update)
                .delete(crate::proxies::delete),
        )
        .route("/v1/channels", get(channels))
        .route("/v1/channels/{id}", get(channel))
        .route(
            "/v1/channels/{id}/runtime",
            axum::routing::put(change_channel),
        )
        .route(
            "/v1/default-route",
            get(default_route).put(set_default_route),
        )
        .route("/v1/topics", get(topics).post(create_topic))
        .route(
            "/v1/topics/{name}",
            get(topic).put(update_topic).delete(delete_topic),
        )
        .route(
            "/v1/topics/{name}/subscriptions",
            get(subscriptions).post(subscribe),
        )
        .route("/v1/topics/{name}/subscriptions/{id}", delete(unsubscribe))
        .route("/v1/topics/{name}/publish", post(publish))
        .route("/v1/send", post(send))
        .route("/v1/messages", get(messages))
        .route("/v1/messages/{id}", get(message))
        .route("/v1/messages/{id}/replay", post(replay))
        .route("/v1/inbox", get(inbox))
        .route("/v1/inbox/send", post(send_inbox))
        .route("/v1/inbox/{id}/read", post(read_inbox))
        .route("/v1/statistics", get(statistics))
        .route("/metrics", get(metrics))
        .route("/v1/metrics", get(metrics))
        .method_not_allowed_fallback(|| async {
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "Method not allowed",
            )
        })
        .fallback(|| async { ApiError::from(DataError::Missing) })
}

async fn health(State(app): State<Arc<App>>) -> (StatusCode, Json<Value>) {
    if app.store.ping().await.is_ok() {
        (StatusCode::OK, Json(json!({"status": "ok"})))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status": "unavailable"})),
        )
    }
}

#[derive(Serialize)]
struct ChannelView {
    #[serde(flatten)]
    description: ChannelDescription,
    #[serde(flatten)]
    runtime: RuntimeState,
    can_manage: bool,
}

async fn channels(
    State(app): State<Arc<App>>,
    identity: Identity,
) -> ApiResult<Json<Page<ChannelView>>> {
    let settings = app.store.channel_settings().await?;
    let can_manage = identity.admin_global().is_ok();
    let mut items = Vec::with_capacity(app.host.ids().len());
    for &id in app.host.ids() {
        let description = app.host.describe(id).await.map_err(ApiError::channel)?;
        items.push(ChannelView {
            description,
            runtime: RuntimeState {
                enabled: settings.get(id).copied().unwrap_or(true),
                available: app.host.available(id),
            },
            can_manage,
        });
    }
    Ok(Json(Page {
        items,
        next_cursor: None,
    }))
}

async fn channel(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<ChannelView>> {
    if !app.host.ids().contains(&id.as_str()) {
        return Err(DataError::Missing.into());
    }
    Ok(Json(ChannelView {
        description: app.host.describe(&id).await.map_err(ApiError::channel)?,
        runtime: RuntimeState {
            enabled: app.store.channel_enabled(&id).await?,
            available: app.host.available(&id),
        },
        can_manage: identity.admin_global().is_ok(),
    }))
}

#[derive(Deserialize)]
struct ChannelChange {
    enabled: Option<bool>,
    #[serde(default)]
    reload: bool,
}

#[derive(Serialize)]
struct ChannelRuntimeView {
    id: String,
    #[serde(flatten)]
    runtime: RuntimeState,
}

async fn change_channel(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(change): ApiJson<ChannelChange>,
) -> ApiResult<Json<ChannelRuntimeView>> {
    identity.admin_global()?;
    if !app.host.ids().contains(&id.as_str()) {
        return Err(DataError::Missing.into());
    }
    let change = match (change.enabled, change.reload) {
        (Some(enabled), false) => Change::SetEnabled(enabled),
        (None, true) => Change::Reload,
        _ => return Err(ApiError::bad("Supply enabled or reload=true")),
    };
    let runtime = app.channel_runtime.change(&id, change).await?;
    Ok(Json(ChannelRuntimeView { id, runtime }))
}

#[derive(Deserialize)]
struct AccountInput {
    name: String,
    channel: String,
    config: Value,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "default_weight")]
    weight: u32,
    #[serde(default)]
    priority: i32,
    #[serde(default = "enabled")]
    enabled: bool,
    rate_limit: Option<u32>,
    proxy_id: Option<String>,
}

fn default_weight() -> u32 {
    1
}
fn enabled() -> bool {
    true
}

#[derive(Deserialize)]
struct AccountUpdate {
    name: Option<String>,
    channel: Option<String>,
    config: Option<Value>,
    tags: Option<Vec<String>>,
    weight: Option<u32>,
    priority: Option<i32>,
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "nullable")]
    rate_limit: Option<Option<u32>>,
    #[serde(default, deserialize_with = "nullable")]
    proxy_id: Option<Option<String>>,
}

async fn accounts(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<Json<Page<Account>>> {
    identity.admin_global()?;
    Ok(Json(
        app.store
            .accounts(page.after(), page.limit(), page.channel.as_deref())
            .await?,
    ))
}

async fn account(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<Account>> {
    identity.admin_global()?;
    Ok(Json(app.store.account(&id).await?.public()?))
}

async fn create_account(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(input): ApiJson<AccountInput>,
) -> ApiResult<(StatusCode, Json<Account>)> {
    identity.admin_global()?;
    let account = Account {
        id: new_id(),
        channel: input.channel,
        name: input.name,
        tags: input.tags,
        weight: input.weight,
        priority: input.priority,
        enabled: input.enabled,
        rate_limit: input.rate_limit,
        proxy_id: input.proxy_id,
    };
    validate_account(&account)?;
    validate_account_proxy(&app, &account.channel, account.proxy_id.as_deref()).await?;
    let encrypted = seal_account(&app, &account, &input.config).await?;
    app.store.create_account(&account, &encrypted).await?;
    Ok((StatusCode::CREATED, Json(account)))
}

async fn update_account(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(input): ApiJson<AccountUpdate>,
) -> ApiResult<Json<Account>> {
    identity.admin_global()?;
    let previous = app.store.account(&id).await?;
    let mut account = previous.public()?;
    if input
        .channel
        .is_some_and(|channel| channel != account.channel)
    {
        return Err(ApiError::bad("Account channel cannot change"));
    }
    if let Some(name) = input.name {
        account.name = name;
    }
    if let Some(tags) = input.tags {
        account.tags = tags;
    }
    if let Some(weight) = input.weight {
        account.weight = weight;
    }
    if let Some(priority) = input.priority {
        account.priority = priority;
    }
    if let Some(enabled) = input.enabled {
        account.enabled = enabled;
    }
    if let Some(rate_limit) = input.rate_limit {
        account.rate_limit = rate_limit;
    }
    if let Some(proxy_id) = &input.proxy_id {
        validate_account_proxy(&app, &account.channel, proxy_id.as_deref()).await?;
        account.proxy_id.clone_from(proxy_id);
    }
    validate_account(&account)?;
    let encrypted = match input.config {
        Some(mut config) => {
            if account.proxy_id.is_some()
                && let Some(config) = config.as_object_mut()
                && !config.contains_key("proxy")
            {
                let mut old = app.cipher.open(&id, &previous.encrypted_config)?;
                if let Some(proxy) = old.as_object_mut().and_then(|value| value.remove("proxy")) {
                    config.insert("proxy".into(), proxy);
                }
            }
            Some(seal_account(&app, &account, &config).await?)
        }
        None => None,
    };
    let proxy = input.proxy_id.as_ref().map(|id| id.as_deref());
    Ok(Json(
        app.store
            .update_account(&account, encrypted.as_deref(), proxy)
            .await?,
    ))
}

async fn validate_account_proxy(app: &App, channel: &str, proxy_id: Option<&str>) -> ApiResult<()> {
    if proxy_id.is_none() {
        return Ok(());
    }
    let schema = app
        .host
        .config_schema(channel)
        .await
        .map_err(ApiError::channel)?;
    if schema["properties"].get("proxy").is_none() {
        return Err(ApiError::bad(
            "This channel does not support an outbound proxy",
        ));
    }
    Ok(())
}

async fn seal_account(app: &App, account: &Account, config: &Value) -> ApiResult<Vec<u8>> {
    if !config.is_object() || !app.host.ids().contains(&account.channel.as_str()) {
        return Err(ApiError::bad(
            "Account configuration requires an available channel and a JSON object",
        ));
    }
    app.host
        .validate(&account.channel, config)
        .await
        .map_err(ApiError::channel)?;
    Ok(app.cipher.seal(&account.id, config)?)
}

fn validate_account(account: &Account) -> ApiResult<()> {
    if account.name.trim().is_empty()
        || account.name.len() > 128
        || !valid_tags(&account.tags)
        || account
            .rate_limit
            .is_some_and(|value| !(1..=60_000).contains(&value))
    {
        return Err(ApiError::bad("Invalid account metadata"));
    }
    Ok(())
}

async fn delete_account(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
    identity.admin_global()?;
    app.store.delete_account(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn test_account(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(message): ApiJson<Message>,
) -> ApiResult<Json<anser_plugin_api::SendOutcome>> {
    identity.admin_global()?;
    validate_message(&message)?;
    let (account, proxy) = app.store.account_for_send(&id).await?;
    let config = app.cipher.open_channel_config(&account, proxy.as_deref())?;
    let outcome = tokio::time::timeout(
        Duration::from_secs(20),
        app.host
            .test_send(&account.channel, ChannelAccount { config }, message),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "channel_timeout",
            "Channel test timed out",
        )
    })?
    .map_err(ApiError::channel)?;
    Ok(Json(outcome))
}

async fn default_route(State(app): State<Arc<App>>, identity: Identity) -> ApiResult<Json<Policy>> {
    identity.admin_global()?;
    Ok(Json(app.store.default_policy().await?))
}

async fn set_default_route(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(policy): ApiJson<Policy>,
) -> ApiResult<Json<Policy>> {
    identity.admin_global()?;
    validate_policy(&policy)?;
    app.store.set_default_policy(&policy).await?;
    Ok(Json(policy))
}

#[derive(Deserialize)]
struct TopicInput {
    #[serde(flatten)]
    topic: Topic,
    #[serde(default, deserialize_with = "nullable")]
    password: Option<Option<String>>,
}

fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

async fn topics(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<Json<Page<Topic>>> {
    Ok(Json(
        app.store
            .topics(page.after(), page.limit(), identity.topic_prefix.as_deref())
            .await?,
    ))
}

async fn topic(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(name): ApiPath<String>,
) -> ApiResult<Json<Topic>> {
    identity.topic(Some(&name))?;
    Ok(Json(app.store.topic(&name).await?))
}

async fn create_topic(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(mut input): ApiJson<TopicInput>,
) -> ApiResult<(StatusCode, Json<Topic>)> {
    identity.require("admin")?;
    identity.topic(Some(&input.topic.name))?;
    validate_topic(&input.topic)?;
    let hash = password_setting(input.password.flatten()).await?;
    input.topic.protected = hash.is_some();
    app.store
        .create_topic(&input.topic, hash.as_deref())
        .await?;
    Ok((StatusCode::CREATED, Json(input.topic)))
}

async fn update_topic(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(name): ApiPath<String>,
    ApiJson(input): ApiJson<TopicInput>,
) -> ApiResult<Json<Topic>> {
    identity.require("admin")?;
    identity.topic(Some(&name))?;
    validate_topic(&input.topic)?;
    let changed = match input.password {
        Some(password) => Some(password_setting(password).await?),
        None => None,
    };
    app.store
        .update_topic(
            &name,
            &input.topic,
            changed.as_ref().map(|value| value.as_deref()),
        )
        .await?;
    Ok(Json(app.store.topic(&name).await?))
}

async fn password_setting(password: Option<String>) -> ApiResult<Option<String>> {
    match password {
        Some(value) if !value.is_empty() => Ok(Some(auth::hash_password(value).await?)),
        _ => Ok(None),
    }
}

async fn delete_topic(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(name): ApiPath<String>,
) -> ApiResult<StatusCode> {
    identity.require("admin")?;
    identity.topic(Some(&name))?;
    app.store.delete_topic(&name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn subscriptions(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(name): ApiPath<String>,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<Json<Page<Subscription>>> {
    identity.require("subscribe")?;
    identity.topic(Some(&name))?;
    let owner = if identity.admin() {
        None
    } else {
        Some(
            identity
                .user
                .as_ref()
                .map_or(identity.key_id.as_str(), |user| user.id.as_str()),
        )
    };
    Ok(Json(
        app.store
            .subscriptions(&name, page.after(), page.limit(), owner)
            .await?,
    ))
}

async fn subscribe(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(name): ApiPath<String>,
    ApiJson(mut input): ApiJson<SubscriptionInput>,
) -> ApiResult<(StatusCode, Json<Subscription>)> {
    identity.require("subscribe")?;
    identity.topic(Some(&name))?;
    if input.subscriber_ref.trim().is_empty()
        || input.subscriber_ref.len() > 128
        || !valid_tags(&input.filter)
    {
        return Err(ApiError::bad("Invalid subscription"));
    }
    if input.account_id.is_some() || input.target.is_some() {
        identity.admin_global()?;
    }
    if input.account_id.is_none() && input.target.is_some() {
        return Err(ApiError::bad(
            "An account is required for channel-specific targets",
        ));
    }
    let hash = verify_topic(&app, &identity, &name, input.password.take()).await?;
    let id = new_id();
    let encrypted = match (input.account_id.as_deref(), input.target.take()) {
        (Some(account_id), Some(target)) => {
            let (account, proxy) = app.store.account_for_send(account_id).await?;
            let mut config = app.cipher.open_channel_config(&account, proxy.as_deref())?;
            validate_target_override(&account.channel, &target, &mut config)?;
            app.host
                .validate(&account.channel, &config)
                .await
                .map_err(ApiError::channel)?;
            Some(app.cipher.seal(&id, &target)?)
        }
        _ => None,
    };
    let result = app
        .store
        .subscribe(
            &name,
            anser_store::manage::SubscriptionWrite {
                id,
                input,
                target: encrypted,
                user_id: identity.user.as_ref().map(|user| user.id.as_str()),
                key_id: &identity.key_id,
                expected_password: hash.as_deref(),
                admin: identity.admin(),
            },
        )
        .await?;
    Ok((StatusCode::CREATED, Json(result)))
}

fn validate_target_override(channel: &str, target: &Value, config: &mut Value) -> ApiResult<()> {
    let allowed = match channel {
        "bark" => &["device_key", "device_keys"][..],
        "email" => &["to"],
        "feishu" => &["receive_id", "receive_id_type"],
        "lazycat" => &["user_id", "device_id"],
        "ntfy" => &["topic"],
        "telegram" => &["chat_id"],
        "wechat-mp" => &["openid"],
        "wecom" => &["touser"],
        _ => &[],
    };
    let values = target
        .as_object()
        .filter(|values| !values.is_empty())
        .ok_or_else(|| ApiError::bad("Subscription target must be a JSON object"))?;
    if values.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(ApiError::bad(
            "Subscription targets may only override recipient fields",
        ));
    }
    if channel == "bark" {
        if values.contains_key("device_key") == values.contains_key("device_keys") {
            return Err(ApiError::bad("Choose either device_key or device_keys"));
        }
        let configured = config.as_object_mut().ok_or_else(ApiError::internal)?;
        configured.remove("device_key");
        configured.remove("device_keys");
    }
    for (key, value) in values {
        config[key] = value.clone();
    }
    Ok(())
}

async fn unsubscribe(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath((name, id)): ApiPath<(String, String)>,
) -> ApiResult<StatusCode> {
    identity.require("subscribe")?;
    identity.topic(Some(&name))?;
    let owner = if identity.admin() {
        None
    } else {
        Some(
            identity
                .user
                .as_ref()
                .map_or(identity.key_id.as_str(), |user| user.id.as_str()),
        )
    };
    app.store.unsubscribe(&name, &id, owner).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn verify_topic(
    app: &App,
    identity: &Identity,
    name: &str,
    password: Option<String>,
) -> ApiResult<Option<String>> {
    if identity.admin() {
        return Ok(None);
    }
    let hash = app.store.topic_password(name).await?;
    let Some(hash) = hash else {
        return Ok(None);
    };
    if let Some(user) = &identity.user
        && app.store.topic_membership(name, &user.id).await?
    {
        return Ok(None);
    }
    let pass = password.ok_or_else(|| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "topic_password_required",
            "Topic password is required",
        )
    })?;
    if !app
        .login_requests
        .hit(&format!("topic:{}", identity.key_id), 12)
    {
        return Err(ApiError::limited());
    }
    if !auth::verify_password(pass, hash.clone()).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "invalid_topic_password",
            "Topic password is incorrect",
        ));
    }
    Ok(Some(hash))
}

#[derive(Deserialize)]
struct Wait {
    #[serde(default)]
    wait: bool,
    timeout_ms: Option<u64>,
}

async fn publish(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(topic): ApiPath<String>,
    ApiQuery(wait): ApiQuery<Wait>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Publish>,
) -> ApiResult<(StatusCode, Json<Receipt>)> {
    enqueue(&app, &identity, Some(&topic), wait, &headers, input).await
}

async fn send(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(wait): ApiQuery<Wait>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Publish>,
) -> ApiResult<(StatusCode, Json<Receipt>)> {
    enqueue(&app, &identity, None, wait, &headers, input).await
}

fn idempotency_key(headers: &HeaderMap) -> ApiResult<Option<&str>> {
    Ok(match headers.get("idempotency-key") {
        Some(header) => Some(
            header
                .to_str()
                .ok()
                .filter(|value| {
                    (1..=128).contains(&value.len())
                        && value.bytes().all(|byte| byte.is_ascii_graphic())
                })
                .ok_or_else(|| ApiError::bad("Invalid Idempotency-Key"))?,
        ),
        None => None,
    })
}

async fn enqueue(
    app: &App,
    identity: &Identity,
    topic: Option<&str>,
    wait: Wait,
    headers: &HeaderMap,
    mut input: Publish,
) -> ApiResult<(StatusCode, Json<Receipt>)> {
    identity.require("send")?;
    identity.topic(topic)?;
    validate_message(&input.message)?;
    if input.channels.as_ref().is_some_and(|targets| {
        targets.is_empty() || targets.len() > 100 || targets.iter().any(invalid_selector)
    }) || input
        .strategy
        .as_ref()
        .and_then(|strategy| strategy.retry.as_ref())
        .is_some_and(|retry| !retry.valid())
    {
        return Err(ApiError::bad("Invalid routing strategy or channels"));
    }
    if input.expire_at.is_some_and(|expiry| expiry <= now_ms()) {
        return Err(ApiError::bad("expire_at must be in the future"));
    }
    if let Some(callback) = &input.callback_url {
        let url =
            reqwest::Url::parse(callback).map_err(|_| ApiError::bad("Invalid callback URL"))?;
        anser_channel_http::validate_url(&url)
            .map_err(|_| ApiError::bad("Invalid callback URL"))?;
    }
    let key = idempotency_key(headers)?;
    let password = match topic {
        Some(topic) => verify_topic(app, identity, topic, input.topic_password.take()).await?,
        None => None,
    };
    let channels: Vec<_> = app
        .host
        .ids()
        .iter()
        .copied()
        .filter(|id| app.host.available(id))
        .collect();
    let receipt = app
        .enqueuer
        .enqueue(Submission {
            available_channels: channels,
            key_id: identity.key_id.clone(),
            topic: topic.map(ToOwned::to_owned),
            idempotency_key: key.map(ToOwned::to_owned),
            request: input,
            ttl_limit_ms: app.ttl_limit_ms,
            retention_ms: app.retention_ms,
            queue_limit: app.queue_limit,
            user_id: identity.user.as_ref().map(|user| user.id.clone()),
            sender: identity.user.as_ref().map(|user| user.username.clone()),
            topic_admin: identity.admin(),
            verified_password_hash: password,
        })
        .await?;
    app.inbox_wakeup.notify_waiters();
    wait_receipt(app, receipt, wait).await
}

async fn wait_receipt(
    app: &App,
    mut receipt: Receipt,
    wait: Wait,
) -> ApiResult<(StatusCode, Json<Receipt>)> {
    if !wait.wait {
        return Ok((StatusCode::ACCEPTED, Json(receipt)));
    }
    let Ok(_permit) = app.send_waiters.try_acquire() else {
        return Ok((StatusCode::ACCEPTED, Json(receipt)));
    };
    let start = tokio::time::Instant::now();
    let max = Duration::from_millis(wait.timeout_ms.unwrap_or(8_000).clamp(1, 30_000));
    while receipt.status == "pending" && start.elapsed() < max {
        tokio::time::sleep(Duration::from_millis(80)).await;
        receipt.status = app
            .store
            .message_status(&receipt.message_id, None, None)
            .await?;
    }
    let code = if receipt.status == "pending" {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    Ok((code, Json(receipt)))
}

async fn messages(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<Json<Page<MessageDetail>>> {
    identity.require("send")?;
    Ok(Json(
        app.store
            .messages(
                page.cursor.as_deref(),
                page.limit(),
                identity.message_owner(),
                identity.topic_prefix.as_deref(),
            )
            .await?,
    ))
}

async fn message(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<MessageDetail>> {
    identity.require("send")?;
    Ok(Json(
        app.store
            .message(
                &id,
                identity.message_owner(),
                identity.topic_prefix.as_deref(),
            )
            .await?,
    ))
}

async fn replay(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    headers: HeaderMap,
) -> ApiResult<(StatusCode, Json<Receipt>)> {
    identity.require("admin")?;
    let (topic, mut input) = app.store.original(&id).await?;
    identity.topic(topic.as_deref())?;
    input.expire_at = None;
    enqueue(
        &app,
        &identity,
        topic.as_deref(),
        Wait {
            wait: false,
            timeout_ms: None,
        },
        &headers,
        input,
    )
    .await
}

#[derive(Deserialize)]
struct InboxQuery {
    cursor: Option<i64>,
    #[serde(default)]
    wait: bool,
    limit: Option<u32>,
}

async fn inbox(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(query): ApiQuery<InboxQuery>,
) -> ApiResult<Json<Page<anser_store::users::InboxItem>>> {
    let user = identity.user()?;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let notify = app.inbox_wakeup.notified();
    tokio::pin!(notify);
    notify.as_mut().enable();
    let initial = app.store.inbox(&user.id, query.cursor, limit).await?;
    if !query.wait || !initial.items.is_empty() || query.cursor.is_none() {
        return Ok(Json(initial));
    }
    let _permit = app
        .inbox_waiters
        .try_acquire()
        .map_err(|_| ApiError::limited())?;
    let _ = tokio::time::timeout(Duration::from_secs(20), notify).await;
    Ok(Json(app.store.inbox(&user.id, query.cursor, limit).await?))
}

async fn read_inbox(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<i64>,
) -> ApiResult<StatusCode> {
    app.store.read_inbox(&identity.user()?.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct InboxSend {
    recipient: String,
    #[serde(flatten)]
    message: Message,
}

async fn send_inbox(
    State(app): State<Arc<App>>,
    identity: Identity,
    headers: HeaderMap,
    ApiJson(input): ApiJson<InboxSend>,
) -> ApiResult<(StatusCode, Json<anser_store::users::InboxReceipt>)> {
    identity.require("send")?;
    if identity.user.is_none() {
        identity.admin_global()?;
    }
    if input.recipient.len() > 64 || input.recipient.trim().is_empty() {
        return Err(ApiError::bad("Invalid recipient"));
    }
    validate_message(&input.message)?;
    let receipt = app
        .store
        .send_inbox(
            &identity.key_id,
            identity.user.as_ref().map(|user| user.username.as_str()),
            &input.recipient,
            &input.message,
            idempotency_key(&headers)?,
            app.retention_ms,
        )
        .await?;
    app.inbox_wakeup.notify_waiters();
    Ok((StatusCode::CREATED, Json(receipt)))
}

async fn statistics(
    State(app): State<Arc<App>>,
    identity: Identity,
) -> ApiResult<Json<HashMap<String, i64>>> {
    identity.admin_global()?;
    Ok(Json(app.store.statistics().await?.into_iter().collect()))
}

async fn metrics(State(app): State<Arc<App>>, identity: Identity) -> ApiResult<impl IntoResponse> {
    identity.admin_global()?;
    let mut body = String::new();
    use std::fmt::Write as _;
    for (name, value) in app.store.statistics().await? {
        writeln!(&mut body, "anser_{name} {value}").expect("writing to a String cannot fail");
    }
    for row in app.store.account_statistics().await? {
        let labels = format!(
            "channel=\"{}\",account_id=\"{}\"",
            prom_label(&row.channel),
            prom_label(&row.account_id)
        );
        writeln!(
            &mut body,
            "anser_account_attempts{{{labels}}} {}",
            row.attempts
        )
        .unwrap();
        writeln!(&mut body, "anser_account_errors{{{labels}}} {}", row.errors).unwrap();
        writeln!(
            &mut body,
            "anser_account_latency_ms_sum{{{labels}}} {}",
            row.latency_ms
        )
        .unwrap();
    }
    Ok((
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
        )],
        body,
    ))
}

fn validate_topic(topic: &Topic) -> ApiResult<()> {
    if !valid_topic_name(&topic.name)
        || topic.description.len() > 2048
        || !valid_tags(&topic.default_tags)
        || topic
            .retention
            .is_some_and(|days| !(1..=3650).contains(&days))
    {
        return Err(ApiError::bad("Invalid Topic settings"));
    }
    validate_policy(&topic.policy)
}

pub fn valid_topic_name(value: &str) -> bool {
    !matches!(value, "" | "." | "..")
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_tags(values: &[String]) -> bool {
    values.len() <= 64
        && values
            .iter()
            .all(|tag| !tag.is_empty() && tag.len() <= 64 && tag.chars().all(|ch| !ch.is_control()))
}

fn validate_policy(policy: &Policy) -> ApiResult<()> {
    if !policy.retry.valid()
        || policy.targets.len() > 100
        || policy.targets.iter().any(invalid_target)
    {
        return Err(ApiError::bad("Invalid route policy"));
    }
    Ok(())
}

fn invalid_target(target: &Target) -> bool {
    (target.channel.is_none() && target.account_id.is_none() && target.tag_selector.is_empty())
        || target
            .channel
            .as_ref()
            .is_some_and(|channel| !valid_topic_name(channel))
        || target
            .account_id
            .as_ref()
            .is_some_and(|id| !valid_topic_name(id))
        || !valid_tags(&target.tag_selector)
}

fn invalid_selector(selector: &Selector) -> bool {
    match selector {
        Selector::Target(target) => invalid_target(target),
        Selector::Name(name) => match name.strip_prefix("tag:") {
            Some(tag) => tag.is_empty() || tag.len() > 64 || tag.chars().any(char::is_control),
            None => !valid_topic_name(name),
        },
    }
}

fn validate_message(message: &Message) -> ApiResult<()> {
    if (message.title.trim().is_empty() && message.body.trim().is_empty())
        || message.title.len() > 4096
        || message.body.len() > 262_144
        || !valid_tags(&message.tags)
        || message.attachments.len() > 16
        || message
            .attachments
            .iter()
            .any(|attachment| !safe_url(&attachment.url))
        || message.url.as_deref().is_some_and(|url| !safe_url(url))
        || message.level.as_ref().is_some_and(|value| value.len() > 32)
    {
        return Err(ApiError::bad(
            "Invalid notification title, body, tags or attachment",
        ));
    }
    Ok(())
}

fn safe_url(url: &str) -> bool {
    url.len() <= 4096
        && reqwest::Url::parse(url).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}

fn prom_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}
