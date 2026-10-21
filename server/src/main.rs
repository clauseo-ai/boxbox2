//! boxbox: one binary between a person's cmx2 daemons and their devices.
//!
//! `boxbox serve` runs the server; `init`, `doctor`, `service`, `upgrade`
//! and `openapi` are the rest of the command line (`cli`). the
//! architecture is `docs/architecture.md`; modules mirror its tasks.

#![forbid(unsafe_code)]

mod auth;
mod board;
mod cli;
mod cmx2;
mod config;
mod fleet;
mod http;
mod icons;
mod journal;
mod media;
#[allow(
    dead_code,
    unused_imports,
    reason = "parts of the openclaw client api wait for their consumers, the sync engine and the verbs (docs/open.md)"
)]
mod openclaw;
mod prefs;
mod pty;
mod push;
mod source;
mod store;
mod telemetry;
mod upstream;
mod wire;

use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use crate::auth::Auth;
use crate::cli::Command;
use crate::config::Config;
use crate::http::AppState;
use crate::http::assets::Assets;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// shutdown finishes inside this, or the process exits anyway
/// (`scars.md`, line 854: a server that hangs on sigterm).
const DRAIN: Duration = Duration::from_secs(5);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env_config = std::env::var("BOXBOX_CONFIG").ok();
    let command = match cli::parse(&args, env_config.as_deref()) {
        Ok(command) => command,
        Err(e) => {
            print_err(&format!("{e}\n\n{}", cli::USAGE));
            return ExitCode::from(2);
        }
    };
    match command {
        Command::Serve { config } => serve(&config),
        Command::Init(options) => cli::init::run(&options),
        Command::Doctor { config } => cli::doctor::run(&config),
        Command::Service(action) => cli::service::run(&action),
        Command::Upgrade(options) => cli::upgrade::run(&options),
        Command::Openapi => print_openapi(),
        Command::Version => print_out(&format!("boxbox {VERSION}")),
        Command::Help => print_out(cli::USAGE),
    }
}

