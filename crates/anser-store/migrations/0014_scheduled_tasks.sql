CREATE TABLE scheduled_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    encrypted_input BLOB NOT NULL,
    topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE,
    interval_minutes INTEGER NOT NULL CHECK(interval_minutes BETWEEN 1 AND 43200),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    next_at INTEGER NOT NULL,
    lease_token TEXT,
    lease_until INTEGER,
    last_at INTEGER,
    last_status TEXT,
    last_count INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX scheduled_tasks_due ON scheduled_tasks(next_at, id) WHERE enabled=1;
CREATE VIEW scheduled_task_views AS
SELECT s.id,s.name,s.plugin_id,t.name AS topic,s.interval_minutes,
       s.enabled,s.next_at,s.last_at,s.last_status,s.last_count
FROM scheduled_tasks s LEFT JOIN topics t ON t.id=s.topic_id;
