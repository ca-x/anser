use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::SystemTime;

use lzc_sdk::proto::common::{
    ListEndDeviceReply, RemoveEndDeviceRequest, SetDeviceRemarkNameRequest,
    end_device_service_server::{EndDeviceService, EndDeviceServiceServer},
};
use lzc_sdk::proto::localdevice::{
    ListPermissionsReply, NotifyResponse, PermissionReply, PermissionRequest,
    RequestAuthTokenRequest, RequestAuthTokenResponse,
    notification_service_server::{NotificationService, NotificationServiceServer},
    permission_manager_server::{PermissionManager, PermissionManagerServer},
};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, PKCS_ED25519,
};
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::{Certificate, Endpoint, Identity, Server, ServerTlsConfig};
use tonic::{Response, Status};

use super::*;

struct GatewayFixture(String);

#[tonic::async_trait]
impl EndDeviceService for GatewayFixture {
    async fn list_end_devices(
        &self,
        request: Request<ListEndDeviceRequest>,
    ) -> Result<Response<ListEndDeviceReply>, Status> {
        assert_eq!(request.get_ref().uid, "alice");
        assert_eq!(request.metadata().get("x-hc-user-id").unwrap(), "alice");
        Ok(Response::new(ListEndDeviceReply {
            devices: vec![
                EndDevice {
                    unique_deivce_id: "offline".into(),
                    model: "Tablet".into(),
                    ..EndDevice::default()
                },
                EndDevice {
                    unique_deivce_id: "device-1".into(),
                    name: "Laptop".into(),
                    remark_name: "Work laptop".into(),
                    device_api_url: self.0.clone(),
                    is_online: true,
                    ..EndDevice::default()
                },
            ],
        }))
    }

    async fn remove_end_device(
        &self,
        _: Request<RemoveEndDeviceRequest>,
    ) -> Result<Response<()>, Status> {
        Err(Status::unimplemented("fixture"))
    }

    async fn set_device_remark_name(
        &self,
        _: Request<SetDeviceRemarkNameRequest>,
    ) -> Result<Response<()>, Status> {
        Err(Status::unimplemented("fixture"))
    }
}

#[derive(Default)]
struct DeviceFixture {
    auth_requests: AtomicUsize,
    reject_token_once: AtomicBool,
    received: Mutex<Vec<NotifyRequest>>,
}

#[tonic::async_trait]
impl PermissionManager for DeviceFixture {
    async fn get_permission(
        &self,
        _: Request<PermissionRequest>,
    ) -> Result<Response<PermissionReply>, Status> {
        Err(Status::unimplemented("fixture"))
    }

    async fn request_permission(
        &self,
        _: Request<PermissionRequest>,
    ) -> Result<Response<PermissionReply>, Status> {
        Err(Status::unimplemented("fixture"))
    }

    async fn list_permissions(
        &self,
        _: Request<()>,
    ) -> Result<Response<ListPermissionsReply>, Status> {
        Err(Status::unimplemented("fixture"))
    }

    async fn request_auth_token(
        &self,
        request: Request<RequestAuthTokenRequest>,
    ) -> Result<Response<RequestAuthTokenResponse>, Status> {
        assert!(request.peer_certs().is_some());
        self.auth_requests.fetch_add(1, Ordering::Relaxed);
        Ok(Response::new(RequestAuthTokenResponse {
            token: "fixture-token".into(),
            deadline: Some((SystemTime::now() + Duration::from_secs(120)).into()),
        }))
    }
}

#[tonic::async_trait]
impl NotificationService for DeviceFixture {
    async fn notify(
        &self,
        request: Request<NotifyRequest>,
    ) -> Result<Response<NotifyResponse>, Status> {
        assert_eq!(
            request.metadata().get("lzc_dapi_auth_token").unwrap(),
            "fixture-token"
        );
        if self.reject_token_once.swap(false, Ordering::Relaxed) {
            return Err(Status::unauthenticated("fixture revoked the token"));
        }
        self.received.lock().await.push(request.into_inner());
        Ok(Response::new(NotifyResponse {}))
    }
}

