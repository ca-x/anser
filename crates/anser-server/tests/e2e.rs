use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const BOOTSTRAP_USER: &str = "admin";
const BOOTSTRAP_PASSWORD: &str = "fixture-admin-passphrase";
const BOOTSTRAP_KEY: &str = "fixture-bootstrap-key-only-for-server-e2e-tests";
const ACCOUNT_PASSWORD: &str = "fixture-user-passphrase";
const TOPIC_PASSWORD: &str = "fixture-topic-passphrase";

struct Server {
    child: Child,
    address: SocketAddr,
    stderr_reader: Option<thread::JoinHandle<()>>,
    client: Client,
}

impl Server {
    fn start(database: &Path) -> Self {
        Self::with_outbound_hosts(database, "")
    }

    fn with_outbound_hosts(database: &Path, outbound_hosts: &str) -> Self {
        Self::with_environment(database, outbound_hosts, &[])
    }

    fn with_environment(database: &Path, outbound_hosts: &str, extra: &[(&str, &str)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_anser"))
            .args(["serve", "--bind", "127.0.0.1:0", "--workers", "1"])
            .arg("--database")
            .arg(database)
            .env_clear()
            .env("ANSER_BOOTSTRAP_USERNAME", BOOTSTRAP_USER)
            .env("ANSER_BOOTSTRAP_PASSWORD", BOOTSTRAP_PASSWORD)
            .env("ANSER_BOOTSTRAP_API_KEY", BOOTSTRAP_KEY)
            .env("ANSER_ALLOW_PRIVATE_NETWORK", "1")
            .env("ANSER_OUTBOUND_ALLOW_HOSTS", outbound_hosts)
            .envs(extra.iter().copied())
            .env("RUST_LOG", "warn")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start the Anser test process");

        let mut stderr = BufReader::new(child.stderr.take().expect("pipe Anser stderr"));
        let (ready, started) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let mut line = String::new();
            let mut diagnostic = String::new();
            loop {
                line.clear();
                match stderr.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        let _ = ready.send(Err(diagnostic));
                        return;
                    }
                    Ok(_) => {}
                }
                if let Some(address) = line.trim().strip_prefix("Anser listening on ") {
                    let address = address.parse().map_err(|_| line.trim().to_owned());
                    let _ = ready.send(address);
                    // Keep draining so a full pipe cannot block the server.
                    let _ = std::io::copy(&mut stderr, &mut std::io::sink());
                    return;
                }
                if diagnostic.len() < 16_384 {
                    diagnostic.push_str(&line);
                }
            }
        });

        let mut server = Self {
            child,
            address: SocketAddr::from(([127, 0, 0, 1], 0)),
            stderr_reader: Some(reader),
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(3))
                .build()
                .expect("build loopback HTTP client"),
        };
        server.address = started
            .recv_timeout(Duration::from_secs(30))
            .expect("Anser did not print its listening address")
            .unwrap_or_else(|diagnostic| panic!("Anser failed to start: {diagnostic}"));
        server
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }

    fn request(&self, method: Method, path: &str, token: Option<&str>) -> RequestBuilder {
        let request = self.client.request(method, self.url(path));
        if let Some(token) = token {
            request.bearer_auth(token)
        } else {
            request
        }
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Value,
        expected: StatusCode,
    ) -> T {
        let response = self
            .request(method, path, token)
            .json(&body)
            .send()
            .await
            .expect("submit JSON request");
        checked_json(response, expected).await
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, token: Option<&str>) -> T {
        let response = self
            .request(Method::GET, path, token)
            .send()
            .await
            .expect("submit GET request");
        checked_json(response, StatusCode::OK).await
    }

    async fn login(&self, user: &str, password: &str) -> String {
        let session: Value = self
            .json(
                Method::POST,
                "/v1/auth/login",
                None,
                json!({"username":user, "password":password}),
                StatusCode::OK,
            )
            .await;
        assert_eq!(session["user"]["username"], user);
        json_string(&session, "token").to_owned()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

async fn checked_json<T: DeserializeOwned>(response: Response, expected: StatusCode) -> T {
    let status = response.status();
    let body = response.bytes().await.expect("read HTTP response");
    assert_eq!(
        status,
        expected,
        "HTTP response: {}",
        String::from_utf8_lossy(&body)
    );
    serde_json::from_slice(&body).expect("parse JSON response")
}

fn json_string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string field {key}"))
}

