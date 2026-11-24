# Notification templates

[简体中文](notification-templates.md)

Create templates under **Notification templates** in the admin console. Titles and bodies accept placeholders such as `{{service}}`. Choose plain text or Markdown. In **Send notification**, select a template and fill in its variables.

| Built-in template ID and name | Variables |
| --- | --- |
| `builtin.deployment` | `service`, `version`, `environment` |
| `builtin.service_alert` | `service`, `status`, `details` |

## Send with the API

Use an API key with the `send` scope or a login session. Submit to `POST /v1/send` for direct routing or `POST /v1/topics/{name}/publish` for an existing topic. Choose either `template_id` or `template_name` and provide string values in `variables`. The template supplies the title, body, and format. Routing, tags, and callbacks use their usual fields. For a protected topic, supply `topic_password` when required.

```bash
curl --fail-with-body "${ANSER_URL%/}/v1/topics/alerts/publish" \
  -H "Authorization: Bearer ${ANSER_API_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: anser-release-123-production' \
  --data '{"template_name":"builtin.deployment","variables":{"service":"Anser","version":"1.2.3","environment":"production"}}'
```

A `202` response confirms that the message was queued. Look up `GET /v1/messages/{id}` with the same key and the returned `message_id`. For retries of the same logical send within 24 hours, reuse its idempotency key. Anser renders and stores the message as part of the enqueue transaction, so template edits and deletions do not affect queued messages, retries, or replays.

Variable names contain letters, digits, and underscores and must start with a letter or underscore. Each template can use up to 64 distinct variables. Supply a value for every placeholder. A variable can appear in both the title and body. In a Markdown body, Anser escapes ASCII punctuation in variable values and replaces line breaks and control characters with spaces. Use the message's `url` field for links.

## Manage templates

| Operation | API |
| --- | --- |
| List accessible templates (supports cursors) | `GET /v1/templates` |
| Create | `POST /v1/templates` |
| Read, replace, or delete by ID | `GET`, `PUT`, or `DELETE /v1/templates/{id}` |

Create and replace accept `{name,title,body,format,shared}`. The default for `shared` is `false` when creating. Omission preserves visibility on update. Owners use and manage private templates through login sessions. Global admins manage shared templates, and API keys with send access can use them. When an admin unshares a template from a login session, it becomes private to that editor. Built-in templates are read-only. When a private template and a shared template have the same name, name lookup prefers the caller's own template. Send by ID to choose explicitly.

Run `anser api templates --help` for the CLI commands. The JSON file in `anser api send --topic alerts message.json` accepts the same fields.
