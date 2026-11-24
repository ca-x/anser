CREATE TABLE plugin_market_listings (
    message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('channel','task','content_transform')),
    manifest TEXT NOT NULL CHECK(json_valid(manifest) AND json_type(manifest) = 'object'),
    created_at INTEGER NOT NULL
);
CREATE INDEX plugin_market_timeline ON plugin_market_listings(topic_id, created_at DESC, message_id DESC);
CREATE INDEX plugin_market_kind_timeline ON plugin_market_listings(topic_id, kind, created_at DESC, message_id DESC);
