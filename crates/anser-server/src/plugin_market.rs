//! A Topic can act as a catalog of immutable plugin announcements.

use std::sync::Arc;

use anser_core::Message;
use anser_core::api::{Page, Publish, Receipt};
use anser_plugin_api::PluginKind;
use anser_store::plugin_market::{Listing, MarketWrite};
use anser_store::queue::Submission;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use reqwest::Url;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::api::{App, idempotency_key};
use crate::auth::Identity;
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery, ApiResult};

#[derive(Deserialize)]
pub struct ListingQuery {
    kind: Option<PluginKind>,
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    id: String,
    kind: PluginKind,
    version: String,
    name: String,
    description: String,
    source_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

impl Manifest {
    fn validate(mut self) -> ApiResult<Self> {
        let valid_identifier = self.id.len() <= 96
            && self.id.split(['.', '_', '-']).all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            });
        if !valid_identifier {
            return Err(ApiError::bad("Invalid plugin listing ID"));
        }
        self.name = self.name.trim().to_owned();
        self.description = self.description.trim().to_owned();
        if self.name.is_empty()
            || self.name.len() > 160
            || self.name.chars().any(char::is_control)
            || self.description.is_empty()
            || self.description.len() > 4096
            || self
                .description
                .chars()
                .any(|ch| ch.is_control() && ch != '\n')
            || self.version.len() > 128
            || Version::parse(&self.version).is_err()
        {
            return Err(ApiError::bad(
                "Invalid plugin listing name, description or version",
            ));
        }
        let url = Url::parse(&self.source_url)
            .ok()
            .filter(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.as_str().len() <= 2048
            })
            .ok_or_else(|| {
                ApiError::bad("Plugin listing source URL must use HTTPS without credentials")
            })?;
        self.source_url = url.into();
        if let Some(digest) = self.sha256.as_mut() {
            if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(ApiError::bad("Invalid plugin listing SHA-256 digest"));
            }
            digest.make_ascii_lowercase();
        }
        Ok(self)
    }
}

pub async fn list(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(topic): ApiPath<String>,
    ApiQuery(query): ApiQuery<ListingQuery>,
) -> ApiResult<Json<Page<Listing>>> {
    identity.topic(Some(&topic))?;
    let page = app
        .store
        .plugin_listings(
            &topic,
            identity.admin(),
            identity.user.as_ref().map(|user| user.id.as_str()),
            query.kind.map(PluginKind::as_str),
            query.cursor.as_deref(),
            query.limit.unwrap_or(50).clamp(1, 100),
        )
        .await?;
    Ok(Json(page))
}

pub async fn publish(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(topic): ApiPath<String>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Manifest>,
) -> ApiResult<(StatusCode, Json<Receipt>)> {
    identity.require("admin")?;
    identity.topic(Some(&topic))?;
    let input = input.validate()?;
    let request = Publish {
        message: Message {
            title: format!("{} {}", input.name, input.version),
            body: format!("{}\n\n{}", input.description, input.source_url),
            url: Some(input.source_url.clone()),
            tags: vec!["plugin-listing".into()],
            ..Default::default()
        },
        ..Default::default()
    };
    let listing = MarketWrite {
        kind: input.kind.as_str(),
        manifest: serde_json::to_value(input).map_err(|_| ApiError::internal())?,
    };
    let available_channels = app
        .host
        .ids()
        .iter()
        .copied()
        .filter(|id| app.host.egress_available(id))
        .collect();
    let receipt = app
        .enqueuer
        .enqueue(Submission {
            available_channels,
            key_id: identity.key_id.clone(),
            topic: Some(topic),
            idempotency_key: idempotency_key(&headers)?.map(|key| format!("plugin-listing {key}")),
            request,
            ttl_limit_ms: app.ttl_limit_ms,
            retention_ms: app.retention_ms,
            queue_limit: app.queue_limit,
            user_id: identity.user.as_ref().map(|user| user.id.clone()),
            sender: identity.user.as_ref().map(|user| user.username.clone()),
            topic_admin: true,
            verified_password_hash: None,
            speech: None,
            listing: Some(listing),
            template: None,
        })
        .await?;
    app.inbox_wakeup.notify_waiters();
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

pub fn openapi_path() -> Value {
    let topic = json!({"name":"name","in":"path","required":true,"schema":{"type":"string"}});
    let security = json!([{"bearerAuth": []}]);
    let kind = json!({"type":"string","enum":["channel","task","content_transform"]});
    let manifest = json!({
        "type":"object",
        "additionalProperties":false,
        "required":["id","kind","version","name","description","source_url"],
        "properties":{
            "id":{"type":"string","maxLength":96,"pattern":"^[a-z0-9]+([._-][a-z0-9]+)*$"},
            "kind":kind,
            "version":{"type":"string","description":"Semantic Versioning 2.0.0","maxLength":128},
            "name":{"type":"string","maxLength":160},
            "description":{"type":"string","maxLength":4096},
            "source_url":{"type":"string","format":"uri","maxLength":2048,"description":"HTTPS source or release link, without credentials"},
            "sha256":{"type":"string","pattern":"^[a-fA-F0-9]{64}$"}
        }
    });
    let failure = json!({"$ref":"#/components/responses/Error"});
    json!({
        "get": {
            "summary":"Browse a Topic plugin catalog",
            "description":"Requires authentication and access to the Topic. Protected Topics require membership or admin scope.",
            "security":security,
            "parameters":[topic,
                {"name":"kind","in":"query","schema":kind},
                {"name":"cursor","in":"query","schema":{"type":"string"}},
                {"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":100}}
            ],
            "responses":{
                "200":{"description":"Catalog page","content":{"application/json":{"schema":{
                    "type":"object","required":["items","next_cursor"],"properties":{
                        "next_cursor":{"type":"string","nullable":true},
                        "items":{"type":"array","items":{"type":"object","required":["message_id","created_at","manifest"],"properties":{
                            "message_id":{"type":"string"},"created_at":{"type":"integer","format":"int64"},
                            "manifest":manifest
                        }}}
                    }
                }}}},
                "default":failure
            }
        },
        "post": {
            "summary":"Publish a plugin listing to a Topic",
            "description":"Requires admin scope and access to an enabled Topic. Publishes an announcement to matching subscribers if there are eligible destinations. The catalog follows the Topic's message retention. Installation is managed separately.",
            "security":security,
            "parameters":[topic,{"name":"Idempotency-Key","in":"header","schema":{"type":"string","pattern":"^[!-~]{1,128}$"}}],
            "requestBody":{"required":true,"content":{"application/json":{"schema":manifest}}},
            "responses":{
                "202":{"description":"Listing persisted","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Receipt"}}}},
                "default":failure
            }
        }
    })
}
