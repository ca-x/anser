CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    admin INTEGER NOT NULL CHECK(admin IN(0,1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),
    created_at INTEGER NOT NULL
) STRICT;
ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE api_keys ADD COLUMN session INTEGER NOT NULL DEFAULT 0 CHECK(session IN(0,1));
ALTER TABLE topics ADD COLUMN password_hash TEXT;

CREATE TABLE user_subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    subscriber_ref TEXT NOT NULL,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    encrypted_target BLOB,
    filter TEXT NOT NULL CHECK(json_valid(filter)),
    created_at INTEGER NOT NULL,
    user_id TEXT REFERENCES users(id)
) STRICT;
INSERT INTO user_subscriptions (id,topic_id,subscriber_ref,account_id,encrypted_target,filter,created_at)
    SELECT id,topic_id,subscriber_ref,account_id,encrypted_target,filter,created_at FROM subscriptions;
DROP TABLE subscriptions;
ALTER TABLE user_subscriptions RENAME TO subscriptions;
CREATE UNIQUE INDEX subscriptions_owner ON subscriptions(topic_id, coalesce(user_id,''), subscriber_ref);
CREATE INDEX subscriptions_user ON subscriptions(user_id,topic_id);

CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    from_username TEXT,
    topic TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    format TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    UNIQUE(user_id,message_id)
) STRICT;
CREATE INDEX inbox_user ON inbox(user_id,id);
CREATE INDEX inbox_retention ON inbox(created_at);

CREATE TABLE pair_codes (
    code_hash BLOB PRIMARY KEY NOT NULL CHECK(length(code_hash)=32),
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pair_expiry ON pair_codes(expires_at);
