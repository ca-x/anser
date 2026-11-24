//! Catalog projections are committed with the Topic announcement.

use anser_core::api::Page;
use serde::Serialize;
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite};

use crate::{DataError, Result, Store, manage};

pub struct MarketWrite {
    pub kind: &'static str,
    pub manifest: Value,
}

#[derive(Serialize)]
pub struct Listing {
    pub message_id: String,
    pub created_at: i64,
    pub manifest: Value,
}

impl Store {
    pub async fn plugin_listings(
        &self,
        topic_name: &str,
        admin: bool,
        user_id: Option<&str>,
        kind: Option<&str>,
        after: Option<&str>,
        limit: u32,
    ) -> Result<Page<Listing>> {
        let mut snapshot = self.0.begin().await?;
        let topic = manage::topic(&mut snapshot, topic_name).await?;
        if !admin && topic.value()?.protected {
            let member: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM subscriptions WHERE topic_id=? AND user_id=?)",
            )
            .bind(&topic.id)
            .bind(user_id)
            .fetch_one(&mut *snapshot)
            .await?;
            if !member {
                return Err(DataError::Forbidden);
            }
        }
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT message_id, created_at, manifest FROM plugin_market_listings WHERE topic_id=",
        );
        query.push_bind(&topic.id);
        if let Some(kind) = kind {
            query.push(" AND kind=").push_bind(kind);
        }
        if let Some(after) = after {
            query
                .push(" AND (created_at,message_id)<(SELECT created_at,message_id FROM plugin_market_listings WHERE topic_id=")
                .push_bind(&topic.id)
                .push(" AND message_id=")
                .push_bind(after)
                .push(")");
        }
        let rows = query
            .push(" ORDER BY created_at DESC,message_id DESC LIMIT ")
            .push_bind(i64::from(limit) + 1)
            .build_query_as::<(String, i64, String)>()
            .fetch_all(&mut *snapshot)
            .await?;
        snapshot.commit().await?;
        let mut values = rows
            .into_iter()
            .map(|(message_id, created_at, manifest)| {
                Ok(Listing {
                    message_id,
                    created_at,
                    manifest: serde_json::from_str(&manifest)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(manage::page(&mut values, limit, |listing| {
            &listing.message_id
        }))
    }
}
