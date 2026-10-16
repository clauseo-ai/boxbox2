//! the connection task (`docs/openclaw.md` 3.3 to 3.7, 5.8): one per
//! `[[openclaw]]` entry. it dials, answers the challenge, validates the
//! hello, runs requests through the scheduler and the allowlist's one
//! sink, watches the socket for death, and reconnects with backoff until
//! it is stopped or refused.
//!
//! two tasks per socket. the **reader** owns the read half: it parses each
//! frame's envelope, sends answers and the connection's own events
//! (`connect.challenge`, `shutdown`) to this task over a small channel, and
//! puts every other event straight on the consumer's stream, so a consumer
//! that is behind never holds up an answer that already arrived. when the
//! stream is full the reader stops reading (3.6); the gateway then buffers,
//! and past 50 MiB closes with 1008 "slow consumer", after which this task
//! reconnects warm (5.8). **this task** owns the write half inside
//! `Outgoing`, the scheduler, the requests in flight and the timers.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use futures_util::stream::{SplitSink, SplitStream};
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::client::{
    self, Client, Command, EVENT_BYTES, Event, Events, Frame, GatewayError, Hello, REQUEST_TIMEOUT,
    RequestError, Response,
};
use super::credentials::{CredentialError, Credentials, Secret, read_token};
use super::protocol::{
    ConnectParams, ConnectParamsAuth, ConnectParamsClient, ConnectParamsDevice, HelloOk,
    PINNED_VERSION, PROTOCOL,
};
use super::scheduler::{Lane, Scheduler, lanes};
use super::state::{ConnectionState, Phase, degraded_words, pairing_words};
use super::wire::{Allowed, CAPS, Outgoing, SCOPES, SendError};
use crate::source::{Exit, OpenclawConfig};
use crate::wire::Refusal;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Sink = SplitSink<Socket, Message>;

const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
const CHALLENGE_TIMEOUT: Duration = Duration::from_secs(10);
/// the largest frame boxbox reads; the gateway's own `maxPayload` is far
/// below it at 2026.10.1, and an attachment-bearing history page fits.
const MAX_MESSAGE: usize = 64 * 1024 * 1024;
const PING_EVERY: Duration = Duration::from_secs(20);
/// a peer gets 25 s to answer a ping (3.7).
const PONG_WITHIN: Duration = Duration::from_secs(25);
const BACKOFF_FLOOR: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(30);
/// a connection that held this long proves the gateway is back (3.7).
const HEALTHY_AFTER: Duration = Duration::from_secs(60);
/// a protocol refusal is tried again this often (2.5).
const PROTOCOL_RETRY: Duration = Duration::from_secs(30 * 60);
/// the methods without which boxbox cannot sync (2.5).
const SYNC_METHODS: [&str; 3] = ["sessions.subscribe", "sessions.list", "chat.history"];
/// how often a refused connection looks at its token file again.
const TOKEN_RECHECK: Duration = Duration::from_secs(30);
/// the close code boxbox uses for a socket it declared dead (3.7).
const CLOSE_DEAD: u16 = 4000;

/// what the supervisor builds for one `[[openclaw]]` entry. `open` gives
/// the handles the sync engine and the verbs hold; `run` is the task.
pub struct Connection {
    config: OpenclawConfig,
    store: crate::store::Store,
    tls: Arc<rustls::ClientConfig>,
    commands: mpsc::Receiver<Command>,
    events: mpsc::Sender<Event>,
    budget: Arc<Semaphore>,
    state: watch::Sender<ConnectionState>,
    scheduler: Scheduler<Command>,
    backoff: FullJitter,
    /// the last gateway process seen, for restart detection (5.8).
    last_boot: Option<String>,
    last_uptime: Option<(u64, Instant)>,
    #[cfg(test)]
    pub(super) test: TestHooks,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("name", &self.config.name)
            .finish_non_exhaustive()
    }
}

/// switches the live tests use; compiled out of every build but tests.
#[cfg(test)]
#[derive(Debug, Default)]
pub(super) struct TestHooks {
    /// the protocol to ask for instead of the pin's, to force a mismatch.
    pub protocol: Option<u64>,
    pub tap: Option<super::wire::Tap>,
    /// cancelling it closes the current socket from boxbox's side, as a
    /// network drop would.
    pub kill_socket: Option<Arc<tokio::sync::Notify>>,
}

#[derive(Debug, thiserror::Error)]
#[error("the tls settings did not build: {0}")]
pub struct TlsSetupError(#[from] rustls::Error);

/// builds a connection for `config`: the client handle, the event stream,
/// and the task to run.
///
/// # Errors
/// the platform's tls settings did not build.
pub fn open(
    config: OpenclawConfig,
    store: crate::store::Store,
) -> Result<(Client, Events, Connection), TlsSetupError> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let verifier = rustls_platform_verifier::Verifier::new(Arc::clone(&provider))?;
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let (commands_tx, commands) =
        mpsc::channel(super::scheduler::MAX_IN_FLIGHT + super::scheduler::MAX_QUEUED);
    let (state, state_rx) = watch::channel(ConnectionState {
        since: crate::now_ms(),
        ..ConnectionState::default()
    });
    let (events, stream) = client::events();
    let budget = Arc::clone(&stream.budget);
    let client = Client {
        commands: commands_tx,
        admission: client::admission(),
        state: state_rx,
    };
    let connection = Connection {
        config,
        store,
        tls: Arc::new(tls),
        commands,
        events,
        budget,
        state,
        scheduler: Scheduler::default(),
        backoff: FullJitter::default(),
        last_boot: None,
        last_uptime: None,
        #[cfg(test)]
        test: TestHooks::default(),
    };
    Ok((client, stream, connection))
}

