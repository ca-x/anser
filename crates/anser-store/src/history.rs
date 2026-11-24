use serde::{Deserialize, Serialize};

use crate::{Result, Store};

#[derive(Clone, Copy, Deserialize, Serialize, sqlx::FromRow)]
#[serde(deny_unknown_fields)]
pub struct HistoryRetention {
    pub enabled: bool,
    pub days: u32,
}

impl Store {
    pub async fn history_retention(&self) -> Result<Option<HistoryRetention>> {
        Ok(
            sqlx::query_as("SELECT enabled,days FROM history_retention WHERE id=1")
                .fetch_optional(&self.0)
                .await?,
        )
    }

    pub async fn set_history_retention(&self, settings: HistoryRetention) -> Result<()> {
        sqlx::query(
            "INSERT INTO history_retention(id,enabled,days) VALUES(1,?,?)
             ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,days=excluded.days",
        )
        .bind(settings.enabled)
        .bind(settings.days)
        .execute(&self.0)
        .await?;
        Ok(())
    }
}
