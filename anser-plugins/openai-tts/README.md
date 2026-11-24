# OpenAI-compatible text to speech

Open the plugin under **Content transforms** in the admin console. Anser returns an audio file you can preview or download. Send the same settings to `POST /v1/plugins/content_transform/openai-tts/run` with a global administrator credential.

```json
{
  "config": {
    "server_url": "https://api.openai.com",
    "api_key": "REPLACE_WITH_PROVIDER_KEY",
    "model": "tts-1",
    "voice": "alloy",
    "response_format": "mp3"
  },
  "message": {"body": "The release is ready.", "format": "text"}
}
```

The server URL may end with `/v1`. The plugin appends the remaining path to `/v1/audio/speech`. The response includes the input message and a separate, base64-encoded artifact. Supported audio formats are MP3, Opus, AAC, FLAC, WAV, and raw PCM. Input is limited to 4,096 characters and audio to 4 MiB.

## Deliver the speech

Choose a recipient, a topic, or the default route in the plugin panel. The equivalent API is `POST /v1/speech/send` with a `destination` alongside `config` and `message`.

- `{"kind":"inbox","username":"alice"}` sends directly to an Anser inbox.
- `{"kind":"topic","name":"alerts"}` uses the topic policy and subscriptions.
- `{"kind":"channels"}` uses the server’s default route.

Anser renders one MP3 and stores it with the notification. The connected NSH client attempts to play new voice notifications in order. The inbox also has a manual play action and an autoplay switch. Browser playback follows browser media policy.

Topic and channel sends require the server's `ANSER_PUBLIC_URL` to be a reachable HTTPS origin. External channels receive the text and an audio link. Anyone with the link can play it until expiry, up to seven days or the notification's retention period, whichever is shorter. Repeat the same `Idempotency-Key` with the same credential to retrieve the original receipt.

| Error | Retryable |
| --- | --- |
| Invalid options, input, credentials, or rejected request | No |
| Audio over 4 MiB | No |
| Network timeout, upstream 5xx, or invalid audio response | Yes |
| Rate limit | Yes, respecting Retry-After |

The plugin uses the shared outbound allowlist, DNS pinning and TLS settings. It sends its credential only to the configured endpoint.
