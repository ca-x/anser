use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header;
use axum::response::Response;
use axum::{Json, body::Body};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{CallToolResult, ErrorData, Implementation, ServerCapabilities, ServerConfig};
use rmcp::schemars::{self, JsonSchema};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::{Deserialize, Serialize};

use crate::api::App;
use crate::auth::Identity;
use crate::error::{ApiError, ApiResult};
use crate::interactions::{self, Ask};

struct Mcp {
    app: Arc<App>,
    identity: Arc<Identity>,
    tools: ToolRouter<Self>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Read {
    /// Request ID returned by ask_user.
    id: String,
    /// Wait briefly for a response, from zero to 20 seconds. Defaults to zero.
    wait_seconds: Option<u8>,
}

#[tool_router(router = tools)]
impl Mcp {
    #[tool(
        description = "Send an MCD question to a named Anser user. Present declared buttons or a text field in their inbox. Returns a request ID immediately. Use get_interaction to retrieve the human response."
    )]
    async fn ask_user(
        &self,
        Parameters(input): Parameters<Ask>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = interactions::ask(&self.app, &self.identity, input)
            .await
            .map_err(tool_error)?;
        structured(result)
    }

    #[tool(
        description = "Read the state and human response for an interaction created by this API key. Pending requests can be checked again later."
    )]
    async fn get_interaction(
        &self,
        Parameters(input): Parameters<Read>,
    ) -> Result<CallToolResult, ErrorData> {
        let result = interactions::result(
            &self.app,
            &self.identity,
            &input.id,
            input.wait_seconds.unwrap_or(0),
        )
        .await
        .map_err(tool_error)?;
        structured(result)
    }
}

#[tool_handler(router = self.tools)]
impl ServerHandler for Mcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("anser", env!("CARGO_PKG_VERSION")))
    }
}

#[derive(Serialize)]
pub(crate) struct Settings {
    endpoint: Option<String>,
}

fn public_origin(app: &App) -> Option<reqwest::Url> {
    app.public_url
        .as_deref()
        .and_then(|value| reqwest::Url::parse(value).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
}

pub(crate) async fn settings(
    State(app): State<Arc<App>>,
    identity: Identity,
) -> ApiResult<Json<Settings>> {
    identity.admin_global()?;
    Ok(Json(Settings {
        endpoint: public_origin(&app)
            .map(|url| format!("{}/mcp", url.origin().ascii_serialization())),
    }))
}

pub(crate) async fn handle(
    State(app): State<Arc<App>>,
    identity: Identity,
    request: Request,
) -> ApiResult<Response> {
    interactions::authorize(&identity)?;
    if identity.session {
        return Err(ApiError::forbidden());
    }
    let public = public_origin(&app);
    if let Some(origin) = request.headers().get(header::ORIGIN)
        && public
            .as_ref()
            .is_none_or(|url| origin != url.origin().ascii_serialization().as_str())
    {
        return Err(ApiError::forbidden());
    }
    let mut hosts = vec![
        "localhost".to_owned(),
        "127.0.0.1".to_owned(),
        "::1".to_owned(),
    ];
    if let Some(host) = public.as_ref().and_then(reqwest::Url::host_str) {
        hosts.push(host.to_owned());
    }
    let identity = Arc::new(identity);
    let service: StreamableHttpService<Mcp, LocalSessionManager> = StreamableHttpService::new(
        move || {
            Ok(Mcp {
                app: app.clone(),
                identity: identity.clone(),
                tools: Mcp::tools(),
            })
        },
        Default::default(),
        StreamableHttpServerConfig::default()
            .with_allowed_hosts(hosts)
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_max_request_body_bytes(64 * 1024),
    );
    Ok(service.handle(request).await.map(Body::new))
}

fn structured(value: impl serde::Serialize) -> Result<CallToolResult, ErrorData> {
    serde_json::to_value(value)
        .map(CallToolResult::structured)
        .map_err(|_| ErrorData::internal_error("Could not encode interaction", None))
}

fn tool_error(error: ApiError) -> ErrorData {
    let details = Some(serde_json::json!({"code": error.code, "status": error.status.as_u16()}));
    if error.status.is_client_error() {
        ErrorData::invalid_params(error.message, details)
    } else {
        ErrorData::internal_error(error.message, details)
    }
}
