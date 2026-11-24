CREATE TABLE notification_templates (
    id TEXT PRIMARY KEY NOT NULL,
    space_id TEXT NOT NULL REFERENCES spaces(id),
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name NOT GLOB '*[^a-zA-Z0-9._-]*'),
    title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) <= 4096),
    body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 32768),
    format TEXT NOT NULL CHECK (format IN ('text', 'markdown')),
    shared INTEGER NOT NULL CHECK (shared IN (0, 1)),
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((shared = 1 AND owner_id IS NULL) OR (shared = 0 AND owner_id IS NOT NULL)),
    CHECK (builtin = 0 OR shared = 1)
) STRICT;

CREATE UNIQUE INDEX notification_templates_shared_name
ON notification_templates (space_id, name) WHERE shared = 1;

CREATE UNIQUE INDEX notification_templates_private_name
ON notification_templates (space_id, owner_id, name) WHERE shared = 0;

INSERT INTO notification_templates (id, space_id, name, title, body, format, shared, builtin, created_at, updated_at)
VALUES
    ('builtin.deployment', 'default', 'builtin.deployment',
     'Deployment complete: {{service}}', '{{service}} {{version}} was deployed to {{environment}}.',
     'text', 1, 1, 0, 0),
    ('builtin.service_alert', 'default', 'builtin.service_alert',
     '{{service}}: {{status}}', '{{details}}',
     'text', 1, 1, 0, 0);
