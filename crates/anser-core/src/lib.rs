//! Domain types shared by the service and its channels.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageFormat {
    #[default]
    Text,
    Markdown,
    Html,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Message {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub format: MessageFormat,
    #[serde(default)]
    pub tags: Vec<String>,
    pub url: Option<String>,
    pub level: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub extras: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Attachment {
    pub url: String,
    pub name: Option<String>,
    pub content_type: Option<String>,
}

/// Public account metadata. The store keeps credentials separately.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Account {
    pub id: String,
    pub channel: String,
    pub name: String,
    pub tags: Vec<String>,
    pub weight: u32,
    pub priority: i32,
    pub enabled: bool,
    pub rate_limit: Option<u32>,
}

/// Account configuration passed only to the selected channel.
#[derive(Deserialize, Serialize)]
pub struct ChannelAccount {
    pub config: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Pending,
    Sending,
    Success,
    Failed,
    Dead,
    Cancelled,
}

pub mod api;
pub mod routing;
