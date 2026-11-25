use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use anser_core::MessageFormat;
use serde_json::json;
use tokio::sync::Notify;

use super::*;

#[derive(Default)]
struct Gate {
    entered: Notify,
    release: Notify,
    mounts: AtomicUsize,
}

struct FixturePlugin;

impl rutis::Plugin for FixturePlugin {
    type Deps = Arc<Gate>;

    async fn apply(&self, ctx: &Ctx, gate: Arc<Gate>) -> rutis::Result {
        gate.mounts.fetch_add(1, Ordering::Relaxed);
        ctx.provide(Fixture(gate))?;
        Ok(())
    }
}

struct Fixture(Arc<Gate>);

#[rutis::service(name = "anser.channel.fixture")]
impl Fixture {
    pub fn display_name(&self) -> String {
        "Fixture".into()
    }

    pub fn config_schema(&self) -> Value {
        json!({"type": "object"})
    }

    pub fn receive_protocol(&self) -> anser_plugin_api::ReceiveProtocol {
        anser_plugin_api::ReceiveProtocol::default()
    }
    pub fn capabilities(&self) -> Capabilities {
        Capabilities {
            formats: vec![MessageFormat::Text],
            max_title_chars: None,
            max_body_chars: None,
            attachments: false,
            user_target: false,
        }
    }

    pub async fn send(
        &self,
        _account: ChannelAccount,
        _message: Message,
    ) -> Result<SendOutcome, SendError> {
        self.0.entered.notify_one();
        self.0.release.notified().await;
        Ok(SendOutcome::Delivered)
    }
}

fn account() -> ChannelAccount {
    ChannelAccount { config: json!({}) }
}

#[tokio::test]
async fn suspend_drains_started_calls_then_resume_and_reload_restore_the_service() {
    let root = Ctx::root().unwrap();
    root.provide(Gate::default()).unwrap();
    let gate = root.get::<Gate>().unwrap();
    let host = Arc::new(
        ChannelHost::start_with(root, &[("fixture", |root| root.plugin(FixturePlugin))])
            .await
            .unwrap(),
    );
    assert!(host.available("fixture"));

    let sending = tokio::spawn({
        let host = host.clone();
        async move {
            host.test_send("fixture", account(), Message::default())
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();

    let suspending = tokio::spawn({
        let host = host.clone();
        async move { host.set_channel("fixture", false).await }
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while host.available("fixture") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!suspending.is_finished());
    assert!(matches!(
        host.test_send("fixture", account(), Message::default())
            .await,
        Err(HostError::Unavailable)
    ));

    gate.release.notify_one();
    assert_eq!(sending.await.unwrap().unwrap(), SendOutcome::Delivered);
    suspending.await.unwrap().unwrap();
    assert_eq!(host.ids(), ["fixture"]);
    assert!(!host.available("fixture"));
    assert_eq!(
        host.describe("fixture").await.unwrap().display_name,
        "Fixture"
    );
    assert!(matches!(
        host.reload_channel("fixture").await,
        Err(HostError::Unavailable)
    ));

    host.set_channel("fixture", true).await.unwrap();
    assert!(host.available("fixture"));
    host.reload_channel("fixture").await.unwrap();
    assert!(host.available("fixture"));
    assert!(!host.available("missing"));
    assert_eq!(gate.mounts.load(Ordering::Relaxed), 3);
    let host = Arc::into_inner(host).expect("fixture tasks returned");
    host.shutdown().await.unwrap();
}
