use std::sync::Arc;

use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, date_time_ymd};
use rustls::ServerConfig;
use rustls::pki_types::PrivatePkcs8KeyDer;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use super::*;

async fn tls_fixture(
    leaf_name: &str,
    expired: bool,
) -> (
    Target,
    RootCertStore,
    tokio::task::JoinHandle<Result<(), io::Error>>,
) {
    let mut ca = CertificateParams::new(Vec::new()).unwrap();
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_key = KeyPair::generate().unwrap();
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca, ca_key);
    let mut leaf = CertificateParams::new(vec![leaf_name.into()]).unwrap();
    if expired {
        leaf.not_before = date_time_ymd(1999, 1, 1);
        leaf.not_after = date_time_ymd(2000, 1, 1);
    }
    let leaf_key = KeyPair::generate().unwrap();
    let leaf = leaf.signed_by(&leaf_key, &issuer).unwrap();
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone()],
                PrivatePkcs8KeyDer::from(leaf_key.serialize_der()).into(),
            )
            .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let target = Target::parse(&format!("https://{}", listener.local_addr().unwrap())).unwrap();
    let peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        let _connection = TlsAcceptor::from(Arc::new(config)).accept(stream).await?;
        Ok(())
    });
    let mut roots = RootCertStore::empty();
    roots.add(ca_cert.der().clone()).unwrap();
    (target, roots, peer)
}

#[tokio::test]
async fn checks_a_verified_loopback_certificate_and_applies_the_threshold() {
    let (target, roots, peer) = tls_fixture("127.0.0.1", false).await;
    let error = check_tls(
        &target,
        &NetworkPolicy::new(false, Vec::new()),
        &connector(roots.clone()).unwrap(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code, "outbound_blocked");
    let result = check_tls(
        &target,
        &NetworkPolicy::new(true, Vec::new()),
        &connector(roots).unwrap(),
    )
    .await
    .unwrap();
    peer.await.unwrap().unwrap();
    let Expiration::Authenticated { expires_at } = result else {
        panic!("expected an authenticated certificate");
    };
    let (healthy, healthy_draft) = output(
        &target,
        Expiration::Authenticated { expires_at },
        30,
        expires_at - 31 * SECONDS_PER_DAY,
    );
    assert!(healthy_draft.is_none());
    assert_eq!(healthy["status"], "healthy");
    let (warning, warning_draft) = output(
        &target,
        Expiration::Authenticated { expires_at },
        30,
        expires_at - 30 * SECONDS_PER_DAY,
    );
    assert_eq!(
        warning_draft.unwrap().extras["certificate"]["days_remaining"],
        30
    );
    assert_eq!(warning["status"], "expiring");
}

#[tokio::test]
async fn rejects_a_mismatched_server_name_and_labels_an_expired_handshake_as_unauthenticated() {
    let policy = NetworkPolicy::new(true, Vec::new());
    let (target, roots, peer) = tls_fixture("other.example", false).await;
    assert!(
        matches!(check_tls(&target, &policy, &connector(roots).unwrap()).await, Err(error) if error.code == "certificate_untrusted")
    );
    assert!(peer.await.unwrap().is_err());

    let (target, roots, peer) = tls_fixture("127.0.0.1", true).await;
    let result = check_tls(&target, &policy, &connector(roots).unwrap())
        .await
        .unwrap();
    assert!(peer.await.unwrap().is_err());
    let (details, draft) = output(&target, result, 30, UnixTime::now().as_secs());
    assert!(draft.is_some());
    assert_eq!(details["status"], "expired");
    assert_eq!(details["certificate"]["authenticated"], false);
}

#[test]
fn requires_a_credential_free_https_origin() {
    for value in [
        "http://example.com",
        "https://user:password@example.com",
        "https://example.com/path",
        "https://example.com/?token=value",
        "https://example.com/#fragment",
        "https://example.com:0",
    ] {
        assert!(matches!(Target::parse(value), Err(error) if error.code == "certificate_url"));
    }
    let target = Target::parse("https://[2001:db8::1]:8443").unwrap();
    assert_eq!(target.host, "2001:db8::1");
    assert_eq!(target.port, 8443);
}

#[tokio::test]
async fn checks_multiple_websites_and_keeps_each_result_when_one_fails() {
    let (healthy, roots, peer) = tls_fixture("127.0.0.1", false).await;
    let closed = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let down = Target::parse(&format!("https://{}", closed.local_addr().unwrap())).unwrap();
    drop(closed);
    let service = connector(roots).unwrap();
    let result = check_targets(
        vec![down, healthy],
        &NetworkPolicy::new(true, Vec::new()),
        &service,
        30,
    )
    .await;
    peer.await.unwrap().unwrap();
    assert!(result.notifications.is_empty());
    let details = result.details.unwrap();
    assert_eq!(details["websites"][0]["status"], "error");
    assert_eq!(details["websites"][1]["status"], "healthy");
}

#[test]
fn enforces_website_count_and_rejects_canonical_duplicates() {
    assert!(parse_targets(&[]).is_err());
    assert!(parse_targets(&vec!["https://example.com".to_owned(); MAX_WEBSITES + 1]).is_err());
    assert!(
        parse_targets(&[
            "https://example.com".into(),
            "https://EXAMPLE.COM:443/".into()
        ])
        .is_err()
    );
    assert_eq!(
        parse_targets(&[
            "https://example.com".into(),
            "https://example.org:8443".into()
        ])
        .unwrap()
        .len(),
        2
    );
}
