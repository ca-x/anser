use std::path::PathBuf;
use std::time::Duration;

use clap::{Args, Subcommand, ValueEnum};
use reqwest::{Method, Url};
use serde_json::Value;
use zeroize::Zeroizing;

#[derive(Args)]
pub struct Remote {
    #[arg(long, env = "ANSER_URL", default_value = "http://127.0.0.1:8080")]
    server: Url,
    #[command(subcommand)]
    resource: Resource,
}

#[derive(Subcommand)]
enum Resource {
    /// Inspect or manage channel plugins.
    Channels {
        channel: Option<String>,
        /// Change the lifecycle of the selected plugin (requires an admin API key).
        #[arg(long, requires = "channel")]
        action: Option<ChannelAction>,
    },
    /// Manage channel accounts.
    Accounts {
        #[command(subcommand)]
        action: AccountAction,
    },
    /// Manage reusable outbound proxy profiles (requires an admin API key).
    Proxies {
        #[command(subcommand)]
        action: Crud,
    },
    /// Manage topics.
    Topics {
        #[command(subcommand)]
        action: Crud,
    },
    /// Submit a message from a JSON file.
    Send {
        #[arg(long)]
        topic: Option<String>,
        /// Write to this user's native inbox and return the inbox ID and message ID.
        #[arg(long, conflicts_with_all = ["topic", "wait"])]
        recipient: Option<String>,
        /// Reuse the original receipt when retrying with this credential within 24 hours.
        #[arg(long)]
        idempotency_key: Option<String>,
        #[arg(long)]
        wait: bool,
        file: PathBuf,
    },
    /// Inspect a message or list recent ones.
    Messages { id: Option<String> },
    /// Replay the message using current route and account settings.
    Replay { id: String },
}

#[derive(Clone, Copy, ValueEnum)]
enum ChannelAction {
    Enable,
    Disable,
    Reload,
}

impl ChannelAction {
    fn request(self) -> Value {
        match self {
            Self::Enable => serde_json::json!({"enabled": true}),
            Self::Disable => serde_json::json!({"enabled": false}),
            Self::Reload => serde_json::json!({"reload": true}),
        }
    }
}

#[derive(Subcommand)]
enum AccountAction {
    #[command(flatten)]
    Manage(Crud),
    /// Test an account with a message JSON file.
    Test { id: String, file: PathBuf },
    /// Enable an account.
    Enable { id: String },
    /// Disable an account.
    Disable { id: String },
}

#[derive(Subcommand)]
enum Crud {
    List {
        #[arg(long)]
        cursor: Option<String>,
    },
    Get {
        id: String,
    },
    Create {
        file: PathBuf,
    },
    Update {
        id: String,
        file: PathBuf,
    },
    Delete {
        id: String,
    },
}

pub async fn run(remote: Remote) -> anyhow::Result<()> {
    if !matches!(remote.server.scheme(), "http" | "https")
        || remote.server.host_str().is_none()
        || remote.server.path() != "/"
        || remote.server.query().is_some()
        || remote.server.fragment().is_some()
        || !remote.server.username().is_empty()
        || remote.server.password().is_some()
    {
        anyhow::bail!("ANSER_URL must be a server origin");
    }
    let token = Zeroizing::new(std::env::var("ANSER_API_KEY")?);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(35))
        .build()?;
    let request = match remote.resource {
        Resource::Channels { channel, action } => match action {
            Some(action) => {
                let id = channel.ok_or_else(|| anyhow::anyhow!("a channel ID is required"))?;
                command(Method::PUT, "channels", [id, "runtime".into()]).json(action.request())
            }
            None => command(Method::GET, "channels", channel),
        },
        Resource::Accounts { action } => match action {
            AccountAction::Manage(action) => resource("accounts", action).await?,
            AccountAction::Test { id, file } => {
                command(Method::POST, "accounts", [id, "test".into()]).json(read(file).await?)
            }
            AccountAction::Enable { id } => {
                command(Method::PUT, "accounts", [id]).json(serde_json::json!({"enabled":true}))
            }
            AccountAction::Disable { id } => {
                command(Method::PUT, "accounts", [id]).json(serde_json::json!({"enabled":false}))
            }
        },
        Resource::Proxies { action } => resource("proxies", action).await?,
        Resource::Topics { action } => resource("topics", action).await?,
        Resource::Send {
            topic,
            recipient,
            wait,
            idempotency_key,
            file,
        } => {
            let mut body = read(file).await?;
            let mut request = if let Some(recipient) = recipient {
                body.as_object_mut()
                    .ok_or_else(|| anyhow::anyhow!("message must be a JSON object"))?
                    .insert("recipient".into(), recipient.into());
                command(Method::POST, "inbox", ["send".into()])
            } else if let Some(topic) = topic {
                command(Method::POST, "topics", [topic, "publish".into()])
            } else {
                command(Method::POST, "send", [])
            }
            .json(body);
            request.idempotency_key = idempotency_key;
            if wait {
                request.query.push(("wait", "true".into()));
            }
            request
        }
        Resource::Messages { id } => {
            command(Method::GET, "messages", id.into_iter().collect::<Vec<_>>())
        }
        Resource::Replay { id } => command(Method::POST, "messages", [id, "replay".into()]),
    };
    let mut url = remote.server;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid ANSER_URL"))?;
        path.clear().push("v1");
        for segment in &request.segments {
            if matches!(segment.as_str(), "" | "." | "..") {
                anyhow::bail!("invalid resource identifier");
            }
            path.push(segment);
        }
    }
    if !request.query.is_empty() {
        url.query_pairs_mut().extend_pairs(request.query);
    }
    let mut query = client.request(request.method, url).bearer_auth(&*token);
    if let Some(body) = request.body {
        query = query.json(&body);
    }
    if let Some(key) = request.idempotency_key {
        query = query.header("Idempotency-Key", key);
    }
    let response = query.send().await?;
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(());
    }
    let value: Value = response.json().await?;
    if !status.is_success() {
        let text = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("request failed");
        anyhow::bail!("Anser API returned {status}: {}", text.escape_default());
    }
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

struct Request {
    method: Method,
    segments: Vec<String>,
    query: Vec<(&'static str, String)>,
    body: Option<Value>,
    idempotency_key: Option<String>,
}

impl Request {
    fn json(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }
}

fn command(method: Method, root: &str, tail: impl IntoIterator<Item = String>) -> Request {
    Request {
        method,
        segments: std::iter::once(root.into()).chain(tail).collect(),
        query: Vec::new(),
        body: None,
        idempotency_key: None,
    }
}

async fn resource(root: &str, action: Crud) -> anyhow::Result<Request> {
    Ok(match action {
        Crud::List { cursor } => {
            let mut request = command(Method::GET, root, []);
            if let Some(cursor) = cursor {
                request.query.push(("cursor", cursor));
            }
            request
        }
        Crud::Get { id } => command(Method::GET, root, [id]),
        Crud::Create { file } => command(Method::POST, root, []).json(read(file).await?),
        Crud::Update { id, file } => command(Method::PUT, root, [id]).json(read(file).await?),
        Crud::Delete { id } => command(Method::DELETE, root, [id]),
    })
}

async fn read(file: PathBuf) -> anyhow::Result<Value> {
    let contents = Zeroizing::new(tokio::fs::read(file).await?);
    serde_json::from_slice(&contents).map_err(|_| anyhow::anyhow!("invalid request JSON"))
}