#[tokio::test]
async fn topic_plugin_catalog_persists_approved_listings_and_respects_membership() {
    const MARKET: &str = "/v1/topics/plugin-news/plugin-listings";
    const TOPIC: &str = "/v1/topics/plugin-news";
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("anser.sqlite3");
    let server = Server::start(&database);
    let admin = server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let created: Value = server
        .json(
            Method::POST,
            "/v1/topics",
            Some(&admin),
            json!({"name":"plugin-news","password":TOPIC_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(created["protected"], true);
    let manifest = json!({
        "id":"org.example.certificate-check",
        "kind":"task",
        "version":"1.2.3",
        "name":"Certificate check",
        "description":"Warns before a certificate expires.",
        "source_url":"https://example.com/plugin/releases/1.2.3",
        "sha256":"A".repeat(64)
    });
    let mut invalid = manifest.clone();
    invalid["source_url"] = json!("https://alice:password@example.com/plugin");
    let error: Value = server
        .json(
            Method::POST,
            MARKET,
            Some(&admin),
            invalid,
            StatusCode::BAD_REQUEST,
        )
        .await;
    assert_eq!(error["code"], "invalid_request");
    let mut invalid_version = manifest.clone();
    invalid_version["version"] = json!("1.2");
    let _: Value = server
        .json(
            Method::POST,
            MARKET,
            Some(&admin),
            invalid_version,
            StatusCode::BAD_REQUEST,
        )
        .await;
    let publish = || {
        server
            .request(Method::POST, MARKET, Some(&admin))
            .header("Idempotency-Key", "certificate-check-1.2.3")
            .json(&manifest)
    };
    let first: Value = checked_json(publish().send().await.unwrap(), StatusCode::ACCEPTED).await;
    let duplicate: Value =
        checked_json(publish().send().await.unwrap(), StatusCode::ACCEPTED).await;
    assert_eq!(first, duplicate);
    assert_eq!(first["status"], "success");
    let listing_id = json_string(&first, "message_id");
    let page: Value = server.get(MARKET, Some(&admin)).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["message_id"], listing_id);
    assert_eq!(page["items"][0]["manifest"]["sha256"], "a".repeat(64));

    let _: Value = server
        .json(
            Method::POST,
            "/v1/users",
            Some(&admin),
            json!({"username":"alice","password":ACCOUNT_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    let alice = server.login("alice", ACCOUNT_PASSWORD).await;
    let forbidden = server
        .request(Method::GET, MARKET, Some(&alice))
        .send()
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    let rejected: Value = server
        .json(
            Method::POST,
            MARKET,
            Some(&alice),
            manifest.clone(),
            StatusCode::FORBIDDEN,
        )
        .await;
    assert_eq!(rejected["code"], "forbidden");
    let subscription: Value = server
        .json(
            Method::POST,
            &format!("{TOPIC}/subscriptions"),
            Some(&alice),
            json!({"subscriber_ref":"alice","filter":["plugin-listing"],"password":TOPIC_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    assert!(subscription["id"].is_string());
    let mut second = manifest.clone();
    second["id"] = json!("org.example.channel");
    second["kind"] = json!("channel");
    let _: Value = server
        .json(
            Method::POST,
            MARKET,
            Some(&admin),
            second,
            StatusCode::ACCEPTED,
        )
        .await;
    let forged: Value = server
        .json(
            Method::POST,
            &format!("{TOPIC}/publish"),
            Some(&alice),
            json!({"title":"Ordinary notification","tags":["plugin-listing"],"extras":{"plugin_listing":manifest}}),
            StatusCode::ACCEPTED,
        )
        .await;
    let inbox: Value = server.get("/v1/inbox", Some(&alice)).await;
    assert!(inbox["items"].as_array().unwrap().iter().any(|item| {
        item["title"] == "Certificate check 1.2.3"
            && item["body"]
                .as_str()
                .unwrap()
                .contains("https://example.com/plugin/releases/1.2.3")
    }));
    let page: Value = server.get(&format!("{MARKET}?limit=1"), Some(&alice)).await;
    let cursor = json_string(&page, "next_cursor");
    let tail: Value = server
        .get(&format!("{MARKET}?cursor={cursor}"), Some(&alice))
        .await;
    assert_eq!(tail["items"].as_array().unwrap().len(), 1);
    for listing in [&page["items"][0], &tail["items"][0]] {
        assert_ne!(listing["message_id"], forged["message_id"]);
    }
    drop(server);

    let server = Server::start(&database);
    let task: Value = server
        .get(&format!("{MARKET}?kind=task"), Some(&alice))
        .await;
    assert_eq!(task["items"].as_array().unwrap().len(), 1);
    assert_eq!(task["items"][0]["message_id"], listing_id);
    let removal = server
        .request(Method::DELETE, TOPIC, Some(&admin))
        .send()
        .await
        .unwrap();
    assert_eq!(removal.status(), StatusCode::NO_CONTENT);
    let _: Value = server
        .json(
            Method::POST,
            "/v1/topics",
            Some(&admin),
            json!({"name":"plugin-news"}),
            StatusCode::CREATED,
        )
        .await;
    let recreated: Value = server.get(MARKET, Some(&alice)).await;
    assert_eq!(recreated["items"], json!([]));
}

#[tokio::test]
async fn lazycat_discovery_requires_a_global_admin_and_an_authenticated_ingress() {
    const DEVICES: &str = "/v1/channels/lazycat/devices";
    const PROOF: &str = "a6d39ee0db05f98202dd601619ce6717617ffaa4c03f4f7bfa8e32c6b6ac9f73";
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("anser.sqlite3");
    let local = Server::start(&database);
    let error: Value = checked_json(
        local
            .request(Method::GET, DEVICES, Some(BOOTSTRAP_KEY))
            .header("x-hc-user-id", "alice")
            .header("x-anser-lazycat-uid", "alice")
            .header("x-anser-lazycat-proof", PROOF)
            .send()
            .await
            .unwrap(),
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    assert_eq!(error["code"], "lazycat_identity_unavailable");
    drop(local);

    let server =
        Server::with_environment(&database, "", &[("ANSER_LAZYCAT_INGRESS_SECRET", PROOF)]);
    let request = |token| {
        server
            .request(Method::GET, DEVICES, token)
            .header("x-hc-user-id", "untrusted")
            .header("x-anser-lazycat-uid", "alice")
    };
    assert_eq!(
        request(None)
            .header("x-anser-lazycat-proof", PROOF)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for forged in [
        request(Some(BOOTSTRAP_KEY)),
        request(Some(BOOTSTRAP_KEY)).header("x-anser-lazycat-proof", "wrong"),
        request(Some(BOOTSTRAP_KEY))
            .header("x-anser-lazycat-uid", "different")
            .header("x-anser-lazycat-proof", PROOF),
    ] {
        let error: Value = checked_json(forged.send().await.unwrap(), StatusCode::FORBIDDEN).await;
        assert_eq!(error["code"], "lazycat_identity_required");
    }
    server
        .json::<Value>(
            Method::POST,
            "/v1/users",
            Some(BOOTSTRAP_KEY),
            json!({"username":"reader","password":ACCOUNT_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    let reader = server.login("reader", ACCOUNT_PASSWORD).await;
    let error: Value = checked_json(
        request(Some(&reader))
            .header("x-anser-lazycat-proof", PROOF)
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN,
    )
    .await;
    assert_eq!(error["code"], "forbidden");

    #[cfg(all(unix, feature = "lazycat"))]
    server
        .json::<Value>(
            Method::PUT,
            "/v1/channels/lazycat/runtime",
            Some(BOOTSTRAP_KEY),
            json!({"enabled":false}),
            StatusCode::OK,
        )
        .await;
    let error: Value = checked_json(
        request(Some(BOOTSTRAP_KEY))
            .header("x-anser-lazycat-proof", PROOF)
            .send()
            .await
            .unwrap(),
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    assert_eq!(error["code"], "channel_unavailable");
}

#[tokio::test]
async fn protected_subscriptions_deliver_to_separate_inboxes_and_pair_codes_are_single_use() {
    let temp = tempfile::tempdir().unwrap();
    let server = Server::start(&temp.path().join("anser.sqlite3"));
    let health: Value = server.get("/v1/health", None).await;
    assert_eq!(health["status"], "ok");

    let response = server
        .request(Method::GET, "/v1/accounts", None)
        .send()
        .await
        .unwrap();
    let error: Value = checked_json(response, StatusCode::UNAUTHORIZED).await;
    assert!(error["code"].is_string());
    let wrong_login: Value = server
        .json(
            Method::POST,
            "/v1/auth/login",
            None,
            json!({"username":BOOTSTRAP_USER, "password":"incorrect-password"}),
            StatusCode::UNAUTHORIZED,
        )
        .await;
    assert!(wrong_login.get("token").is_none());

    let admin = server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let mut tokens = Vec::new();
    for user in ["alice", "bob"] {
        let created: Value = server
            .json(
                Method::POST,
                "/v1/users",
                Some(&admin),
                json!({"username":user, "password":ACCOUNT_PASSWORD}),
                StatusCode::CREATED,
            )
            .await;
        assert_eq!(created["username"], user);
        assert!(created.get("password_hash").is_none());
        tokens.push(server.login(user, ACCOUNT_PASSWORD).await);
    }
    let [alice, bob] = tokens.as_slice() else {
        unreachable!("expected two logged-in users")
    };

    let topic: Value = server
        .json(
            Method::POST,
            "/v1/topics",
            Some(&admin),
            json!({"name":"private-alerts", "password": TOPIC_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(topic["protected"], true);
    assert!(topic.get("password").is_none());
    let subscription_path = "/v1/topics/private-alerts/subscriptions";
    let denied: Value = server
        .json(
            Method::POST,
            subscription_path,
            Some(alice),
            json!({"subscriber_ref":"alice"}),
            StatusCode::FORBIDDEN,
        )
        .await;
    assert_eq!(denied["code"], "topic_password_required");

    let mut subscriptions = Vec::new();
    for (user, token) in [("alice", alice), ("bob", bob)] {
        let subscription: Value = server
            .json(
                Method::POST,
                subscription_path,
                Some(token),
                json!({"subscriber_ref":user, "password":TOPIC_PASSWORD,"filter":["maintenance"]}),
                StatusCode::CREATED,
            )
            .await;
        subscriptions.push(subscription);
        assert!(subscriptions.last().unwrap().get("password").is_none());
    }
    assert_ne!(subscriptions[0]["id"], subscriptions[1]["id"]);
    let alice_subs: Value = server.get(subscription_path, Some(alice)).await;
    let bob_subs: Value = server.get(subscription_path, Some(bob)).await;
    assert_eq!(alice_subs["items"], json!([subscriptions[0]]));
    assert_eq!(bob_subs["items"], json!([subscriptions[1]]));
    let bob_subscription = format!(
        "{subscription_path}/{}",
        json_string(&subscriptions[1], "id")
    );
    let response = server
        .request(Method::DELETE, &bob_subscription, Some(alice))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let receipt: Value = server
        .json(
            Method::POST,
            "/v1/topics/private-alerts/publish",
            Some(&admin),
            json!({"title":"Maintenance", "tags":["maintenance"]}),
            StatusCode::ACCEPTED,
        )
        .await;
    assert_eq!(receipt["status"], "success");
    let detail: Value = server
        .get(
            &format!("/v1/messages/{}", json_string(&receipt, "message_id")),
            Some(&admin),
        )
        .await;
    assert_eq!(detail["inbox_deliveries"], 2);
    assert!(detail.get("inbox_recipient").is_none());
    assert_eq!(detail["deliveries"], json!([]));
    for (path, body) in [
        ("/v1/send", json!({})),
        ("/v1/topics/private-alerts/publish", json!({"title":"  "})),
        ("/v1/inbox/send", json!({"recipient":"alice","body":"\n\t"})),
        (
            "/v1/accounts/example/test",
            json!({"title":"  ","body":"　"}),
        ),
    ] {
        let error: Value = server
            .json(
                Method::POST,
                path,
                Some(&admin),
                body,
                StatusCode::BAD_REQUEST,
            )
            .await;
        assert_eq!(error["code"], "invalid_request");
    }
    let mut inbox_ids = Vec::new();
    for token in [alice, bob] {
        let inbox: Value = server.get("/v1/inbox", Some(token)).await;
        let items = inbox["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item["topic"], "private-alerts");
        assert_eq!(item["title"], "Maintenance");
        assert_eq!(item["body"], "");
        assert_eq!(item["from_username"], BOOTSTRAP_USER);
        inbox_ids.push(item["id"].as_i64().unwrap());
    }
    assert_ne!(inbox_ids[0], inbox_ids[1]);
    let response = server
        .request(
            Method::POST,
            &format!("/v1/inbox/{}/read", inbox_ids[0]),
            Some(alice),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let alice_inbox: Value = server.get("/v1/inbox", Some(alice)).await;
    let bob_inbox: Value = server.get("/v1/inbox", Some(bob)).await;
    assert!(alice_inbox["items"][0]["read_at"].as_i64().is_some());
    assert!(bob_inbox["items"][0]["read_at"].is_null());

    let link: Value = server
        .json(
            Method::POST,
            "/v1/auth/pair",
            Some(alice),
            json!({"server":server.url("/")}),
            StatusCode::OK,
        )
        .await;
    let url = reqwest::Url::parse(json_string(&link, "url")).unwrap();
    assert_eq!(url.scheme(), "anser");
    assert_eq!(url.host_str(), Some("connect"));
    let code = url
        .query_pairs()
        .find_map(|(parameter, value)| (parameter == "code").then_some(value.into_owned()))
        .expect("pairing URL includes a code");
    let exchange: Value = server
        .json(
            Method::POST,
            "/v1/auth/pair/exchange",
            None,
            json!({"code":code}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(exchange["user"]["username"], "alice");
    assert_ne!(exchange["token"].as_str(), Some(alice.as_str()));
    let me: Value = server
        .get("/v1/auth/me", Some(json_string(&exchange, "token")))
        .await;
    assert_eq!(me["username"], "alice");
    let reused: Value = server
        .json(
            Method::POST,
            "/v1/auth/pair/exchange",
            None,
            json!({"code":code}),
            StatusCode::UNAUTHORIZED,
        )
        .await;
    assert!(reused.get("token").is_none());
}

#[tokio::test]
async fn direct_notification_keeps_one_sender_receipt_across_retries_and_restart() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("anser.sqlite3");
    let server = Server::start(&database);
    for user in ["alice", "bob"] {
        server
            .json::<Value>(
                Method::POST,
                "/v1/users",
                Some(BOOTSTRAP_KEY),
                json!({"username":user,"password":ACCOUNT_PASSWORD}),
                StatusCode::CREATED,
            )
            .await;
    }
    let alice = server.login("alice", ACCOUNT_PASSWORD).await;
    let bob = server.login("bob", ACCOUNT_PASSWORD).await;
    let send = |server: &Server, recipient: &str, key: &str| {
        server
            .request(Method::POST, "/v1/inbox/send", Some(&alice))
            .header("Idempotency-Key", key)
            .json(&json!({"recipient":recipient,"body":"Train 24 is here"}))
            .send()
    };
    let (first, second) = tokio::join!(send(&server, "bob", "same"), send(&server, "bob", "same"));
    let receipt: Value = checked_json(first.unwrap(), StatusCode::CREATED).await;
    assert_eq!(
        checked_json::<Value>(second.unwrap(), StatusCode::CREATED).await,
        receipt
    );
    let path = format!("/v1/messages/{}", json_string(&receipt, "message_id"));
    let detail: Value = server.get(&path, Some(&alice)).await;
    assert_eq!(detail["status"], "success");
    assert_eq!(detail["message"]["title"], "");
    assert_eq!(detail["message"]["body"], "Train 24 is here");
    assert_eq!(detail["inbox_deliveries"], 1);
    assert_eq!(detail["deliveries"], json!([]));
    assert_eq!(
        send(&server, "missing", "different")
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(&server, "bob", "invalid key").await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );

    let inbox: Value = server.get("/v1/inbox", Some(&bob)).await;
    let items = inbox["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], receipt["id"]);
    assert_eq!(items[0]["from_username"], "alice");
    assert_eq!(items[0]["body"], "Train 24 is here");
    let read = format!("/v1/inbox/{}/read", receipt["id"].as_i64().unwrap());
    assert_eq!(
        server
            .request(Method::POST, &read, Some(&bob))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(server.get::<Value>(&path, Some(&alice)).await, detail);
    assert_eq!(detail["inbox_recipient"], "bob");
    assert!(detail.get("read_at").is_none());
    assert_eq!(
        server
            .request(Method::GET, &path, Some(&bob))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let history: Value = server.get("/v1/messages", Some(&bob)).await;
    assert_eq!(history["items"], json!([]));

    drop(server);
    let restarted = Server::start(&database);
    assert_eq!(
        checked_json::<Value>(
            send(&restarted, "bob", "same").await.unwrap(),
            StatusCode::CREATED
        )
        .await,
        receipt
    );
    let new_session = restarted.login("alice", ACCOUNT_PASSWORD).await;
    let history: Value = restarted.get("/v1/messages", Some(&new_session)).await;
    assert_eq!(history["items"], json!([detail]));
    let inbox: Value = restarted.get("/v1/inbox", Some(&bob)).await;
    assert_eq!(inbox["items"].as_array().unwrap().len(), 1);
    assert!(inbox["items"][0]["read_at"].is_number());
}

#[cfg(feature = "ntfy")]
mod durable_delivery {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use anser_core::api::{MessageDetail, Receipt};
    use axum::extract::{Json, State};
    use axum::http::{HeaderMap, header};
    use axum::response::IntoResponse;
    use axum::{Router, routing::post};
    use tokio::net::TcpListener;
    use tokio::sync::Notify;
    use tokio::task::JoinHandle;
    use tokio::time::{Instant, sleep};

    const PROVIDER_TOKEN: &str = "fixture-ntfy-credential";

    #[derive(Default)]
    struct NtfyMock {
        success: AtomicBool,
        calls: AtomicUsize,
        correct_request: AtomicBool,
    }

    async fn ntfy(
        State(fixture): State<Arc<NtfyMock>>,
        headers: HeaderMap,
        Json(input): Json<Value>,
    ) -> impl IntoResponse {
        if input["title"] == "Worker barrier" {
            return (
                StatusCode::OK,
                Json(json!({"event":"message","id":"barrier"})),
            );
        }
        fixture.calls.fetch_add(1, Ordering::SeqCst);
        let authorization = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        let correct_request = authorization == Some("Bearer fixture-ntfy-credential")
            && input["topic"] == "restart-alerts"
            && input["title"] == "Restart test";
        fixture
            .correct_request
            .store(correct_request, Ordering::SeqCst);
        if fixture.success.load(Ordering::SeqCst) {
            (
                StatusCode::OK,
                Json(json!({"event":"message","id":"fixture"})),
            )
        } else {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"detail":"temporary fixture error"})),
            )
        }
    }

    struct MockServer(JoinHandle<std::io::Result<()>>);

    impl Drop for MockServer {
        fn drop(&mut self) {
            self.0.abort();
        }
    }

    async fn mock_server() -> (Arc<NtfyMock>, SocketAddr, MockServer) {
        let fixture = Arc::new(NtfyMock::default());
        let router = Router::new()
            .route("/", post(ntfy))
            .with_state(fixture.clone());
        let (address, server) = listen_mock(router).await;
        (fixture, address, server)
    }

    async fn listen_mock(router: Router) -> (SocketAddr, MockServer) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await });
        (address, MockServer(task))
    }

    async fn submit(server: &Server) -> Receipt {
        let response = server
            .request(Method::POST, "/v1/send", Some(BOOTSTRAP_KEY))
            .header("Idempotency-Key", "restart-notification-1")
            .json(&json!({
                "title":"Restart test",
                "body":"Persist this across server processes",
                "channels":["ntfy"],
                "strategy":{"retry":{
                    "max_attempts":3, "backoff":"fixed", "jitter":false,
                    "base_delay":4500, "max_delay":4500, "ttl":30000
                }}
            }))
            .send()
            .await
            .unwrap();
        checked_json(response, StatusCode::ACCEPTED).await
    }

    async fn wait_for(
        server: &Server,
        message_id: &str,
        mut predicate: impl FnMut(&MessageDetail) -> bool,
    ) -> MessageDetail {
        let path = format!("/v1/messages/{message_id}");
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let detail = server
                .get::<MessageDetail>(&path, Some(BOOTSTRAP_KEY))
                .await;
            if predicate(&detail) {
                return detail;
            }
            assert!(
                Instant::now() < deadline,
                "delivery did not progress: {detail:#?}"
            );
            sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn restarts_a_waiting_ntfy_attempt_without_republishing_the_idempotency_key() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("anser.sqlite3");
        let (mock, mock_address, _mock_server) = mock_server().await;
        let server = Server::start(&database);
        let account: Value = server
            .json(
                Method::POST,
                "/v1/accounts",
                Some(BOOTSTRAP_KEY),
                json!({
                    "name":"local ntfy fixture",
                    "channel":"ntfy",
                    "config":{
                        "server_url":format!("http://{mock_address}/"),
                        "topic":"restart-alerts", "token":PROVIDER_TOKEN
                    }
                }),
                StatusCode::CREATED,
            )
            .await;
        let account_id = json_string(&account, "id").to_owned();
        assert!(!account.to_string().contains(PROVIDER_TOKEN));
        let receipt = submit(&server).await;
        let repeated = submit(&server).await;
        assert_eq!(receipt.message_id, repeated.message_id);

        let waiting = wait_for(&server, &receipt.message_id, |detail| {
            detail.deliveries.first().is_some_and(|delivery| {
                delivery.next_retry_at.is_some()
                    && delivery
                        .attempts
                        .first()
                        .is_some_and(|attempt| attempt.finished_at.is_some())
            })
        })
        .await;
        assert_eq!(waiting.status, "pending");
        assert_eq!(waiting.deliveries[0].attempts.len(), 1);
        assert!(waiting.deliveries[0].attempts[0].error_code.is_some());
        assert!(
            !waiting.deliveries[0].attempts[0]
                .error_msg
                .as_deref()
                .unwrap_or_default()
                .contains("temporary fixture error")
        );
        // The only worker must release the retry lease before it can process this probe.
        let probe: Receipt = server
            .json(
                Method::POST,
                "/v1/send?wait=true&timeout_ms=2000",
                Some(BOOTSTRAP_KEY),
                json!({"title":"Worker barrier","body":"Fixture only","channels":["ntfy"]}),
                StatusCode::OK,
            )
            .await;
        assert_eq!(probe.status, "success");
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);

        // Killing the process, rather than using a graceful shutdown, exercises the durable queue.
        drop(server);
        mock.success.store(true, Ordering::SeqCst);
        let server = Server::start(&database);
        let repeated = submit(&server).await;
        assert_eq!(receipt.message_id, repeated.message_id);

        let final_detail = wait_for(&server, &receipt.message_id, |detail| {
            detail.status == "success"
        })
        .await;
        assert_eq!(final_detail.deliveries.len(), 1);
        let delivery = &final_detail.deliveries[0];
        assert_eq!(delivery.account_id, account_id);
        assert_eq!(delivery.channel, "ntfy");
        assert_eq!(delivery.status, "success");
        assert_eq!(delivery.attempts.len(), 2);
        assert_eq!(delivery.attempts[0].n, 1);
        assert_eq!(delivery.attempts[1].n, 2);
        assert!(delivery.attempts[1].error_code.is_none());
        assert!(delivery.attempts[1].finished_at.is_some());
        assert!(mock.correct_request.load(Ordering::SeqCst));
        assert_eq!(mock.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn channel_disablement_survives_restart_until_an_admin_enables_it() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("anser.sqlite3");
        let (mock, address, _mock_server) = mock_server().await;
        mock.success.store(true, Ordering::SeqCst);
        let store = anser_store::Store::open(&database).await.unwrap();
        store
            .set_channel_enabled("fixture-uncompiled", false)
            .await
            .unwrap();
        drop(store);

        let server = Server::start(&database);
        let _: Value = server
            .json(
                Method::POST,
                "/v1/accounts",
                Some(BOOTSTRAP_KEY),
                json!({
                    "name":"runtime setting fixture",
                    "channel":"ntfy",
                    "config":{"server_url":format!("http://{address}/"),"topic":"runtime-fixture"}
                }),
                StatusCode::CREATED,
            )
            .await;
        let _: Value = server
            .json(
                Method::POST,
                "/v1/users",
                Some(BOOTSTRAP_KEY),
                json!({"username":"operator","password":ACCOUNT_PASSWORD}),
                StatusCode::CREATED,
            )
            .await;
        let operator = server.login("operator", ACCOUNT_PASSWORD).await;
        let detail_path = "/v1/channels/ntfy";
        let runtime_path = "/v1/channels/ntfy/runtime";
        let description: Value = server.get(detail_path, Some(BOOTSTRAP_KEY)).await;
        assert_eq!(description["enabled"], true);
        assert_eq!(description["available"], true);
        assert_eq!(description["can_manage"], true);
        assert!(description["config_schema"].is_object());
        let regular_description: Value = server.get(detail_path, Some(&operator)).await;
        assert_eq!(regular_description["can_manage"], false);
        let _: Value = server
            .json(
                Method::PUT,
                runtime_path,
                Some(&operator),
                json!({"enabled":false}),
                StatusCode::FORBIDDEN,
            )
            .await;
        let disabled: Value = server
            .json(
                Method::PUT,
                runtime_path,
                Some(BOOTSTRAP_KEY),
                json!({"enabled":false}),
                StatusCode::OK,
            )
            .await;
        assert_eq!(
            disabled,
            json!({"id":"ntfy","enabled":false,"available":false})
        );

        drop(server);
        let server = Server::start(&database);
        let detail: Value = server.get(detail_path, Some(BOOTSTRAP_KEY)).await;
        assert_eq!(detail["enabled"], false);
        assert_eq!(detail["available"], false);
        assert_eq!(detail["config_schema"], description["config_schema"]);
        let list: Value = server.get("/v1/channels", Some(&operator)).await;
        let ntfy = list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|channel| channel["id"] == "ntfy")
            .unwrap();
        assert_eq!(ntfy["enabled"], false);
        assert_eq!(ntfy["available"], false);
        assert_eq!(ntfy["can_manage"], false);
        let store = anser_store::Store::open(&database).await.unwrap();
        assert_eq!(
            store
                .channel_settings()
                .await
                .unwrap()
                .get("fixture-uncompiled"),
            Some(&false)
        );
        drop(store);

        let payload =
            json!({"title":"Runtime test","body":"Check saved plugin setting","channels":["ntfy"]});
        let no_targets: Value = server
            .json(
                Method::POST,
                "/v1/send",
                Some(BOOTSTRAP_KEY),
                payload.clone(),
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
        assert_eq!(no_targets["code"], "no_available_targets");
        assert_eq!(mock.calls.load(Ordering::SeqCst), 0);

        let enabled: Value = server
            .json(
                Method::PUT,
                runtime_path,
                Some(BOOTSTRAP_KEY),
                json!({"enabled":true}),
                StatusCode::OK,
            )
            .await;
        assert_eq!(
            enabled,
            json!({"id":"ntfy","enabled":true,"available":true})
        );
        let receipt: Receipt = server
            .json(
                Method::POST,
                "/v1/send?wait=true&timeout_ms=2000",
                Some(BOOTSTRAP_KEY),
                payload,
                StatusCode::OK,
            )
            .await;
        assert_eq!(receipt.status, "success");
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    }

    #[derive(Default)]
    struct FanoutMock {
        successes: AtomicUsize,
        retry_failures: AtomicUsize,
        ttl_failures: AtomicUsize,
        callbacks: AtomicUsize,
        first_failure_ready: Notify,
    }

    async fn good_provider(
        State(mock): State<Arc<FanoutMock>>,
        Json(input): Json<Value>,
    ) -> Json<Value> {
        if input["title"] == "Fanout" {
            mock.successes.fetch_add(1, Ordering::SeqCst);
        }
        Json(json!({"event":"message","id":"success"}))
    }

    async fn unavailable_provider(
        State(mock): State<Arc<FanoutMock>>,
        Json(input): Json<Value>,
    ) -> StatusCode {
        if input["title"] == "Expiry" {
            mock.ttl_failures.fetch_add(1, Ordering::SeqCst);
        } else if mock.retry_failures.fetch_add(1, Ordering::SeqCst) == 0 {
            mock.first_failure_ready.notified().await;
        }
        StatusCode::SERVICE_UNAVAILABLE
    }

    async fn callback_probe(State(mock): State<Arc<FanoutMock>>) -> StatusCode {
        mock.callbacks.fetch_add(1, Ordering::SeqCst);
        StatusCode::NO_CONTENT
    }

    async fn create_ntfy_account(server: &Server, address: SocketAddr, provider: &str) -> String {
        let account: Value = server
            .json(
                Method::POST,
                "/v1/accounts",
                Some(BOOTSTRAP_KEY),
                json!({
                    "name":provider,
                    "channel":"ntfy",
                    "config":{
                        "server_url":format!("http://{address}/{provider}"),
                        "topic":"fanout-fixture",
                    }
                }),
                StatusCode::CREATED,
            )
            .await;
        json_string(&account, "id").to_owned()
    }

    #[tokio::test]
    async fn broadcast_any_keeps_attempts_independent_and_unsubscribe_cancels_retries() {
        let temp = tempfile::tempdir().unwrap();
        let mock = Arc::new(FanoutMock::default());
        let router = Router::new()
            .route("/available", post(good_provider))
            .route("/unavailable", post(unavailable_provider))
            .route("/callback", post(callback_probe))
            .with_state(mock.clone());
        let (address, _mock_server) = listen_mock(router).await;
        let server = Server::start(&temp.path().join("anser.sqlite3"));
        let available = create_ntfy_account(&server, address, "available").await;
        let unavailable = create_ntfy_account(&server, address, "unavailable").await;
        let _: Value = server
            .json(
                Method::POST,
                "/v1/topics",
                Some(BOOTSTRAP_KEY),
                json!({
                    "name":"fanout",
                    "policy":{
                        "mode":"broadcast",
                        "success_criteria":"any",
                        "targets":[{"account_id":available},{"account_id":unavailable}],
                        "retry":{"max_attempts":4,"backoff":"fixed","jitter":false,
                                 "base_delay":1800,"max_delay":1800,"ttl":30000}
                    }
                }),
                StatusCode::CREATED,
            )
            .await;
        let subscription: Value = server
            .json(
                Method::POST,
                "/v1/topics/fanout/subscriptions",
                Some(BOOTSTRAP_KEY),
                json!({"subscriber_ref":"fixture"}),
                StatusCode::CREATED,
            )
            .await;
        let subscription_id = json_string(&subscription, "id");
        let receipt: Receipt = server
            .json(
                Method::POST,
                "/v1/topics/fanout/publish",
                Some(BOOTSTRAP_KEY),
                json!({
                    "title":"Fanout",
                    "body":"Check independent delivery results",
                    "callback_url":format!("http://{address}/callback")
                }),
                StatusCode::ACCEPTED,
            )
            .await;

        // Hold the first failure's response until the other provider commits a success.
        let early_success = wait_for(&server, &receipt.message_id, |detail| {
            detail.status == "success"
                && detail.deliveries.iter().any(|delivery| {
                    delivery.account_id == unavailable && delivery.status == "sending"
                })
        })
        .await;
        assert_eq!(early_success.deliveries.len(), 2);
        mock.first_failure_ready.notify_one();

        let success_with_retry = wait_for(&server, &receipt.message_id, |detail| {
            detail.status == "success"
                && detail.deliveries.iter().any(|delivery| {
                    delivery.account_id == unavailable
                        && delivery.next_retry_at.is_some()
                        && delivery.attempts.len() >= 2
                })
        })
        .await;
        assert_eq!(success_with_retry.deliveries.len(), 2);
        let good_delivery = success_with_retry
            .deliveries
            .iter()
            .find(|delivery| delivery.account_id == available)
            .unwrap();
        let failed_delivery = success_with_retry
            .deliveries
            .iter()
            .find(|delivery| delivery.account_id == unavailable)
            .unwrap();
        assert_eq!(
            good_delivery.subscription_id.as_deref(),
            Some(subscription_id)
        );
        assert_eq!(good_delivery.account_name.as_deref(), Some("available"));
        assert_eq!(good_delivery.status, "success");
        assert_eq!(good_delivery.attempts.len(), 1);
        assert_eq!(failed_delivery.status, "pending");
        assert_eq!(failed_delivery.attempts.len(), 2);
        let retry_at = failed_delivery.next_retry_at.unwrap();

        let response = server
            .request(
                Method::DELETE,
                &format!("/v1/topics/fanout/subscriptions/{subscription_id}"),
                Some(BOOTSTRAP_KEY),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        // Run an expiring route as a worker barrier, extending past the cancelled retry's due time.
        let ttl = retry_at.saturating_sub(anser_store::now_ms()).max(0) + 750;
        let expiry: Receipt = server
            .json(
                Method::POST,
                "/v1/send",
                Some(BOOTSTRAP_KEY),
                json!({
                    "title":"Expiry", "body":"Expire this failing task", "channels":[unavailable],
                    "strategy":{"retry":{"max_attempts":1,"backoff":"fixed","jitter":false,
                                        "base_delay":600,"max_delay":600,"until_success":true,"ttl":ttl}}
                }),
                StatusCode::ACCEPTED,
            )
            .await;
        let expired = wait_for(&server, &expiry.message_id, |detail| {
            detail.status == "dead"
        })
        .await;
        assert_eq!(expired.deliveries[0].status, "dead");
        assert!(expired.deliveries[0].next_retry_at.is_none());
        assert!(mock.ttl_failures.load(Ordering::SeqCst) >= 1);

        let final_detail: MessageDetail = server
            .get(
                &format!("/v1/messages/{}", receipt.message_id),
                Some(BOOTSTRAP_KEY),
            )
            .await;
        assert_eq!(final_detail.status, "success");
        let cancelled = final_detail
            .deliveries
            .iter()
            .find(|delivery| delivery.account_id == unavailable)
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.next_retry_at.is_none());
        assert_eq!(cancelled.attempts.len(), 2);
        assert_eq!(mock.successes.load(Ordering::SeqCst), 1);
        assert_eq!(mock.retry_failures.load(Ordering::SeqCst), 2);

        // A second scheduler attempt proves the first callback was processed and deferred.
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let stats: Value = server.get("/v1/statistics", Some(BOOTSTRAP_KEY)).await;
            assert_eq!(mock.callbacks.load(Ordering::SeqCst), 0);
            if stats["callback_attempts"].as_i64().unwrap_or_default() >= 2 {
                assert_eq!(stats["callback_pending"], 1);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "callback was not attempted: {stats}"
            );
            sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(mock.callbacks.load(Ordering::SeqCst), 0);
    }
}

fn fixture_totp(seed: &[u8], step: u64) -> String {
    use hmac::{Hmac, KeyInit, Mac};

    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(seed).unwrap();
    mac.update(&step.to_be_bytes());
    let bytes = mac.finalize().into_bytes();
    let offset = usize::from(bytes[19] & 15);
    let truncated = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap());
    format!("{:06}", (truncated & 0x7fff_ffff) % 1_000_000)
}

#[tokio::test]
async fn totp_enrollment_login_recovery_and_disable_preserve_session_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("anser.sqlite3");
    let server = Server::start(&path);
    let existing = server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let owner = server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let _: Value = server
        .json(
            Method::POST,
            "/v1/users",
            Some(&owner),
            json!({"username":"bob", "password":ACCOUNT_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    let pair: Value = server
        .json(
            Method::POST,
            "/v1/auth/pair",
            Some(&existing),
            json!({"server":format!("http://{}", server.address)}),
            StatusCode::OK,
        )
        .await;
    let pair_url = reqwest::Url::parse(json_string(&pair, "url")).unwrap();
    let pair_code = pair_url
        .query_pairs()
        .find(|(key, _)| key == "code")
        .unwrap()
        .1;
    let status: Value = server.get("/v1/auth/totp", Some(&owner)).await;
    assert_eq!(status, json!({"enabled":false}));
    let wrong_password: Value = server
        .json(
            Method::POST,
            "/v1/auth/totp/setup",
            Some(&owner),
            json!({"password":"wrong-password"}),
            StatusCode::BAD_REQUEST,
        )
        .await;
    assert_eq!(wrong_password["code"], "invalid_password");
    let setup_response = server
        .request(Method::POST, "/v1/auth/totp/setup", Some(&owner))
        .json(&json!({"password":BOOTSTRAP_PASSWORD}))
        .send()
        .await
        .unwrap();
    assert_eq!(setup_response.headers()["cache-control"], "no-store");
    let setup: Value = checked_json(setup_response, StatusCode::OK).await;
    let secret = json_string(&setup, "secret");
    let uri = reqwest::Url::parse(json_string(&setup, "uri")).unwrap();
    assert_eq!(uri.scheme(), "otpauth");
    assert!(
        uri.query_pairs()
            .any(|(key, value)| key == "secret" && value == secret)
    );
    assert!(setup["expires_at"].as_i64().unwrap() > anser_store::now_ms());
    let wrong_session: Value = server
        .json(
            Method::POST,
            "/v1/auth/totp/confirm",
            Some(&existing),
            json!({"code":"000000"}),
            StatusCode::BAD_REQUEST,
        )
        .await;
    assert_eq!(wrong_session["code"], "totp_setup_expired");
    let wrong_confirmation: Value = server
        .json(
            Method::POST,
            "/v1/auth/totp/confirm",
            Some(&owner),
            json!({"code":"invalid"}),
            StatusCode::BAD_REQUEST,
        )
        .await;
    assert_eq!(wrong_confirmation["code"], "invalid_totp");

    let seed = data_encoding::BASE32_NOPAD
        .decode(secret.as_bytes())
        .unwrap();
    let current = u64::try_from(anser_store::now_ms()).unwrap() / 30_000;
    let confirmation_code = fixture_totp(&seed, current);
    let confirmation: Value = server
        .json(
            Method::POST,
            "/v1/auth/totp/confirm",
            Some(&owner),
            json!({"code":confirmation_code}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(confirmation["enabled"], true);
    let recovery = confirmation["recovery_codes"].as_array().unwrap();
    assert_eq!(recovery.len(), 8);
    let status: Value = server.get("/v1/auth/totp", Some(&owner)).await;
    assert_eq!(status, json!({"enabled":true}));
    let revoked = server
        .request(Method::GET, "/v1/auth/me", Some(&existing))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    let revoked_pair = server
        .request(Method::POST, "/v1/auth/pair/exchange", None)
        .json(&json!({"code":pair_code}))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked_pair.status(), StatusCode::UNAUTHORIZED);

    drop(server);
    let server = Server::start(&path);
    let status: Value = server.get("/v1/auth/totp", Some(&owner)).await;
    assert_eq!(status, json!({"enabled":true}));

    let login = || server.request(Method::POST, "/v1/auth/login", None);
    let valid_password = json!({"username":BOOTSTRAP_USER, "password":BOOTSTRAP_PASSWORD});
    let missing: Value = checked_json(
        login().json(&valid_password).send().await.unwrap(),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_eq!(missing["code"], "totp_required");
    let password_error: Value = checked_json(
        login()
            .json(&json!({"username":BOOTSTRAP_USER,"password":"wrong-password"}))
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_eq!(password_error["code"], "authentication_required");
    let login_code = |code: &str| {
        login().json(&json!({"username":BOOTSTRAP_USER, "password":BOOTSTRAP_PASSWORD,"code":code}))
    };
    let enrollment_replay: Value = checked_json(
        login_code(&confirmation_code).send().await.unwrap(),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_eq!(enrollment_replay["code"], "invalid_totp");
    let next_code = fixture_totp(&seed, current + 1);
    let authenticated: Value =
        checked_json(login_code(&next_code).send().await.unwrap(), StatusCode::OK).await;
    let other_session = json_string(&authenticated, "token");
    let login_replay: Value = checked_json(
        login_code(&next_code).send().await.unwrap(),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_eq!(login_replay["code"], "invalid_totp");

    let first_recovery = recovery[0].as_str().unwrap();
    let (first, second) = tokio::join!(
        login_code(first_recovery).send(),
        login_code(first_recovery).send()
    );
    let first = first.unwrap();
    let second = second.unwrap();
    let denied = if first.status() == StatusCode::OK {
        second
    } else {
        assert_eq!(second.status(), StatusCode::OK);
        first
    };
    let spent: Value = checked_json(denied, StatusCode::UNAUTHORIZED).await;
    assert_eq!(spent["code"], "invalid_totp");

    let disabled: Value = server
        .json(
            Method::POST,
            "/v1/auth/totp/disable",
            Some(&owner),
            json!({"password":BOOTSTRAP_PASSWORD, "code":recovery[1].as_str().unwrap().to_ascii_lowercase()}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(disabled, json!({"enabled":false}));
    let status: Value = server.get("/v1/auth/totp", Some(&owner)).await;
    assert_eq!(status, disabled);
    let revoked = server
        .request(Method::GET, "/v1/auth/me", Some(other_session))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let bob = server.login("bob", ACCOUNT_PASSWORD).await;
    let bob_status: Value = server.get("/v1/auth/totp", Some(&bob)).await;
    assert_eq!(bob_status, json!({"enabled":false}));
}

#[cfg(all(feature = "ntfy", feature = "email"))]
mod outbound_proxy {
    use super::*;
    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, Uri, header};
    use axum::routing::post;
    use base64::Engine as _;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    const DESTINATION: &str = "http://127.0.0.1:1";
    const USERNAME: &str = "fixture-proxy-user@corp";
    const PASSWORD: &str = "fixture-proxy-pass%40:蓝";

    struct Mock {
        auth: Option<String>,
        hits: AtomicUsize,
    }

    async fn proxy_request(
        State(mock): State<Arc<Mock>>,
        uri: Uri,
        headers: HeaderMap,
    ) -> (StatusCode, axum::Json<Value>) {
        let authorization = headers
            .get(header::PROXY_AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        if authorization != mock.auth.as_deref() {
            return (
                StatusCode::PROXY_AUTHENTICATION_REQUIRED,
                axum::Json(json!({})),
            );
        }
        if uri.to_string() != format!("{DESTINATION}/") {
            return (StatusCode::BAD_REQUEST, axum::Json(json!({})));
        }
        mock.hits.fetch_add(1, Ordering::SeqCst);
        (
            StatusCode::OK,
            axum::Json(json!({"event":"message","id":"fixture"})),
        )
    }

    async fn start_proxy(auth: Option<String>) -> (String, Arc<Mock>, JoinHandle<()>) {
        let mock = Arc::new(Mock {
            auth,
            hits: AtomicUsize::new(0),
        });
        let router = Router::new()
            .route("/", post(proxy_request))
            .with_state(mock.clone());
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (origin, mock, task)
    }

    #[tokio::test]
    async fn reusable_profiles_drive_delivery_and_preserve_inline_fallback() {
        let credentials =
            base64::engine::general_purpose::STANDARD.encode(format!("{USERNAME}:{PASSWORD}"));
        let (first_url, first_mock, first_task) =
            start_proxy(Some(format!("Basic {credentials}"))).await;
        let (fallback_url, fallback_mock, fallback_task) = start_proxy(None).await;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("proxy-test.sqlite3");
        let admin = Some(BOOTSTRAP_KEY);
        let server = Server::start(&path);
        let _: Value = server
            .json(
                Method::POST,
                "/v1/users",
                admin,
                json!({"username":"proxy-viewer","password":ACCOUNT_PASSWORD}),
                StatusCode::CREATED,
            )
            .await;
        let viewer = server.login("proxy-viewer", ACCOUNT_PASSWORD).await;
        let forbidden = server
            .request(Method::GET, "/v1/proxies", Some(&viewer))
            .send()
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let _: Value = server
            .json(
                Method::POST,
                "/v1/proxies",
                admin,
                json!({"name":"incomplete","url":first_url,"username":USERNAME}),
                StatusCode::BAD_REQUEST,
            )
            .await;
        let _: Value = server
            .json(
                Method::POST,
                "/v1/proxies",
                admin,
                json!({"name":"invalid","url":"socks5://127.0.0.1:4567"}),
                StatusCode::BAD_REQUEST,
            )
            .await;
        let profile: Value = server
            .json(
                Method::POST,
                "/v1/proxies",
                admin,
                json!({"name":"Primary","url":first_url,"username":USERNAME,"password":PASSWORD}),
                StatusCode::CREATED,
            )
            .await;
        let proxy_id = json_string(&profile, "id");
        assert_eq!(
            profile,
            json!({"id":proxy_id,"name":"Primary","url":first_url,"authenticated":true})
        );
        let proxy_path = format!("/v1/proxies/{proxy_id}");
        let detail: Value = server.get(&proxy_path, admin).await;
        assert_eq!(detail, profile);
        let forbidden = server
            .request(Method::GET, &proxy_path, Some(&viewer))
            .send()
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        for database in [path.clone(), path.with_file_name("proxy-test.sqlite3-wal")] {
            let bytes = std::fs::read(database).unwrap();
            for secret in [b"fixture-proxy-user".as_slice(), b"fixture-proxy-pass"] {
                assert!(!bytes.windows(secret.len()).any(|window| window == secret));
            }
        }
        let _: Value = server
            .json(
                Method::POST,
                "/v1/accounts",
                admin,
                json!({"name":"SMTP","channel":"email","proxy_id":proxy_id,"config":{}}),
                StatusCode::BAD_REQUEST,
            )
            .await;
        let account: Value = server
            .json(
                Method::POST,
                "/v1/accounts",
                admin,
                json!({"name":"Test ntfy","channel":"ntfy","proxy_id":proxy_id,
                "config":{"server_url":DESTINATION,"topic":"probe","proxy":fallback_url}}),
                StatusCode::CREATED,
            )
            .await;
        assert_eq!(account["proxy_id"], proxy_id);
        let account_id = json_string(&account, "id");
        let account_path = format!("/v1/accounts/{account_id}");
        let test_path = format!("{account_path}/test");
        let test_body = json!({"body":"Check outbound proxy"});
        let blocked: Value = server
            .json(
                Method::POST,
                &test_path,
                admin,
                test_body.clone(),
                StatusCode::UNPROCESSABLE_ENTITY,
            )
            .await;
        assert_eq!(
            blocked["details"]["provider_code"],
            "outbound_proxy_blocked"
        );
        assert_eq!(first_mock.hits.load(Ordering::SeqCst), 0);

        drop(server);
        let server = Server::with_outbound_hosts(&path, "127.0.0.1");
        let _: Value = server
            .json(
                Method::POST,
                &test_path,
                admin,
                test_body.clone(),
                StatusCode::OK,
            )
            .await;
        assert_eq!(first_mock.hits.load(Ordering::SeqCst), 1);
        assert_eq!(fallback_mock.hits.load(Ordering::SeqCst), 0);
        let in_use = server
            .request(Method::DELETE, &proxy_path, admin)
            .send()
            .await
            .unwrap();
        let error: Value = checked_json(in_use, StatusCode::CONFLICT).await;
        assert_eq!(error["code"], "proxy_in_use");

        let renamed: Value = server
            .json(
                Method::PUT,
                &proxy_path,
                admin,
                json!({"name":"Renamed"}),
                StatusCode::OK,
            )
            .await;
        assert_eq!(
            renamed,
            json!({"id":proxy_id,"name":"Renamed","url":first_url,"authenticated":true})
        );
        let updated_account: Value = server
            .json(
                Method::PUT,
                &account_path,
                admin,
                json!({"config":{"server_url":DESTINATION,"topic":"changed"}}),
                StatusCode::OK,
            )
            .await;
        assert_eq!(updated_account["proxy_id"], proxy_id);
        let receipt: Value = server.json(Method::POST, "/v1/send?wait=true", admin,
            json!({"title":"Via worker","body":"fixture","channels":[{"account_id":account_id}]}),
            StatusCode::OK).await;
        assert_eq!(receipt["status"], "success");
        assert_eq!(first_mock.hits.load(Ordering::SeqCst), 2);

        let replacement: Value = server
            .json(
                Method::PUT,
                &proxy_path,
                admin,
                json!({"name":"Renamed","url":fallback_url}),
                StatusCode::OK,
            )
            .await;
        assert_eq!(
            replacement,
            json!({"id":proxy_id,"name":"Renamed","url":fallback_url,"authenticated":false})
        );
        let _: Value = server
            .json(
                Method::POST,
                &test_path,
                admin,
                test_body.clone(),
                StatusCode::OK,
            )
            .await;
        assert_eq!(fallback_mock.hits.load(Ordering::SeqCst), 1);
        let detached: Value = server
            .json(
                Method::PUT,
                &account_path,
                admin,
                json!({"proxy_id":null}),
                StatusCode::OK,
            )
            .await;
        assert!(detached["proxy_id"].is_null());
        let _: Value = server
            .json(
                Method::POST,
                &test_path,
                admin,
                test_body.clone(),
                StatusCode::OK,
            )
            .await;
        assert_eq!(fallback_mock.hits.load(Ordering::SeqCst), 2);

        // A credential edit keeps the old inline proxy without disclosing it to the UI.
        let _: Value = server.json(Method::PUT, &account_path, admin,
            json!({"inline_proxy":"keep","config":{"server_url":DESTINATION,"topic":"updated"}}),
            StatusCode::OK).await;
        let _: Value = server
            .json(
                Method::POST,
                &test_path,
                admin,
                test_body.clone(),
                StatusCode::OK,
            )
            .await;
        assert_eq!(fallback_mock.hits.load(Ordering::SeqCst), 3);

        // Explicitly choosing Direct removes both the reference and the encrypted fallback.
        let _: Value = server
            .json(
                Method::PUT,
                &account_path,
                admin,
                json!({"inline_proxy":"clear","proxy_id":null}),
                StatusCode::OK,
            )
            .await;
        let result = server
            .request(Method::POST, &test_path, admin)
            .json(&test_body)
            .send()
            .await
            .unwrap();
        assert!(!result.status().is_success());
        assert_eq!(fallback_mock.hits.load(Ordering::SeqCst), 3);

        let list: Value = server.get("/v1/proxies?limit=1", admin).await;
        assert_eq!(list["items"], json!([replacement]));
        let deleted = server
            .request(Method::DELETE, &proxy_path, admin)
            .send()
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        first_task.abort();
        fallback_task.abort();
    }
}

#[tokio::test]
async fn personal_profile_requires_a_session_and_persists_independently_of_login() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    const PROFILE: &str = "/v1/auth/profile";
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("anser.sqlite3");
    let server = Server::start(&database);
    let info: Value = server.get("/v1/info", None).await;
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));

    let forbidden: Value = server
        .json(
            Method::PUT,
            PROFILE,
            Some(BOOTSTRAP_KEY),
            json!({"nickname":"No"}),
            StatusCode::FORBIDDEN,
        )
        .await;
    assert_eq!(forbidden["code"], "forbidden");
    let _: Value = server
        .json(
            Method::POST,
            "/v1/users",
            Some(BOOTSTRAP_KEY),
            json!({"username":"reader","password":ACCOUNT_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    let reader = server.login("reader", ACCOUNT_PASSWORD).await;
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let avatar = format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded.into_inner())
    );
    let saved: Value = server
        .json(
            Method::PUT,
            PROFILE,
            Some(&reader),
            json!({"nickname":"  雁友  ","avatar":avatar}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(saved["nickname"], "雁友");
    assert!(json_string(&saved, "avatar").starts_with("data:image/png;base64,"));

    for avatar in [
        "https://example.org/portrait.jpg",
        "data:image/svg+xml;base64,PHN2Zy8+",
        "data:image/png;base64,aGVsbG8=",
    ] {
        let error: Value = server
            .json(
                Method::PUT,
                PROFILE,
                Some(&reader),
                json!({"nickname":"Overwrite","avatar":avatar}),
                StatusCode::BAD_REQUEST,
            )
            .await;
        assert_eq!(error["code"], "invalid_avatar");
    }
    let admin = server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    assert_eq!(
        server.get::<Value>(PROFILE, Some(&admin)).await,
        json!({"nickname":null,"avatar":null})
    );
    drop(server);

    let server = Server::start(&database);
    let other_session = server.login("reader", ACCOUNT_PASSWORD).await;
    let response = server
        .request(Method::GET, PROFILE, Some(&other_session))
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(checked_json::<Value>(response, StatusCode::OK).await, saved);
    let cleared: Value = server
        .json(
            Method::PUT,
            PROFILE,
            Some(&other_session),
            json!({"nickname":null,"avatar":null}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(cleared, json!({"nickname":null,"avatar":null}));
}

#[cfg(all(
    feature = "chanify",
    feature = "dingtalk",
    feature = "discord",
    feature = "gotify",
    feature = "ifttt",
    feature = "qqbot",
    feature = "slack"
))]
#[tokio::test]
async fn new_channel_schemas_are_discoverable_and_accept_the_packaged_examples() {
    let temp = tempfile::tempdir().unwrap();
    let server = Server::start(&temp.path().join("anser.sqlite3"));
    let channels: Value = server.get("/v1/channels", Some(BOOTSTRAP_KEY)).await;
    let channels = channels["items"].as_array().unwrap();

    for (id, config, secret) in [
        (
            "chanify",
            include_str!("../../../anser-plugins/chanify/example.json"),
            "token",
        ),
        (
            "dingtalk",
            include_str!("../../../anser-plugins/dingtalk/example.json"),
            "webhook",
        ),
        (
            "discord",
            include_str!("../../../anser-plugins/discord/example.json"),
            "webhook",
        ),
        (
            "gotify",
            include_str!("../../../anser-plugins/gotify/example.json"),
            "app_token",
        ),
        (
            "ifttt",
            include_str!("../../../anser-plugins/ifttt/example.json"),
            "webhook_key",
        ),
        (
            "qqbot",
            include_str!("../../../anser-plugins/qqbot/example.json"),
            "app_secret",
        ),
        (
            "slack",
            include_str!("../../../anser-plugins/slack/example.json"),
            "bot_token",
        ),
    ] {
        let channel = channels
            .iter()
            .find(|channel| channel["id"] == id)
            .unwrap_or_else(|| panic!("missing {id}"));
        assert_eq!(channel["available"], true, "{id}");
        assert_eq!(
            channel["config_schema"]["properties"][secret]["writeOnly"], true,
            "{id}"
        );
        let config: Value = serde_json::from_str(config).unwrap();
        let account: Value = server
            .json(
                Method::POST,
                "/v1/accounts",
                Some(BOOTSTRAP_KEY),
                json!({"channel":id,"name":format!("my-{id}"),"config":config}),
                StatusCode::CREATED,
            )
            .await;
        assert_eq!(account["channel"], id);
        assert!(
            !account.to_string().contains(json_string(&config, secret)),
            "{id}"
        );
    }
}

#[tokio::test]
async fn templates_render_once_in_the_queue_and_respect_visibility() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("anser.sqlite3");
    let server = Server::start(&database);
    let mut sessions = Vec::new();
    for user in ["template-owner", "template-reader"] {
        let _: Value = server
            .json(
                Method::POST,
                "/v1/users",
                Some(BOOTSTRAP_KEY),
                json!({"username":user,"password":ACCOUNT_PASSWORD}),
                StatusCode::CREATED,
            )
            .await;
        sessions.push(server.login(user, ACCOUNT_PASSWORD).await);
    }
    let owner = sessions[0].as_str();
    let reader = sessions[1].as_str();
    let issued: Value = server
        .json(
            Method::POST,
            "/v1/api-keys",
            Some(BOOTSTRAP_KEY),
            json!({"name":"template-integration","scopes":["send"]}),
            StatusCode::CREATED,
        )
        .await;
    let send_key = json_string(&issued, "token");
    let _: Value = server
        .json(
            Method::POST,
            "/v1/topics",
            Some(BOOTSTRAP_KEY),
            json!({"name":"template-tests","password":TOPIC_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    let _: Value = server
        .json(
            Method::POST,
            "/v1/topics/template-tests/subscriptions",
            Some(reader),
            json!({"subscriber_ref":"reader","password":TOPIC_PASSWORD}),
            StatusCode::CREATED,
        )
        .await;
    let shared = json!({"name":"alert","title":"Shared {{service}}","body":"{{status}}","format":"text","shared":true});
    let shared_template: Value = server
        .json(
            Method::POST,
            "/v1/templates",
            Some(BOOTSTRAP_KEY),
            shared.clone(),
            StatusCode::CREATED,
        )
        .await;
    let shared_id = json_string(&shared_template, "id");
    let private =
        json!({"name":"alert","title":"Private {{service}}","body":"{{status}}","format":"text"});
    let private_template: Value = server
        .json(
            Method::POST,
            "/v1/templates",
            Some(owner),
            private,
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(private_template["variables"], json!(["service", "status"]));
    assert_eq!(private_template["can_edit"], true);
    let private_id = json_string(&private_template, "id");
    let private_path = format!("/v1/templates/{private_id}");
    assert_ne!(shared_id, private_id);
    for token in [reader, send_key, BOOTSTRAP_KEY] {
        let unavailable: Value = checked_json(
            server
                .request(Method::GET, &private_path, Some(token))
                .send()
                .await
                .unwrap(),
            StatusCode::NOT_FOUND,
        )
        .await;
        assert_eq!(unavailable["code"], "template_not_found");
    }
    let forbidden: Value = server
        .json(
            Method::POST,
            "/v1/templates",
            Some(owner),
            shared,
            StatusCode::FORBIDDEN,
        )
        .await;
    assert_eq!(forbidden["code"], "forbidden");
    assert_eq!(
        server
            .request(
                Method::DELETE,
                "/v1/templates/builtin.deployment",
                Some(BOOTSTRAP_KEY)
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let catalog: Value = server.get("/v1/templates", Some(send_key)).await;
    let catalog = catalog["items"].as_array().unwrap();
    assert!(
        catalog
            .iter()
            .any(|item| item["id"] == "builtin.deployment" && item["builtin"] == true)
    );
    assert!(
        catalog
            .iter()
            .any(|item| item["id"] == shared_id && item["can_edit"] == false)
    );
    assert!(catalog.iter().all(|item| item["id"] != private_id));

    let publish_path = "/v1/topics/template-tests/publish";
    let mut request = json!({"template_name":"alert","variables":{"service":"雁字","status":"Ready"},"tags":["release"],"topic_password":TOPIC_PASSWORD});
    let send = |token, resource: &Value| {
        server
            .request(Method::POST, publish_path, Some(token))
            .header("Idempotency-Key", "fixture-template")
            .json(resource)
    };
    let receipt: Value = checked_json(
        send(owner, &request).send().await.unwrap(),
        StatusCode::ACCEPTED,
    )
    .await;
    let message_path = format!("/v1/messages/{}", json_string(&receipt, "message_id"));
    assert_eq!(receipt["status"], "success");
    let readback: Value = server.get(&message_path, Some(owner)).await;
    assert_eq!(readback["message"]["title"], "Private 雁字");
    assert_eq!(readback["message"]["body"], "Ready");
    assert_eq!(readback["message"]["tags"], json!(["release"]));
    let inbox: Value = server.get("/v1/inbox", Some(reader)).await;
    assert_eq!(inbox["items"][0]["title"], "Private 雁字");

    let corrected: Value = server
        .json(
            Method::PUT,
            &private_path,
            Some(owner),
            json!({"name":"renamed","title":"{{changed}}","format":"text"}),
            StatusCode::OK,
        )
        .await;
    assert_eq!(corrected["variables"], json!(["changed"]));
    assert_eq!(
        server
            .request(Method::DELETE, &private_path, Some(owner))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let repeated: Value = checked_json(
        send(owner, &request).send().await.unwrap(),
        StatusCode::ACCEPTED,
    )
    .await;
    assert_eq!(receipt["message_id"], repeated["message_id"]);
    assert_eq!(
        server.get::<Value>(&message_path, Some(owner)).await["message"],
        readback["message"]
    );

    request["template_id"] = json!(private_id);
    request.as_object_mut().unwrap().remove("template_name");
    let unavailable: Value = server
        .json(
            Method::POST,
            publish_path,
            Some(send_key),
            request.clone(),
            StatusCode::NOT_FOUND,
        )
        .await;
    assert_eq!(unavailable["code"], "template_not_found");
    request["template_id"] = json!(shared_id);
    let shared_receipt: Value = checked_json(
        send(send_key, &request).send().await.unwrap(),
        StatusCode::ACCEPTED,
    )
    .await;
    let shared_message: Value = server
        .get(
            &format!(
                "/v1/messages/{}",
                json_string(&shared_receipt, "message_id")
            ),
            Some(send_key),
        )
        .await;
    assert_eq!(shared_message["message"]["title"], "Shared 雁字");

    let invalid: Value = server
        .json(
            Method::POST,
            publish_path,
            Some(send_key),
            json!({"template_name":"alert","variables":{"unrecognized":"value"},"topic_password":TOPIC_PASSWORD}),
            StatusCode::BAD_REQUEST,
        )
        .await;
    assert_eq!(invalid["code"], "invalid_template_variables");
    let direct: Value = server
        .json(
            Method::POST,
            "/v1/send",
            Some(send_key),
            json!({"template_name":"builtin.deployment","variables":{"service":"app","version":"1.0","environment":"test"}}),
            StatusCode::UNPROCESSABLE_ENTITY,
        )
        .await;
    assert_eq!(direct["code"], "no_available_targets");
    let openapi: Value = server.get("/v1/openapi.json", None).await;
    assert_eq!(
        openapi["paths"]["/v1/templates"]["post"]["requestBody"]["content"]["application/json"]["schema"]
            ["$ref"],
        "#/components/schemas/TemplateInput"
    );
}

#[cfg(all(
    feature = "certificate-expiration",
    feature = "openai-tts",
    feature = "weather-wttr"
))]
#[tokio::test]
async fn installed_plugins_group_typed_actions_and_require_global_admin_to_run() {
    let temp = tempfile::tempdir().unwrap();
    let server = Server::start(&temp.path().join("anser.sqlite3"));
    let admin = server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let private_key: Value = server
        .json(
            Method::POST,
            "/v1/api-keys",
            Some(&admin),
            json!({"name":"test-sender","scopes":["send"]}),
            StatusCode::CREATED,
        )
        .await;
    let sender = json_string(&private_key, "token");
    let inventory: Value = server.get("/v1/plugins", Some(sender)).await;
    let installed = inventory["items"].as_array().unwrap();
    for (kind, expected) in [
        ("task", "certificate-expiration"),
        ("task", "wttr-weather"),
        ("content_transform", "openai-tts"),
    ] {
        assert!(installed.iter().any(|plugin| {
            plugin["id"] == expected
                && plugin["kind"] == kind
                && plugin["available"] == true
                && plugin["version"] == "0.1.0"
        }));
    }

    let path = "/v1/plugins/task/wttr-weather/run";
    let denied: Value = server
        .json(
            Method::POST,
            path,
            Some(sender),
            json!({"config": {"location": "Paris"}}),
            StatusCode::FORBIDDEN,
        )
        .await;
    assert_eq!(denied["code"], "forbidden");
    let invalid: Value = server
        .json(
            Method::POST,
            path,
            Some(&admin),
            json!({"config": {"location": "Paris"}, "input": {"unexpected": true}}),
            StatusCode::UNPROCESSABLE_ENTITY,
        )
        .await;
    assert_eq!(invalid["code"], "plugin_error");
    assert_eq!(invalid["details"]["provider_code"], "weather_input");
    let mismatch: Value = server
        .json(
            Method::POST,
            "/v1/plugins/content_transform/wttr-weather/run",
            Some(&admin),
            json!({"config": {}, "message": {"body": "Hello."}}),
            StatusCode::NOT_FOUND,
        )
        .await;
    assert_eq!(mismatch["code"], "not_found");
}

#[cfg(feature = "weather-wttr")]
#[tokio::test]
async fn schedule_api_accepts_legacy_and_weekly_rules_and_finishes_a_due_one_time_task() {
    use anser_core::schedule::Rule;
    use anser_store::now_ms;

    const SCHEDULES: &str = "/v1/schedules";
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("anser.sqlite3");
    let server = Server::start(&path);
    let admin = server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let create = |timing: Value| {
        // An invalid location makes execution deterministic without an external provider.
        let mut request =
            json!({"name":"Weather","plugin_id":"wttr-weather","config":{"location":""}});
        request
            .as_object_mut()
            .unwrap()
            .extend(timing.as_object().unwrap().clone());
        request
    };

    let legacy: Value = server
        .json(
            Method::POST,
            SCHEDULES,
            Some(&admin),
            create(json!({"interval_minutes":120})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(legacy["interval_minutes"], 120);
    assert_eq!(legacy["rule"], json!({"kind":"interval","minutes":120}));

    let rule = json!({"kind":"weekly","weekdays":[1,7],"time":"08:30","time_zone":"Asia/Shanghai"});
    let weekly: Value = server
        .json(
            Method::POST,
            SCHEDULES,
            Some(&admin),
            create(json!({"rule":rule})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(weekly["rule"], rule);
    assert!(weekly["interval_minutes"].is_null());
    let weekly_path = format!("{SCHEDULES}/{}/run", json_string(&weekly, "id"));
    let queued: Value = server
        .json(
            Method::POST,
            &weekly_path,
            Some(&admin),
            Value::Null,
            StatusCode::ACCEPTED,
        )
        .await;
    assert_eq!(queued["queued"], true);

    for timing in [
        json!({"rule":{"kind":"weekly","weekdays":[8],"time":"08:30","time_zone":"UTC"}}),
        json!({"rule":{"kind":"weekly","weekdays":[1],"time":"08:30","time_zone":"unknown"}}),
        json!({"rule":{"kind":"once","at":now_ms()-1000}}),
        json!({"rule":rule,"start_at":now_ms()}),
        json!({"rule":rule,"interval_minutes":120}),
    ] {
        let error: Value = server
            .json(
                Method::POST,
                SCHEDULES,
                Some(&admin),
                create(timing),
                StatusCode::BAD_REQUEST,
            )
            .await;
        assert_eq!(error["code"], "invalid_request");
    }

    let at = now_ms() + 2_500;
    let once: Value = server
        .json(
            Method::POST,
            SCHEDULES,
            Some(&admin),
            create(json!({"rule":{"kind":"once","at":at}})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(once["next_at"], at);
    assert_eq!(once["completed"], false);
    let id = json_string(&once, "id");

    let finished = tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let schedules: Value = server.get(SCHEDULES, Some(&admin)).await;
            let items = schedules["items"].as_array().unwrap();
            let item = items.iter().find(|item| item["id"] == id).unwrap();
            if item["completed"] == true {
                let weekly = items.iter().find(|item| item["rule"] == rule).unwrap();
                let cadence: Rule = serde_json::from_value(rule.clone()).unwrap();
                let last = weekly["last_at"].as_i64().unwrap();
                assert_eq!(weekly["next_at"].as_i64(), cadence.next_after(last));
                break item.clone();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(finished["last_at"].as_i64().unwrap() >= at);
    assert_eq!(finished["last_status"], "plugin_error");
    assert_eq!(finished["enabled"], false);
    assert!(finished["next_at"].is_null());

    drop(server);
    let restarted = Server::start(&path);
    let admin = restarted.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let error: Value = restarted
        .json(
            Method::POST,
            &format!("{SCHEDULES}/{id}/run"),
            Some(&admin),
            Value::Null,
            StatusCode::NOT_FOUND,
        )
        .await;
    assert_eq!(error["code"], "not_found");
    let schedules: Value = restarted.get(SCHEDULES, Some(&admin)).await;
    assert!(schedules["items"].as_array().unwrap().contains(&finished));
}

#[tokio::test]
async fn speech_delivery_reuses_audio_for_inbox_and_topic_links() {
    use axum::Router;
    use axum::routing::post;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;

    let provider_calls = Arc::new(AtomicUsize::new(0));
    let count = provider_calls.clone();
    let provider = Router::new().route(
        "/v1/audio/speech",
        post(
            move |headers: axum::http::HeaderMap, axum::Json(input): axum::Json<Value>| {
                let count = count.clone();
                async move {
                    assert_eq!(headers["authorization"], "Bearer fixture-provider");
                    assert_eq!(input["response_format"], "mp3");
                    count.fetch_add(1, Ordering::SeqCst);
                    ([("content-type", "audio/mpeg")], "ID3fixture-mp3")
                }
            },
        ),
    );
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let provider_url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });

    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("speech.sqlite");
    let server = Server::with_environment(
        &database,
        "",
        &[("ANSER_PUBLIC_URL", "https://notify.example.test")],
    );
    let admin = server.login(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD).await;
    let _: Value = server
        .json(
            Method::POST,
            "/v1/users",
            Some(&admin),
            json!({"username":"alice","password":ACCOUNT_PASSWORD,"admin":false}),
            StatusCode::CREATED,
        )
        .await;
    let alice = server.login("alice", ACCOUNT_PASSWORD).await;
    let payload = json!({
        "config":{"server_url":provider_url,"api_key":"fixture-provider","model":"tts-1","voice":"alloy","response_format":"wav"},
        "message":{"title":"Hello","body":"Your build is ready."},
        "destination":{"kind":"inbox","username":"alice"}
    });
    let denied = server
        .request(Method::POST, "/v1/speech/send", Some(&alice))
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let send = |payload: Value, key: &str| {
        server
            .request(Method::POST, "/v1/speech/send", Some(&admin))
            .header("Idempotency-Key", key)
            .json(&payload)
    };
    let first: Value = checked_json(
        send(payload.clone(), "voice-42").send().await.unwrap(),
        StatusCode::CREATED,
    )
    .await;
    let second: Value = checked_json(
        send(payload.clone(), "voice-42").send().await.unwrap(),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(first, second);
    assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
    let admin_items: Value = server.get("/v1/inbox", Some(&admin)).await;
    assert_eq!(admin_items["items"].as_array().unwrap().len(), 0);
    let inbox: Value = server.get("/v1/inbox", Some(&alice)).await;
    assert_eq!(inbox["items"].as_array().unwrap().len(), 1);
    assert_eq!(inbox["items"][0]["body"], "Your build is ready.");
    let audio_path = inbox["items"][0]["audio_path"].as_str().unwrap().to_owned();
    let audio = server
        .request(Method::GET, &audio_path, None)
        .header("Range", "bytes=0-2")
        .send()
        .await
        .unwrap();
    assert_eq!(audio.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(audio.headers()["content-type"], "audio/mpeg");
    assert!(
        audio.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store")
    );
    assert_eq!(audio.bytes().await.unwrap(), "ID3");

    let _: Value = server
        .json(
            Method::POST,
            "/v1/topics",
            Some(&admin),
            json!({"name":"speech"}),
            StatusCode::CREATED,
        )
        .await;
    let _: Value = server
        .json(
            Method::POST,
            "/v1/topics/speech/subscriptions",
            Some(&alice),
            json!({"subscriber_ref":"alice"}),
            StatusCode::CREATED,
        )
        .await;
    let mut announcement = payload;
    announcement["destination"] = json!({"kind":"topic","name":"speech"});
    let published: Value = checked_json(
        send(announcement, "voice-43").send().await.unwrap(),
        StatusCode::ACCEPTED,
    )
    .await;
    let detail: Value = server
        .get(
            &format!("/v1/messages/{}", published["message_id"].as_str().unwrap()),
            Some(&admin),
        )
        .await;
    assert!(
        detail["message"]["body"]
            .as_str()
            .unwrap()
            .starts_with("https://notify.example.test/v1/speech/audio/")
    );
    let inbox: Value = server.get("/v1/inbox", Some(&alice)).await;
    assert_eq!(inbox["items"].as_array().unwrap().len(), 2);
    let path = inbox["items"][1]["audio_path"].as_str().unwrap();
    assert_eq!(
        detail["message"]["url"],
        format!("https://notify.example.test{path}")
    );
    assert_ne!(path, audio_path);
    assert_eq!(provider_calls.load(Ordering::SeqCst), 2);
    drop(server);

    let restarted = Server::start(&database);
    let audio = restarted
        .request(Method::GET, &audio_path, None)
        .send()
        .await
        .unwrap();
    assert_eq!(audio.status(), StatusCode::OK);
    assert_eq!(audio.bytes().await.unwrap(), "ID3fixture-mp3");
    task.abort();
}