/// how one socket ended.
#[derive(Debug)]
enum Ended {
    Stopped,
    /// another attempt follows after the backoff, no sooner than `floor`.
    Retry {
        why: String,
        floor: Option<Duration>,
        phase: Phase,
        held: Duration,
    },
    /// no attempt until the config changes (`retry_in` none) or `retry_in`.
    Refused {
        refusal: Refusal,
        words: String,
        protocol: Option<u32>,
        retry_in: Option<Duration>,
    },
}

impl Ended {
    fn retry(why: impl Into<String>) -> Self {
        Self::Retry {
            why: why.into(),
            floor: None,
            phase: Phase::Down,
            held: Duration::ZERO,
        }
    }
}

impl Connection {
    /// runs until `shutdown` fires (`Exit::Stopped`) or the gateway or the
    /// config refuses for good (`Exit::Refused`). transient failures never
    /// end it: it reconnects with backoff (3.7).
    pub async fn run(&mut self, shutdown: CancellationToken) -> Exit {
        let name = self.config.name.clone();
        let mut credentials = match Credentials::load(&self.config, &self.store).await {
            Ok(credentials) => credentials,
            Err(CredentialError::Config(words)) => {
                self.publish(|s| {
                    s.phase = Phase::Refused(Refusal::Auth);
                    s.last_error = Some(words.clone());
                });
                warn!(connection = %name, why = %words, "openclaw credentials refused");
                return self.park_refused(words, &shutdown).await;
            }
            Err(CredentialError::Store(e)) => return Exit::Retry { why: e.to_string() },
        };
        info!(connection = %name, device = %credentials.identity.id(), "openclaw connection starting");
        loop {
            let token = read_token(&self.config.token_file).await;
            let ended = match &token {
                Ok(token) => self.attempt(&mut credentials, token, &shutdown).await,
                Err(e) => Ended::Refused {
                    refusal: Refusal::Auth,
                    words: e.to_string(),
                    protocol: None,
                    retry_in: None,
                },
            };
            match ended {
                Ended::Stopped => return Exit::Stopped,
                Ended::Retry {
                    why,
                    floor,
                    phase,
                    held,
                } => {
                    if held >= HEALTHY_AFTER {
                        self.backoff.reset();
                    }
                    let delay = self.backoff.next().max(floor.unwrap_or_default());
                    info!(connection = %name, %why, retry_in_ms = delay.as_millis(), "openclaw connection down");
                    self.publish(|s| {
                        s.phase = phase.clone();
                        s.last_error = Some(why.clone());
                    });
                    if self.idle(delay, &shutdown).await {
                        return Exit::Stopped;
                    }
                }
                Ended::Refused {
                    refusal,
                    words,
                    protocol,
                    retry_in,
                } => {
                    warn!(connection = %name, ?refusal, why = %words, "openclaw connection refused");
                    self.publish(|s| {
                        s.phase = Phase::Refused(refusal);
                        s.last_error = Some(words.clone());
                        if protocol.is_some() {
                            s.protocol = protocol;
                        }
                    });
                    if let Some(delay) = retry_in {
                        if self.idle(delay, &shutdown).await {
                            return Exit::Stopped;
                        }
                    } else {
                        // the entry is read once at start (docs/open.md), so
                        // a fixed token file is the config change to wait for
                        let refused = token.ok();
                        if self.await_token_change(refused.as_ref(), &shutdown).await {
                            return Exit::Refused { why: words };
                        }
                    }
                }
            }
        }
    }

    /// waits until `token_file` reads differently from `refused` (the token
    /// the gateway refused, or none when the file could not be read),
    /// answering requests `NotConnected`; true when stopped meanwhile.
    async fn await_token_change(
        &mut self,
        refused: Option<&Secret>,
        shutdown: &CancellationToken,
    ) -> bool {
        loop {
            if self.idle(TOKEN_RECHECK, shutdown).await {
                return true;
            }
            match (read_token(&self.config.token_file).await, refused) {
                (Ok(now), Some(before)) if now == *before => {}
                (Err(_), None) => {}
                _ => {
                    info!(connection = %self.config.name, "the token file changed; trying again");
                    return false;
                }
            }
        }
    }

    /// refused until the config changes: answer every request
    /// `NotConnected` until the supervisor stops this task.
    async fn park_refused(&mut self, why: String, shutdown: &CancellationToken) -> Exit {
        loop {
            tokio::select! {
                () = shutdown.cancelled() => return Exit::Refused { why },
                command = self.commands.recv() => {
                    let Some(command) = command else {
                        shutdown.cancelled().await;
                        return Exit::Refused { why };
                    };
                    refuse(command, RequestError::NotConnected);
                }
            }
        }
    }

    /// waits `delay` while answering requests `NotConnected`; true when
    /// stopped meanwhile.
    async fn idle(&mut self, delay: Duration, shutdown: &CancellationToken) -> bool {
        let until = tokio::time::Instant::now() + delay;
        loop {
            tokio::select! {
                () = shutdown.cancelled() => return true,
                () = tokio::time::sleep_until(until) => return false,
                command = self.commands.recv() => match command {
                    Some(command) => refuse(command, RequestError::NotConnected),
                    None => {
                        tokio::select! {
                            () = shutdown.cancelled() => return true,
                            () = tokio::time::sleep_until(until) => return false,
                        }
                    }
                },
            }
        }
    }

    fn publish(&self, change: impl FnOnce(&mut ConnectionState)) {
        self.state.send_if_modified(|state| {
            let before = state.clone();
            change(state);
            if state.phase != before.phase {
                state.since = crate::now_ms();
            }
            *state != before
        });
    }

