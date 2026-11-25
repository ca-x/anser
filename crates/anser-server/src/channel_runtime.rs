//! Serializes persisted configuration and live channel transitions.

use std::sync::Arc;

use anser_host::{ChannelHost, HostError};
use anser_store::Store;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::{ApiError, ApiResult};

pub struct ChannelRuntime {
    commands: mpsc::Sender<Command>,
}

pub enum Change {
    SetEnabled(bool),
    Reload,
    SetDirections {
        ingress: Option<bool>,
        egress: Option<bool>,
    },
}

struct Command {
    id: String,
    change: Change,
    response: oneshot::Sender<ApiResult<RuntimeState>>,
}

#[derive(Serialize)]
pub struct RuntimeState {
    pub enabled: bool,
    pub available: bool,
    pub ingress_enabled: bool,
    pub egress_enabled: bool,
}

impl RuntimeState {
    pub fn current(host: &ChannelHost, id: &str, enabled: bool) -> Self {
        Self {
            enabled,
            available: host.available(id),
            ingress_enabled: host.ingress_enabled(id),
            egress_enabled: host.egress_enabled(id),
        }
    }
}

impl ChannelRuntime {
    pub async fn restore(store: &Store, host: &ChannelHost) -> anyhow::Result<()> {
        let settings = store.channel_settings().await?;
        for &id in host.ids() {
            if let Some(state) = settings.get(id) {
                host.set_directions(id, state.ingress_enabled, state.egress_enabled)?;
                if !state.enabled {
                    host.set_channel(id, false).await?;
                }
            }
        }
        Ok(())
    }

    pub fn start(store: Arc<Store>, host: Arc<ChannelHost>) -> (Self, JoinHandle<()>) {
        let (commands, mut receiver) = mpsc::channel::<Command>(16);
        let task = tokio::spawn(async move {
            // The controller owns a submitted mutation until completion even
            // when the management client disconnects or drops its response.
            while let Some(command) = receiver.recv().await {
                let result = apply(&store, &host, &command.id, command.change).await;
                let _ = command.response.send(result);
            }
        });
        (Self { commands }, task)
    }

    pub async fn change(&self, id: &str, change: Change) -> ApiResult<RuntimeState> {
        let (response, receive) = oneshot::channel();
        self.commands
            .try_send(Command {
                id: id.to_owned(),
                change,
                response,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => ApiError::limited(),
                mpsc::error::TrySendError::Closed(_) => ApiError::internal(),
            })?;
        receive.await.map_err(|_| ApiError::internal())?
    }
}

async fn apply(
    store: &Store,
    host: &ChannelHost,
    id: &str,
    change: Change,
) -> ApiResult<RuntimeState> {
    let enabled = match change {
        Change::SetEnabled(enabled) => {
            // Commit intent first. A process failure between this write and the
            // live transition is repaired during startup before serving.
            store.set_channel_enabled(id, enabled).await?;
            host.set_channel(id, enabled)
                .await
                .map_err(ApiError::channel)?;
            enabled
        }
        Change::SetDirections { ingress, egress } => {
            let direction = host
                .describe(id)
                .await
                .map_err(ApiError::channel)?
                .direction;
            if (ingress.is_some() && !direction.supports_ingress())
                || (egress.is_some() && !direction.supports_egress())
            {
                return Err(ApiError::bad(
                    "Plugin does not support the requested channel direction",
                ));
            }
            // Merge inside the serialized controller so concurrent patches retain both intents.
            let ingress = ingress.unwrap_or_else(|| host.ingress_enabled(id));
            let egress = egress.unwrap_or_else(|| host.egress_enabled(id));
            store.set_channel_directions(id, ingress, egress).await?;
            host.set_directions(id, ingress, egress)
                .map_err(ApiError::channel)?;
            store.channel_enabled(id).await?
        }
        Change::Reload => {
            if !store.channel_enabled(id).await? {
                return Err(ApiError::channel(HostError::Unavailable));
            }
            if host.available(id) {
                host.reload_channel(id).await
            } else {
                host.set_channel(id, true).await
            }
            .map_err(ApiError::channel)?;
            true
        }
    };
    Ok(RuntimeState::current(host, id, enabled))
}
