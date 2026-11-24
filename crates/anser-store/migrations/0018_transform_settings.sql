CREATE TABLE transform_settings (
    plugin_id TEXT NOT NULL PRIMARY KEY,
    encrypted_config BLOB NOT NULL
);
