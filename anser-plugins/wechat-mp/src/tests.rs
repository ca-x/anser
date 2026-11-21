use super::*;
use anser_channel_http::mock::serve_sequence;

#[tokio::test]
async fn mock_wechat_refreshes_rejected_token_and_keeps_new_token() {
    let (url, requests) = serve_sequence(&[
        (
            "200 OK",
            "",
            r#"{"access_token":"first","expires_in":7200}"#,
        ),
        ("200 OK", "", r#"{"errcode":42001,"errmsg":"secret error"}"#),
        (
            "200 OK",
            "",
            r#"{"access_token":"second","expires_in":7200}"#,
        ),
        ("200 OK", "", r#"{"errcode":0,"msgid":7}"#),
        ("200 OK", "", r#"{"errcode":0,"msgid":8}"#),
    ])
    .await;
    let plugin = WechatMp::default();
    let config = Config::parse(&json!({
        "appid":"wx_demo","secret":"test secret","template_id":"template","openid":"open_demo",
        "title_field":"thing1","body_field":"thing2"
    }))
    .unwrap();
    let message = Message {
        title: "Event".into(),
        body: "**OK**".into(),
        format: MessageFormat::Markdown,
        ..Message::default()
    };
    let policy = NetworkPolicy::new(true, vec![]);
    for _ in 0..2 {
        assert_eq!(
            plugin
                .send_at(&config, &message, url.as_str(), Some(&policy))
                .await
                .unwrap(),
            SendOutcome::Delivered
        );
    }
    let requests = requests.await.unwrap();
    assert!(requests[0].headers.contains("GET /cgi-bin/token?"));
    assert!(requests[0].headers.contains("secret=test+secret"));
    assert!(requests[1].headers.contains("access_token=first"));
    assert!(requests[2].headers.contains("GET /cgi-bin/token?"));
    assert!(requests[3].headers.contains("access_token=second"));
    assert!(requests[4].headers.contains("access_token=second"));
    let body: Value = serde_json::from_slice(&requests[4].body).unwrap();
    assert_eq!(
        body,
        json!({"touser":"open_demo","template_id":"template","data":{"thing1":{"value":"Event"},"thing2":{"value":"OK"}}})
    );
}

#[test]
fn rejects_unsafe_urls_and_invalid_template_data() {
    let config = Config::parse(&json!({
        "appid":"demo","secret":"secret","template_id":"template","openid":"open"
    }))
    .unwrap();
    let mut message = Message {
        title: "Event".into(),
        url: Some("javascript:alert(1)".into()),
        ..Message::default()
    };
    assert!(!template_payload(&config, &message).unwrap_err().retryable);
    message.url = None;
    message.extras = json!({"wechat_mp_data":{"thing1":{"value":"ok","color":"#äaaaa"}}});
    assert!(template_payload(&config, &message).is_err());
    assert!(delivery_result(45009).unwrap_err().retryable);
    assert!(!delivery_result(40003).unwrap_err().retryable);
}
