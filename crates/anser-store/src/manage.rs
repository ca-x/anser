//! Account, topic, subscription and API key persistence.

use anser_core::Account;
use anser_core::api::{Page, Policy, Subscription, SubscriptionInput, Topic};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Select};
use serde::Serialize;
use sqlx::SqliteConnection;

use crate::entities::{account, topic};
use crate::{DataError, Result, Store, affected, new_id, now_ms};

#[derive(sqlx::FromRow, sea_orm::FromQueryResult)]
pub struct StoredAccount {
    pub id: String,
    pub channel: String,
    pub name: String,
    pub tags: String,
    pub weight: u32,
    pub priority: i32,
    pub enabled: bool,
    pub rate_limit: Option<u32>,
    pub proxy_id: Option<String>,
    pub encrypted_config: Vec<u8>,
    pub circuit_until: i64,
}

impl StoredAccount {
    pub fn public(&self) -> Result<Account> {
        Ok(Account {
            id: self.id.clone(),
            channel: self.channel.clone(),
            name: self.name.clone(),
            tags: serde_json::from_str(&self.tags)?,
            weight: self.weight,
            priority: self.priority,
            enabled: self.enabled,
            rate_limit: self.rate_limit,
            proxy_id: self.proxy_id.clone(),
        })
    }
}

#[derive(sqlx::FromRow, sea_orm::FromQueryResult)]
pub(crate) struct TopicRow {
    pub id: String,
    name: String,
    description: String,
    enabled: bool,
    default_tags: String,
    retention: Option<u32>,
    policy: String,
    protected: bool,
}

impl TopicRow {
    pub fn value(&self) -> Result<Topic> {
        Ok(Topic {
            name: self.name.clone(),
            description: self.description.clone(),
            enabled: self.enabled,
            default_tags: serde_json::from_str(&self.default_tags)?,
            retention: self.retention,
            policy: serde_json::from_str(&self.policy)?,
            protected: self.protected,
        })
    }
}

#[derive(sqlx::FromRow)]
pub(crate) struct SubscriptionRow {
    pub id: String,
    subscriber_ref: String,
    pub account_id: Option<String>,
    pub encrypted_target: Option<Vec<u8>>,
    pub filter: String,
    pub user_id: Option<String>,
    created_at: i64,
}

impl SubscriptionRow {
    pub fn value(self) -> Result<Subscription> {
        Ok(Subscription {
            id: self.id,
            user_id: self.user_id,
            subscriber_ref: self.subscriber_ref,
            account_id: self.account_id,
            filter: serde_json::from_str(&self.filter)?,
            created_at: self.created_at,
        })
    }
}

pub struct SubscriptionWrite<'a> {
    pub id: String,
    pub input: SubscriptionInput,
    pub target: Option<Vec<u8>>,
    pub user_id: Option<&'a str>,
    pub key_id: &'a str,
    pub expected_password: Option<&'a str>,
    pub admin: bool,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ApiKey {
    pub id: String,
    #[serde(skip)]
    pub secret_hash: Vec<u8>,
    pub name: String,
    #[serde(skip)]
    scopes_json: String,
    pub topic_prefix: Option<String>,
    pub expires_at: Option<i64>,
    pub enabled: bool,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub user_id: Option<String>,
    pub session: bool,
}

impl ApiKey {
    pub fn scopes(&self) -> Result<Vec<String>> {
        Ok(serde_json::from_str(&self.scopes_json)?)
    }

    pub fn view(&self) -> Result<serde_json::Value> {
        let mut value = serde_json::to_value(self)?;
        value["scopes"] = serde_json::to_value(self.scopes()?)?;
        Ok(value)
    }
}

pub struct NewKey<'a> {
    pub id: &'a str,
    pub hash: &'a [u8],
    pub name: &'a str,
    pub scopes: &'a [String],
    pub topic_prefix: Option<&'a str>,
    pub expires_at: Option<i64>,
}

