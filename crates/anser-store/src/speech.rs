//! Speech media tied to a durable notification snapshot.

use sqlx::SqliteConnection;

use crate::{DataError, Result, Store, now_ms};

pub struct SpeechWrite {
    pub token: String,
    pub bytes: Vec<u8>,
    pub retention_ms: i64,
}

impl SpeechWrite {
    pub fn path(&self) -> String {
        format!("/v1/speech/audio/{}.mp3", self.token)
    }

    pub(crate) async fn insert(
        self,
        tx: &mut SqliteConnection,
        message_id: &str,
        now: i64,
        retention_ms: i64,
    ) -> Result<()> {
        let expires = now.saturating_add(retention_ms.min(self.retention_ms));
        sqlx::query(
            "INSERT INTO notification_audio (message_id, token, bytes, expires_at) VALUES(?,?,?,?)",
        )
        .bind(message_id)
        .bind(self.token)
        .bind(self.bytes)
        .bind(expires)
        .execute(tx)
        .await?;
        Ok(())
    }
}

impl Store {
    pub async fn speech_receipt(
        &self,
        key_id: &str,
        key: &str,
        inbox: bool,
    ) -> Result<Option<anser_core::api::Receipt>> {
        let prefix = if inbox { "inbox speech" } else { "speech" };
        self.existing_receipt(key_id, &format!("{prefix} {key}"))
            .await
    }

    pub async fn existing_receipt(
        &self,
        key_id: &str,
        key: &str,
    ) -> Result<Option<anser_core::api::Receipt>> {
        let entry: Option<(String, String)> = sqlx::query_as(
            "SELECT m.id,m.status FROM idempotency i JOIN messages m ON m.id=i.message_id
             WHERE i.key_id=? AND i.request_key=? AND i.expires_at>?",
        )
        .bind(key_id)
        .bind(key)
        .bind(now_ms())
        .fetch_optional(&self.0)
        .await?;
        Ok(entry.map(|(message_id, status)| anser_core::api::Receipt { message_id, status }))
    }

    pub async fn speech_audio(&self, token: &str) -> Result<Vec<u8>> {
        sqlx::query_scalar("SELECT bytes FROM notification_audio WHERE token=? AND expires_at>?")
            .bind(token)
            .bind(now_ms())
            .fetch_optional(&self.0)
            .await?
            .ok_or(DataError::Missing)
    }
}
