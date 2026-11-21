//! Admission and lifecycle control for one built-in channel.

use std::sync::Arc;

use rutis::Ctx;
use rutis::host::{FiberState, FiberView};
use tokio::sync::{RwLock, RwLockReadGuard};

use super::HostError;

pub(super) type Factory = fn(&Ctx) -> FiberView;

pub(super) struct Lifecycle {
    factory: Factory,
    fiber: RwLock<Option<FiberView>>,
}

#[derive(Clone, Copy)]
pub(super) enum Transition {
    SetEnabled(bool),
    Reload,
}

impl Lifecycle {
    pub(super) async fn mount(root: &Ctx, factory: Factory) -> Result<Self, HostError> {
        let fiber = mount(root, factory).await?;
        Ok(Self {
            factory,
            fiber: RwLock::new(Some(fiber)),
        })
    }

    /// New calls fail promptly while an exclusive transition is waiting or active.
    /// Calls already admitted retain the read guard until their futures complete.
    pub(super) fn admit(&self) -> Result<RwLockReadGuard<'_, Option<FiberView>>, HostError> {
        let fiber = self.fiber.try_read().map_err(|_| HostError::Unavailable)?;
        if fiber.as_ref().is_none_or(|fiber| !active(fiber)) {
            return Err(HostError::Unavailable);
        }
        Ok(fiber)
    }

    pub(super) async fn apply(
        self: Arc<Self>,
        root: Ctx,
        transition: Transition,
    ) -> Result<(), HostError> {
        // A dropped management request must not release the write lock while
        // rutis is still unloading or start a competing fiber for the same name.
        tokio::spawn(async move {
            let mut current = self.fiber.write().await;
            match transition {
                Transition::SetEnabled(false) => {
                    if let Some(fiber) = current.take() {
                        fiber.dispose().await.map_err(|_| HostError::Lifecycle)?;
                    }
                }
                Transition::SetEnabled(true) => match current.as_ref() {
                    Some(fiber) if active(fiber) => {}
                    Some(fiber) => restart(fiber).await?,
                    None => *current = Some(mount(&root, self.factory).await?),
                },
                Transition::Reload => {
                    let fiber = current.as_ref().ok_or(HostError::Unavailable)?;
                    restart(fiber).await?;
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| HostError::Lifecycle)?
    }
}

fn active(fiber: &FiberView) -> bool {
    fiber.state().state == FiberState::Active
}

async fn mount(root: &Ctx, factory: Factory) -> Result<FiberView, HostError> {
    let fiber = factory(root);
    let result = (&fiber).await;
    if result.is_ok() && active(&fiber) {
        return Ok(fiber);
    }
    let _ = fiber.dispose().await;
    Err(HostError::Lifecycle)
}

async fn restart(fiber: &FiberView) -> Result<(), HostError> {
    fiber.restart().await.map_err(|_| HostError::Lifecycle)?;
    if active(fiber) {
        Ok(())
    } else {
        Err(HostError::Lifecycle)
    }
}
