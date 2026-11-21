//! Shared single-flight cache for expiring provider tokens.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anser_plugin_api::SendError;
use tokio::sync::Mutex;

type Slot = Arc<Mutex<Option<CachedToken>>>;

struct CachedToken {
    refresh_at: Instant,
    value: Arc<str>,
}

/// Tokens are indexed by a digest of the provider and account configuration.
/// The Arc identity prevents late failures from expiring a newer token.
#[derive(Default)]
pub struct TokenCache {
    accounts: Mutex<HashMap<[u8; 32], Slot>>,
}

impl TokenCache {
    pub async fn get(
        &self,
        key: [u8; 32],
        fetch: impl Future<Output = Result<(String, u64), SendError>>,
    ) -> Result<Arc<str>, SendError> {
        let mut accounts = self.accounts.lock().await;
        let slot = if let Some(slot) = accounts.get(&key) {
            slot.clone()
        } else {
            let slot = Arc::new(Mutex::new(None));
            if accounts.len() >= 256 {
                accounts.retain(|_, entry| {
                    let active = Arc::strong_count(entry) > 1;
                    let populated = entry.try_lock().is_ok_and(|cache| {
                        cache
                            .as_ref()
                            .is_some_and(|token| token.refresh_at > Instant::now())
                    });
                    active || populated
                });
            }
            if accounts.len() < 256 {
                accounts.insert(key, slot.clone());
            }
            slot
        };
        drop(accounts);

        let mut cached = slot.lock().await;
        if let Some(token) = cached
            .as_ref()
            .filter(|token| token.refresh_at > Instant::now())
        {
            return Ok(token.value.clone());
        }
        let (token, ttl) = fetch.await?;
        if ttl == 0 || token.trim().is_empty() {
            return Err(SendError::new(
                "provider_invalid_token",
                "provider returned an invalid expiring token",
                true,
            ));
        }
        let ttl = ttl.min(24 * 60 * 60);
        let refresh_after = Duration::from_secs(ttl - (ttl / 10).min(60));
        let value = Arc::from(token);
        *cached = Some(CachedToken {
            refresh_at: Instant::now() + refresh_after,
            value: Arc::clone(&value),
        });
        Ok(value)
    }

    pub async fn expire(&self, key: [u8; 32], rejected: &Arc<str>) {
        let slot = self.accounts.lock().await.get(&key).cloned();
        if let Some(slot) = slot {
            let mut cached = slot.lock().await;
            if cached
                .as_ref()
                .is_some_and(|token| Arc::ptr_eq(&token.value, rejected))
            {
                *cached = None;
            }
        }
    }
}
