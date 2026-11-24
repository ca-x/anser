use std::collections::BTreeMap;
use std::sync::Arc;

use anser_core::MessageFormat;
use anser_core::api::{Page, Publish};
use anser_core::template::{Format, Reference, Usage, valid_name};
use anser_store::templates::{Access, Definition, Template};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;

use crate::api::{App, Pagination};
use crate::auth::Identity;
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery, ApiResult};

#[derive(Deserialize)]
pub(crate) struct PublishRequest {
    #[serde(flatten)]
    publish: Publish,
    #[serde(default)]
    pub(crate) speech: bool,
    template_id: Option<String>,
    template_name: Option<String>,
    variables: Option<BTreeMap<String, String>>,
}

impl From<Publish> for PublishRequest {
    fn from(publish: Publish) -> Self {
        Self {
            publish,
            speech: false,
            template_id: None,
            template_name: None,
            variables: None,
        }
    }
}

impl PublishRequest {
    pub fn into_parts(self) -> ApiResult<(Publish, Option<Usage>)> {
        let reference = match (self.template_id, self.template_name) {
            (None, None) => None,
            (Some(id), None) if valid_name(&id) => Some(Reference::Id(id)),
            (None, Some(name)) if valid_name(&name) => Some(Reference::Name(name)),
            _ => {
                return Err(ApiError::bad(
                    "Specify a valid template ID or name, but not both",
                ));
            }
        };
        let variables = self.variables;
        let message = &self.publish.message;
        if reference.is_some()
            && (!message.title.is_empty()
                || !message.body.is_empty()
                || message.format != MessageFormat::Text)
        {
            return Err(ApiError::bad(
                "A template supplies the notification title, body and format",
            ));
        }
        if reference.is_none() && variables.is_some() {
            return Err(ApiError::bad(
                "Template variables require a template ID or name",
            ));
        }
        Ok((
            self.publish,
            reference.map(|reference| Usage {
                reference,
                variables: variables.unwrap_or_default(),
            }),
        ))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    format: Format,
    shared: Option<bool>,
}

impl From<Input> for Definition {
    fn from(value: Input) -> Self {
        Self {
            name: value.name,
            title: value.title,
            body: value.body,
            format: value.format,
            shared: value.shared,
        }
    }
}

fn access(identity: &Identity) -> ApiResult<Access<'_>> {
    identity.require("send")?;
    Ok(Access {
        owner: identity.session_user().ok().map(|user| user.id.as_str()),
        admin: identity.admin_global().is_ok(),
    })
}

pub async fn list(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiQuery(page): ApiQuery<Pagination>,
) -> ApiResult<Json<Page<Template>>> {
    Ok(Json(
        app.store
            .templates(access(&identity)?, page.after(), page.limit())
            .await?,
    ))
}

pub async fn detail(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<Json<Template>> {
    Ok(Json(app.store.template(access(&identity)?, &id).await?))
}

pub async fn create(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiJson(value): ApiJson<Input>,
) -> ApiResult<(StatusCode, Json<Template>)> {
    let created = app
        .store
        .create_template(access(&identity)?, value.into())
        .await?;
    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn update(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
    ApiJson(value): ApiJson<Input>,
) -> ApiResult<Json<Template>> {
    Ok(Json(
        app.store
            .update_template(access(&identity)?, &id, value.into())
            .await?,
    ))
}

pub async fn delete(
    State(app): State<Arc<App>>,
    identity: Identity,
    ApiPath(id): ApiPath<String>,
) -> ApiResult<StatusCode> {
    app.store.delete_template(access(&identity)?, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