    /// one socket, from dial to close.
    async fn attempt(
        &mut self,
        credentials: &mut Credentials,
        token: &Secret,
        shutdown: &CancellationToken,
    ) -> Ended {
        if !matches!(self.state.borrow().phase, Phase::Pairing { .. }) {
            self.publish(|s| s.phase = Phase::Connecting);
        }
        let socket = tokio::select! {
            () = shutdown.cancelled() => return Ended::Stopped,
            socket = self.dial() => match socket {
                Ok(socket) => socket,
                Err(why) => return Ended::retry(why),
            },
        };
        let (sink, stream) = socket.split();
        #[cfg_attr(not(test), allow(unused_mut, reason = "the tests tap it"))]
        let mut outgoing = Outgoing::new(sink, self.config.mode);
        #[cfg(test)]
        if let Some(tap) = &self.test.tap {
            outgoing = outgoing.tapped(Arc::clone(tap));
        }
        let (control_tx, mut control) = mpsc::channel(32);
        let shared = Arc::new(ReaderShared::new());
        let (gate_tx, gate) = oneshot::channel();
        let reader = tokio::spawn(read(
            stream,
            control_tx,
            self.events.clone(),
            Arc::clone(&self.budget),
            Arc::clone(&shared),
            gate,
        ));
        let mut session = Session {
            outgoing,
            reader,
            shared,
            next_id: 0,
            in_flight: HashMap::new(),
            connected: false,
        };
        let ended = self
            .handshake(
                &mut session,
                &mut control,
                credentials,
                token,
                gate_tx,
                shutdown,
            )
            .await;
        let ended = match ended {
            Ok(hello) => {
                self.serve(&mut session, &mut control, &hello, shutdown)
                    .await
            }
            Err(ended) => ended,
        };
        self.finish(session, &ended).await;
        ended
    }

    async fn dial(&self) -> Result<Socket, String> {
        let url = self.config.url.as_str();
        let request = url
            .into_client_request()
            .map_err(|e| format!("{url} is not a websocket address: {e}"))?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let connector = Connector::Rustls(Arc::clone(&self.tls));
        match tokio::time::timeout(
            DIAL_TIMEOUT,
            tokio_tungstenite::connect_async_tls_with_config(
                request,
                Some(config),
                true,
                Some(connector),
            ),
        )
        .await
        {
            Err(_) => Err(format!(
                "{} did not answer within {} s",
                self.config.name,
                DIAL_TIMEOUT.as_secs()
            )),
            Ok(Err(e)) => Err(format!("cannot reach {}: {e}", self.config.name)),
            Ok(Ok((socket, _))) => Ok(socket),
        }
    }

    /// the challenge, the signed `connect`, and the hello's validation
    /// (2.5, 3.3). on success the reader is released and `Connected` is on
    /// the stream before any frame of the new socket.
    async fn handshake(
        &mut self,
        session: &mut Session,
        control: &mut mpsc::Receiver<Control>,
        credentials: &mut Credentials,
        token: &Secret,
        gate: oneshot::Sender<()>,
        shutdown: &CancellationToken,
    ) -> Result<Arc<Hello>, Ended> {
        let name = self.config.name.clone();
        let challenge = loop {
            let control = tokio::select! {
                () = shutdown.cancelled() => return Err(Ended::Stopped),
                () = tokio::time::sleep(CHALLENGE_TIMEOUT) => {
                    return Err(Ended::retry(format!("{name} sent no connect.challenge within {} s", CHALLENGE_TIMEOUT.as_secs())));
                }
                control = control.recv() => control,
            };
            match control {
                Some(Control::Challenge { nonce, ts }) => break (nonce, ts),
                Some(Control::Closed { code, reason }) => {
                    return Err(closed_before_hello(&name, code, &reason));
                }
                Some(other) => debug!(connection = %name, ?other, "ignored before the challenge"),
                None => return Err(Ended::retry(format!("{name} closed the socket"))),
            }
        };
        let params = self.connect_params(credentials, token, &challenge.0, challenge.1);
        let used_device_token = credentials.device_token.is_some();
        let id = session.id();
        if let Err(e) = session
            .outgoing
            .send(&id, &Allowed::Connect(Box::new(params)))
            .await
        {
            return Err(Ended::retry(format!(
                "sending connect to {name} failed: {e}"
            )));
        }
        let answer = loop {
            let control = tokio::select! {
                () = shutdown.cancelled() => return Err(Ended::Stopped),
                () = tokio::time::sleep(REQUEST_TIMEOUT) => {
                    return Err(Ended::retry(format!("{name} did not answer connect within 30 s")));
                }
                control = control.recv() => control,
            };
            match control {
                Some(Control::Response {
                    id: answered,
                    answer,
                }) if answered == id => break answer,
                Some(Control::Closed { code, reason }) => {
                    return Err(closed_before_hello(&name, code, &reason));
                }
                Some(other) => debug!(connection = %name, ?other, "ignored during the handshake"),
                None => return Err(Ended::retry(format!("{name} closed the socket"))),
            }
        };
        let payload = match answer {
            Ok(payload) => payload,
            Err(error) => return Err(self.connect_refused(credentials, error).await),
        };
        let hello: HelloOk = match payload.as_deref().map(|p| serde_json::from_str(p.get())) {
            Some(Ok(hello)) => hello,
            Some(Err(e)) => {
                return Err(Ended::retry(format!(
                    "boxbox could not read {name}'s hello: {e}"
                )));
            }
            None => {
                return Err(Ended::retry(format!(
                    "{name} answered connect with no hello"
                )));
            }
        };
        let hello = self.accept(credentials, hello, used_device_token).await?;
        // `Connected` goes on the stream before the reader forwards a
        // single frame of this socket
        if self
            .events
            .send(Event::Connected(Arc::clone(&hello)))
            .await
            .is_err()
        {
            return Err(Ended::Stopped);
        }
        let _ = gate.send(());
        session.connected = true;
        Ok(hello)
    }

