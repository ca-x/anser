---
name: anser-plugin-authoring
description: Use when creating, changing, testing, or publishing an Anser channel, task, or content transformation plugin, including its Web and NSH options and Topic marketplace listing.
---

# Anser plugin authoring

Read [AGENTS.md](../../../AGENTS.md), the [plugin API](../../../crates/anser-plugin-api/src/lib.rs), and the [task and transform contracts](../../../crates/anser-plugin-api/src/actions.rs). Use the repository's Rust practices. For native options, follow the NSH coding and design guides.

## Choose the capability

| Provider role | Interface | Output |
| --- | --- | --- |
| Channel | `ChannelService`, `anser.channel.<id>` | One send outcome for one account and message |
| Task | `TaskService`, `anser.task.<id>` | Zero or more message drafts |
| Content transform | `ContentTransformService`, `anser.content_transform.<id>` | A transformed message and optional media artifacts |

Keep certificate checks and weather collection in a task. A task produces drafts. The scheduler runs it at the configured interval and sends the drafts through the chosen Topic or the default route. A manual plugin run still previews the drafts. Keep an LLM rewrite or speech synthesis in a content transform. Run the transform before publishing when the result should be shared by multiple deliveries. Account retries and failover call the channel again, so they must not run the task or repeat the transform.

Use a stable lowercase identifier and an independent `X.Y.Z` plugin version. Put the Rust crate in `anser-plugins/<id>` and add its feature and service registration in [anser-host](../../../crates/anser-host) and the [server features](../../../crates/anser-server/Cargo.toml). Review the OpenAI-compatible [TTS plugin](../../../anser-plugins/openai-tts/src/lib.rs) for an action returning a media artifact and [Gotify](../../../anser-plugins/gotify/src/lib.rs) for a channel.

## Implement a channel receive protocol

One provider plugin owns its outbound adapter, receive adapter, or both. Declare a stable `direction()`: `Egress` (the default), `Ingress`, or `Bidirectional`. Use separate modules for reading provider requests and for sending them. Receive-only plugins need no outbound accounts. Installation, the primary runtime switch, and the two direction switches are separate. New receive endpoints default off; existing outbound accounts stay usable after a server upgrade.

1. Declare read-only `ingress_routes()` entries with a method, relative path, description and copyable shell example. Anser mounts them below `/v1/receive/<plugin-id>`. A single-segment placeholder may include a fixed prefix or suffix, e.g. `/{topic}.send`. Both URL spellings of the root reach the same handler. The host returns 404 for disabled endpoints.
2. Implement `decode_ingress` for the published protocol subset. Return an `IngressMessage` containing a normalized message and optional destination Topic. Validate types, sizes and unsupported parameters. Supply normalized lowercase message-header names via `ingress_headers`. For SDKs with a native token header use `ingress_token_header`: the host consumes it as an Anser credential. Keep tokens out of URLs, plugin input, message metadata and errors.
3. Delegate authentication, send scope, Topic restrictions and passwords, idempotency, routing, queueing and retries to Anser. A protocol label never selects its own outbound account. A Topic in the request must agree with `X-Anser-Topic`. With neither, use the default route. Outbound credentials belong only to the outbound account.
4. Build the provider's native JSON acknowledgement in `ingress_response` using the persisted receipt. HTTP 200 acknowledges enqueue. Document the field containing the Anser message ID, and how to query delivery. Keep rendering deterministic where possible and free of I/O.
5. Put setup instructions and protocol limitations in `config_schema["x-anser-ui"]["help"]`, as parallel plain-text strings keyed by `en` and `zh-CN`. Web and NSH render the selected translation. Use placeholders for origins and keys in examples. Explain which fields are supported and any transport override a provider SDK requires.
6. Test parsing, invalid inputs, supported native credentials, responses and independent switches. Run a real provider SDK against an isolated Anser instance and verify the persisted notification or downstream delivery. Fix upstream versions for repeatability. Document any endpoint or auth-header adapter explicitly.

## Own the option definitions

The plugin supplies a JSON Schema with fields, types, accepted values, defaults, and required fields. The web console and NSH render their own controls from it. Use `format: "password"` and `writeOnly: true` on credentials. Put input validation in the plugin so CLI, API, and both clients get the same rules.

Use `x-anser-ui` for optional presentation details. Localize labels and descriptions in `en` and `zh-CN`. Keep enum values stable and translate their labels. For a field that belongs to one mode, declare the predicate in the schema.

```json
{
  "type": "string",
  "format": "password",
  "writeOnly": true,
  "x-anser-ui": {
    "label": {"en": "Signing secret", "zh-CN": "签名密钥"},
    "visible_when": {"field": "mode", "equals": "webhook"},
    "required_when": {"field": "mode", "equals": "webhook"}
  }
}
```

Use the host's allowed native widgets for privileged operations such as selecting a LazyCat device. For a new widget, define its wire interaction and authorization in the host and implement a native NSH control alongside the Web control. Keep plugin metadata declarative and render text as text.

- Declare the channel version in `x-anser-version` using `env!("CARGO_PKG_VERSION")`. Supply localized field, choice and plugin labels in the schema so Web and NSH can share the same form.
- Use `x-anser-ui.form_fields` to show only the fields needed in the guided form. Keep supported API options in `properties`. A field can supply localized HTTPS help links through `x-anser-ui.links` with `label` and `url`.
- Use `x-anser-ui.account_editor.fields` to enumerate the settings the admin editor may read. Only list fields safe to return. Declare write-only credentials under `account_editor.credentials` and list every field that affects where and under which identity a stored credential will be used. An empty binding list suits credentials for a fixed upstream. The editor can preserve an omitted credential only when those settings are unchanged. The proxy picker manages shared proxy profiles separately from channel fields.

## Make provider calls predictable

- Use the [shared transport](../../../anser-plugins/http/src/lib.rs) for URL policy, TLS, timeouts, proxy handling, and retry classification. Keep provider SDKs and credentials inside the plugin. Return safe error codes and messages and preserve Retry-After when present.
- Distinguish provider acceptance from delivery. Keep provider endpoints and credentials outside the message content and never log configuration or remote response bodies.
- Bound input and response sizes. Enforce the shared artifact limit before encoding audio. Return artifacts using the published media type and standard padded base64.
- Include sample configuration with placeholder credentials, a compact error mapping, and loopback tests for the successful wire request, provider errors, authentication, and limits. Exercise conditional forms in both clients. Check that disabling an existing channel still preserves in-flight deliveries.

## Announce a release

Publish immutable release artifacts under the plugin's own version. Add the GitHub repository topic `anser-plugin` to appear in **Plugin management → Marketplace**. To notify Topic subscribers about a release, use **Plugin management → Marketplace → Topic announcements** or publish a manifest to `POST /v1/topics/{name}/plugin-listings`:

```json
{
  "id": "openai-tts",
  "kind": "content_transform",
  "version": "0.1.0",
  "name": "OpenAI TTS",
  "description": "Synthesizes speech through an OpenAI-compatible endpoint.",
  "source_url": "https://example.org/plugin-releases/openai-tts/v0.1.0"
}
```

Provide the optional `sha256` when the link points to a downloadable artifact. Confirm compatibility and verify the checksum before deployment. Topic announcements are discoverable metadata. Use an administrator-controlled build and deployment to install a plugin.
