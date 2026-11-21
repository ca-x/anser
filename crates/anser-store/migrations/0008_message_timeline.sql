CREATE INDEX messages_timeline ON messages(created_at DESC, id DESC);
CREATE INDEX messages_key_timeline ON messages(key_id, created_at DESC, id DESC);
CREATE INDEX api_keys_user ON api_keys(user_id) WHERE user_id IS NOT NULL;

-- The new key-first index also supports lookups by message owner.
DROP INDEX messages_key;

-- Match the worker's tie-breaker so a burst of routes due in the same
-- millisecond does not need to be sorted each time a lease is claimed.
DROP INDEX routes_ready;
CREATE INDEX routes_ready ON routes(next_at, id, lease_until) WHERE finished = 0;
