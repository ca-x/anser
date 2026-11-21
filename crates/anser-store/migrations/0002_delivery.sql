ALTER TABLE spaces ADD COLUMN default_policy TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(default_policy));
ALTER TABLE topics ADD COLUMN policy TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy));
ALTER TABLE topics ADD COLUMN default_tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(default_tags));
ALTER TABLE topics ADD COLUMN retention INTEGER;
ALTER TABLE accounts ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN circuit_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN next_send_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    secret_hash BLOB NOT NULL CHECK(length(secret_hash) = 32),
    name TEXT NOT NULL,
    scopes TEXT NOT NULL CHECK(json_valid(scopes)),
    topic_prefix TEXT,
    expires_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
) STRICT;

CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    subscriber_ref TEXT NOT NULL,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    encrypted_target BLOB,
    filter TEXT NOT NULL CHECK(json_valid(filter)),
    created_at INTEGER NOT NULL,
    UNIQUE (topic_id, subscriber_ref)
) STRICT;

CREATE TABLE messages (
    id TEXT PRIMARY KEY NOT NULL,
    key_id TEXT NOT NULL REFERENCES api_keys(id),
    topic TEXT,
    body TEXT NOT NULL CHECK(json_valid(body)),
    request TEXT NOT NULL CHECK(json_valid(request)),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    retain_until INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_key ON messages(key_id, id);
CREATE INDEX messages_retention ON messages(retain_until);

CREATE TABLE idempotency (
    key_id TEXT NOT NULL REFERENCES api_keys(id),
    request_key TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (key_id, request_key)
) STRICT;

CREATE TABLE routes (
    id INTEGER PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    subscription_id TEXT,
    policy TEXT NOT NULL CHECK(json_valid(policy)),
    state TEXT NOT NULL DEFAULT 'pending',
    next_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    lease_token TEXT,
    lease_until INTEGER,
    finished INTEGER NOT NULL DEFAULT 0,
    UNIQUE (id, message_id)
) STRICT;
CREATE INDEX routes_ready ON routes(next_at, lease_until) WHERE finished = 0;
CREATE INDEX routes_message ON routes(message_id);
CREATE INDEX routes_subscription ON routes(subscription_id) WHERE finished = 0;

CREATE TABLE deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    position INTEGER NOT NULL,
    weight INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    encrypted_target BLOB,
    state TEXT NOT NULL DEFAULT 'ready',
    due_at INTEGER,
    attempts_in_round INTEGER NOT NULL DEFAULT 0,
    UNIQUE(route_id, account_id)
) STRICT;

CREATE TABLE attempts (
    id INTEGER PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error_code TEXT,
    error_msg TEXT,
    UNIQUE (delivery_id, n)
) STRICT;

CREATE TABLE callbacks (
    message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    next_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    finished INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX callbacks_ready ON callbacks(next_at, lease_until) WHERE finished = 0;
