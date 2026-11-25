//! Durable desired state for compiled notification channels.

use std::collections::HashMap;

use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, EntityTrait};

use crate::entities::channel_setting;
use crate::{Result, Store};

pub struct ChannelSettings {
    pub enabled: bool,
    pub ingress_enabled: bool,
    pub egress_enabled: bool,
}

impl Store {
    pub async fn channel_settings(&self) -> Result<HashMap<String, ChannelSettings>> {
        let settings = channel_setting::Entity::find()
            .all(self.business_db())
            .await?;
        Ok(settings
            .into_iter()
            .map(|setting| {
                (
                    setting.channel,
                    ChannelSettings {
                        enabled: setting.enabled,
                        ingress_enabled: setting.ingress_enabled,
                        egress_enabled: setting.egress_enabled,
                    },
                )
            })
            .collect())
    }

    pub async fn channel_enabled(&self, channel: &str) -> Result<bool> {
        Ok(channel_setting::Entity::find_by_id(channel)
            .one(self.business_db())
            .await?
            .is_none_or(|setting| setting.enabled))
    }

    pub async fn set_channel_directions(
        &self,
        channel: &str,
        ingress_enabled: bool,
        egress_enabled: bool,
    ) -> Result<()> {
        use channel_setting::Column;
        channel_setting::Entity::insert(channel_setting::ActiveModel {
            channel: Set(channel.to_owned()),
            enabled: Set(true),
            ingress_enabled: Set(ingress_enabled),
            egress_enabled: Set(egress_enabled),
        })
        .on_conflict(
            OnConflict::column(Column::Channel)
                .update_columns([Column::IngressEnabled, Column::EgressEnabled])
                .to_owned(),
        )
        .exec_without_returning(self.business_db())
        .await?;
        Ok(())
    }

    pub async fn set_channel_enabled(&self, channel: &str, enabled: bool) -> Result<()> {
        channel_setting::Entity::insert(channel_setting::ActiveModel {
            channel: Set(channel.to_owned()),
            enabled: Set(enabled),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(channel_setting::Column::Channel)
                .update_column(channel_setting::Column::Enabled)
                .to_owned(),
        )
        .exec_without_returning(self.business_db())
        .await?;
        Ok(())
    }
}
