# Channel SDK interoperability

The ignored Rust integration test starts an isolated Anser server and a loopback ntfy receiver. It enables all four ingress plugins, creates a send-only key, invokes each SDK, checks native receipts and verifies all four messages at the receiver. It uses a temporary SQLite database.

| Plugin | Client used by the test | Connection |
| --- | --- | --- |
| ntfy | Upstream Go `heckel.io/ntfy/v2/client` | Full Topic URL, `WithBearerAuth` |
| Chanify | Upstream Go `github.com/chanify/chanify/sender` | Base URL, Anser key in the native `token` header |
| Bark | Community Node package `bark-push` | Base URL, Bearer header, `deviceKey: "default"` |
| ServerChan | Official Node package `serverchan-sdk` | The official package hardcodes its public host. A process-local fetch adapter maps only the exact fixture URL to the Anser Topic path, adds the Bearer header and passes the SDK's body and response through. |

From the repository root, with Go 1.27.3+, Node.js 18+ and the repository’s Rust toolchain installed:

```sh
npm ci --prefix tests/receive-sdk --ignore-scripts
cargo test --locked -p anser-server --test e2e provider_sdks_publish_through_all_four_receive_routes -- --ignored --nocapture
```

Go and npm may fetch pinned dependencies. All notification requests use the loopback fixture. See [Go calls](main.go) and [Node calls](publish.mjs).
