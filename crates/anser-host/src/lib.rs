//! The runtime boundary between application code and rutis.

use std::collections::HashMap;
use std::sync::Arc;

use anser_core::{ChannelAccount, Message};
use anser_plugin_api::{
    Capabilities, PluginDescriptor, SendError, SendOutcome, TaskOutput, TransformOutput,
};
use rutis::Ctx;
use rutis::host::CtxHost;
use rutis_bridge::session::{Error as BridgeError, call_service};
use serde_json::Value;

mod actions;
mod builtins;
mod lifecycle;

use lifecycle::{Factory, Lifecycle, Transition};

#[cfg(all(unix, feature = "lazycat"))]
mod lazycat;

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("plugin is not installed for this capability")]
    PluginNotFound,
    #[error("channel runtime could not start")]
    Startup,
    #[error("channel runtime could not shut down cleanly")]
    Shutdown,
    #[error("channel unavailable")]
    Unavailable,
    #[error("channel lifecycle transition failed")]
    Lifecycle,
    #[error("channel service call failed")]
    Call(#[source] BridgeError),
    #[error(transparent)]
    Send(#[from] SendError),
}

pub struct ChannelHost {
    root: Ctx,
    ids: Vec<&'static str>,
    channels: HashMap<&'static str, Channel>,
    actions: actions::Actions,
}

struct Channel {
    lifecycle: Arc<Lifecycle>,
    description: ChannelDescription,
}

impl ChannelHost {
    pub async fn start() -> Result<Self, HostError> {
        let root = Ctx::root().map_err(|_| HostError::Startup)?;
        Self::start_with(root, builtins::CHANNELS).await
    }

    async fn start_with(
        root: Ctx,
        factories: &[(&'static str, Factory)],
    ) -> Result<Self, HostError> {
        let mut ids = Vec::with_capacity(factories.len());
        let mut channels = HashMap::with_capacity(factories.len());
        for &(id, factory) in factories {
            let channel = match Channel::mount(&root, id, factory).await {
                Ok(channel) => channel,
                Err(error) => {
                    let _ = root.shutdown().await;
                    return Err(error);
                }
            };
            ids.push(id);
            channels.insert(id, channel);
        }
        let actions = match actions::Actions::mount(&root).await {
            Ok(actions) => actions,
            Err(error) => {
                let _ = root.shutdown().await;
                return Err(error);
            }
        };
        Ok(Self {
            root,
            ids,
            channels,
            actions,
        })
    }

    /// Every compiled built-in channel, including suspended channels.
    pub fn ids(&self) -> &[&'static str] {
        &self.ids
    }

    /// Whether the channel currently admits service calls.
    pub fn available(&self, id: &str) -> bool {
        self.channels
            .get(id)
            .is_some_and(|channel| channel.lifecycle.admit().is_ok())
    }

    /// Idempotently suspend or mount a built-in. Suspension waits for admitted calls.
    pub async fn set_channel(&self, id: &str, enabled: bool) -> Result<(), HostError> {
        self.channel(id)?
            .lifecycle
            .clone()
            .apply(self.root.clone(), Transition::SetEnabled(enabled))
            .await
    }

    /// Drain admitted calls and restart the mounted fiber.
    /// Suspended channels require an explicit enable operation.
    pub async fn reload_channel(&self, id: &str) -> Result<(), HostError> {
        self.channel(id)?
            .lifecycle
            .clone()
            .apply(self.root.clone(), Transition::Reload)
            .await
    }

    pub async fn describe(&self, channel: &str) -> Result<ChannelDescription, HostError> {
        Ok(self.channel(channel)?.description.clone())
    }

    pub async fn validate(&self, channel: &str, config: &Value) -> Result<(), HostError> {
        let _admission = self.channel(channel)?.lifecycle.admit()?;
        call_service(
            &self.root,
            &service_name(channel),
            "validateConfig",
            (config,),
        )
        .await
        .map_err(channel_error)
    }

    pub async fn config_schema(&self, channel: &str) -> Result<Value, HostError> {
        Ok(self.channel(channel)?.description.config_schema.clone())
    }

    pub async fn lazycat_devices(
        &self,
        user_id: &str,
    ) -> Result<Vec<anser_core::api::LazycatDevice>, HostError> {
        let _admission = self.channel("lazycat")?.lifecycle.admit()?;
        call_service(&self.root, "anser.channel.lazycat", "devices", (user_id,))
            .await
            .map_err(channel_error)
    }

    pub async fn test_send(
        &self,
        channel: &str,
        account: ChannelAccount,
        message: Message,
    ) -> Result<SendOutcome, HostError> {
        let _admission = self.channel(channel)?.lifecycle.admit()?;
        call_service(
            &self.root,
            &service_name(channel),
            "send",
            (account, message),
        )
        .await
        .map_err(channel_error)
    }

    /// Installed task and transform descriptors with current runtime availability.
    pub fn actions(&self) -> impl Iterator<Item = (&PluginDescriptor, bool)> {
        self.actions
            .installed()
            .iter()
            .map(|action| (&action.descriptor, action.available()))
    }

    /// Run one registered task and return message drafts.
    ///
    /// # Errors
    ///
    /// Returns an error if the task is missing, unavailable, or fails.
    pub async fn run_task(
        &self,
        id: &str,
        config: Value,
        input: Value,
    ) -> Result<TaskOutput, HostError> {
        self.actions.run(&self.root, id, config, input).await
    }

    /// Transform one message using the registered content plugin.
    ///
    /// # Errors
    ///
    /// Returns an error if the transform is missing, unavailable, or fails.
    pub async fn transform(
        &self,
        id: &str,
        config: Value,
        message: Message,
    ) -> Result<TransformOutput, HostError> {
        self.actions
            .transform(&self.root, id, config, message)
            .await
    }

    pub async fn shutdown(self) -> Result<(), HostError> {
        self.root.shutdown().await.map_err(|_| HostError::Shutdown)
    }

    pub async fn validate_transform_settings(
        &self,
        id: &str,
        config: &Value,
    ) -> Result<(), HostError> {
        self.actions
            .validate_transform_settings(&self.root, id, config)
            .await
    }

    pub async fn transform_options(
        &self,
        id: &str,
        field: &str,
        config: &Value,
    ) -> Result<Vec<anser_plugin_api::ConfigOption>, HostError> {
        self.actions
            .transform_options(&self.root, id, field, config)
            .await
    }

    fn channel(&self, id: &str) -> Result<&Channel, HostError> {
        self.channels.get(id).ok_or(HostError::Unavailable)
    }
}

impl Channel {
    async fn mount(root: &Ctx, id: &str, factory: Factory) -> Result<Self, HostError> {
        let lifecycle = Lifecycle::mount(root, factory)
            .await
            .map_err(|_| HostError::Startup)?;
        let name = service_name(id);
        // Built-ins have immutable descriptors, including while suspended.
        let description = ChannelDescription {
            id: id.into(),
            display_name: call_service(root, &name, "displayName", ())
                .await
                .map_err(HostError::Call)?,
            config_schema: call_service(root, &name, "configSchema", ())
                .await
                .map_err(HostError::Call)?,
            capabilities: call_service(root, &name, "capabilities", ())
                .await
                .map_err(HostError::Call)?,
        };
        Ok(Self {
            lifecycle: Arc::new(lifecycle),
            description,
        })
    }
}

fn service_name(channel: &str) -> String {
    format!("anser.channel.{channel}")
}

#[derive(serde::Serialize)]
pub struct ChannelDescription {
    pub id: String,
    pub display_name: String,
    pub config_schema: Value,
    pub capabilities: Capabilities,
}

impl Clone for ChannelDescription {
    fn clone(&self) -> Self {
        let Capabilities {
            formats,
            max_title_chars,
            max_body_chars,
            attachments,
            user_target,
        } = &self.capabilities;
        Self {
            id: self.id.clone(),
            display_name: self.display_name.clone(),
            config_schema: self.config_schema.clone(),
            capabilities: Capabilities {
                formats: formats.clone(),
                max_title_chars: *max_title_chars,
                max_body_chars: *max_body_chars,
                attachments: *attachments,
                user_target: *user_target,
            },
        }
    }
}

fn channel_error(error: BridgeError) -> HostError {
    match error
        .data()
        .and_then(|data| serde_json::from_value(data).ok())
    {
        Some(send_error) => HostError::Send(send_error),
        None => HostError::Call(error),
    }
}

#[cfg(test)]
mod lifecycle_test;