pub(crate) async fn topic(connection: &mut SqliteConnection, name: &str) -> Result<TopicRow> {
    sqlx::query_as("SELECT id, name, description, enabled, default_tags, retention, policy, password_hash IS NOT NULL AS protected FROM topics WHERE space_id = 'default' AND name=?")
        .bind(name).fetch_optional(connection).await?.ok_or(DataError::Missing)
}

pub(crate) async fn subscriptions(
    connection: &mut SqliteConnection,
    topic_id: &str,
) -> Result<Vec<SubscriptionRow>> {
    Ok(sqlx::query_as("SELECT id, subscriber_ref, account_id, encrypted_target, filter, created_at, user_id FROM subscriptions WHERE topic_id=? ORDER BY id")
        .bind(topic_id).fetch_all(connection).await?)
}

fn management_accounts() -> Select<account::Entity> {
    use account::Column as C;

    account::Entity::find()
        .select_only()
        .columns([
            C::Id,
            C::Channel,
            C::Name,
            C::Tags,
            C::Weight,
            C::Priority,
            C::Enabled,
            C::RateLimit,
            C::ProxyId,
            C::EncryptedConfig,
            C::CircuitUntil,
        ])
        .filter(C::SpaceId.eq("default"))
}

fn management_topics() -> Select<topic::Entity> {
    use topic::Column as C;

    topic::in_default_space()
        .select_only()
        .columns([
            C::Id,
            C::Name,
            C::Description,
            C::Enabled,
            C::DefaultTags,
            C::Retention,
            C::Policy,
        ])
        .column_as(C::PasswordHash.is_not_null(), "protected")
}

impl Store {
    pub async fn account(&self, id: &str) -> Result<StoredAccount> {
        management_accounts()
            .filter(account::Column::Id.eq(id))
            .into_model::<StoredAccount>()
            .one(self.business_db())
            .await?
            .ok_or(DataError::Missing)
    }

    pub async fn accounts(
        &self,
        after: &str,
        limit: u32,
        channel: Option<&str>,
    ) -> Result<Page<Account>> {
        let mut query = management_accounts().filter(account::Column::Id.gt(after));
        if let Some(channel) = channel {
            query = query.filter(account::Column::Channel.eq(channel));
        }
        let mut values = query
            .order_by_asc(account::Column::Id)
            .limit(u64::from(limit) + 1)
            .into_model::<StoredAccount>()
            .all(self.business_db())
            .await?
            .iter()
            .map(StoredAccount::public)
            .collect::<Result<Vec<_>>>()?;
        Ok(page(&mut values, limit, |value| &value.id))
    }

    pub async fn available_accounts(&self) -> Result<Vec<StoredAccount>> {
        Ok(management_accounts()
            .filter(account::Column::Enabled.eq(true))
            .order_by_asc(account::Column::CreatedAt)
            .order_by_asc(account::Column::Id)
            .into_model::<StoredAccount>()
            .all(self.business_db())
            .await?)
    }

