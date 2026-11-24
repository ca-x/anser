use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, sea_query::OnConflict};

use crate::entities::transform_setting as setting;
use crate::{DataError, Result, Store};

impl Store {
    pub async fn transform_settings(&self, plugin: &str) -> Result<Option<Vec<u8>>> {
        Ok(setting::Entity::find_by_id(plugin.to_owned())
            .one(self.business_db())
            .await?
            .map(|entry| entry.encrypted_config))
    }

    pub async fn save_transform_settings(
        &self,
        plugin: &str,
        expected: Option<Vec<u8>>,
        encrypted_config: Vec<u8>,
    ) -> Result<()> {
        let updated = match expected {
            Some(current) => {
                setting::Entity::update_many()
                    .col_expr(
                        setting::Column::EncryptedConfig,
                        sea_orm::sea_query::Expr::value(encrypted_config),
                    )
                    .filter(setting::Column::PluginId.eq(plugin))
                    .filter(setting::Column::EncryptedConfig.eq(current))
                    .exec(self.business_db())
                    .await?
                    .rows_affected
            }
            None => {
                setting::Entity::insert(setting::ActiveModel {
                    plugin_id: Set(plugin.to_owned()),
                    encrypted_config: Set(encrypted_config),
                })
                .on_conflict(
                    OnConflict::column(setting::Column::PluginId)
                        .do_nothing()
                        .to_owned(),
                )
                .exec_without_returning(self.business_db())
                .await?
            }
        };
        if updated != 1 {
            return Err(DataError::Conflict);
        }
        Ok(())
    }
}
