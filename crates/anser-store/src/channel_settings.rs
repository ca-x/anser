//! Durable desired state for compiled notification channels.

use std::collections::HashMap;

use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, EntityTrait};

use crate::entities::channel_setting;
use crate::{Result, Store};

impl Store {
    pub async fn channel_settings(&self) -> Result<HashMap<String, bool>> {
        let settings = channel_setting::Entity::find()
            .all(self.business_db())
            .await?;
        Ok(settings
            .into_iter()
            .map(|setting| (setting.channel, setting.enabled))
            .collect())
    }

    pub async fn channel_enabled(&self, channel: &str) -> Result<bool> {
        Ok(channel_setting::Entity::find_by_id(channel)
            .one(self.business_db())
            .await?
            .is_none_or(|setting| setting.enabled))
    }

    pub async fn set_channel_enabled(&self, channel: &str, enabled: bool) -> Result<()> {
        channel_setting::Entity::insert(channel_setting::ActiveModel {
            channel: Set(channel.to_owned()),
            enabled: Set(enabled),
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
