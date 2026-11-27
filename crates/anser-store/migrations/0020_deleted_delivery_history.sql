-- Receipts may still back an inbox item, an audio URL or an idempotent retry.
ALTER TABLE messages ADD COLUMN history_deleted INTEGER NOT NULL DEFAULT 0 CHECK(history_deleted IN (0,1));
CREATE INDEX messages_visible_history ON messages(created_at DESC,id DESC) WHERE history_deleted=0;
