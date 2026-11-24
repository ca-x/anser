<img src="assets/logo.png" width="92" height="92" alt="Anser logo">

# Anser

Anser is a self-hosted notification hub. Use one API to send messages to topics, channel accounts, or the Anser client. The server embeds an Elastic UI console. The standalone NSH client uses native components for connecting, receiving, sending, and inspecting deliveries.

[简体中文](README.md) · [Website](https://ca-x.github.io/anser/?lang=en) · [Download](https://github.com/ca-x/anser/releases/latest) · [Screenshots](#screenshots) · [Configuration](#configuration)

The server binary, Docker images, and NSH client come in separate archives. Verify downloads against the `SHA256SUMS` file for the same release.

## Run the server

Docker Compose can build the server and its embedded console from source. Set both bootstrap variables to create the first administrator.

```sh
export ANSER_BOOTSTRAP_USERNAME=admin
read -rsp 'Anser administrator password: ' ANSER_BOOTSTRAP_PASSWORD
echo
export ANSER_BOOTSTRAP_PASSWORD
docker compose up --build -d
unset ANSER_BOOTSTRAP_PASSWORD
```

Sign in at `http://127.0.0.1:8080/login` to open the console at `/admin`. Starting the server again with the same SQLite database preserves the administrator. For a deployment behind an HTTPS reverse proxy, set `ANSER_PUBLIC_URL=https://anser.example.com` so pairing codes use that address. The Docker volume holds the database and its master key file.

To use a prebuilt image, download the archive for your architecture and import it with `docker load -i anser-docker-linux-amd64.tar.gz`. The imported image is tagged `anser:<version>`.

You can also download a standalone server binary or build it with Node.js 24 and Rust 1.94.

```sh
npm --prefix clients/web ci
npm --prefix clients/web run build
ANSER_REQUIRE_WEB=1 cargo build --locked --release -p anser-server
./target/release/anser serve
```

Set `ANSER_BOOTSTRAP_USERNAME` and `ANSER_BOOTSTRAP_PASSWORD` before running the binary for the first time. You can also set a high-entropy `ANSER_BOOTSTRAP_API_KEY` for the initial administrator API key. The server binary includes the console assets and needs a writable data directory.

## Use the client

Enter your server address and sign in on the client’s connection screen. You can also generate a single-use code under **Pair a client** in the console. Scan it with your phone’s camera and confirm the server address in Anser within two minutes. On the same device, copy the pairing link and choose **Import connection link** in the client.

**Send your first notification.** Open **Send notification** in the console, choose **Personal inbox**, and enter your own username and a short message. Open your inbox in the client to see it. When you send to another user, they can reply from the notification. Your delivery history shows the destination username for direct sends and the number of inboxes reached for topic sends. Read status stays in the recipient’s inbox.

While signed in, you can switch screens in the client or console and return to your draft. Reloading the app or signing out clears it.

Users can turn on two-factor authentication in their account security settings. After linking an authenticator, password sign-in also requires a one-time authenticator code or a recovery code. Save the recovery codes when you finish setup. They appear once.

- [Build and package the NSH client](clients/nsh/README.md)
- [Develop the server console](clients/web)
- [SQLite, consistency, and recovery](docs/storage.md)

- [Notification templates and API examples](docs/notification-templates.en.md)
- [Plugin authoring skill](.agents/skills/anser-plugin-authoring/SKILL.md)
- [Scheduled notifications and discovery](docs/scheduled-notifications.md)

## Screenshots

The delivery overview shows the queue, successful deliveries, dead letters, and retries. These screenshots use the English interface and sample data.

![Delivery overview](docs/screenshots/en/server-overview.png)

<details>
<summary>Delivery details, server plugins, proxies, and account security</summary>

![Direct notification inbox receipt](docs/screenshots/en/server-inbox-receipt.png)

![Delivery and attempt details](docs/screenshots/en/server-delivery.png)

![Choosing a LazyCat notification device. Green dots indicate online devices and gray dots indicate offline devices (sample devices).](docs/screenshots/en/server-account-device.png)

![Channel plugin runtime and account settings](docs/screenshots/en/server-plugin.png)

![Installed plugins grouped by capability](docs/screenshots/en/server-plugins-catalog.png)

![Manage notification templates](docs/screenshots/en/server-templates.png)

![Outbound proxy settings](docs/screenshots/en/server-proxies.png)

![Account security settings](docs/screenshots/en/server-security.png)

![About Anser, with the running server version, release notes, and the story behind the logo](docs/screenshots/en/server-about.png)

![Personal settings dialog for editing a nickname and avatar](docs/screenshots/en/server-profile.png)

</details>

<details>
<summary>Mobile web console</summary>

![Mobile administrator sign-in](docs/screenshots/en/server-mobile-login.png)

![Mobile delivery overview](docs/screenshots/en/server-mobile-overview.png)

![Mobile navigation drawer](docs/screenshots/en/server-mobile-menu.png)

![Sending a notification on mobile](docs/screenshots/en/server-mobile-send.png)

![Compose a voice notification on mobile](docs/screenshots/en/server-mobile-speech.png)

![Channel plugins on mobile](docs/screenshots/en/server-mobile-channels.png)

![Outbound proxies on mobile](docs/screenshots/en/server-mobile-proxies.png)

</details>

<details>
<summary>Native Linux client</summary>

![Delivery receipt after a reply in the native client](docs/screenshots/en/nsh-receipt.png)

![Sending a notification in the native client](docs/screenshots/en/nsh-compose.png)

![Selecting a group of LazyCat devices in the native client (sample devices)](docs/screenshots/en/nsh-account-device.png)

![Channel plugin settings in the native client](docs/screenshots/en/nsh-plugin.png)

![Outbound proxy settings in the native client](docs/screenshots/en/nsh-proxies.png)

![About in the native client](docs/screenshots/en/nsh-about.png)

![Personal settings dialog in the native client](docs/screenshots/en/nsh-profile.png)

</details>

Choose English or Simplified Chinese and a light, dark, or system theme from the gear menu on the sign-in page or in the console. The NSH client has the same options in Preferences. Each browser or device remembers its own choices.

## Outbound proxies

Administrators can save named HTTP or HTTPS proxies with optional credentials. Each channel account that supports HTTP proxies can select a saved profile. Changes apply to the next delivery attempt for every account using that profile. Existing accounts can keep their current connection. Choosing **Direct** and saving detaches the shared profile and clears any legacy inline proxy on that account.

List both the proxy host and the notification destination host in `ANSER_OUTBOUND_ALLOW_HOSTS`. Enter hostnames or IP addresses separated by commas. Detach a profile from its accounts before deleting it. SMTP and LazyCat use their own transports. For terminal commands, run `anser api proxies --help`.

## Plugins and voice notifications

The plugin page groups installed plugins into channels, tasks, and content transforms. The certificate task checks multiple HTTPS sites with a configurable warning window. The weather task accepts a city or airport code, language, and units. Choose a task, interval, and destination under **Plugin management → Scheduled notifications**. The server publishes its output to the selected Topic or default route. The marketplace searches public GitHub repositories tagged `anser-plugin`. Topic announcements are a separate view within the marketplace.

Use **Content transforms → OpenAI TTS** to preview speech or send a voice notification. Connected Anser clients play new voice notifications in order. Recipients can turn off autoplay in the inbox. Other channels receive the text and an expiring audio link. Set `ANSER_PUBLIC_URL` to a reachable HTTPS origin for topic and default-route voice sends.

## API and channels

Open Personal settings from the avatar menu to update your nickname and avatar. Both interfaces display the same profile. Sign-in and direct notifications still use your username.

Open Anser through your signed-in LazyCat app and create a LazyCat channel account. Pick your device by name from the list, including offline devices. You can send a test notification from the accounts page.

- The server exposes OpenAPI at `/v1/openapi.json` and a health check at `/healthz`.
- Administrators can open a plugin's settings in the console or NSH client to enable it, disable it, reload it, or configure its accounts. Disabled plugins stay disabled after restart, and new deliveries skip their accounts.
- `POST /v1/send` and `POST /v1/topics/{name}/publish` durably queue messages and accept `Idempotency-Key` and `?wait=true`. Send API keys in `Authorization: Bearer ...`.
- `POST /v1/inbox/send` sends directly to a username and accepts an `Idempotency-Key`. The receipt contains the recipient’s inbox item `id` and a sender-visible `message_id` for delivery history. Direct messages sent before the upgrade remain in their recipients’ inboxes.
- `GET /v1/messages/{id}` shows deliveries and their attempts. The console supports broadcast, priority failover, weighted selection, weighted failover, rate limits, and retry backoff.
- Official SDKs support sending notifications, publishing templates, checking delivery status, and managing subscriptions. See [Rust on crates.io](https://crates.io/crates/anser-sdk), [Go](https://github.com/lib-x/anser-sdk-go), [TypeScript](https://github.com/lib-x/anser-sdk-ts), and the [SDK guide](https://ca-x.github.io/anser/?lang=en#sdk).
- Use `anser api --help` to find management commands and examples.
- Available channels include ntfy, ServerChan, Bark, SMTP email, LazyCat, WeChat Official Account, WeCom, Lark, Telegram, Gotify, QQ Bot, DingTalk, Slack, Discord, IFTTT, and Chanify. PushPlus and gorush served as design references. [Channel setup](anser-plugins) · [LazyCat setup](docs/lazycat.md)

## Configuration

| Environment variable | Default or purpose |
| --- | --- |
| `ANSER_BIND` | `127.0.0.1:8080`, or `0.0.0.0:8080` inside the container |
| `ANSER_DATABASE` | `anser.sqlite3` |
| `ANSER_BOOTSTRAP_USERNAME` / `ANSER_BOOTSTRAP_PASSWORD` | Initial administrator credentials. Passwords must be 8 to 256 UTF-8 bytes. |
| `ANSER_BOOTSTRAP_API_KEY` | Optional initial API key with at least 32 high-entropy characters |
| `ANSER_MASTER_KEY_FILE` / `ANSER_MASTER_KEY` | Optional 32-byte key encoded as URL-safe Base64. Anser creates a `.key` file alongside the database by default. |
| `ANSER_PUBLIC_URL` | HTTPS origin to advertise in mobile pairing codes |
| `ANSER_CORS_ORIGINS` | Comma-separated browser origins allowed to use the API |
| `ANSER_ALLOW_PRIVATE_NETWORK` / `ANSER_OUTBOUND_ALLOW_HOSTS` | Allow private network access as required by a self-hosted channel. It is restricted by default. |
| `ANSER_CALLBACK_ALLOW_HOSTS` / `ANSER_ATTACHMENT_ALLOW_HOSTS` | Comma-separated private hosts allowed for callbacks and attachments, respectively |
| `ANSER_WORKERS` / `ANSER_CONCURRENCY` | 4 queue workers and 32 concurrent sends |
| `ANSER_CHANNEL_CONCURRENCY` / `ANSER_ACCOUNT_CONCURRENCY` | 8 concurrent sends per channel and 1 per account |
| `ANSER_MAX_TTL_SECONDS` / `ANSER_RETENTION_DAYS` | 86,400-second TTL limit and 30-day record retention |
| `ANSER_QUEUE_LIMIT` / `ANSER_REQUESTS_PER_MINUTE` | 10,000 pending routes and 120,000 requests per credential per minute |

The server, Web console, and NSH client share one `x.y.z` version. Each notification channel plugin maintains its own version. A matching `vX.Y.Z` tag builds Linux amd64 and arm64 images for GHCR and publishes Docker archives, server binaries, NSH packages, and SHA-256 checksums to GitHub Releases.
