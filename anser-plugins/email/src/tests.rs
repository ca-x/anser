use super::*;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[test]
fn rejects_header_injection_and_plaintext_passwords() {
    let mut data = json!({"host":"smtp.example.com", "encryption":"none", "from":"from@example.com", "to":["to@example.com"]});
    assert!(Email.validate_config(&data).is_ok());
    data["from"] = json!("from@example.com\r\nBcc: stolen@example.com");
    assert!(Email.validate_config(&data).is_err());
    data["from"] = json!("from@example.com");
    data["from_name"] = json!("Sender\r\nBcc: stolen@example.com");
    assert!(Email.validate_config(&data).is_err());
    data.as_object_mut().unwrap().remove("from_name");
    data["username"] = json!("demo");
    data["password"] = json!("fixture");
    assert!(Email.validate_config(&data).is_err());
}

#[test]
fn sender_display_name_overrides_legacy_name_and_supports_unicode() {
    let mut data = json!({
        "host":"smtp.example.com", "from":"Previous <from@example.com>", "to":["to@example.com"],
    });
    let sender = |data: &Value| Config::parse(data).unwrap().sender().unwrap();
    assert_eq!(sender(&data).name.as_deref(), Some("Previous"));
    data["from_name"] = json!(" 雁字提醒 ");
    let named = sender(&data);
    assert_eq!(named.name.as_deref(), Some("雁字提醒"));
    assert_eq!(named.email.to_string(), "from@example.com");
}

#[test]
fn ferrum_escapes_content_and_preserves_line_breaks() {
    let html =
        template::render("<Updates>", "第一行\r\n\n<script>alert(1)</script> & more").unwrap();
    assert!(html.contains("&lt;Updates&gt;"));
    assert!(html.contains("第一行<br /><br />&lt;script&gt;alert(1)&lt;/script&gt; &amp; more"));
    assert!(!html.contains("<script>"));
}

#[test]
fn plain_text_style_preserves_existing_markdown_conversion() {
    let config = Config::parse(&json!({
        "host":"smtp.example.com", "from":"from@example.com", "to":["to@example.com"],
        "email_style":"plain",
    }))
    .unwrap();
    let message = Message {
        title: "Anser".into(),
        body: "**Hello**".into(),
        format: MessageFormat::Markdown,
        ..Default::default()
    };
    let wire = String::from_utf8(build_email(&config, &message).unwrap().formatted()).unwrap();
    assert!(wire.contains("Content-Type: text/plain; charset=utf-8"));
    assert!(!wire.contains("text/html"));
    assert_eq!(wire.split_once("\r\n\r\n").unwrap().1.trim(), "Hello");
}

#[tokio::test]
async fn mock_smtp_receives_html_body() {
    let body = send_to_mock_smtp(MessageFormat::Html, "<b>Hello</b>").await;
    assert!(body.contains("Content-Type: text/html; charset=utf-8"));
    assert!(!body.contains("multipart/alternative"));
    assert!(body.contains("<b>Hello</b>"));
}

#[tokio::test]
async fn mock_smtp_receives_default_template_with_plain_text_fallback() {
    let body = send_to_mock_smtp(MessageFormat::Text, "Hello").await;
    assert!(body.contains("From: Alerts <from@example.com>"));
    assert!(body.contains("Content-Type: multipart/alternative"));
    let plain = body
        .find("Content-Type: text/plain; charset=utf-8")
        .unwrap();
    let html = body.find("Content-Type: text/html; charset=utf-8").unwrap();
    assert!(plain < html);
    assert!(body[plain..html].contains("\nHello\n"));
    assert!(body[html..].contains("<!DOCTYPE html>"));
}

async fn send_to_mock_smtp(format: MessageFormat, body: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let relay = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = socket.into_split();
        let mut lines = BufReader::new(reader).lines();
        writer
            .write_all(b"220 relay.example ESMTP\r\n")
            .await
            .unwrap();
        let mut collecting = false;
        let mut body = String::new();
        while let Some(line) = lines.next_line().await.unwrap() {
            let response: &[u8] = if collecting {
                if line != "." {
                    body.push_str(&line);
                    body.push('\n');
                    continue;
                }
                collecting = false;
                b"250 queued\r\n"
            } else if line.starts_with("EHLO") {
                b"250 relay.example\r\n"
            } else if line.starts_with("MAIL FROM:") || line.starts_with("RCPT TO:") {
                b"250 OK\r\n"
            } else if line == "DATA" {
                collecting = true;
                b"354 End data with <CRLF>.<CRLF>\r\n"
            } else if line == "QUIT" {
                writer.write_all(b"221 Bye\r\n").await.unwrap();
                break;
            } else {
                panic!("unexpected SMTP command: {line}");
            };
            writer.write_all(response).await.unwrap();
        }
        body
    });
    let config = Config::parse(&json!({
        "host":"127.0.0.1","encryption":"none","from":"from@example.com",
        "from_name":"Alerts","to":["to@example.com"]
    }))
    .unwrap();
    let message = Message {
        title: "Anser".into(),
        body: body.into(),
        format,
        ..Default::default()
    };
    assert_eq!(
        deliver(&config, address, &message).await.unwrap(),
        SendOutcome::Delivered
    );
    tokio::time::timeout(Duration::from_secs(2), relay)
        .await
        .unwrap()
        .unwrap()
}
