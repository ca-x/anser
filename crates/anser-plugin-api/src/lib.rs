//! Contracts for channels, tasks, and content transformations.

use std::future::Future;
use std::pin::Pin;

use anser_core::{ChannelAccount, Message, MessageFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod actions;
mod ingress;
pub use ingress::{
    ChannelDirection, IngressMessage, IngressRequest, IngressRoute, ReceiveProtocol, RouteInfo,
};

pub use actions::{
    ConfigOption, ContentTransformService, MAX_TRANSFORM_ARTIFACT_BYTES, PluginDescriptor,
    PluginError, PluginFuture, PluginKind, TaskOutput, TaskService, TransformArtifact,
    TransformOutput,
};

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<SendOutcome, SendError>> + Send + 'a>>;

pub trait ChannelService: Send + Sync + 'static {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn config_schema(&self) -> Value;
    fn validate_config(&self, config: &Value) -> Result<(), SendError>;
    fn capabilities(&self) -> Capabilities;
    fn direction(&self) -> ChannelDirection {
        ChannelDirection::Egress
    }
    fn ingress_routes(&self) -> &'static [IngressRoute] {
        &[]
    }
    fn ingress_headers(&self) -> &'static [&'static str] {
        &[]
    }
    fn ingress_token_header(&self) -> Option<&'static str> {
        None
    }
    fn decode_ingress(&self, _request: IngressRequest<'_>) -> Result<IngressMessage, &'static str> {
        Err("This plugin has no receive protocol")
    }
    fn ingress_response(
        &self,
        _message: &IngressMessage,
        receipt: &anser_core::api::Receipt,
    ) -> Value {
        serde_json::json!(receipt)
    }
    fn send<'a>(&'a self, _account: &'a ChannelAccount, _message: &'a Message) -> SendFuture<'a> {
        Box::pin(async {
            Err(SendError::new(
                "unsupported_direction",
                "The plugin has no outbound channel",
                false,
            ))
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Capabilities {
    pub formats: Vec<MessageFormat>,
    pub max_title_chars: Option<u32>,
    pub max_body_chars: Option<u32>,
    pub attachments: bool,
    pub user_target: bool,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SendOutcome {
    Delivered,
    Accepted { reference: String },
}

/// Error text is safe to return in an API response. Omit raw provider bodies,
/// status messages, URL credentials, and account configuration.
#[derive(Debug, Deserialize, PartialEq, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct SendError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl SendError {
    pub fn new(code: &str, message: &str, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            retry_after_ms: None,
        }
    }
}
