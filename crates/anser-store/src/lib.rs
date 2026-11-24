//! SQLite connection and schema initialization.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::{ConnAcquireErr, DatabaseConnection, DbErr, RuntimeErr, SqlxSqliteConnector};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("failed to open SQLite: {0}")]
    Connect(#[from] sqlx::Error),
    #[error("failed to migrate SQLite: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

mod channel_settings;
mod entities;

pub struct Store(SqlitePool, DatabaseConnection, tokio::sync::Mutex<()>);

impl Store {
    pub async fn open(path: &Path) -> std::result::Result<Self, OpenError> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        let business_db = SqlxSqliteConnector::from_sqlx_sqlite_pool(pool.clone());
        Ok(Self(pool, business_db, tokio::sync::Mutex::new(())))
    }

    // Entity queries use SeaORM's connection interface. Migrations and transactional
    // SQL still require the SQLite pool.
    fn business_db(&self) -> &DatabaseConnection {
        &self.1
    }

    pub async fn ping(&self) -> std::result::Result<(), sqlx::Error> {
        sqlx::query("SELECT 1").execute(&self.0).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn upgrade_preserves_legacy_schedules() {
        use anser_core::schedule::Rule;
        use sqlx::{Connection, SqliteConnection};

        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let migrations = sqlx::migrate!();
        migrations.run_to(14, &mut db).await.unwrap();
        sqlx::query(
            "INSERT INTO scheduled_tasks(id,name,plugin_id,encrypted_input,interval_minutes,next_at)
             VALUES('legacy','Weather','wttr-weather',x'AA',90,123)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        migrations.run(&mut db).await.unwrap();
        let schedule: crate::scheduled_tasks::Schedule =
            sqlx::query_as("SELECT * FROM scheduled_task_views WHERE id='legacy'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(schedule.rule, Rule::Interval { minutes: 90 });
        assert_eq!(schedule.interval_minutes, Some(90));
        assert_eq!(schedule.next_at, Some(123));
        assert!(schedule.enabled);
        assert!(!schedule.completed);
    }

    #[tokio::test]
    async fn upgrade_preserves_old_inboxes_and_backfills_only_linked_receipts() {
        use sqlx::{Connection, SqliteConnection};
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let migrations = sqlx::migrate!();
        migrations.run_to(8, &mut db).await.unwrap();
        sqlx::raw_sql("INSERT INTO api_keys(id,secret_hash,name,scopes,created_at)
              VALUES('sender',zeroblob(32),'key','[]',0);
            INSERT INTO users(id,username,password_hash,admin,created_at)
              VALUES('a','alice','hash',0,0),('b','bob','hash',0,0);
            INSERT INTO messages(id,key_id,body,request,topic,created_at,retain_until)
              VALUES('topic','sender','{}','{}','ops',0,100),('routed','sender','{}','{}',NULL,0,100);
            INSERT INTO inbox(user_id,message_id,title,body,format,created_at)
              VALUES('a','topic','release','restarted','text',0),
                    ('b','topic','release','restarted','text',0),('b',NULL,'old','private','text',0);")
            .execute(&mut db).await.unwrap();
        migrations.run_to(9, &mut db).await.unwrap();

        let messages: Vec<(String, i64, Option<String>)> =
            sqlx::query_as("SELECT id,inbox_deliveries,inbox_recipient FROM messages ORDER BY id")
                .fetch_all(&mut db)
                .await
                .unwrap();
        assert_eq!(
            messages,
            [("routed".into(), 0, None), ("topic".into(), 2, None)]
        );
        let historical: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM inbox WHERE message_id IS NULL AND body='private'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(historical, 1);
    }

    #[tokio::test]
    async fn upgrade_seeds_templates_without_changing_existing_messages() {
        use sqlx::{Connection, SqliteConnection};
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let migrations = sqlx::migrate!();
        migrations.run_to(10, &mut db).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO api_keys(id,secret_hash,name,scopes,created_at)
              VALUES('sender',zeroblob(32),'key','[]',0);
            INSERT INTO messages(id,key_id,body,request,created_at,retain_until)
              VALUES('original','sender','{\"title\":\"Existing message\"}','{}',0,100);",
        )
        .execute(&mut db)
        .await
        .unwrap();
        migrations.run_to(11, &mut db).await.unwrap();
        let existing: String = sqlx::query_scalar(
            "SELECT json_extract(body,'$.title') FROM messages WHERE id='original'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(existing, "Existing message");
        let templates: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM notification_templates WHERE builtin=1 AND shared=1 ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(templates, ["builtin.deployment", "builtin.service_alert"]);
    }

    #[tokio::test]
    async fn reopens_a_migrated_database_with_foreign_keys_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("anser.sqlite3");
        let store = Store::open(&path).await.unwrap();
        assert!(sqlx::query("INSERT INTO accounts (id, space_id, channel, name, encrypted_config) VALUES ('a', 'missing', 'test', 'test', x'01')")
            .execute(&store.0).await.unwrap_err().as_database_error().unwrap().is_foreign_key_violation());
        store.0.close().await;

        let reopened = Store::open(&path).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM spaces WHERE id = 'default'")
            .fetch_one(&reopened.0)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }
}

pub mod history;
pub mod interactions;
pub mod manage;
pub mod plugin_market;
pub mod proxies;
pub mod queue;
pub mod scheduled_tasks;
pub mod speech;
pub mod templates;
pub mod totp;
pub mod users;

#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored data is invalid")]
    Json(#[from] serde_json::Error),
    #[error("resource not found")]
    Missing,
    #[error("resource conflicts with existing data")]
    Conflict,
    #[error("proxy profile is assigned to an account")]
    ProxyInUse,
    #[error("permission denied")]
    Forbidden,
    #[error("notification template not found")]
    TemplateMissing,
    #[error(transparent)]
    Template(#[from] anser_core::template::Error),
    #[error("interaction reply does not match the form")]
    InvalidInteractionReply,
    #[error("authentication factor is invalid or no longer current")]
    InvalidFactor,
    #[error("request has no available destinations")]
    NoTargets,
    #[error("queue could not commit a submission batch")]
    Batch,
    #[error("delivery queue is full")]
    QueueFull,
}

impl From<DbErr> for DataError {
    fn from(error: DbErr) -> Self {
        let error = match error {
            DbErr::ConnectionAcquire(ConnAcquireErr::Timeout) => sqlx::Error::PoolTimedOut,
            DbErr::ConnectionAcquire(ConnAcquireErr::ConnectionClosed) => sqlx::Error::PoolClosed,
            DbErr::Conn(RuntimeErr::SqlxError(error))
            | DbErr::Exec(RuntimeErr::SqlxError(error))
            | DbErr::Query(RuntimeErr::SqlxError(error)) => Arc::try_unwrap(error)
                .unwrap_or_else(|error| sqlx::Error::AnyDriverError(Box::new(error))),
            error => sqlx::Error::AnyDriverError(Box::new(error)),
        };
        Self::Sql(error)
    }
}

pub type Result<T> = std::result::Result<T, DataError>;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn affected(rows: u64) -> Result<()> {
    if rows == 0 {
        Err(DataError::Missing)
    } else {
        Ok(())
    }
}