    #[cfg_attr(
        not(test),
        allow(clippy::unused_self, reason = "the tests' protocol switch reads it")
    )]
    fn connect_params(
        &self,
        credentials: &Credentials,
        token: &Secret,
        nonce: &str,
        ts: u64,
    ) -> ConnectParams {
        let platform = platform();
        let (auth, signed_token) = match &credentials.device_token {
            Some(device) => (
                ConnectParamsAuth {
                    device_token: Some(device.expose().to_owned()),
                    ..empty_auth()
                },
                device.expose(),
            ),
            None => (
                ConnectParamsAuth {
                    token: Some(token.expose().to_owned()),
                    ..empty_auth()
                },
                token.expose(),
            ),
        };
        let proof = super::identity::Proof {
            client_id: "gateway-client",
            client_mode: "backend",
            role: "operator",
            scopes: &SCOPES,
            signed_at: ts,
            token: signed_token,
            nonce,
            platform,
            device_family: "",
        };
        #[cfg(test)]
        let protocol = self.test.protocol.unwrap_or(PROTOCOL);
        #[cfg(not(test))]
        let protocol = PROTOCOL;
        let protocol = std::num::NonZeroU64::new(protocol).unwrap_or(std::num::NonZeroU64::MIN);
        ConnectParams {
            min_protocol: protocol,
            max_protocol: protocol,
            client: ConnectParamsClient {
                id: "gateway-client".to_owned(),
                mode: "backend".to_owned(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
                platform: platform.to_owned(),
                instance_id: Some(credentials.instance_id.clone()),
                display_name: Some("boxbox".to_owned()),
                build_id: None,
                device_family: None,
                model_identifier: None,
                time_zone: None,
            },
            role: Some("operator".to_owned()),
            scopes: SCOPES.iter().map(|s| (*s).to_owned()).collect(),
            caps: CAPS.iter().map(|s| (*s).to_owned()).collect(),
            auth: Some(auth),
            device: Some(ConnectParamsDevice {
                id: credentials.identity.id().to_owned(),
                public_key: credentials.identity.public_key().to_owned(),
                signature: credentials.identity.sign(&proof),
                signed_at: ts,
                nonce: nonce.to_owned(),
            }),
            commands: Vec::new(),
            computer_use: None,
            locale: None,
            model_catalog: None,
            path_env: None,
            permissions: std::collections::HashMap::new(),
            user_agent: None,
            worker_runs: None,
        }
    }

    /// what a refused `connect` means (3.4, 2.5).
    async fn connect_refused(
        &mut self,
        credentials: &mut Credentials,
        error: GatewayError,
    ) -> Ended {
        let name = &self.config.name;
        let said = format!("{name} said: {}", error.message);
        match error.detail.as_deref() {
            Some("PAIRING_REQUIRED") => {
                let request_id = error
                    .details
                    .as_ref()
                    .and_then(|d| d.get("requestId"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                info!(connection = %name, request_id = request_id.as_deref().unwrap_or("none"), "openclaw pairing required");
                Ended::Retry {
                    why: pairing_words(request_id.as_deref()),
                    floor: error.retry_after,
                    phase: Phase::Pairing { request_id },
                    held: Duration::ZERO,
                }
            }
            Some("AUTH_DEVICE_TOKEN_MISMATCH" | "AUTH_SCOPE_MISMATCH") => {
                if let Err(e) = credentials.drop_device_token().await {
                    warn!(connection = %name, error = %e, "forgetting the refused device token failed");
                }
                Ended::Retry {
                    why: format!(
                        "{said}; boxbox dropped its device token and asks again with the shared token"
                    ),
                    floor: error.retry_after,
                    phase: Phase::Connecting,
                    held: Duration::ZERO,
                }
            }
            Some("PROTOCOL_MISMATCH") => {
                let protocol = error
                    .details
                    .as_ref()
                    .and_then(|d| d.get("expectedProtocol"))
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|p| u32::try_from(p).ok());
                Ended::Refused {
                    refusal: Refusal::Protocol,
                    words: protocol_words(name, protocol),
                    protocol,
                    retry_in: Some(PROTOCOL_RETRY),
                }
            }
            Some("AUTH_RATE_LIMITED") => Ended::Retry {
                why: said,
                floor: error.retry_after,
                phase: Phase::Down,
                held: Duration::ZERO,
            },
            _ if error.retryable => Ended::Retry {
                why: said,
                floor: error.retry_after,
                phase: Phase::Down,
                held: Duration::ZERO,
            },
            Some(code)
                if code.starts_with("AUTH_")
                    || code.starts_with("DEVICE_")
                    || error.code == "NOT_PAIRED" =>
            {
                Ended::Refused {
                    refusal: Refusal::Auth,
                    words: format!("{name} refused boxbox's token; check token_file. {said}"),
                    protocol: None,
                    retry_in: None,
                }
            }
            _ if error.code == "NOT_PAIRED" => Ended::Refused {
                refusal: Refusal::Auth,
                words: format!("{name} will not pair boxbox. {said}"),
                protocol: None,
                retry_in: None,
            },
            _ => Ended::Retry {
                why: said,
                floor: error.retry_after,
                phase: Phase::Down,
                held: Duration::ZERO,
            },
        }
    }

    /// validates a hello (2.5, 3.3 step 6 and 7) and records it.
    async fn accept(
        &mut self,
        credentials: &mut Credentials,
        mut hello: HelloOk,
        used_device_token: bool,
    ) -> Result<Arc<Hello>, Ended> {
        let name = self.config.name.clone();
        let protocol = u32::try_from(hello.protocol.get()).ok();
        if hello.protocol.get() != PROTOCOL {
            return Err(Ended::Refused {
                refusal: Refusal::Protocol,
                words: protocol_words(&name, protocol),
                protocol,
                retry_in: Some(PROTOCOL_RETRY),
            });
        }
        let methods: BTreeSet<String> = hello.features.methods.iter().cloned().collect();
        let events: BTreeSet<String> = hello.features.events.iter().cloned().collect();
        if let Some(missing) = SYNC_METHODS.iter().find(|m| !methods.contains(**m)) {
            return Err(Ended::Refused {
                refusal: Refusal::Methods,
                words: format!("{name} does not offer {missing}; boxbox cannot sync it."),
                protocol,
                retry_in: Some(PROTOCOL_RETRY),
            });
        }
        let granted: BTreeSet<&str> = hello.auth.scopes.iter().map(String::as_str).collect();
        let missing_scopes: Vec<&'static str> = SCOPES
            .into_iter()
            .filter(|s| !granted.contains(s))
            .collect();
        if let Some(device_token) = &hello.auth.device_token
            && let Err(e) = credentials.keep_device_token(device_token).await
        {
            warn!(connection = %name, error = %e, "keeping the device token failed; it is used for this run only");
        }
        let boot_id = hello.server.boot_id.clone();
        let uptime = hello.snapshot.uptime_ms;
        let restarted = self.restarted(boot_id.as_deref(), uptime);
        let previous_boot_id = self.last_boot.clone();
        if boot_id.is_some() {
            self.last_boot.clone_from(&boot_id);
        }
        self.last_uptime = Some((uptime, Instant::now()));
        let version = hello.server.version.clone();
        let untested = version != PINNED_VERSION;
        info!(
            connection = %name,
            %version,
            untested,
            restarted,
            boot = boot_id.as_deref().unwrap_or("none"),
            missing_scopes = ?missing_scopes,
            used_device_token,
            got_device_token = hello.auth.device_token.is_some(),
            "openclaw connected"
        );
        let last_error =
            (!missing_scopes.is_empty()).then(|| degraded_words(&name, &missing_scopes));
        self.publish(|s| {
            s.phase = Phase::Connected;
            s.last_error = last_error;
            s.connects += 1;
            s.version = Some(version);
            s.protocol = protocol;
            s.untested = untested;
            s.missing_scopes.clone_from(&missing_scopes);
            s.boot_id.clone_from(&boot_id);
        });
        // the device token is a credential: kept above, never passed on
        let got_device_token = hello.auth.device_token.take().is_some();
        hello.auth.device_tokens.clear();
        Ok(Arc::new(Hello {
            hello,
            previous_boot_id,
            restarted,
            untested,
            got_device_token,
            used_device_token,
            missing_scopes,
            methods,
            events,
        }))
    }

    /// a restart: a new `bootId`, or with none, an uptime smaller than the
    /// last one plus the time since, less 5 s (5.8).
    fn restarted(&self, boot_id: Option<&str>, uptime_ms: u64) -> bool {
        match (boot_id, self.last_boot.as_deref()) {
            (Some(now), Some(before)) => now != before,
            (Some(_), None) if self.last_uptime.is_none() => false,
            _ => self.last_uptime.is_some_and(|(before, at)| {
                let elapsed = u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX);
                uptime_ms.saturating_add(5_000) < before.saturating_add(elapsed)
            }),
        }
    }

    /// the connected loop: requests out, answers in, liveness.
    async fn serve(
        &mut self,
        session: &mut Session,
        control: &mut mpsc::Receiver<Control>,
        hello: &Hello,
        shutdown: &CancellationToken,
    ) -> Ended {
        let name = self.config.name.clone();
        let started = Instant::now();
        let held = || started.elapsed();
        let tick = Duration::from_millis(hello.hello.policy.tick_interval_ms.get());
        let silence_limit = tick * 2;
        let mut clock = tokio::time::interval(Duration::from_secs(1));
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_ping = Instant::now();
        let mut ping_unanswered: Option<Instant> = None;
        let mut draining: Option<Duration> = None;
        let mut clients_gone = false;
        #[cfg(test)]
        let kill = self.test.kill_socket.clone().unwrap_or_default();
        loop {
            if draining.is_none()
                && let Err(why) = self.dispatch(session, hello).await
            {
                return Ended::Retry {
                    why,
                    floor: None,
                    phase: Phase::Down,
                    held: held(),
                };
            }
            let wake = self.scheduler.wake_at(Instant::now());
            let wake = async {
                match wake {
                    Some(at) => tokio::time::sleep_until(at.into()).await,
                    None => std::future::pending().await,
                }
            };
            #[cfg(test)]
            let killed = kill.notified();
            #[cfg(not(test))]
            let killed = std::future::pending::<()>();
            tokio::select! {
                () = shutdown.cancelled() => {
                    session.outgoing.close(1000, "boxbox is stopping").await;
                    return Ended::Stopped;
                }
                () = killed => {
                    session.outgoing.close(1000, "test drop").await;
                    return Ended::Retry { why: format!("boxbox dropped the socket to {name} (test)"), floor: None, phase: Phase::Down, held: held() };
                }
                command = self.commands.recv(), if !clients_gone => match command {
                    Some(command) => self.admit(command, hello, draining.is_some()),
                    None => clients_gone = true,
                },
                message = control.recv() => match message {
                    Some(Control::Response { id, answer }) => self.answered(session, &id, answer),
                    Some(Control::Shutdown { restart_expected }) => {
                        info!(connection = %name, restart_expected_ms = restart_expected.map(|d| d.as_millis()), "openclaw gateway shutting down");
                        draining = Some(restart_expected.unwrap_or_default());
                    }
                    Some(Control::Challenge { .. }) => debug!(connection = %name, "a second challenge, ignored"),
                    Some(Control::Closed { code, reason }) => {
                        return closed_after_hello(&name, code, &reason, draining, held());
                    }
                    None => return Ended::Retry { why: format!("{name}'s reader stopped"), floor: None, phase: Phase::Down, held: held() },
                },
                _ = clock.tick() => {
                    self.expire(session);
                    let now = Instant::now();
                    let waiting = session.shared.waiting_on_consumer.load(Ordering::Relaxed);
                    let silent = session.shared.silent_for();
                    if !waiting && silent > silence_limit {
                        session.outgoing.close(CLOSE_DEAD, "no frames").await;
                        return Ended::Retry { why: format!("{name} sent nothing for {} s", silent.as_secs()), floor: None, phase: Phase::Down, held: held() };
                    }
                    if let Some(sent) = ping_unanswered {
                        if session.shared.pong_since(sent) {
                            ping_unanswered = None;
                        } else if !waiting && now.duration_since(sent) > PONG_WITHIN {
                            session.outgoing.close(CLOSE_DEAD, "no pong").await;
                            return Ended::Retry { why: format!("{name} did not answer a ping within 25 s"), floor: None, phase: Phase::Down, held: held() };
                        }
                    }
                    if now.duration_since(last_ping) >= PING_EVERY {
                        last_ping = now;
                        if session.outgoing.ping(b"boxbox").await.is_err() {
                            return Ended::Retry { why: format!("the socket to {name} failed"), floor: None, phase: Phase::Down, held: held() };
                        }
                        ping_unanswered.get_or_insert(now);
                    }
                }
                () = wake => {}
            }
        }
    }

    /// refusals that never reach the socket, then the queue.
    fn admit(&mut self, command: Command, hello: &Hello, draining: bool) {
        let method = command.request.method();
        let refusal = if matches!(command.request, Allowed::Connect(_)) {
            // the handshake is this task's alone
            Some(RequestError::Unsupported { method })
        } else if self.config.mode == crate::source::OpenclawMode::Watch
            && command.request.is_write()
        {
            Some(RequestError::Watch { method })
        } else if command.request.starts_turn() && hello.missing_scopes.contains(&"operator.admin")
        {
            Some(RequestError::NoAdmin { method })
        } else if !hello.offers(method) {
            Some(RequestError::Unsupported { method })
        } else if draining {
            Some(RequestError::NotConnected)
        } else {
            None
        };
        if let Some(error) = refusal {
            refuse(command, error);
        } else {
            let lanes = lanes(&command.request);
            self.scheduler.push(lanes, command);
        }
    }

    /// writes every request the scheduler lets go now.
    async fn dispatch(&mut self, session: &mut Session, hello: &Hello) -> Result<(), String> {
        let _ = hello;
        while let Some((lanes, command)) = self.scheduler.next(Instant::now()) {
            let id = session.id();
            let method = command.request.method();
            match session.outgoing.send(&id, &command.request).await {
                Ok(()) => {
                    session.in_flight.insert(
                        id,
                        InFlight {
                            method,
                            lanes,
                            deadline: Instant::now() + REQUEST_TIMEOUT,
                            command,
                        },
                    );
                }
                Err(SendError::Watch { method }) => {
                    self.scheduler.finished(&lanes);
                    refuse(command, RequestError::Watch { method });
                }
                Err(SendError::Encode { method, source }) => {
                    self.scheduler.finished(&lanes);
                    warn!(connection = %self.config.name, method, error = %source, "a request did not encode");
                    refuse(command, RequestError::NotConnected);
                }
                Err(e @ (SendError::Socket(_) | SendError::Stalled)) => {
                    self.scheduler.finished(&lanes);
                    // the frame may be partly written: uncertain
                    refuse(command, RequestError::Lost { method });
                    return Err(format!("writing to {} failed: {e}", self.config.name));
                }
            }
        }
        Ok(())
    }

    fn answered(
        &mut self,
        session: &mut Session,
        id: &str,
        answer: Result<Option<Box<RawValue>>, GatewayError>,
    ) {
        let Some(flight) = session.in_flight.remove(id) else {
            debug!(connection = %self.config.name, id, "an answer with no request waiting, dropped");
            return;
        };
        self.scheduler.finished(&flight.lanes);
        let result =
            answer
                .map(|payload| Response { payload })
                .map_err(|error| RequestError::Gateway {
                    method: flight.method,
                    error,
                });
        let _ = flight.command.reply.send(result);
    }

    /// answers `Timeout` for every request past its deadline; a late answer
    /// is then dropped as unmatched.
    fn expire(&mut self, session: &mut Session) {
        let now = Instant::now();
        let late: Vec<String> = session
            .in_flight
            .iter()
            .filter(|(_, flight)| flight.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in late {
            if let Some(flight) = session.in_flight.remove(&id) {
                self.scheduler.finished(&flight.lanes);
                warn!(connection = %self.config.name, method = flight.method, "no answer within 30 s");
                refuse(
                    flight.command,
                    RequestError::Timeout {
                        method: flight.method,
                    },
                );
            }
        }
    }

    /// settles everything the socket held and tells the stream.
    async fn finish(&mut self, session: Session, ended: &Ended) {
        session.reader.abort();
        for (_, flight) in session.in_flight {
            refuse(
                flight.command,
                RequestError::Lost {
                    method: flight.method,
                },
            );
        }
        let queued: Vec<Command> = self.scheduler.drain().collect();
        for command in queued {
            refuse(command, RequestError::NotConnected);
        }
        self.scheduler.reset();
        if session.connected {
            let why = match ended {
                Ended::Stopped => "boxbox is stopping".to_owned(),
                Ended::Retry { why, .. } => why.clone(),
                Ended::Refused { words, .. } => words.clone(),
            };
            let _ = self.events.send(Event::Disconnected { why }).await;
        }
    }
}

fn refuse(command: Command, error: RequestError) {
    let _ = command.reply.send(Err(error));
}

struct Session {
    outgoing: Outgoing<Sink>,
    reader: JoinHandle<()>,
    shared: Arc<ReaderShared>,
    next_id: u64,
    in_flight: HashMap<String, InFlight>,
    /// `Connected` went on the stream, so `Disconnected` follows it.
    connected: bool,
}

impl Session {
    /// a per-socket counter, as a string (3.6).
    fn id(&mut self) -> String {
        self.next_id += 1;
        self.next_id.to_string()
    }
}

struct InFlight {
    method: &'static str,
    lanes: Vec<Lane>,
    deadline: Instant,
    command: Command,
}

/// what the reader hands this task.
#[derive(Debug)]
enum Control {
    Challenge {
        nonce: String,
        ts: u64,
    },
    Response {
        id: String,
        answer: Result<Option<Box<RawValue>>, GatewayError>,
    },
    Shutdown {
        restart_expected: Option<Duration>,
    },
    Closed {
        code: Option<u16>,
        reason: String,
    },
}

/// what the reader records for the liveness checks, without a lock.
struct ReaderShared {
    epoch: Instant,
    /// ms since `epoch` of the last frame of any kind.
    last_inbound: AtomicU64,
    last_pong: AtomicU64,
    /// the reader is waiting for room on the event stream: silence is
    /// boxbox's own doing, not a dead socket.
    waiting_on_consumer: AtomicBool,
}

impl ReaderShared {
    fn new() -> Self {
        Self {
            epoch: Instant::now(),
            last_inbound: AtomicU64::new(0),
            last_pong: AtomicU64::new(0),
            waiting_on_consumer: AtomicBool::new(false),
        }
    }

    fn now(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn touch(&self) {
        self.last_inbound.store(self.now(), Ordering::Relaxed);
    }

    fn silent_for(&self) -> Duration {
        Duration::from_millis(
            self.now()
                .saturating_sub(self.last_inbound.load(Ordering::Relaxed)),
        )
    }

    fn pong(&self) {
        self.last_pong.store(self.now().max(1), Ordering::Relaxed);
    }

    fn pong_since(&self, sent: Instant) -> bool {
        let sent = u64::try_from(sent.saturating_duration_since(self.epoch).as_millis())
            .unwrap_or(u64::MAX);
        // any frame after the ping proves the socket: a pong read late,
        // behind frames buffered while the consumer was slow, still counts
        let pong = self
            .last_pong
            .load(Ordering::Relaxed)
            .max(self.last_inbound.load(Ordering::Relaxed));
        pong != 0 && pong >= sent
    }
}

/// the outer envelope of every frame; payloads stay raw until a consumer
/// decodes them.
#[derive(Deserialize)]
struct Envelope {
    r#type: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    seq: Option<u64>,
    #[serde(default)]
    payload: Option<Box<RawValue>>,
    #[serde(default)]
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ChallengePayload {
    nonce: String,
    ts: u64,
}

#[derive(Deserialize)]
struct ShutdownPayload {
    #[serde(default, rename = "restartExpectedMs")]
    restart_expected_ms: Option<u64>,
}

/// the reader: one per socket (3.6).
#[allow(
    clippy::too_many_lines,
    reason = "one frame loop, one arm per frame kind"
)]
async fn read(
    mut stream: SplitStream<Socket>,
    control: mpsc::Sender<Control>,
    events: mpsc::Sender<Event>,
    budget: Arc<Semaphore>,
    shared: Arc<ReaderShared>,
    gate: oneshot::Receiver<()>,
) {
    let mut gate = Some(gate);
    let mut last_seq: Option<u64> = None;
    let mut undecodable: u64 = 0;
    let closed = loop {
        let Some(message) = stream.next().await else {
            break Control::Closed {
                code: None,
                reason: "the gateway closed the socket".into(),
            };
        };
        shared.touch();
        let text = match message {
            Ok(Message::Text(text)) => text,
            Ok(Message::Pong(_)) => {
                shared.pong();
                continue;
            }
            Ok(Message::Close(frame)) => {
                break Control::Closed {
                    code: frame.as_ref().map(|f| u16::from(f.code)),
                    reason: frame.map(|f| f.reason.to_string()).unwrap_or_default(),
                };
            }
            Ok(_) => continue,
            Err(e) => {
                break Control::Closed {
                    code: None,
                    reason: e.to_string(),
                };
            }
        };
        let envelope: Envelope = match serde_json::from_str(text.as_str()) {
            Ok(envelope) => envelope,
            Err(e) => {
                undecodable += 1;
                warn!(error = %e, undecodable, "an openclaw frame did not decode, skipped");
                continue;
            }
        };
        match envelope.r#type.as_str() {
            "res" => {
                let Some(id) = envelope.id else { continue };
                let answer = if envelope.ok == Some(true) {
                    Ok(envelope.payload)
                } else {
                    Err(gateway_error(envelope.error))
                };
                if control
                    .send(Control::Response { id, answer })
                    .await
                    .is_err()
                {
                    return;
                }
                // the first answer is the hello: hold every later frame
                // until the connection has put `Connected` on the stream
                if let Some(gate) = gate.take()
                    && gate.await.is_err()
                {
                    return;
                }
            }
            "event" => {
                let event = envelope.event.unwrap_or_default();
                let gap = match (envelope.seq, last_seq) {
                    (Some(seq), Some(last)) if seq > last + 1 => Some((last + 1, seq - last - 1)),
                    _ => None,
                };
                if let Some(seq) = envelope.seq {
                    last_seq = Some(seq);
                }
                let to_control = match event.as_str() {
                    "connect.challenge" => envelope
                        .payload
                        .as_deref()
                        .and_then(|p| serde_json::from_str::<ChallengePayload>(p.get()).ok())
                        .map(|c| Control::Challenge {
                            nonce: c.nonce,
                            ts: c.ts,
                        }),
                    "shutdown" => Some(Control::Shutdown {
                        restart_expected: envelope
                            .payload
                            .as_deref()
                            .and_then(|p| serde_json::from_str::<ShutdownPayload>(p.get()).ok())
                            .and_then(|s| s.restart_expected_ms)
                            .map(Duration::from_millis),
                    }),
                    // liveness only; `touch` above recorded it
                    "tick" => continue,
                    _ => None,
                };
                if let Some(message) = to_control {
                    if control.send(message).await.is_err() {
                        return;
                    }
                    continue;
                }
                if gate.is_some() {
                    debug!(event, "an event before the hello, dropped");
                    continue;
                }
                let bytes = text.len().min(EVENT_BYTES);
                let permit = acquire(&budget, bytes, &shared).await;
                let frame = Frame {
                    event,
                    seq: envelope.seq,
                    gap,
                    payload: envelope.payload,
                    _budget: permit,
                };
                shared.waiting_on_consumer.store(true, Ordering::Relaxed);
                let sent = events.send(Event::Frame(frame)).await;
                shared.touch();
                shared.waiting_on_consumer.store(false, Ordering::Relaxed);
                if sent.is_err() {
                    return;
                }
            }
            _ => {}
        }
    };
    let _ = control.send(closed).await;
}