    pub async fn create_account(&self, account: &Account, encrypted: &[u8]) -> Result<()> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        super::proxies::ensure_proxy(&mut tx, account.proxy_id.as_deref()).await?;
        sqlx::query("INSERT INTO accounts(id,space_id,channel,name,encrypted_config,tags,weight,priority,enabled,rate_limit,proxy_id) VALUES(?,'default',?,?,?,?,?,?,?,?,?)")
            .bind(&account.id).bind(&account.channel).bind(&account.name).bind(encrypted)
            .bind(serde_json::to_string(&account.tags)?).bind(account.weight).bind(account.priority)
            .bind(account.enabled).bind(account.rate_limit).bind(&account.proxy_id)
            .execute(&mut *tx).await.map_err(conflict)?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn update_account(
        &self,
        account: &Account,
        previous: &StoredAccount,
        encrypted: Option<&[u8]>,
        proxy: Option<Option<&str>>,
    ) -> Result<Account> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        super::proxies::ensure_proxy(&mut tx, proxy.flatten()).await?;
        // Detect writer conflicts on all editable state used to assemble this update.
        // Workers may still update scheduling timestamps and circuit state independently.
        let updated: StoredAccount = sqlx::query_as(
            "UPDATE accounts SET name=?, tags=?, weight=?, priority=?, enabled=?, rate_limit=?,
                 encrypted_config=COALESCE(?,encrypted_config), proxy_id=CASE WHEN ? THEN ? ELSE proxy_id END,
                 consecutive_failures=CASE WHEN ? OR (? AND proxy_id IS NOT ?) THEN 0 ELSE consecutive_failures END,
                 circuit_until=CASE WHEN ? OR (? AND proxy_id IS NOT ?) THEN 0 ELSE circuit_until END
             WHERE id=? AND channel=? AND space_id='default' AND encrypted_config=? AND proxy_id IS ?
                 AND name=? AND tags=? AND weight=? AND priority=? AND enabled=? AND rate_limit IS ?
             RETURNING id,channel,name,tags,weight,priority,enabled,rate_limit,proxy_id,encrypted_config,circuit_until"
        )
            .bind(&account.name).bind(serde_json::to_string(&account.tags)?).bind(account.weight)
            .bind(account.priority).bind(account.enabled).bind(account.rate_limit)
            .bind(encrypted).bind(proxy.is_some()).bind(proxy.flatten())
            .bind(encrypted.is_some()).bind(proxy.is_some()).bind(proxy.flatten())
            .bind(encrypted.is_some()).bind(proxy.is_some()).bind(proxy.flatten())
            .bind(&account.id).bind(&account.channel).bind(&previous.encrypted_config).bind(&previous.proxy_id)
            .bind(&previous.name).bind(&previous.tags).bind(previous.weight).bind(previous.priority)
            .bind(previous.enabled).bind(previous.rate_limit)
            .fetch_optional(&mut *tx).await.map_err(conflict)?.ok_or(DataError::Conflict)?;
        let public = updated.public()?;
        tx.commit().await?;
        Ok(public)
    }

    pub async fn delete_account(&self, id: &str) -> Result<()> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        cancel_subscriptions(&mut tx, "account_id", id).await?;
        let result = sqlx::query("DELETE FROM accounts WHERE id=? AND space_id='default'")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        affected(result.rows_affected())?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn default_policy(&self) -> Result<Policy> {
        let json: String =
            sqlx::query_scalar("SELECT default_policy FROM spaces WHERE id='default'")
                .fetch_one(&self.0)
                .await?;
        Ok(serde_json::from_str(&json)?)
    }

    pub async fn set_default_policy(&self, policy: &Policy) -> Result<()> {
        sqlx::query("UPDATE spaces SET default_policy=? WHERE id='default'")
            .bind(serde_json::to_string(policy)?)
            .execute(&self.0)
            .await?;
        Ok(())
    }

    pub async fn topic(&self, name: &str) -> Result<Topic> {
        management_topics()
            .filter(topic::Column::Name.eq(name))
            .into_model::<TopicRow>()
            .one(self.business_db())
            .await?
            .ok_or(DataError::Missing)?
            .value()
    }

    pub async fn topics(
        &self,
        after: &str,
        limit: u32,
        prefix: Option<&str>,
    ) -> Result<Page<Topic>> {
        let mut query = management_topics().filter(topic::Column::Name.gt(after));
        if let Some(prefix) = prefix.filter(|prefix| !prefix.is_empty()) {
            query = query.filter(topic::name_prefix(prefix));
        }
        let mut values = query
            .order_by_asc(topic::Column::Name)
            .limit(u64::from(limit) + 1)
            .into_model::<TopicRow>()
            .all(self.business_db())
            .await?
            .iter()
            .map(TopicRow::value)
            .collect::<Result<Vec<_>>>()?;
        Ok(page(&mut values, limit, |value| &value.name))
    }

    pub async fn create_topic(&self, topic: &Topic, password_hash: Option<&str>) -> Result<()> {
        sqlx::query("INSERT INTO topics(id,space_id,name,description,enabled,default_tags,retention,policy,password_hash) VALUES(?,'default',?,?,?,?,?,?,?)")
            .bind(new_id()).bind(&topic.name).bind(&topic.description).bind(topic.enabled)
            .bind(serde_json::to_string(&topic.default_tags)?).bind(topic.retention)
            .bind(serde_json::to_string(&topic.policy)?).bind(password_hash).execute(&self.0).await.map_err(conflict)?;
        Ok(())
    }

    pub async fn update_topic(
        &self,
        name: &str,
        topic: &Topic,
        password_hash: Option<Option<&str>>,
    ) -> Result<()> {
        // Renames would change authorization and the identity recorded on existing deliveries.
        if name != topic.name {
            return Err(DataError::Conflict);
        }
        let updated = sqlx::query("UPDATE topics SET description=?,enabled=?,default_tags=?,retention=?,policy=?,password_hash=CASE WHEN ? THEN ? ELSE password_hash END WHERE space_id='default' AND name=?")
            .bind(&topic.description).bind(topic.enabled).bind(serde_json::to_string(&topic.default_tags)?)
            .bind(topic.retention).bind(serde_json::to_string(&topic.policy)?).bind(password_hash.is_some()).bind(password_hash.flatten()).bind(name).execute(&self.0).await?;
        affected(updated.rows_affected())
    }

    pub async fn delete_topic(&self, name: &str) -> Result<()> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let topic = topic(&mut tx, name).await?;
        cancel_subscriptions(&mut tx, "topic_id", &topic.id).await?;
        sqlx::query("DELETE FROM topics WHERE id=?")
            .bind(topic.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn subscriptions(
        &self,
        name: &str,
        after: &str,
        limit: u32,
        owner: Option<&str>,
    ) -> Result<Page<Subscription>> {
        let topic = topic(&mut *self.0.acquire().await?, name).await?;
        let mut values = sqlx::query_as::<_, SubscriptionRow>("SELECT id,subscriber_ref,account_id,encrypted_target,filter,created_at,user_id FROM subscriptions WHERE topic_id=? AND id>? AND (? IS NULL OR COALESCE(user_id,key_id)=?) ORDER BY id LIMIT ?")
            .bind(topic.id).bind(after).bind(owner).bind(owner).bind(limit + 1).fetch_all(&self.0).await?
            .into_iter().map(SubscriptionRow::value).collect::<Result<Vec<_>>>()?;
        Ok(page(&mut values, limit, |value| &value.id))
    }

    pub async fn subscribe(
        &self,
        name: &str,
        write: SubscriptionWrite<'_>,
    ) -> Result<Subscription> {
        let SubscriptionWrite {
            id,
            input,
            target,
            user_id,
            key_id,
            expected_password,
            admin,
        } = write;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let topic = topic(&mut tx, name).await?;
        if !admin {
            let same: bool = sqlx::query_scalar("SELECT password_hash IS ? OR EXISTS(SELECT 1 FROM subscriptions WHERE topic_id=topics.id AND user_id=?) FROM topics WHERE id=?")
                .bind(expected_password).bind(user_id).bind(&topic.id).fetch_one(&mut *tx).await?;
            if !same {
                return Err(DataError::Forbidden);
            }
        }
        let now = now_ms();
        sqlx::query("INSERT INTO subscriptions(id,topic_id,subscriber_ref,account_id,encrypted_target,filter,created_at,user_id,key_id) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(&id).bind(topic.id).bind(&input.subscriber_ref).bind(&input.account_id)
            .bind(target).bind(serde_json::to_string(&input.filter)?).bind(now).bind(user_id).bind(user_id.is_none().then_some(key_id))
            .execute(&mut *tx).await.map_err(conflict)?;
        tx.commit().await?;
        Ok(Subscription {
            id,
            user_id: user_id.map(ToOwned::to_owned),
            subscriber_ref: input.subscriber_ref,
            account_id: input.account_id,
            filter: input.filter,
            created_at: now,
        })
    }

    pub async fn unsubscribe(&self, name: &str, id: &str, owner: Option<&str>) -> Result<()> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let topic = topic(&mut tx, name).await?;
        let result = sqlx::query("DELETE FROM subscriptions WHERE id=? AND topic_id=? AND (? IS NULL OR COALESCE(user_id,key_id)=?)")
            .bind(id).bind(topic.id).bind(owner).bind(owner).execute(&mut *tx).await?;
        affected(result.rows_affected())?;
        super::queue::cancel(&mut tx, id).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn key(&self, id: &str) -> Result<ApiKey> {
        if id == crate::scheduled_tasks::RESERVED_SCHEDULE_KEY {
            return Err(DataError::Missing);
        }
        sqlx::query_as("SELECT id, secret_hash, name, scopes AS scopes_json, topic_prefix, expires_at, enabled, created_at, last_used_at, user_id, session FROM api_keys WHERE id=?")
            .bind(id).fetch_optional(&self.0).await?.ok_or(DataError::Missing)
    }

    pub async fn keys(&self, after: &str, limit: u32) -> Result<Page<serde_json::Value>> {
        self.keys_with_scope(after, limit, None).await
    }

    pub async fn keys_with_scope(
        &self,
        after: &str,
        limit: u32,
        scope: Option<&str>,
    ) -> Result<Page<serde_json::Value>> {
        let mut keys = sqlx::query_as::<_, ApiKey>(
            "SELECT id,secret_hash,name,scopes AS scopes_json,topic_prefix,expires_at,enabled,created_at,last_used_at,user_id,session
             FROM api_keys WHERE session=0 AND id<>? AND id>? AND
             (? IS NULL OR EXISTS(SELECT 1 FROM json_each(scopes) WHERE value=?)) ORDER BY id LIMIT ?",
        ).bind(crate::scheduled_tasks::RESERVED_SCHEDULE_KEY).bind(after)
        .bind(scope).bind(scope).bind(limit + 1).fetch_all(&self.0).await?;
        let keys = page(&mut keys, limit, |key| &key.id);
        Ok(Page {
            items: keys
                .items
                .iter()
                .map(ApiKey::view)
                .collect::<Result<Vec<_>>>()?,
            next_cursor: keys.next_cursor,
        })
    }

    pub async fn touch_key(&self, id: &str, now: i64) -> Result<()> {
        sqlx::query("UPDATE api_keys SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)")
            .bind(now).bind(id).bind(now - 60_000).execute(&self.0).await?;
        Ok(())
    }

    pub async fn insert_key(&self, key: NewKey<'_>, bootstrap: bool) -> Result<bool> {
        let result = sqlx::query("INSERT INTO api_keys(id,secret_hash,name,scopes,topic_prefix,expires_at,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT ? OR NOT EXISTS(SELECT 1 FROM api_keys)")
            .bind(key.id).bind(key.hash).bind(key.name).bind(serde_json::to_string(key.scopes)?)
            .bind(key.topic_prefix).bind(key.expires_at).bind(now_ms()).bind(bootstrap).execute(&self.0).await.map_err(conflict)?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn disable_key(&self, id: &str) -> Result<()> {
        let result = sqlx::query("UPDATE api_keys SET enabled=0 WHERE id=?")
            .bind(id)
            .execute(&self.0)
            .await?;
        affected(result.rows_affected())
    }

    pub async fn rotate_key(&self, id: &str, hash: &[u8]) -> Result<()> {
        let result = sqlx::query("UPDATE api_keys SET secret_hash=? WHERE id=? AND enabled=1")
            .bind(hash)
            .bind(id)
            .execute(&self.0)
            .await?;
        affected(result.rows_affected())
    }
}

async fn cancel_subscriptions(
    tx: &mut SqliteConnection,
    selector: &str,
    value: &str,
) -> Result<()> {
    let statement = match selector {
        "account_id" => "SELECT id FROM subscriptions WHERE account_id=?",
        "topic_id" => "SELECT id FROM subscriptions WHERE topic_id=?",
        _ => unreachable!("fixed subscription selectors"),
    };
    let ids: Vec<String> = sqlx::query_scalar(statement)
        .bind(value)
        .fetch_all(&mut *tx)
        .await?;
    for id in ids {
        super::queue::cancel(tx, &id).await?;
    }
    Ok(())
}

pub(crate) fn conflict(error: sqlx::Error) -> DataError {
    if error
        .as_database_error()
        .is_some_and(|error| error.is_unique_violation() || error.is_foreign_key_violation())
    {
        DataError::Conflict
    } else {
        error.into()
    }
}

pub(crate) fn page<T>(values: &mut Vec<T>, limit: u32, key: impl Fn(&T) -> &str) -> Page<T> {
    let more = values.len() > limit as usize;
    values.truncate(limit as usize);
    let next_cursor = more
        .then(|| values.last().map(|value| key(value).to_owned()))
        .flatten();
    Page {
        items: std::mem::take(values),
        next_cursor,
    }
}

impl Store {
    pub async fn has_credentials(&self) -> Result<bool> {
        Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduled_tasks) OR EXISTS(SELECT 1 FROM accounts) OR EXISTS(SELECT 1 FROM proxy_profiles) OR EXISTS(SELECT 1 FROM deliveries WHERE encrypted_target IS NOT NULL) OR EXISTS(SELECT 1 FROM user_totp WHERE setup_expires_at IS NULL OR setup_expires_at>?)")
            .bind(now_ms()).fetch_one(&self.0).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn account_edits_detect_concurrent_proxy_and_metadata_changes() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("accounts.db")).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO proxy_profiles(id,space_id,name,url,authenticated,encrypted_connection)
                       VALUES('p','default','proxy','http://proxy.example',0,x'01');
                       INSERT INTO accounts(id,space_id,name,channel,encrypted_config)
                       VALUES('a','default','initial','ntfy',x'01');",
        )
        .execute(&store.0)
        .await
        .unwrap();
        let before = store.account("a").await.unwrap();
        let original = before.public().unwrap();
        store
            .update_account(&original, &before, None, Some(Some("p")))
            .await
            .unwrap();
        assert!(matches!(
            store
                .update_account(&original, &before, Some(&[2]), None)
                .await,
            Err(DataError::Conflict)
        ));

        let current = store.account("a").await.unwrap();
        let mut renamed = current.public().unwrap();
        renamed.name = "changed".into();
        store
            .update_account(&renamed, &current, None, None)
            .await
            .unwrap();
        assert!(matches!(
            store
                .update_account(&original, &current, None, Some(None))
                .await,
            Err(DataError::Conflict)
        ));
        let result = store.account("a").await.unwrap();
        assert_eq!(result.name, "changed");
        assert_eq!(result.proxy_id.as_deref(), Some("p"));
        assert_eq!(result.encrypted_config, [1]);
    }

    #[tokio::test]
    async fn channel_filter_is_applied_before_pagination() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("anser.sqlite3"))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO accounts (id, space_id, channel, name, encrypted_config) VALUES
            ('a', 'default', 'ntfy', 'One', x'01'),
            ('b', 'default', 'email', 'Two', x'01'),
            ('c', 'default', 'bark', 'Three', x'01'),
            ('d', 'default', 'ntfy', 'Four', x'01')",
        )
        .execute(&store.0)
        .await
        .unwrap();
        let first = store.accounts("", 1, Some("ntfy")).await.unwrap();
        assert_eq!(first.items[0].id, "a");
        let cursor = first.next_cursor.unwrap();
        let second = store.accounts(&cursor, 1, Some("ntfy")).await.unwrap();
        assert_eq!(second.items[0].id, "d");
        assert!(second.next_cursor.is_none());
    }
}
