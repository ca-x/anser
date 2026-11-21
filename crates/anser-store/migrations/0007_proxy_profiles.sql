CREATE TABLE proxy_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    authenticated INTEGER NOT NULL CHECK(authenticated IN (0, 1)),
    encrypted_connection BLOB NOT NULL CHECK(length(encrypted_connection) > 0),
    UNIQUE(space_id, name)
) STRICT;

ALTER TABLE accounts ADD COLUMN proxy_id TEXT REFERENCES proxy_profiles(id);
CREATE INDEX accounts_proxy ON accounts(proxy_id) WHERE proxy_id IS NOT NULL;
