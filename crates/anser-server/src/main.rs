mod api;
mod auth;
mod cli;
mod error;
mod openapi;
mod web;

use anser_queue::{Cipher, Enqueuer, Limits, Workers};
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method, header};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};

use anser_core::{ChannelAccount, Message};
use anser_host::ChannelHost;
use anser_store::Store;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "anser", version, about = "Anser notification delivery")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the server and initialize its SQLite database.
    Serve(ServerConfig),
    /// Manage a running Anser server over its API.
    Api(cli::Remote),
    /// Show a compiled channel's configuration schema.
    ChannelSchema { channel: String },
    /// Send a notification directly using a local account configuration file.
    TestSend {
        channel: String,
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        title: String,
        #[arg(long)]
        body: String,
    },
}

#[derive(clap::Args)]
struct ServerConfig {
    #[arg(long, env = "ANSER_BIND", default_value = "127.0.0.1:8080")]
    bind: SocketAddr,
    #[arg(long, env = "ANSER_DATABASE", default_value = "anser.sqlite3")]
    database: PathBuf,
    #[arg(long, env = "ANSER_WORKERS", default_value_t = 4, value_parser = clap::value_parser!(u16).range(1..=128))]
    workers: u16,
    #[arg(long, env = "ANSER_CONCURRENCY", default_value_t = 32, value_parser = clap::value_parser!(u16).range(1..=1024))]
    concurrency: u16,
    #[arg(long, env = "ANSER_CHANNEL_CONCURRENCY", default_value_t = 8, value_parser = clap::value_parser!(u16).range(1..=1024))]
    channel_concurrency: u16,
    #[arg(long, env = "ANSER_ACCOUNT_CONCURRENCY", default_value_t = 1, value_parser = clap::value_parser!(u16).range(1..=1024))]
    account_concurrency: u16,
    #[arg(long, env = "ANSER_QUEUE_LIMIT", default_value_t = 10_000, value_parser = clap::value_parser!(u32).range(1..))]
    queue_limit: u32,
    #[arg(long, env = "ANSER_REQUESTS_PER_MINUTE", default_value_t = 120_000, value_parser = clap::value_parser!(u32).range(1..))]
    requests_per_minute: u32,
    #[arg(long, env = "ANSER_MAX_TTL_SECONDS", default_value_t = 86_400, value_parser = clap::value_parser!(u32).range(1..))]
    ttl_seconds: u32,
    #[arg(long, env = "ANSER_RETENTION_DAYS", default_value_t = 30, value_parser = clap::value_parser!(u32).range(1..=3650))]
    retention_days: u32,
    #[arg(long, env = "ANSER_PUBLIC_URL")]
    public_url: Option<String>,
    #[arg(long, env = "ANSER_CORS_ORIGINS", value_delimiter = ',')]
    cors_origins: Vec<String>,
    #[arg(long, env = "ANSER_MASTER_KEY_FILE")]
    master_key_file: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    // Several channel SDKs enable different rustls crypto features. The server owns the process default.
    let _ = rustls::crypto::ring::default_provider().install_default();
    use tracing_subscriber::EnvFilter;
    let _ = tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .try_init();
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let command = cli.command.unwrap_or_else(|| {
        // Parse defaults and environment variables through the same entry point.
        Cli::parse_from(["anser", "serve"]).command.unwrap()
    });
    let host = Arc::new(ChannelHost::start().await?);
    let result = dispatch(host.clone(), command).await;
    let shutdown = Arc::try_unwrap(host)
        .map_err(|_| anyhow::anyhow!("channel runtime is still in use"))?
        .shutdown()
        .await;
    result?;
    shutdown?;
    Ok(())
}

async fn dispatch(host: Arc<ChannelHost>, command: Command) -> anyhow::Result<()> {
    match command {
        Command::Serve(config) => serve(config, host).await?,
        Command::Api(config) => cli::run(config).await?,
        Command::ChannelSchema { channel } => {
            let schema = host.config_schema(&channel).await?;
            println!("{}", serde_json::to_string_pretty(&schema)?);
        }
        Command::TestSend {
            channel,
            config,
            title,
            body,
        } => {
            let data = tokio::fs::read(config).await?;
            let config = serde_json::from_slice(&data)
                .map_err(|_| anyhow::anyhow!("channel configuration must be valid JSON"))?;
            let message = Message {
                title,
                body,
                ..Message::default()
            };
            let outcome = host
                .test_send(&channel, ChannelAccount { config }, message)
                .await?;
            println!("{}", serde_json::to_string(&outcome)?);
        }
    }
    Ok(())
}