fn serve(path: &str) -> ExitCode {
    init_logging();
    let config = match Config::load(path) {
        Ok(config) => config,
        Err(e) => {
            error!(error = %e, "config refused");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            error!(error = %e, "the async runtime did not start");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!(error = %e, "boxbox stopped on an error");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum StartupError {
    #[error("cannot create the data dir {path}: {source}")]
    DataDir {
        path: String,
        source: std::io::Error,
    },
    #[error(transparent)]
    Secret(#[from] auth::SecretError),
    #[error("cannot create the telemetry dir: {0}")]
    Telemetry(std::io::Error),
    #[error(transparent)]
    Store(#[from] store::StoreError),
    #[error(
        "{name} in boxbox.toml is already the key of an agent on {owner}; rename the connection, or pin that agent's key"
    )]
    NameIsAgentKey { name: String, owner: String },
    #[error(transparent)]
    Push(#[from] push::StartError),
    #[error("the http client did not build: {0}")]
    Client(reqwest::Error),
    #[error(transparent)]
    Terminals(#[from] pty::TlsSetupError),
    #[error("cannot listen on {addr}: {source}")]
    Listen {
        addr: std::net::SocketAddr,
        source: std::io::Error,
    },
    #[error(transparent)]
    Media(#[from] media::OpenError),
    #[error("the http server failed: {0}")]
    Serve(std::io::Error),
}

#[allow(
    clippy::too_many_lines,
    reason = "the server's startup, one owner after another in the order they start"
)]
async fn run(config: Config) -> Result<(), StartupError> {
    create_private_dir(&config.data_dir).map_err(|source| StartupError::DataDir {
        path: config.data_dir.display().to_string(),
        source,
    })?;
    let auth = Auth::new(
        Auth::load_secret(&config.data_dir)?,
        &config.password,
        config.cookie.clone(),
    );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("boxbox/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(StartupError::Client)?;

    let shutdown = CancellationToken::new();
    let build = match http::assets::build_id() {
        Some(app) if config.dev.is_none() => format!("{VERSION}+{app}"),
        _ => format!("{VERSION}+dev"),
    };
    let (telemetry, writer) =
        telemetry::spawn(config.data_dir.join("telemetry")).map_err(StartupError::Telemetry)?;
    let (store, store_thread) = store::Store::open(&config.data_dir.join("boxbox.db"))?;
    if config.board.is_some() {
        // the board's one table, only where the board is configured (`store/schema.rs` says why)
        store.call(|c| board::store::ensure(c)).await?;
    }
    let paired = upstream::paired::load(&store).await?;
    refuse_agent_keys(&config, &store).await?;
    // the fleet asks for window tails; the upstream side reads them
    let (tails, tail_requests) = tokio::sync::mpsc::channel(fleet::TAIL_REQUESTS);
    let (push, pusher, fleet, fleet_task) = start_fleet(
        &config, &store, &client, &telemetry, build, tails, &shutdown,
    )
    .await?;
    let (media, media_task) = open_media(&config, &store, &telemetry, &shutdown).await?;
    let fleet_upstream = fleet.upstream();
    let (upstreams, supervisor) = upstream::spawn(
        config.hosts.clone(),
        &config.connections(),
        paired,
        upstream::source::Shared::new(media.clone()),
        client.clone(),
        fleet.upstream(),
        tail_requests,
        &store,
        shutdown.clone(),
    );
    let config_watch = tokio::spawn(config::watch(
        config.clone(),
        upstreams.reload.clone(),
        shutdown.clone(),
    ));
    let (icons, icons_task) = icons::spawn(client.clone(), fleet.clone(), shutdown.clone());
    let assets = match &config.dev {
        Some(dev) => Assets::Vite {
            client: client.clone(),
            origin: dev.vite.clone(),
        },
        None => Assets::Embedded,
    };
    let state = Arc::new(AppState {
        auth,
        upstreams,
        fleet,
        client,
        telemetry,
        push,
        store,
        terminals: pty::Terminals::new()?,
        assets,
        icons,
        media,
        births: http::compose::Births::default(),
        summaries: crate::fleet::summary::Summaries::new(),
        sends: source::sends::Sends::new(fleet_upstream),
        board: config.board.clone().map(board::Board::new),
        shutdown: shutdown.clone(),
    });

    let listener = listen(&config).await?;

    tokio::spawn(stop_on_signal(shutdown.clone()));
    tokio::spawn(http::threads::confirm_adopted(Arc::clone(&state)));
    // each connection's peer, for the board's address match (`board/addr.rs`)
    axum::serve(
        listener,
        http::router(Arc::clone(&state))
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown.clone().cancelled_owned())
    .await
    .map_err(StartupError::Serve)?;

    // once the relays and the state are gone, push finishes its deliveries
    // and drops its handles, the writers flush and stop, and the watchers,
    // the fleet and the config watch stop on the token
    let drained = tokio::time::timeout(DRAIN, async {
        close_relays(state).await;
        let _ = supervisor.await;
        let _ = fleet_task.await;
        let _ = icons_task.await;
        let _ = media_task.await;
        let _ = config_watch.await;
        let _ = pusher.await;
        let _ = writer.await;
        let _ = tokio::task::spawn_blocking(move || store_thread.join()).await;
    })
    .await;
    if drained.is_ok() {
        info!("boxbox stopped");
    } else {
        warn!(
            limit_s = DRAIN.as_secs(),
            "shutdown ran past its limit; exiting anyway"
        );
    }
    Ok(())
}

/// a configured connection never takes a key an agent of another
/// connection already holds (`docs/agents.md`, section 3, collisions):
/// that key's read marks, needs and clears belong to the agent.
async fn refuse_agent_keys(config: &Config, store: &store::Store) -> Result<(), StartupError> {
    for connection in config.connections() {
        let name = connection.name();
        if let Some((owner, _)) = store.agent_key_owner(name).await?
            && owner != name
        {
            return Err(StartupError::NameIsAgentKey {
                name: name.to_owned(),
                owner,
            });
        }
    }
    Ok(())
}

/// the media store under the data dir, with its cap from the config.
async fn open_media(
    config: &Config,
    store: &store::Store,
    telemetry: &telemetry::Sender,
    shutdown: &CancellationToken,
) -> Result<(media::Media, JoinHandle<()>), StartupError> {
    Ok(media::Media::open(
        &config.data_dir,
        store.clone(),
        config.media.max_bytes,
        telemetry.clone(),
        shutdown.clone(),
    )
    .await?)
}

/// push first, since the fleet hands it notices and hears from it who is
/// looking; then the fleet, with the needs and read marks the store kept.
async fn start_fleet(
    config: &Config,
    store: &store::Store,
    client: &reqwest::Client,
    telemetry: &telemetry::Sender,
    build: String,
    tails: tokio::sync::mpsc::Sender<fleet::model::TailRequest>,
    shutdown: &CancellationToken,
) -> Result<(push::Push, JoinHandle<()>, fleet::Fleet, JoinHandle<()>), StartupError> {
    let (looking_tx, looking) = tokio::sync::watch::channel(Vec::new());
    let (push, pusher) = push::spawn(
        store.clone(),
        client.clone(),
        telemetry.clone(),
        config.push.contact.clone(),
        looking_tx,
    )
    .await?;
    let restored = fleet::restore(store).await?;
    let (fleet, fleet_task) = fleet::spawn(
        build,
        fleet::Wiring {
            push: push.clone(),
            telemetry: telemetry.clone(),
            store: store.clone(),
            looking,
            needs: restored.needs,
            reads: restored.reads,
            clears: restored.clears,
            adopted: restored.adopted,
            colours: restored.colours,
            tails,
        },
        shutdown.clone(),
    );
    Ok((push, pusher, fleet, fleet_task))
}

/// binds the listen address and says so, with everything a person
/// starting the server wants to see in one line.
async fn listen(config: &Config) -> Result<tokio::net::TcpListener, StartupError> {
    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .map_err(|source| StartupError::Listen {
            addr: config.listen,
            source,
        })?;
    info!(
        version = VERSION,
        listen = %config.listen,
        hosts = config.hosts.len(),
        config = %config.path.display(),
        data_dir = %config.data_dir.display(),
        cookie = %config.cookie.name,
        dev = config.dev.is_some(),
        pid = std::process::id(),
        "boxbox listening"
    );
    Ok(listener)
}

/// upgraded sockets outlive the router: each terminal relay closes its
/// browser on the token and holds a telemetry sender until it has, so the
/// state (and the last sender with it) goes only once they are done.
async fn close_relays(state: Arc<AppState>) {
    let open = state.terminals.open();
    if open > 0 {
        info!(relays = open, "closing terminal relays");
    }
    state.terminals.drained().await;
    drop(state);
}

async fn stop_on_signal(shutdown: CancellationToken) {
    let interrupt = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => {
                warn!(error = %e, "cannot listen for sigterm; ctrl-c still stops the server");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = interrupt => info!(signal = "interrupt", "shutting down"),
        () = terminate => info!(signal = "terminate", "shutting down"),
    }
    shutdown.cancel();
}

fn init_logging() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("boxbox=info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(std::io::stderr().is_terminal())
        .with_writer(std::io::stderr)
        .init();
}

fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

/// wall-clock milliseconds since the epoch, the unit every stamp uses.
#[must_use]
pub fn now_ms() -> i64 {
    #[cfg(test)]
    if let Some(now) = test_clock::now() {
        return now;
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

fn print_openapi() -> ExitCode {
    match http::openapi::document() {
        Ok(json) => {
            use std::io::Write;
            match std::io::stdout().write_all(json.as_bytes()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(_) => ExitCode::FAILURE,
            }
        }
        Err(e) => {
            print_err(&format!("the api document did not serialize: {e}"));
            ExitCode::FAILURE
        }
    }
}

#[allow(clippy::print_stdout, reason = "the cli's own output")]
fn print_out(text: &str) -> ExitCode {
    println!("{text}");
    ExitCode::SUCCESS
}

#[allow(clippy::print_stderr, reason = "usage errors before logging exists")]
fn print_err(text: &str) {
    eprintln!("{text}");
}

/// the one clock seam, for tests only: a test that replays recorded inputs
/// (`fleet/replay.rs`) sets the time each input was taken at, on its own
/// thread, so `now_ms` answers the recorded clock there and the real one
/// everywhere else.
#[cfg(test)]
pub mod test_clock {
    use std::cell::Cell;

    thread_local! {
        static NOW: Cell<Option<i64>> = const { Cell::new(None) };
    }

    pub fn now() -> Option<i64> {
        NOW.with(Cell::get)
    }

    /// `Some` pins this thread's clock; `None` hands it back to the wall.
    pub fn set(now: Option<i64>) {
        NOW.with(|cell| cell.set(now));
    }
}
