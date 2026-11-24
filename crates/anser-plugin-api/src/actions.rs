//! Contracts for on-demand tasks and content transformation.

use std::future::Future;
use std::pin::Pin;

use anser_core::Message;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::SendError;

/// Identifies the job performed by a plugin, independently of its identifier.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginKind {
    Channel,
    Task,
    ContentTransform,
}

impl PluginKind {
    /// The stable segment used in service names and the HTTP inventory.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Task => "task",
            Self::ContentTransform => "content_transform",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ConfigOption {
    pub value: String,
    pub label: String,
}

/// Installation metadata. Configuration is described by JSON Schema and optional
/// presentation annotations, so callers can use platform-native controls.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginDescriptor {
    pub kind: PluginKind,
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
    pub config_schema: Value,
}

/// Public task or transformation errors. The message must be safe to return to callers.
pub type PluginError = SendError;

pub type PluginFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, PluginError>> + Send + 'a>>;

/// Result of one task invocation. The host or API caller chooses how to publish
/// these message drafts. A task can succeed without producing a notification.
#[derive(Debug, Deserialize, Serialize)]
pub struct TaskOutput {
    pub notifications: Vec<Message>,
    /// Optional diagnostic data, independent of the notification drafts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// Executes a task against a single caller-supplied input.
pub trait TaskService: Send + Sync + 'static {
    fn descriptor(&self) -> PluginDescriptor;

    /// Validate configuration and run one invocation.
    ///
    /// # Errors
    ///
    /// Returns a safe error if the configuration, input, or task execution fails.
    fn run<'a>(&'a self, config: &'a Value, input: &'a Value) -> PluginFuture<'a, TaskOutput>;
}

/// Content returned by one transformation. The message can be published as a
/// notification, and the caller can store or play separately returned media.
#[derive(Debug, Deserialize, Serialize)]
pub struct TransformOutput {
    pub message: Message,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<TransformArtifact>,
}

/// One in-memory media result. Artifact content is standard padded base64.
#[derive(Debug, Deserialize, Serialize)]
pub struct TransformArtifact {
    pub name: String,
    pub content_type: String,
    pub content_base64: String,
}

/// Maximum total decoded artifact size for one invocation.
pub const MAX_TRANSFORM_ARTIFACT_BYTES: usize = 4 * 1024 * 1024;

/// Converts a message independently of accounts, delivery attempts, and retries.
pub trait ContentTransformService: Send + Sync + 'static {
    fn descriptor(&self) -> PluginDescriptor;

    fn validate_settings(&self, _config: &Value) -> Result<(), PluginError> {
        Err(unsupported_settings())
    }

    fn config_options<'a>(
        &'a self,
        _field: &'a str,
        _config: &'a Value,
    ) -> PluginFuture<'a, Vec<ConfigOption>> {
        Box::pin(async { Err(unsupported_settings()) })
    }

    /// Validate configuration, then return the transformed message.
    ///
    /// # Errors
    ///
    /// Returns a safe error if the configuration or transformation fails.
    fn transform<'a>(
        &'a self,
        config: &'a Value,
        message: Message,
    ) -> PluginFuture<'a, TransformOutput>;
}

fn unsupported_settings() -> PluginError {
    SendError::new(
        "unsupported_plugin_settings",
        "This plugin does not provide these settings",
        false,
    )
}
