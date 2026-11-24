# TLS certificate expiration

The `certificate-expiration` task checks a website's TLS certificate and emits a notification draft when the certificate has expired or enters the warning window. The caller decides whether and where to send the draft.

## Run a check

Send this request as a global Anser administrator to `POST /v1/plugins/task/certificate-expiration/run`.

```json
{
  "config": {
    "urls": ["https://example.com", "https://example.org:8443"],
    "warning_days": 30
  }
}
```

Supply one to sixteen HTTPS origins with optional ports. The default warning window is 30 days. Valid values range from 0 to 365. The task uses the existing outbound host policy and a verified TLS handshake. It sends no HTTP request. Private endpoints require the server's outbound policy to allow them. Certificates from private authorities require a publicly trusted replacement for this check to authenticate them.

The response includes one entry in `details.websites` per origin, in input order. Entries can be `healthy`, `expiring`, `expired`, or `error`. A connection or validation error on one website does not hide the other results. When a certificate has expired, rustls rejects the handshake. The task reports the rejection with `authenticated: false`, and includes the observed date when rustls supplies it. Timestamps in task diagnostics are UTC Unix seconds.

| Error code | Meaning | Retry |
| --- | --- | --- |
| `certificate_config`, `certificate_url`, `certificate_warning_days`, `certificate_websites` | Invalid task options | Fix configuration |
| `outbound_blocked` | The outbound network policy denied the endpoint | Review the server's policy |
| `dns`, `certificate_connect`, `certificate_io`, `certificate_timeout` | Temporary network failure | Retry |
| `certificate_untrusted`, `certificate_invalid`, `certificate_handshake`, `certificate_tls_setup` | The endpoint did not yield an authenticated TLS certificate | Review TLS and hostname configuration |
