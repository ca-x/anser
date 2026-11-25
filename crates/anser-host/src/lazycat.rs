use anser_core::{ChannelAccount, Message};
use anser_plugin_api::{Capabilities, ChannelService, SendError, SendOutcome};
use anser_plugin_lazycat::Lazycat;
use rutis::Ctx;
use serde_json::Value;

pub(super) struct Plugin;

impl rutis::Plugin for Plugin {
    type Deps = ();

    async fn apply(&self, ctx: &Ctx, _: ()) -> rutis::Result {
        ctx.provide(Service(Lazycat::default()))?;
        Ok(())
    }
}

pub(super) struct Service(Lazycat);

#[rutis::service(name = "anser.channel.lazycat")]
impl Service {
    pub fn id(&self) -> String {
        self.0.id().into()
    }

    pub fn display_name(&self) -> String {
        self.0.display_name().into()
    }

    pub fn config_schema(&self) -> Value {
        self.0.config_schema()
    }

    pub fn receive_protocol(&self) -> anser_plugin_api::ReceiveProtocol {
        anser_plugin_api::ReceiveProtocol::of(&self.0)
    }
    pub fn capabilities(&self) -> Capabilities {
        self.0.capabilities()
    }

    pub fn validate_config(&self, config: Value) -> Result<(), SendError> {
        self.0.validate_config(&config)
    }

    pub async fn devices(
        &self,
        user_id: String,
    ) -> Result<Vec<anser_core::api::LazycatDevice>, SendError> {
        self.0.devices(&user_id).await
    }

    pub async fn send(
        &self,
        account: ChannelAccount,
        message: Message,
    ) -> Result<SendOutcome, SendError> {
        self.0.send(&account, &message).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rutis::host::CtxHost;
    use rutis_bridge::session::call_service;

    #[tokio::test]
    async fn named_send_keeps_the_plugins_error_classification() {
        use crate::{ChannelHost, HostError};

        let host = ChannelHost::start().await.unwrap();
        let error = host
            .test_send(
                "lazycat",
                ChannelAccount {
                    config: Value::Null,
                },
                Message::default(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(error, HostError::Send(SendError { retryable: false, ref code, .. }) if code == "lazycat_invalid_config")
        );
        host.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn channel_is_available_by_rust_type_and_wire_name_until_unloaded() {
        let root = Ctx::root().unwrap();
        let plugin = root.plugin(Plugin);
        (&plugin).await.unwrap();

        let typed = root.get::<Service>().unwrap();
        let named: Value = call_service(&root, "anser.channel.lazycat", "configSchema", ())
            .await
            .unwrap();
        assert_eq!(typed.config_schema(), named);

        let config = serde_json::json!({"user_id": "alice", "device_id": "device-1"});
        typed.validate_config(config.clone()).unwrap();
        call_service::<()>(&root, "anser.channel.lazycat", "validateConfig", (config,))
            .await
            .unwrap();
        assert!(
            call_service::<()>(
                &root,
                "anser.channel.lazycat",
                "validateConfig",
                (Value::Null,)
            )
            .await
            .is_err()
        );

        plugin.dispose().await.unwrap();
        assert!(root.get::<Service>().is_none());
        assert!(
            call_service::<Value>(&root, "anser.channel.lazycat", "configSchema", ())
                .await
                .is_err()
        );
        root.shutdown().await.unwrap();
    }
}
