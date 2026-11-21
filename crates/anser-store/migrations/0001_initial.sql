CREATE TABLE spaces (
    id TEXT PRIMARY KEY NOT NULL
) STRICT;

INSERT INTO spaces (id) VALUES ('default');

CREATE TABLE accounts (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    channel TEXT NOT NULL,
    name TEXT NOT NULL,
    encrypted_config BLOB NOT NULL CHECK (length(encrypted_config) > 0),
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
    weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    rate_limit INTEGER CHECK (rate_limit > 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (space_id, channel, name)
) STRICT;

CREATE TABLE topics (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    name TEXT NOT NULL CHECK (length(name) > 0 AND name NOT GLOB '*[^a-zA-Z0-9._-]*'),
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    UNIQUE (space_id, name)
) STRICT;