/// bytes of the stream's budget for one frame; waits (and says so) while
/// the consumer is behind.
async fn acquire(
    budget: &Arc<Semaphore>,
    bytes: usize,
    shared: &ReaderShared,
) -> Option<OwnedSemaphorePermit> {
    let bytes = u32::try_from(bytes).unwrap_or(u32::MAX);
    if let Ok(permit) = Arc::clone(budget).try_acquire_many_owned(bytes) {
        return Some(permit);
    }
    shared.waiting_on_consumer.store(true, Ordering::Relaxed);
    let permit = Arc::clone(budget).acquire_many_owned(bytes).await.ok();
    // the silence while boxbox was behind was its own; count from now
    shared.touch();
    shared.waiting_on_consumer.store(false, Ordering::Relaxed);
    permit
}

fn gateway_error(error: Option<serde_json::Value>) -> GatewayError {
    let error = error.unwrap_or_default();
    let text = |key: &str| {
        error
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let details = error.get("details").cloned();
    GatewayError {
        code: text("code").unwrap_or_else(|| "UNKNOWN".into()),
        message: text("message").unwrap_or_else(|| "no reason given".into()),
        detail: details
            .as_ref()
            .and_then(|d| d.get("code"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        details,
        retryable: error
            .get("retryable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        retry_after: error
            .get("retryAfterMs")
            .and_then(serde_json::Value::as_u64)
            .map(Duration::from_millis),
    }
}

/// a close before any hello: the connect answer (if any) already spoke.
fn closed_before_hello(name: &str, code: Option<u16>, reason: &str) -> Ended {
    Ended::retry(match code {
        Some(code) => format!("{name} closed the socket during the handshake ({code} {reason})"),
        None => format!("{name} closed the socket during the handshake ({reason})"),
    })
}

/// a close after the hello (3.7, 5.8).
fn closed_after_hello(
    name: &str,
    code: Option<u16>,
    reason: &str,
    draining: Option<Duration>,
    held: Duration,
) -> Ended {
    let floor = draining.filter(|d| !d.is_zero());
    let why = match code {
        Some(1008) if reason.contains("slow consumer") => {
            format!("{name} closed boxbox as a slow consumer; reconnecting, nothing is lost")
        }
        // spec 3.7 calls any other 1008 a configuration error with no retry
        // loop; the gateway also sends 1008 while its handler is still
        // loading after a restart, so boxbox retries at the cap instead of
        // wedging, and shows the gateway's words
        Some(1008) => {
            return Ended::Retry {
                why: format!("{name} closed the socket: {reason}"),
                floor: Some(floor.unwrap_or(BACKOFF_CAP)),
                phase: Phase::Down,
                held,
            };
        }
        Some(code) if draining.is_some() => format!("{name} is restarting ({code} {reason})"),
        Some(code) => format!("{name} closed the socket ({code} {reason})"),
        None => format!("the socket to {name} dropped: {reason}"),
    };
    Ended::Retry {
        why,
        floor,
        phase: Phase::Down,
        held,
    }
}

fn protocol_words(name: &str, protocol: Option<u32>) -> String {
    match protocol {
        Some(p) => format!(
            "{name} speaks openclaw protocol {p}; boxbox speaks {PROTOCOL}. update boxbox, or run the openclaw it is pinned to ({PINNED_VERSION})."
        ),
        None => format!(
            "{name} refused boxbox's protocol {PROTOCOL}. run the openclaw boxbox is pinned to ({PINNED_VERSION})."
        ),
    }
}

/// node's `process.platform` names, which openclaw's clients send (3.3).
fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

fn empty_auth() -> ConnectParamsAuth {
    ConnectParamsAuth {
        agent_runtime_identity_token: None,
        approval_runtime_token: None,
        bootstrap_token: None,
        device_token: None,
        password: None,
        token: None,
    }
}

/// exponential from 1 s to 30 s with full jitter, never under the floor
/// (3.7).
#[derive(Debug, Default)]
struct FullJitter {
    attempt: u32,
}

impl FullJitter {
    fn next(&mut self) -> Duration {
        self.next_with(rand::random::<f64>())
    }

    fn next_with(&mut self, unit: f64) -> Duration {
        let ceiling = BACKOFF_FLOOR
            .saturating_mul(1 << self.attempt.min(16))
            .min(BACKOFF_CAP);
        self.attempt = self.attempt.saturating_add(1);
        ceiling.mul_f64(unit.clamp(0.0, 1.0)).max(BACKOFF_FLOOR)
    }

    fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests;
