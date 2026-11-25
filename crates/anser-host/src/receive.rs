//! Direction switches are independent from the plugin's overall lifecycle.
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

use anser_core::api::Receipt;
use anser_plugin_api::{IngressMessage, RouteInfo};
use rutis::host::FiberView;
use rutis_bridge::session::call_service;
use serde_json::Value;
use tokio::sync::RwLockReadGuard;

use super::{Channel, ChannelHost, HostError, channel_error, service_name};

impl ChannelHost {
    pub fn set_directions(&self, id: &str, ingress: bool, egress: bool) -> Result<(), HostError> {
        self.channel(id)?.directions.store(
            u8::from(ingress) | (u8::from(egress) << 1),
            Ordering::Release,
        );
        Ok(())
    }
    pub fn ingress_enabled(&self, id: &str) -> bool {
        self.channels.get(id).is_some_and(|c| {
            c.description.direction.supports_ingress()
                && c.directions.load(Ordering::Acquire) & 1 != 0
        })
    }
    pub fn supports_egress(&self, id: &str) -> bool {
        self.channels
            .get(id)
            .is_some_and(|c| c.description.direction.supports_egress())
    }
    pub fn egress_enabled(&self, id: &str) -> bool {
        self.channels.get(id).is_some_and(|c| {
            c.description.direction.supports_egress()
                && c.directions.load(Ordering::Acquire) & 2 != 0
        })
    }
    pub fn egress_available(&self, id: &str) -> bool {
        self.egress_enabled(id) && self.available(id)
    }

    /// Compiled protocol headers for browser preflights from configured origins.
    pub fn receive_header_names(&self) -> impl Iterator<Item = &str> {
        self.channels
            .values()
            .filter(|channel| channel.description.direction.supports_ingress())
            .flat_map(|channel| channel.headers.iter().chain(channel.token_header.iter()))
            .map(String::as_str)
    }

    pub fn receive(&self, id: &str) -> Option<ReceiveSession<'_>> {
        let channel = self.channels.get(id)?;
        let admission = channel.lifecycle.admit().ok()?;
        self.ingress_enabled(id).then_some(ReceiveSession {
            host: self,
            channel,
            _admission: admission,
        })
    }
}

pub struct ReceiveSession<'a> {
    host: &'a ChannelHost,
    channel: &'a Channel,
    _admission: RwLockReadGuard<'a, Option<FiberView>>,
}

impl ReceiveSession<'_> {
    pub fn routes(&self) -> &[RouteInfo] {
        &self.channel.description.ingress_routes
    }
    pub fn headers(&self) -> &[String] {
        &self.channel.headers
    }
    pub fn token_header(&self) -> Option<&str> {
        self.channel.token_header.as_deref()
    }

    pub async fn decode(
        &self,
        method: &str,
        path: &str,
        headers: BTreeMap<String, String>,
        body: &[u8],
    ) -> Result<IngressMessage, HostError> {
        call_service(
            &self.host.root,
            &service_name(&self.channel.description.id),
            "decodeIngress",
            (method, path, headers, body),
        )
        .await
        .map_err(channel_error)
    }
    pub async fn response(
        &self,
        message: IngressMessage,
        receipt: Receipt,
    ) -> Result<Value, HostError> {
        call_service(
            &self.host.root,
            &service_name(&self.channel.description.id),
            "ingressResponse",
            (message, receipt),
        )
        .await
        .map_err(channel_error)
    }
}
