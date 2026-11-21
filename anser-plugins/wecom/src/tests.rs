use super::*;
use anser_channel_http::mock::serve_sequence;

fn account() -> Config {
    Config::parse(&json!({"corpid":"corp-demo","agentid":1000002,"secret":"fixture"})).unwrap()
}

#[tokio::test]
async fn mock_wecom_uploads_image_and_acknowledges_duplicate_check() {
    let (url, requests) = serve_sequence(&[
        (
            "200 OK",
            "",
            r#"{"errcode":0,"access_token":"mock","expires_in":7200}"#,
        ),
        (
            "200 OK",
            "",
            r#"{"errcode":0,"media_id":"image-1","type":"image"}"#,
        ),
        ("200 OK", "", r#"{"errcode":0,"errmsg":"ok"}"#),
    ])
    .await;
    let plugin = Wecom::default();
    let image = STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture");
    let message = Message {
        extras: json!({"wecom_image":{"base64":image,"filename":"ready.png"}}),
        ..Message::default()
    };
    let policy = NetworkPolicy::new(true, vec![]);
    assert_eq!(
        plugin
            .send_at(&account(), &message, url.as_str(), Some(&policy))
            .await
            .unwrap(),
        SendOutcome::Delivered
    );
    let requests = requests.await.unwrap();
    assert!(requests[0].headers.contains("GET /cgi-bin/gettoken?"));
    assert!(
        requests[1]
            .headers
            .contains("POST /cgi-bin/media/upload?access_token=mock&type=image ")
    );
    assert!(
        requests[1]
            .headers
            .contains("content-type: multipart/form-data")
    );
    assert!(requests[1].body.windows(9).any(|part| part == b"ready.png"));
    let payload: Value = serde_json::from_slice(&requests[2].body).unwrap();
    assert_eq!(
        payload,
        json!({
            "touser":"@all","agentid":1000002,"msgtype":"image","image":{"media_id":"image-1"},
            "enable_duplicate_check":1,"duplicate_check_interval":600
        })
    );
}

#[tokio::test]
async fn mock_wecom_classifies_trusted_ip_error_without_leaking_response() {
    let (url, requests) = serve_sequence(&[
        (
            "200 OK",
            "",
            r#"{"errcode":0,"access_token":"mock","expires_in":7200}"#,
        ),
        (
            "200 OK",
            "",
            r#"{"errcode":60020,"errmsg":"not trusted ip: 198.51.100.20"}"#,
        ),
    ])
    .await;
    let plugin = Wecom::default();
    let message = Message {
        title: "Anser".into(),
        body: "**test**".into(),
        format: MessageFormat::Markdown,
        ..Message::default()
    };
    let policy = NetworkPolicy::new(true, vec![]);
    let error = plugin
        .send_at(&account(), &message, url.as_str(), Some(&policy))
        .await
        .unwrap_err();
    assert_eq!(error.code, "wecom_60020");
    assert!(!error.retryable);
    assert!(error.message.contains("trusted-IP"));
    assert!(!error.message.contains("198.51.100.20"));
    let requests = requests.await.unwrap();
    let payload: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(payload["markdown"]["content"], "Anser\n**test**");
}

#[tokio::test]
async fn mock_wecom_downloads_only_one_checked_attachment_before_upload() {
    let (url, requests) = serve_sequence(&[
        ("200 OK", "", "GIF89aimage bytes"),
        (
            "200 OK",
            "",
            r#"{"errcode":0,"access_token":"mock","expires_in":7200}"#,
        ),
        ("200 OK", "", r#"{"errcode":0,"media_id":"image-1"}"#),
        ("200 OK", "", r#"{"errcode":0}"#),
    ])
    .await;
    let message = Message {
        attachments: vec![anser_core::Attachment {
            url: url.join("fixture.gif").unwrap().to_string(),
            name: Some("ready.gif".into()),
            content_type: Some("image/gif".into()),
        }],
        ..Default::default()
    };
    let policy = NetworkPolicy::new(true, vec![]);
    let result = Wecom::default()
        .send_at(&account(), &message, url.as_str(), Some(&policy))
        .await
        .unwrap();
    assert_eq!(result, SendOutcome::Delivered);
    let requests = requests.await.unwrap();
    assert!(requests[0].headers.starts_with("GET /fixture.gif "));
    assert!(requests[2].body.windows(9).any(|part| part == b"ready.gif"));
}
