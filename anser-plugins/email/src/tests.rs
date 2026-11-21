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
    data["username"] = json!("demo");
    data["password"] = json!("fixture");
    assert!(Email.validate_config(&data).is_err());
}

#[tokio::test]
async fn mock_smtp_receives_html_body() {
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
        "host":"127.0.0.1","encryption":"none","from":"from@example.com","to":["to@example.com"]
    }))
    .unwrap();
    let message = Message {
        title: "Anser".into(),
        body: "<b>Hello</b>".into(),
        format: MessageFormat::Html,
        ..Default::default()
    };
    assert_eq!(
        deliver(&config, address, &message).await.unwrap(),
        SendOutcome::Delivered
    );
    let body = tokio::time::timeout(Duration::from_secs(2), relay)
        .await
        .unwrap()
        .unwrap();
    assert!(
        body.contains("Content-Type: text/html; charset=utf-8"),
        "{body}"
    );
    assert!(body.contains("<b>Hello</b>"), "{body}");
}
