CREATE TABLE notification_audio (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 4194304),
    expires_at INTEGER NOT NULL
);
CREATE INDEX notification_audio_expiry ON notification_audio(expires_at);
