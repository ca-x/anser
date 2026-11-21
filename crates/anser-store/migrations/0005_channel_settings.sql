-- Independent of the compiled channel catalog, so a build without a plugin
-- preserves its saved setting.
CREATE TABLE channel_settings (
    channel TEXT PRIMARY KEY NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
) STRICT;
