use super::*;
use anser_channel_http::mock::{serve, serve_sequence};

#[tokio::test]
async fn mock_webhook_receives_signed_card() {
    let (url, request) = serve(
        "200 OK",
        "",
        r#"{"StatusCode":0,"StatusMessage":"success"}"#,
    )
    .await;
    let config = Config::Webhook {
        webhook: url.to_string(),
        signing_secret: Some("fixture".into()),
        proxy: None,
    };
    let message = Message {
        extras: json!({"feishu_card":{"elements":[]}}),
        ..Message::default()
    };
    let policy = NetworkPolicy::new(true, vec![]);
    assert_eq!(
        Feishu::default()
            .send_at(&config, &message, None, Some(&policy))
            .await
            .unwrap(),
        SendOutcome::Delivered
    );
    let request = request.await.unwrap();
    let payload: Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(payload["msg_type"], "interactive");
    assert_eq!(payload["card"], json!({"elements":[]}));
    let timestamp = payload["timestamp"].as_str().unwrap().parse().unwrap();
    assert_eq!(payload["sign"], sign(timestamp, "fixture"));
    assert!(!request.headers.contains("fixture"));
}

#[tokio::test]
async fn mock_application_sends_to_recipient_and_reuses_token() {
    let (url, requests) = serve_sequence(&[
        (
            "200 OK",
            "",
            r#"{"code":0,"tenant_access_token":"mock-token","expire":7200}"#,
        ),
        ("200 OK", "", r#"{"code":0}"#),
        ("200 OK", "", r#"{"code":0}"#),
    ])
    .await;
    let config = Config::parse(&json!({
        "mode":"app","app_id":"demo","app_secret":"fixture","receive_id":"chat-1","receive_id_type":"chat_id"
    })).unwrap();
    let message = Message {
        title: "Anser".into(),
        body: "test".into(),
        ..Message::default()
    };
    let policy = NetworkPolicy::new(true, vec![]);
    let plugin = Feishu::default();
    for _ in 0..2 {
        assert_eq!(
            plugin
                .send_at(&config, &message, Some(url.as_str()), Some(&policy))
                .await
                .unwrap(),
            SendOutcome::Delivered
        );
    }
    let requests = requests.await.unwrap();
    assert!(
        requests[0]
            .headers
            .starts_with("POST /open-apis/auth/v3/tenant_access_token/internal ")
    );
    assert!(
        requests[1]
            .headers
            .starts_with("POST /open-apis/im/v1/messages?receive_id_type=chat_id ")
    );
    assert!(
        requests[2]
            .headers
            .contains("authorization: Bearer mock-token")
    );
    let payload: Value = serde_json::from_slice(&requests[2].body).unwrap();
    assert_eq!(payload["receive_id"], "chat-1");
    let content: Value = serde_json::from_str(payload["content"].as_str().unwrap()).unwrap();
    assert_eq!(content["text"], "Anser\ntest");
}

#[test]
fn signs_known_timestamp_with_feishu_algorithm() {
    assert_eq!(
        sign(1_700_000_000, "secret"),
        "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA="
    );
}
