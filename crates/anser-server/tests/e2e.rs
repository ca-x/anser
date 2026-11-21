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
        let mut child = Command::new(env!("CARGO_BIN_EXE_anser"))
            .args(["serve", "--bind", "127.0.0.1:0", "--workers", "1"])
            .arg("--database")
            .arg(database)
            .env_clear()
            .env("ANSER_BOOTSTRAP_USERNAME", BOOTSTRAP_USER)
            .env("ANSER_BOOTSTRAP_PASSWORD", BOOTSTRAP_PASSWORD)
            .env("ANSER_BOOTSTRAP_API_KEY", BOOTSTRAP_KEY)
            .env("ANSER_ALLOW_PRIVATE_NETWORK", "1")
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
            json!({"title":"Maintenance", "body":"Service restored", "tags":["maintenance"]}),
            StatusCode::ACCEPTED,
        )
        .await;
    assert_eq!(receipt["status"], "success");
    let mut inbox_ids = Vec::new();
    for token in [alice, bob] {
        let inbox: Value = server.get("/v1/inbox", Some(token)).await;
        let items = inbox["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item["topic"], "private-alerts");
        assert_eq!(item["title"], "Maintenance");
        assert_eq!(item["body"], "Service restored");
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
