# Ask a user and retrieve their answer

Anser sends a question to a named account's personal inbox. The recipient can choose a button, submit text, or use a dropdown in the NSH client, including its Web build. Responses are recorded once, including when two devices submit at the same time. The sender reads the result using the same credential that created the question.

## REST API

Create a token under **Administration → MCP**, or create a key with **Interactions** scope in **API keys**. The key must have no Topic prefix. Submit a question to `POST /v1/interactions`:

```json
{
  "recipient": "alice",
  "title": "Approve deployment",
  "body": "The preview environment is ready.",
  "request_key": "deploy-preview-42",
  "expires_in_seconds": 3600,
  "mcd": ":::buttons\n- [Approve](approve)\n- [Defer](defer)\n:::\n\n:::input name=\"note\" label=\"Reason\" submit=\"Reply\" placeholder=\"Add context\" multiline=\"true\" max_length=\"500\"\n:::"
}
```

Use `Authorization: Bearer <key>`. Omitting `expires_in_seconds` sets a one-hour deadline. The maximum is 24 hours. Use a stable `request_key` when retrying to avoid sending another inbox entry. Read `GET /v1/interactions/{id}` for `pending`, `answered`, or `expired`. A reply has a `kind` of `action`, `text`, or `choice`.

If you generate forms in code, pass `form` in place of `mcd`:

```json
{
  "select": {
    "name": "environment",
    "label": "Environment",
    "submit": "Choose environment",
    "options": [
      { "label": "Preview", "value": "preview" },
      { "label": "Production", "value": "production" }
    ]
  }
}
```

The equivalent MCD form is:

```text
:::select name="environment" label="Environment" submit="Choose environment"
- [Preview](preview)
- [Production](production)
:::
```

Use `:::buttons` for immediate responses and `:::input` for a text field. Text can be single-line or multiline. `max_length` counts Unicode characters. Labels and values are treated as plain text. A button or dropdown value is returned as data. The server retains the question and its reply with the recipient's inbox entry.

## MCP

Copy the server address in **Administration → MCP**. Configure a Streamable HTTP connection to `https://your-anser.example/mcp` with `Authorization: Bearer <key>`. To use a hostname other than localhost, set `ANSER_PUBLIC_URL` to the server's external origin. Requests use stateless MCP.

- `ask_user` takes the same input as `POST /v1/interactions` and returns the question's ID immediately.
- `get_interaction` reads that ID. Set `wait_seconds` to a number from 1 to 20 to wait for a reply. When a recipient submits, Anser wakes the waiting call after storing the answer. If the connection closes, use the same ID to read it again.
