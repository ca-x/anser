use anser_core::Message;
use anser_mcd::{Form, Reply};
use serde::Serialize;
use sqlx::types::Json;

use crate::users::{InboxSpeech, enqueue_inbox};
use crate::{DataError, Result, Store, new_id, now_ms};

#[derive(Serialize, sqlx::FromRow)]
pub struct Interaction {
    pub id: String,
    pub inbox_id: i64,
    pub expires_at: i64,
    #[sqlx(json(nullable))]
    pub reply: Option<Reply>,
    pub replied_at: Option<i64>,
}

impl Interaction {
    pub fn status(&self) -> &'static str {
        if self.reply.is_some() {
            "answered"
        } else if self.expires_at <= now_ms() {
            "expired"
        } else {
            "pending"
        }
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InboxInteraction {
    #[sqlx(flatten)]
    #[serde(flatten)]
    pub interaction: Interaction,
    #[sqlx(json)]
    pub form: Form,
}

pub struct NewInteraction<'a> {
    pub key_id: &'a str,
    pub sender: Option<&'a str>,
    pub recipient: &'a str,
    pub message: &'a Message,
    pub request_key: Option<&'a str>,
    pub form: &'a Form,
    pub expires_in_ms: i64,
    pub retention_ms: i64,
}

impl Store {
    pub async fn create_interaction(&self, input: NewInteraction<'_>) -> Result<Interaction> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let now = now_ms();
        if let Some(request_key) = input.request_key
            && let Some(existing) = sqlx::query_as(
                "SELECT id,inbox_id,expires_at,reply,replied_at FROM interactions WHERE owner_key=? AND request_key=?",
            ).bind(input.key_id).bind(request_key).fetch_optional(&mut *tx).await?
        {
            tx.commit().await?;
            return Ok(existing);
        }
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM interactions WHERE owner_key=? AND reply IS NULL AND expires_at>?",
        ).bind(input.key_id).bind(now).fetch_one(&mut *tx).await?;
        if pending >= 50 {
            return Err(DataError::QueueFull);
        }
        let receipt = enqueue_inbox(
            &mut tx,
            input.key_id,
            input.sender,
            input.recipient,
            InboxSpeech {
                message: input.message,
                speech: None,
            },
            now,
            input.retention_ms,
        )
        .await?;
        let id = new_id();
        let expires_at = now.saturating_add(input.expires_in_ms);
        sqlx::query("INSERT INTO interactions(id,inbox_id,owner_key,request_key,form,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
            .bind(&id).bind(receipt.id).bind(input.key_id).bind(input.request_key).bind(Json(input.form)).bind(now).bind(expires_at)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Interaction {
            id,
            inbox_id: receipt.id,
            expires_at,
            reply: None,
            replied_at: None,
        })
    }

    pub async fn interaction(&self, key: &str, id: &str) -> Result<Interaction> {
        sqlx::query_as("SELECT id,inbox_id,expires_at,reply,replied_at FROM interactions WHERE id=? AND owner_key=?")
            .bind(id).bind(key).fetch_optional(&self.0).await?.ok_or(DataError::Missing)
    }

    pub async fn inbox_interaction(&self, user: &str, inbox: i64) -> Result<InboxInteraction> {
        sqlx::query_as(
            "SELECT a.id,a.inbox_id,a.expires_at,a.reply,a.replied_at,a.form
            FROM interactions a JOIN inbox i ON i.id=a.inbox_id WHERE i.id=? AND i.user_id=?",
        )
        .bind(inbox)
        .bind(user)
        .fetch_optional(&self.0)
        .await?
        .ok_or(DataError::Missing)
    }

    pub async fn reply_to_interaction(
        &self,
        user: &str,
        inbox: i64,
        reply: &Reply,
    ) -> Result<Interaction> {
        let existing = self.inbox_interaction(user, inbox).await?;
        if !existing.form.accepts(reply) {
            return Err(DataError::InvalidInteractionReply);
        }
        let now = now_ms();
        if let Some(updated) = sqlx::query_as(
            "UPDATE interactions SET reply=?,replied_at=? WHERE inbox_id=? AND reply IS NULL AND expires_at>?
               AND EXISTS(SELECT 1 FROM inbox WHERE id=? AND user_id=?)
             RETURNING id,inbox_id,expires_at,reply,replied_at",
        ).bind(Json(reply)).bind(now).bind(inbox).bind(now).bind(inbox).bind(user).fetch_optional(&self.0).await?
        {
            return Ok(updated);
        }
        let current = self.inbox_interaction(user, inbox).await?.interaction;
        if current.reply.as_ref() == Some(reply) {
            return Ok(current);
        }
        Err(DataError::Conflict)
    }
}
