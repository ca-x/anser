use anser_channel_http::mock;
use serde_json::{Value, json};

use super::*;

const RATE_LIMIT: &str =
    r#"{"code":"slow_down","message":"Try again later","details":{"limit":10}}"#;
const RECEIPT: &str = r#"{"message_id":"fixture-id","status":"pending"}"#;
const SESSION: &str = r#"{"token":"session-fixture","user":{"id":"u1","username":"alice","admin":false,"enabled":true,"created_at":1000}}"#;
const SUBSCRIPTION: &str =
    r#"{"id":"sub1","subscriber_ref":"alice","account_id":null,"filter":[],"created_at":1000}"#;

fn fixture_client(base: &str) -> Client {
    Client::builder(base)
        .unwrap()
        .api_key("fixture-api-key")
        .unwrap()
        .retry(RetryConfig {
            max_retries: 2,
            base_delay: Duration::ZERO,
            max_delay: Duration::ZERO,
        })
        .build()
        .unwrap()
}

fn header<'a>(request: &'a mock::Request, name: &str) -> Option<&'a str> {
    request.headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

#[tokio::test]
async fn retries_a_protected_publish_with_one_idempotency_key() {
    let (mut base, requests) = mock::serve_sequence(&[
        ("429 Too Many Requests", "Retry-After: 0\r\n", RATE_LIMIT),
        ("202 Accepted", "", RECEIPT),
    ])
    .await;
    base.set_path("/proxy/anser/");
    let client = fixture_client(base.as_str());
    let publish = Publish {
        message: Message {
            title: "雁字".into(),
            body: "通知".into(),
            ..Message::default()
        },
        topic_password: Some("topic-pass-fixture".into()),
        ..Publish::default()
    };
    let result = client
        .publish_with_options(
            "status",
            &publish,
            &SendOptions {
                idempotency_key: None,
                wait: true,
                wait_timeout: Some(Duration::from_secs(4)),
            },
        )
        .await
        .unwrap();
    assert_eq!(result.message_id, "fixture-id");
    let requests = requests.await.unwrap();
    assert_eq!(requests.len(), 2);
    let key = header(&requests[0], "idempotency-key").unwrap();
    assert!(uuid::Uuid::parse_str(key).is_ok());
    for request in &requests {
        assert!(
            request.headers.starts_with(
                "POST /proxy/anser/v1/topics/status/publish?wait=true&timeout_ms=4000 "
            )
        );
        assert_eq!(
            header(request, "authorization"),
            Some("Bearer fixture-api-key")
        );
        assert_eq!(header(request, "idempotency-key"), Some(key));
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["topic_password"], "topic-pass-fixture");
        assert_eq!(body["title"], "雁字");
    }
    assert_eq!(requests[0].body, requests[1].body);
}

#[tokio::test]
async fn keeps_path_segments_and_api_errors_typed() {
    let (base, request) = mock::serve(
        "404 Not Found",
        "",
        r#"{"code":"missing_message","message":"Unknown ID","details":{"reason":"message"}}"#,
    )
    .await;
    let error = fixture_client(base.as_str())
        .message("odd/path?value")
        .await
        .unwrap_err();
    let Error::Api(error) = error else {
        panic!("expected an API error")
    };
    assert_eq!(error.status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(error.code, "missing_message");
    assert_eq!(error.message, "Unknown ID");
    assert_eq!(error.details["reason"], "message");
    assert!(
        request
            .await
            .unwrap()
            .headers
            .starts_with("GET /v1/messages/odd%2Fpath%3Fvalue ")
    );
}

#[tokio::test]
async fn serializes_subscription_password_and_does_not_send_it_when_unsubscribing() {
    let (base, requests) = mock::serve_sequence(&[
        ("201 Created", "", SUBSCRIPTION),
        ("204 No Content", "", ""),
    ])
    .await;
    let client = fixture_client(base.as_str());
    let subscription = client
        .subscribe(
            "protected",
            &SubscriptionInput {
                subscriber_ref: "alice".into(),
                account_id: None,
                target: None,
                password: Some("password-fixture".into()),
                filter: Vec::new(),
            },
        )
        .await
        .unwrap();
    client
        .unsubscribe("protected", &subscription.id)
        .await
        .unwrap();
    let requests = requests.await.unwrap();
    let input: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(input["password"], "password-fixture");
    assert!(
        requests[1]
            .headers
            .starts_with("DELETE /v1/topics/protected/subscriptions/sub1 ")
    );
    assert!(requests[1].body.is_empty());
}

#[tokio::test]
async fn login_and_pair_exchange_use_their_public_endpoints_without_forwarding_a_key() {
    let (base, requests) =
        mock::serve_sequence(&[("200 OK", "", SESSION), ("200 OK", "", SESSION)]).await;
    let client = fixture_client(base.as_str());
    let login = client.login("alice", "account-pass-fixture").await.unwrap();
    let pair = client.exchange_pair_code("pair-fixture").await.unwrap();
    assert_eq!(login.token, "session-fixture");
    assert_eq!(pair.user.username, "alice");
    let requests = requests.await.unwrap();
    assert!(requests[0].headers.starts_with("POST /v1/auth/login "));
    assert!(
        requests[1]
            .headers
            .starts_with("POST /v1/auth/pair/exchange ")
    );
    assert!(
        requests
            .iter()
            .all(|request| header(request, "authorization").is_none())
    );
    let login: Value = serde_json::from_slice(&requests[0].body).unwrap();
    let exchange: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(
        login,
        json!({"username":"alice","password":"account-pass-fixture"})
    );
    assert_eq!(exchange, json!({"code":"pair-fixture"}));
}

#[tokio::test]
async fn never_retries_a_one_time_pair_exchange() {
    let (base, request) = mock::serve(
        "503 Service Unavailable",
        "",
        r#"{"code":"later","message":"Try again later"}"#,
    )
    .await;
    let result = fixture_client(base.as_str())
        .exchange_pair_code("pair-fixture")
        .await;
    assert!(
        matches!(result, Err(Error::Api(error)) if error.status == reqwest::StatusCode::SERVICE_UNAVAILABLE)
    );
    request.await.unwrap();
}

#[tokio::test]
async fn does_not_follow_cross_origin_redirects() {
    let (base, request) =
        mock::serve("302 Found", "Location: http://127.0.0.1:9/other\r\n", "").await;
    let result = fixture_client(base.as_str()).message("fixture-id").await;
    assert!(matches!(result, Err(Error::Api(error)) if error.status == reqwest::StatusCode::FOUND));
    assert_eq!(
        header(&request.await.unwrap(), "authorization"),
        Some("Bearer fixture-api-key")
    );
}

#[tokio::test]
async fn reads_inbox_items_and_encodes_cursor() {
    let (base, request) = mock::serve("200 OK", "", r#"{"items":[{"id":42,"from_username":"bob","topic":"alerts","title":"T","body":"B","format":"text","created_at":1000,"read_at":null}],"next_cursor":"43"}"#).await;
    let page = fixture_client(base.as_str())
        .inbox(&PageOptions {
            cursor: Some("opaque/?".into()),
            limit: Some(4),
        })
        .await
        .unwrap();
    assert_eq!(page.items[0].id, 42);
    assert_eq!(page.items[0].from_username.as_deref(), Some("bob"));
    assert_eq!(page.next_cursor.as_deref(), Some("43"));
    let request = request.await.unwrap();
    assert!(
        request
            .headers
            .starts_with("GET /v1/inbox?cursor=opaque%2F%3F&limit=4 ")
    );
}
