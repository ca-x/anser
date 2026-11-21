//! Contracts for notification channels.

use std::future::Future;
use std::pin::Pin;

use anser_core::{ChannelAccount, Message, MessageFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<SendOutcome, SendError>> + Send + 'a>>;

pub trait ChannelService: Send + Sync + 'static {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn config_schema(&self) -> Value;
    fn validate_config(&self, config: &Value) -> Result<(), SendError>;
    fn capabilities(&self) -> Capabilities;
    fn send<'a>(&'a self, account: &'a ChannelAccount, message: &'a Message) -> SendFuture<'a>;
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
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
