//! Durable configuration and HTTP request types shared with the Rust SDK.

use std::num::NonZeroU32;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Message;
use crate::routing::{Backoff, Mode, RetryPolicy, SuccessCriteria};

pub const DEFAULT_AUDIO_RETENTION_DAYS: u16 = 7;
pub const MAX_AUDIO_RETENTION_DAYS: u16 = 365;

pub fn audio_retention_ms(days: u16) -> Option<i64> {
    (1..=MAX_AUDIO_RETENTION_DAYS)
        .contains(&days)
        .then(|| i64::from(days) * 86_400_000)
}

/// Applies a validated subscription override to a decrypted channel configuration.
pub fn apply_recipient_override(
    channel: &str,
    config: &mut serde_json::Map<String, Value>,
    target: &serde_json::Map<String, Value>,
) {
    let replace: &[&str] = match channel {
        "bark" => &["device_key", "device_keys"],
        "lazycat" if target.contains_key("device_id") || target.contains_key("device_ids") => {
            &["device_id", "device_ids"]
        }
        _ => &[],
    };
    for key in replace {
        config.remove(*key);
    }
    config.extend(target.clone());
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub channel: Option<String>,
    pub account_id: Option<String>,
    #[serde(default)]
    pub tag_selector: Vec<String>,
    pub weight: Option<u32>,
    pub priority: Option<i32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Retry {
    pub max_attempts: NonZeroU32,
    pub backoff: Backoff,
    pub base_delay: u64,
    pub max_delay: u64,
    pub jitter: bool,
    pub until_success: bool,
    pub ttl: u64,
}

impl Default for Retry {
    fn default() -> Self {
        Self {
            max_attempts: NonZeroU32::new(3).unwrap(),
            backoff: Backoff::Exponential,
            base_delay: 1_000,
            max_delay: 30_000,
            jitter: true,
            until_success: false,
            ttl: 3_600_000,
        }
    }
}

impl Retry {
    pub fn timing(&self) -> RetryPolicy {
        RetryPolicy {
            max_attempts: self.max_attempts,
            backoff: self.backoff,
            base_delay: Duration::from_millis(self.base_delay),
            max_delay: Duration::from_millis(self.max_delay),
            jitter: self.jitter,
        }
    }

    pub fn valid(&self) -> bool {
        self.max_attempts.get() <= 100
            && self.base_delay > 0
            && self.base_delay <= self.max_delay
            && self.max_delay <= 86_400_000
            && self.ttl > 0
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Policy {
    pub mode: Mode,
    pub targets: Vec<Target>,
    pub retry: Retry,
    pub success_criteria: SuccessCriteria,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            mode: Mode::Broadcast,
            targets: Vec::new(),
            retry: Retry::default(),
            success_criteria: SuccessCriteria::All,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Selector {
    Name(String),
    Target(Target),
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Strategy {
    pub mode: Option<Mode>,
    pub retry: Option<Retry>,
    pub success_criteria: Option<SuccessCriteria>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Publish {
    #[serde(flatten)]
    pub message: Message,
    pub channels: Option<Vec<Selector>>,
    pub strategy: Option<Strategy>,
    /// UTC milliseconds since the Unix epoch.
    pub expire_at: Option<i64>,
    pub callback_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub topic_password: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Receipt {
    pub message_id: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

/// Registered notification targets for the authenticated LazyCat platform user.
#[derive(Debug, Deserialize, Serialize)]
pub struct LazycatDevices {
    pub user_id: String,
    pub devices: Vec<LazycatDevice>,
    pub max_selection: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub configured_device_ids: Vec<String>,
}

pub const LAZYCAT_DEVICE_LIMIT: usize = 16;

#[derive(Debug, Deserialize, Serialize)]
pub struct LazycatDevice {
    pub device_id: String,
    pub name: String,
    pub online: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Topic {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub default_tags: Vec<String>,
    pub retention: Option<u32>,
    #[serde(default)]
    pub policy: Policy,
    #[serde(default)]
    pub protected: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SubscriptionInput {
    pub subscriber_ref: String,
    pub account_id: Option<String>,
    pub target: Option<Value>,
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    #[serde(default)]
    pub filter: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Subscription {
    pub user_id: Option<String>,
    pub id: String,
    pub subscriber_ref: String,
    pub account_id: Option<String>,
    pub filter: Vec<String>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Attempt {
    pub n: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error_code: Option<String>,
    pub error_msg: Option<String>,
    pub latency: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Delivery {
    pub id: String,
    pub channel: String,
    pub account_id: String,
    /// Current account name for administrators with global account access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    pub subscription_id: Option<String>,
    pub status: String,
    pub next_retry_at: Option<i64>,
    pub attempts: Vec<Attempt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MessageDetail {
    pub id: String,
    pub topic: Option<String>,
    pub status: String,
    pub message: Message,
    pub created_at: i64,
    /// Number of native inboxes the server wrote to at send time.
    #[serde(default)]
    pub inbox_deliveries: i64,
    /// Destination username supplied by the sender of a direct inbox notification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inbox_recipient: Option<String>,
    /// Relative URL for an available Anser speech recording. Only included in message detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_path: Option<String>,
    pub deliveries: Vec<Delivery>,
}

#[cfg(test)]
mod recipient_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lazycat_subscription_can_switch_between_single_and_multiple_devices() {
        let mut config = json!({"user_id":"owner","device_id":"old"});
        let group = json!({"device_ids":["one","two"]});
        apply_recipient_override(
            "lazycat",
            config.as_object_mut().unwrap(),
            group.as_object().unwrap(),
        );
        assert_eq!(
            config,
            json!({"user_id":"owner","device_ids":["one","two"]})
        );
        let single = json!({"device_id":"other"});
        apply_recipient_override(
            "lazycat",
            config.as_object_mut().unwrap(),
            single.as_object().unwrap(),
        );
        assert_eq!(config, json!({"user_id":"owner","device_id":"other"}));
    }
}
