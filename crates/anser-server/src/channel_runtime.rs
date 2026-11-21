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
}

impl ChannelRuntime {
    pub async fn restore(store: &Store, host: &ChannelHost) -> anyhow::Result<()> {
        let settings = store.channel_settings().await?;
        for &id in host.ids() {
            if settings.get(id) == Some(&false) {
                host.set_channel(id, false).await?;
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
    Ok(RuntimeState {
        enabled,
        available: host.available(id),
    })
}
