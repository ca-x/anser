CREATE TABLE interactions (
    id TEXT PRIMARY KEY NOT NULL,
    inbox_id INTEGER NOT NULL UNIQUE REFERENCES inbox(id) ON DELETE CASCADE,
    owner_key TEXT NOT NULL,
    request_key TEXT,
    form TEXT NOT NULL CHECK(json_valid(form)),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    reply TEXT CHECK(reply IS NULL OR json_valid(reply)),
    replied_at INTEGER,
    UNIQUE(owner_key,request_key)
) STRICT;
CREATE INDEX interactions_pending ON interactions(owner_key,expires_at) WHERE reply IS NULL;
