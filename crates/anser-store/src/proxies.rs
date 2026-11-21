//! Admin-managed outbound proxy profiles and encrypted account connections.

use anser_core::api::Page;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Select};
use serde::Serialize;
use sqlx::SqliteConnection;

use crate::entities::proxy;
use crate::{DataError, Result, Store, affected, manage};

#[derive(Serialize, sqlx::FromRow, sea_orm::FromQueryResult)]
pub struct ProxyProfile {
    pub id: String,
    pub name: String,
    pub url: String,
    pub authenticated: bool,
}

pub struct ProxyConnection<'a> {
    pub url: &'a str,
    pub authenticated: bool,
    pub encrypted: &'a [u8],
}

impl Store {
    pub async fn proxies(&self, after: &str, limit: u32) -> Result<Page<ProxyProfile>> {
        let mut values = public_proxies()
            .filter(proxy::Column::Id.gt(after))
            .order_by_asc(proxy::Column::Id)
            .limit(u64::from(limit) + 1)
            .into_model::<ProxyProfile>()
            .all(self.business_db())
            .await?;
        Ok(manage::page(&mut values, limit, |value| &value.id))
    }

    pub async fn proxy(&self, id: &str) -> Result<ProxyProfile> {
        public_proxies()
            .filter(proxy::Column::Id.eq(id))
            .into_model::<ProxyProfile>()
            .one(self.business_db())
            .await?
            .ok_or(DataError::Missing)
    }

    pub async fn create_proxy(
        &self,
        id: &str,
        name: &str,
        connection: ProxyConnection<'_>,
    ) -> Result<ProxyProfile> {
        sqlx::query_as("INSERT INTO proxy_profiles(id,space_id,name,url,authenticated,encrypted_connection) VALUES(?,'default',?,?,?,?) RETURNING id,name,url,authenticated")
            .bind(id).bind(name).bind(connection.url).bind(connection.authenticated).bind(connection.encrypted)
            .fetch_one(&self.0).await.map_err(manage::conflict)
    }

    pub async fn update_proxy(
        &self,
        id: &str,
        name: &str,
        connection: Option<ProxyConnection<'_>>,
    ) -> Result<ProxyProfile> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let profile = sqlx::query_as("UPDATE proxy_profiles SET name=?,url=COALESCE(?,url),authenticated=COALESCE(?,authenticated),encrypted_connection=COALESCE(?,encrypted_connection) WHERE id=? AND space_id='default' RETURNING id,name,url,authenticated")
            .bind(name)
            .bind(connection.as_ref().map(|connection| connection.url))
            .bind(connection.as_ref().map(|connection| connection.authenticated))
            .bind(connection.as_ref().map(|connection| connection.encrypted))
            .bind(id)
            .fetch_optional(&mut *tx).await.map_err(manage::conflict)?.ok_or(DataError::Missing)?;
        if connection.is_some() {
            sqlx::query("UPDATE accounts SET consecutive_failures=0,circuit_until=0 WHERE space_id='default' AND proxy_id=?")
                .bind(id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(profile)
    }

    pub async fn delete_proxy(&self, id: &str) -> Result<()> {
        let deleted = sqlx::query("DELETE FROM proxy_profiles WHERE id=? AND space_id='default'")
            .bind(id)
            .execute(&self.0)
            .await
            .map_err(|error| {
                if error
                    .as_database_error()
                    .is_some_and(|error| error.is_foreign_key_violation())
                {
                    DataError::ProxyInUse
                } else {
                    error.into()
                }
            })?;
        affected(deleted.rows_affected())
    }

    /// Account and profile are read from the same snapshot used to begin a send.
    pub async fn account_for_send(
        &self,
        id: &str,
    ) -> Result<(crate::manage::StoredAccount, Option<Vec<u8>>)> {
        let mut tx = self.0.begin().await?;
        let account = sqlx::query_as::<_, crate::manage::StoredAccount>("SELECT id,channel,name,tags,weight,priority,enabled,rate_limit,proxy_id,encrypted_config,circuit_until FROM accounts WHERE id=? AND space_id='default'")
            .bind(id).fetch_optional(&mut *tx).await?.ok_or(DataError::Missing)?;
        let proxy = proxy_credentials(&mut tx, account.proxy_id.as_deref()).await?;
        tx.commit().await?;
        Ok((account, proxy))
    }
}

fn public_proxies() -> Select<proxy::Entity> {
    use proxy::Column as C;
    proxy::Entity::find()
        .select_only()
        .columns([C::Id, C::Name, C::Url, C::Authenticated])
        .filter(C::SpaceId.eq("default"))
}

pub(super) async fn ensure_proxy(tx: &mut SqliteConnection, proxy_id: Option<&str>) -> Result<()> {
    if let Some(id) = proxy_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM proxy_profiles WHERE id=? AND space_id='default')",
        )
        .bind(id)
        .fetch_one(tx)
        .await?;
        if !exists {
            return Err(DataError::Missing);
        }
    }
    Ok(())
}

pub(super) async fn proxy_credentials(
    tx: &mut SqliteConnection,
    proxy_id: Option<&str>,
) -> Result<Option<Vec<u8>>> {
    let Some(id) = proxy_id else { return Ok(None) };
    let encrypted = sqlx::query_scalar(
        "SELECT encrypted_connection FROM proxy_profiles WHERE id=? AND space_id='default'",
    )
    .bind(id)
    .fetch_optional(tx)
    .await?
    .ok_or(DataError::Missing)?;
    Ok(Some(encrypted))
}
