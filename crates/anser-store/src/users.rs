//! User credentials, session exchange, and the native notification inbox.

use anser_core::Message;
use anser_core::api::Page;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Serialize;

use crate::entities::{topic, user};
use crate::totp::{FactorProof, consume_factor};
use crate::{DataError, Result, Store, affected, new_id, now_ms};

#[derive(Clone, Serialize, sqlx::FromRow, sea_orm::FromQueryResult)]
pub struct User {
    pub id: String,
    pub username: String,
    #[serde(skip)]
    pub password_hash: String,
    pub admin: bool,
    pub enabled: bool,
    pub created_at: i64,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InboxItem {
    pub id: i64,
    pub from_username: Option<String>,
    pub topic: Option<String>,
    pub title: String,
    pub body: String,
    pub format: String,
    pub created_at: i64,
    pub read_at: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InboxReceipt {
    pub id: i64,
    pub message_id: String,
}

impl Store {
    pub async fn create_user(
        &self,
        username: &str,
        password_hash: &str,
        admin: bool,
        bootstrap: bool,
    ) -> Result<Option<User>> {
        let result = sqlx::query_as("INSERT INTO users(id,username,password_hash,admin,created_at) SELECT ?,?,?,?,? WHERE NOT ? OR NOT EXISTS(SELECT 1 FROM users) RETURNING id,username,password_hash,admin,enabled,created_at")
            .bind(new_id()).bind(username).bind(password_hash).bind(admin).bind(now_ms()).bind(bootstrap)
            .fetch_optional(&self.0).await.map_err(super::manage::conflict)?;
        Ok(result)
    }

    pub async fn user(&self, id: &str) -> Result<User> {
        user::Entity::find_by_id(id)
            .into_model::<User>()
            .one(self.business_db())
            .await?
            .ok_or(DataError::Missing)
    }

    pub async fn user_named(&self, name: &str) -> Result<User> {
        user::Entity::find()
            .filter(user::Column::Username.eq(name))
            .into_model::<User>()
            .one(self.business_db())
            .await?
            .ok_or(DataError::Missing)
    }

    pub async fn users(&self, after: &str, limit: u32) -> Result<Page<User>> {
        let mut users = user::Entity::find()
            .filter(user::Column::Username.gt(after))
            .order_by_asc(user::Column::Username)
            .limit(u64::from(limit) + 1)
            .into_model::<User>()
            .all(self.business_db())
            .await?;
        Ok(super::manage::page(&mut users, limit, |value| {
            &value.username
        }))
    }

    pub async fn update_user(
        &self,
        id: &str,
        enabled: Option<bool>,
        admin: Option<bool>,
        password: Option<&str>,
    ) -> Result<User> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let user: User = sqlx::query_as(
            "SELECT id,username,password_hash,admin,enabled,created_at FROM users WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(DataError::Missing)?;
        if user.admin && user.enabled && (admin == Some(false) || enabled == Some(false)) {
            let admins: i64 =
                sqlx::query_scalar("SELECT count(*) FROM users WHERE admin=1 AND enabled=1")
                    .fetch_one(&mut *tx)
                    .await?;
            if admins < 2 {
                return Err(DataError::Conflict);
            }
        }
        let result = sqlx::query_as("UPDATE users SET enabled=COALESCE(?,enabled),admin=COALESCE(?,admin),password_hash=COALESCE(?,password_hash) WHERE id=? RETURNING id,username,password_hash,admin,enabled,created_at")
            .bind(enabled).bind(admin).bind(password).bind(id).fetch_one(&mut *tx).await?;
        if password.is_some() || enabled == Some(false) || admin.is_some() {
            sqlx::query("UPDATE api_keys SET enabled=0 WHERE user_id=? AND session=1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM pair_codes WHERE user_id=?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(result)
    }

    pub async fn topic_password(&self, topic: &str) -> Result<Option<String>> {
        topic::in_default_space()
            .filter(topic::Column::Name.eq(topic))
            .select_only()
            .column(topic::Column::PasswordHash)
            .into_tuple::<Option<String>>()
            .one(self.business_db())
            .await?
            .ok_or(DataError::Missing)
    }

    pub async fn topic_membership(&self, topic: &str, user_id: &str) -> Result<bool> {
        let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM subscriptions s JOIN topics t ON t.id=s.topic_id WHERE t.space_id='default' AND t.name=? AND s.user_id=?)")
            .bind(topic).bind(user_id).fetch_one(&self.0).await?;
        Ok(exists != 0)
    }

    pub async fn create_session(
        &self,
        id: &str,
        hash: &[u8],
        user_id: &str,
        expiry: i64,
        expected_password: &str,
        factor: Option<FactorProof<'_>>,
    ) -> Result<User> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let user = session(&mut tx, id, hash, user_id, expiry, Some(expected_password)).await?;
        consume_factor(&mut tx, user_id, factor).await?;
        tx.commit().await?;
        Ok(user)
    }

    pub async fn revoke_session(&self, id: &str) -> Result<()> {
        let result = sqlx::query("UPDATE api_keys SET enabled=0 WHERE id=? AND session=1")
            .bind(id)
            .execute(&self.0)
            .await?;
        affected(result.rows_affected())
    }

    pub async fn make_pair(
        &self,
        user_id: &str,
        key_id: &str,
        hash: &[u8],
        expiry: i64,
    ) -> Result<()> {
        let result = sqlx::query("INSERT INTO pair_codes(user_id,code_hash,expires_at) SELECT u.id,?,? FROM users u JOIN api_keys k ON k.user_id=u.id WHERE u.id=? AND k.id=? AND u.enabled=1 AND k.enabled=1 AND k.session=1 AND k.expires_at>?")
            .bind(hash).bind(expiry).bind(user_id).bind(key_id).bind(now_ms()).execute(&self.0).await?;
        affected(result.rows_affected())
    }

    pub async fn exchange_pair(
        &self,
        code_hash: &[u8],
        id: &str,
        hash: &[u8],
        expiry: i64,
    ) -> Result<User> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let user: String = sqlx::query_scalar(
            "DELETE FROM pair_codes WHERE code_hash=? AND expires_at>? RETURNING user_id",
        )
        .bind(code_hash)
        .bind(now_ms())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(DataError::Missing)?;
        let user = session(&mut tx, id, hash, &user, expiry, None).await?;
        tx.commit().await?;
        Ok(user)
    }

    pub async fn inbox(
        &self,
        user_id: &str,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<InboxItem>> {
        let mut items = if let Some(after) = after {
            sqlx::query_as::<_, InboxItem>("SELECT id, from_username,topic,title,body,format,created_at,read_at FROM inbox WHERE user_id=? AND id>? ORDER BY id LIMIT ?")
                .bind(user_id).bind(after).bind(limit).fetch_all(&self.0).await?
        } else {
            sqlx::query_as::<_, InboxItem>("SELECT id,from_username,topic,title,body,format,created_at,read_at FROM inbox WHERE user_id=? ORDER BY id DESC LIMIT ?")
                .bind(user_id).bind(limit).fetch_all(&self.0).await?
        };
        if after.is_none() {
            items.reverse();
        }
        let next_cursor = Some(
            items
                .last()
                .map_or(after.unwrap_or_default(), |item| item.id)
                .to_string(),
        );
        Ok(Page { items, next_cursor })
    }

    pub async fn read_inbox(&self, user_id: &str, id: i64) -> Result<()> {
        let result =
            sqlx::query("UPDATE inbox SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?")
                .bind(now_ms())
                .bind(id)
                .bind(user_id)
                .execute(&self.0)
                .await?;
        affected(result.rows_affected())
    }

    pub async fn send_inbox(
        &self,
        key_id: &str,
        sender: Option<&str>,
        recipient: &str,
        message: &Message,
        idempotency_key: Option<&str>,
        retention_ms: i64,
    ) -> Result<InboxReceipt> {
        // Published messages use the raw validated key. Spaces cannot occur in a client key.
        let request_key = idempotency_key.map(|key| format!("inbox {key}"));
        let body = serde_json::to_string(message)?;
        let format = serde_json::to_value(message.format)?;
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let now = now_ms();
        if let Some(key) = &request_key
            && let Some(receipt) = sqlx::query_as(
                "SELECT inbox_id AS id,message_id FROM idempotency
                WHERE key_id=? AND request_key=? AND expires_at>? AND inbox_id IS NOT NULL",
            )
            .bind(key_id)
            .bind(key)
            .bind(now)
            .fetch_optional(&mut *tx)
            .await?
        {
            tx.commit().await?;
            return Ok(receipt);
        }
        let message_id = new_id();
        sqlx::query("INSERT INTO messages(id,key_id,body,request,status,inbox_deliveries,inbox_recipient,created_at,retain_until)
            VALUES(?1,?2,?3,?3,'success',1,?4,?5,?6)")
            .bind(&message_id).bind(key_id).bind(body).bind(recipient).bind(now).bind(now.saturating_add(retention_ms))
            .execute(&mut *tx).await?;
        let id = sqlx::query_scalar(
            "INSERT INTO inbox(user_id,message_id,from_username,title,body,format,created_at)
            SELECT id,?,?,?,?,?,? FROM users WHERE username=? AND enabled=1 RETURNING id",
        )
        .bind(&message_id)
        .bind(sender)
        .bind(&message.title)
        .bind(&message.body)
        .bind(format.as_str().unwrap_or("text"))
        .bind(now)
        .bind(recipient)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(DataError::Missing)?;
        if let Some(key) = &request_key {
            crate::queue::remember_receipt(&mut tx, key_id, key, &message_id, Some(id), now)
                .await?;
        }
        tx.commit().await?;
        Ok(InboxReceipt { id, message_id })
    }
}

async fn session(
    tx: &mut sqlx::SqliteConnection,
    id: &str,
    hash: &[u8],
    user_id: &str,
    expiry: i64,
    expected_password: Option<&str>,
) -> Result<User> {
    let user: User = sqlx::query_as("SELECT id,username,password_hash,admin,enabled,created_at FROM users WHERE id=? AND enabled=1 AND (? IS NULL OR password_hash=?)")
        .bind(user_id).bind(expected_password).bind(expected_password).fetch_optional(&mut *tx).await?.ok_or(DataError::Missing)?;
    let scopes = if user.admin {
        r#"["send","subscribe","admin"]"#
    } else {
        r#"["send","subscribe"]"#
    };
    sqlx::query("INSERT INTO api_keys(id,secret_hash,name,scopes,expires_at,created_at,user_id,session) VALUES(?,?,?,?,?,?,?,1)")
        .bind(id).bind(hash).bind("login session").bind(scopes).bind(expiry).bind(now_ms())
        .bind(user_id).execute(tx).await?;
    Ok(user)
}