async fn serve(config: ServerConfig, host: Arc<ChannelHost>) -> anyhow::Result<()> {
    let store = Arc::new(Store::open(&config.database).await?);
    auth::bootstrap(&store).await?;
    let cipher = Arc::new(key_for(&config, &store).await?);
    let dummy_password = auth::hash_password(auth::random_secret().as_str().to_owned())
        .await
        .map_err(|_| anyhow::anyhow!("could not initialize password authentication"))?;
    let cors = cors(&config.cors_origins)?;
    let (enqueuer, ingest) = Enqueuer::start(store.clone());
    let app = Arc::new(api::App {
        enqueuer,
        store: store.clone(),
        host: host.clone(),
        cipher: cipher.clone(),
        requests: auth::Rate::default(),
        login_requests: auth::Rate::default(),
        dummy_password,
        public_url: config.public_url.filter(|value| !value.is_empty()),
        requests_per_minute: config.requests_per_minute,
        queue_limit: config.queue_limit,
        ttl_limit_ms: i64::from(config.ttl_seconds) * 1000,
        retention_ms: i64::from(config.retention_days) * 86_400_000,
        inbox_wakeup: tokio::sync::Notify::new(),
        inbox_waiters: tokio::sync::Semaphore::new(1_024),
        send_waiters: tokio::sync::Semaphore::new(128),
    });
    let router = api::router()
        .layer(DefaultBodyLimit::max(3 * 1024 * 1024))
        .layer(cors)
        .layer(axum::middleware::from_fn(no_store))
        .with_state(app)
        .merge(web::router());
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    eprintln!("Anser listening on {}", listener.local_addr()?);
    let workers = Workers::start(
        store,
        host,
        cipher,
        Limits {
            workers: usize::from(config.workers),
            concurrency: usize::from(config.concurrency),
            per_channel: usize::from(config.channel_concurrency),
            per_account: usize::from(config.account_concurrency),
            retention_ms: i64::from(config.retention_days) * 86_400_000,
        },
    );
    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await;
    let ingest_result = ingest.await;
    workers.stop().await;
    ingest_result?;
    result?;
    Ok(())
}

async fn no_store(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn cors(origins: &[String]) -> anyhow::Result<CorsLayer> {
    let origins = origins
        .iter()
        .map(|origin| {
            let url = reqwest::Url::parse(origin)?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                anyhow::bail!("invalid ANSER_CORS_ORIGINS entry");
            }
            Ok(HeaderValue::from_str(&url.origin().ascii_serialization())?)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("idempotency-key"),
        ])
        .expose_headers([header::RETRY_AFTER]))
}

async fn key_for(config: &ServerConfig, store: &Store) -> anyhow::Result<Cipher> {
    use std::io::Write as _;
    use zeroize::Zeroizing;
    if let Ok(value) = std::env::var("ANSER_MASTER_KEY") {
        let value = Zeroizing::new(value);
        return Ok(Cipher::from_base64(&value)?);
    }
    let path = config.master_key_file.clone().unwrap_or_else(|| {
        let mut path = config.database.as_os_str().to_owned();
        path.push(".key");
        PathBuf::from(path)
    });
    let secret = match tokio::fs::read_to_string(&path).await {
        Ok(secret) => Zeroizing::new(secret),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && config.master_key_file.is_none() =>
        {
            if store.has_credentials().await? {
                anyhow::bail!("the master key is missing for a database with existing credentials");
            }
            let root = path
                .parent()
                .filter(|value| !value.as_os_str().is_empty())
                .unwrap_or(std::path::Path::new("."));
            let secret = Cipher::generate_key();
            let mut file = tempfile::NamedTempFile::new_in(root)?;
            writeln!(file, "{}", &*secret)?;
            file.as_file_mut().sync_all()?;
            match file.persist_noclobber(&path) {
                Ok(_) => secret,
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Zeroizing::new(tokio::fs::read_to_string(&path).await?)
                }
                Err(error) => return Err(error.error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    };
    Ok(Cipher::from_base64(&secret)?)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = terminate.recv() => {},
                _ = tokio::signal::ctrl_c() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
