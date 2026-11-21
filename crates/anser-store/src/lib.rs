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

pub mod manage;
pub mod queue;
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
    #[error("permission denied")]
    Forbidden,
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