fn fixture_tls(temp: &tempfile::TempDir) -> (CredentialPaths, ServerTlsConfig) {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let ca = ca_params.self_signed(&ca_key).unwrap().pem();
    let issuer = Issuer::new(ca_params, ca_key);

    let server_key = KeyPair::generate().unwrap();
    let mut server_params = CertificateParams::new(["127.0.0.1".into()]).unwrap();
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let server = server_params.signed_by(&server_key, &issuer).unwrap();
    let tls = ServerTlsConfig::new()
        .identity(Identity::from_pem(server.pem(), server_key.serialize_pem()))
        .client_ca_root(Certificate::from_pem(&ca));

    let app_key = KeyPair::generate_for(&PKCS_ED25519).unwrap();
    let mut app_params = CertificateParams::default();
    app_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    app_params
        .distinguished_name
        .push(DnType::from_oid(&[2, 5, 4, 5]), "anser-fixture");
    let app = app_params.signed_by(&app_key, &issuer).unwrap();
    let paths = CredentialPaths {
        box_certificate: temp.path().join("box.crt"),
        application_certificate: temp.path().join("app.crt"),
        application_private_key: temp.path().join("app.key"),
    };
    std::fs::write(&paths.box_certificate, ca).unwrap();
    std::fs::write(&paths.application_certificate, app.pem()).unwrap();
    std::fs::write(&paths.application_private_key, app_key.serialize_pem()).unwrap();
    (paths, tls)
}

#[tokio::test]
async fn selects_a_device_and_sends_through_genuine_grpc_clients() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let temp = tempfile::tempdir().unwrap();
    let (paths, tls) = fixture_tls(&temp);
    let device_tls = Some(verified_tls(&paths, &paths.box_certificate).await.unwrap());
    let credentials = ClientCredentials::load(paths).await.unwrap();

    let device = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let device_url = format!("https://{}", device.local_addr().unwrap());
    let fixture = Arc::new(DeviceFixture::default());
    let backend = Server::builder()
        .tls_config(tls)
        .unwrap()
        .add_service(PermissionManagerServer::from_arc(fixture.clone()))
        .add_service(NotificationServiceServer::from_arc(fixture.clone()));
    let device_server = tokio::spawn(backend.serve_with_incoming(TcpListenerStream::new(device)));

    let gateway = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway_url = format!("http://{}", gateway.local_addr().unwrap());
    let gateway_server = tokio::spawn(
        Server::builder()
            .add_service(EndDeviceServiceServer::new(GatewayFixture(device_url)))
            .serve_with_incoming(TcpListenerStream::new(gateway)),
    );

    let gateway = Endpoint::from_shared(gateway_url)
        .unwrap()
        .connect()
        .await
        .unwrap();
    let channel = Lazycat {
        runtime: OnceCell::new_with(Some(Runtime {
            gateway: ApiGateway::from_channel(gateway, credentials.clone()),
            credentials,
            devices: Mutex::new(HashMap::new()),
            device_tls,
        })),
    };
    let devices = channel.devices("alice").await.unwrap();
    assert_eq!(
        serde_json::to_value(&devices).unwrap(),
        json!([
            {"device_id":"device-1","name":"Work laptop","online":true},
            {"device_id":"offline","name":"Tablet","online":false}
        ])
    );
    assert_eq!(fixture.auth_requests.load(Ordering::Relaxed), 0);
    let account = ChannelAccount {
        config: json!({"user_id": "alice", "device_id": "device-1"}),
    };
    let message = Message {
        title: "雁字".into(),
        body: "a **test**".into(),
        format: MessageFormat::Markdown,
        ..Message::default()
    };
    for _ in 0..2 {
        assert_eq!(
            channel.send(&account, &message).await.unwrap(),
            SendOutcome::Delivered
        );
    }
    assert_eq!(fixture.auth_requests.load(Ordering::Relaxed), 1);
    fixture.reject_token_once.store(true, Ordering::Relaxed);
    assert_eq!(
        channel.send(&account, &message).await.unwrap(),
        SendOutcome::Delivered
    );
    assert_eq!(fixture.auth_requests.load(Ordering::Relaxed), 2);
    let mut body_only = message.clone();
    body_only.title.clear();
    body_only.body = format!("\n# {}\n\n第二段", "雁".repeat(85));
    channel.send(&account, &body_only).await.unwrap();
    let received = fixture.received.lock().await;
    assert_eq!(received.len(), 4);
    assert_eq!(received[3].title, format!("{}…", "雁".repeat(79)));
    assert_eq!(received[3].body, format!("{} 第二段", "雁".repeat(85)));
    assert_eq!(received[0].title, "雁字");
    assert_eq!(received[0].body, "a test");
    device_server.abort();
    gateway_server.abort();
}
