//! one host's watcher: health, a fresh read when it has no cursor, then
//! the event stream from its cursor, decoded frame by frame, resuming with
//! jittered backoff when anything ends it.
//!
//! the cursor is the `(epoch, seq)` of the last daemon event passed on
//! (cmx2-asks a1). a dropped connection resumes with `Last-Event-ID` and
//! the daemon replays what was missed; any event at or below the cursor is
//! dropped, so a replay overlapping what was already seen applies once. a
//! part that was streaming when the connection dropped comes back once,
//! whole and unsequenced, and its deltas continue. when the daemon cannot
//! replay (`stream.reset`: another epoch, an expired or invalid cursor) the
//! host is read afresh (`reconcile.rs`) and the stream resumes from there.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::{StatusCode, header};
use tokio::sync::watch;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::backoff::Backoff;
use super::reconcile::{self, ReadError};
use super::sse::{Decoder, Item};
use super::{Connection, Counters, Health, HostStatus, get, plain};
use crate::cmx2::{self, Event, EventKind};
use crate::config::HostConfig;
use crate::journal::Cursor;
use crate::source::cmx2::translate;
use crate::source::{SourceEvent, SourceSender};

/// one frame may not pass this (architecture: memory caps). a completed tool
/// part can carry up to 4 mb of image attachments (cmx2's budget) on top of
/// its output and input, so the cap leaves room for that part whole.
const FRAME_CAP: usize = 8 * 1024 * 1024;
/// cmx2 heartbeats every 10 s; this long without a byte means the socket
/// is dead even if it still looks established (`scars.md`, line 1633).
const STALL: Duration = Duration::from_secs(45);
/// how long a request may take to answer with its headers.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
/// error bodies and the health answer are small; nothing larger is read.
const SMALL_BODY_CAP: usize = 64 * 1024;
/// a connection that held this long resets the backoff.
const STABLE: Duration = Duration::from_secs(30);
pub(super) const BACKOFF_FLOOR: Duration = Duration::from_millis(500);
pub(super) const BACKOFF_CAP: Duration = Duration::from_secs(30);

const HEALTH: &str = "/global/health";
const EVENTS: &str = "/global/event";

#[derive(Debug, thiserror::Error)]
enum SessionError {
    #[error("{route}: {}", plain(source))]
    Request {
        route: &'static str,
        source: reqwest::Error,
    },
    #[error("{route}: no answer within {}s", ANSWER_TIMEOUT.as_secs())]
    Timeout { route: &'static str },
    #[error("{route} answered {status}: {message}")]
    Status {
        route: &'static str,
        status: StatusCode,
        message: String,
    },
    #[error("{route}: the answer did not decode: {source}")]
    Decode {
        route: &'static str,
        source: serde_json::Error,
    },
    #[error("reading the host: {0}")]
    Read(#[from] ReadError),
    #[error("no bytes for {}s; the connection is presumed dead", STALL.as_secs())]
    Stalled,
    #[error("the daemon closed the event stream")]
    Closed,
    #[error("the event stream broke: {}", plain(.0))]
    Broke(reqwest::Error),
    #[error("the daemon cannot replay from {cursor} ({reason}); reading the host afresh")]
    Reset { cursor: String, reason: String },
    #[error(
        "an event arrived from epoch {got} while the cursor is in {held}; reading the host afresh"
    )]
    EpochChanged { held: String, got: String },
    #[error("the fleet actor has stopped")]
    FleetStopped,
}

impl SessionError {
    /// a reset is the daemon asking for a fresh read, not a failure: it
    /// goes again at once, without backoff.
    fn is_reset(&self) -> bool {
        matches!(self, Self::Reset { .. } | Self::EpochChanged { .. })
    }
}

#[derive(Debug)]
pub(super) struct Watcher {
    host: Arc<HostConfig>,
    name: Arc<str>,
    client: reqwest::Client,
    status: Arc<watch::Sender<HostStatus>>,
    counters: Arc<Counters>,
    fleet: SourceSender,
    shutdown: CancellationToken,
    backoff: Backoff,
    /// the last daemon event passed to the fleet; `None` until the host
    /// has been read, and again after a reset.
    cursor: Option<Cursor>,
}

impl Watcher {
    pub(super) fn new(
        host: Arc<HostConfig>,
        client: reqwest::Client,
        status: Arc<watch::Sender<HostStatus>>,
        counters: Arc<Counters>,
        fleet: SourceSender,
        shutdown: CancellationToken,
    ) -> Self {
        let backoff = Backoff::new(BACKOFF_FLOOR, BACKOFF_CAP);
        Self {
            name: Arc::from(host.name.as_str()),
            host,
            client,
            status,
            counters,
            fleet,
            shutdown,
            backoff,
            cursor: None,
        }
    }

    pub(super) async fn run(mut self) {
        let shutdown = self.shutdown.clone();
        loop {
            self.set_connection(Connection::Connecting, None).await;
            let started = Instant::now();
            let ended = tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                result = self.session() => match result {
                    Err(error) => error,
                    Ok(never) => match never {},
                },
            };
            if matches!(ended, SessionError::FleetStopped) {
                break;
            }
            let held = started.elapsed();
            if ended.is_reset() {
                info!(host = %self.name, reason = %ended, "resuming through a fresh read");
                self.cursor = None;
                continue;
            }
            if held >= STABLE {
                self.backoff.reset();
            }
            let delay = self.backoff.next_delay();
            warn!(
                host = %self.name,
                error = %ended,
                held_ms = millis(held),
                retry_in_ms = millis(delay),
                cursor = %self.cursor_text(),
                "host connection ended"
            );
            self.set_connection(Connection::Down, Some(&ended.to_string()))
                .await;
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                () = tokio::time::sleep(delay) => {}
            }
        }
        info!(host = %self.name, cursor = %self.cursor_text(), "watcher stopped");
    }

    /// one connection, from the health check until something ends it.
    async fn session(&mut self) -> Result<Infallible, SessionError> {
        let health = self.health().await?;
        self.status
            .send_modify(|status| status.health = Some(health));

        if self.cursor.is_none() {
            let read = reconcile::read(&self.client, &self.host).await?;
            self.cursor = Some(Cursor {
                epoch: read.epoch.clone(),
                seq: read.resume_seq(),
            });
            let snapshot = translate::snapshot(read);
            self.emit(None, SourceEvent::Snapshot(Box::new(snapshot)), None)
                .await
                .map_err(|_| SessionError::FleetStopped)?;
        }
        let resume_from = self.cursor_text();

        let started = Instant::now();
        let request = get(&self.client, &self.host, EVENTS)
            .header(header::ACCEPT, "text/event-stream")
            .header("last-event-id", &resume_from)
            .send();
        let response = timeout(ANSWER_TIMEOUT, request)
            .await
            .map_err(|_| SessionError::Timeout { route: EVENTS })?
            .map_err(|source| SessionError::Request {
                route: EVENTS,
                source,
            })?;
        let status = response.status();
        if status != StatusCode::OK {
            return Err(refusal(EVENTS, response).await);
        }
        info!(
            host = %self.name,
            route = EVENTS,
            status = status.as_u16(),
            latency_ms = millis(started.elapsed()),
            resume_from = %resume_from,
            "event stream open"
        );
        self.status.send_modify(|status| status.connects += 1);
        self.set_connection(Connection::Connected, None).await;

        let mut stream = response.bytes_stream();
        let mut decoder = Decoder::new(FRAME_CAP);
        let mut items = Vec::new();
        let mut first_seq: Option<u64> = None;
        loop {
            let chunk = match timeout(STALL, stream.next()).await {
                Err(_) => return Err(SessionError::Stalled),
                Ok(None) => return Err(SessionError::Closed),
                Ok(Some(Err(error))) => return Err(SessionError::Broke(error)),
                Ok(Some(Ok(chunk))) => chunk,
            };
            decoder.push(&chunk, &mut items);
            for item in std::mem::take(&mut items) {
                if let Some(seq) = self.frame(item).await?
                    && first_seq.is_none()
                {
                    first_seq = Some(seq);
                    info!(host = %self.name, resume_from = %resume_from, first_seq = seq, "resumed: the first event after the cursor arrived");
                }
            }
        }
    }

    /// passes one frame on; answers the seq when it carried one that was new.
    async fn frame(&mut self, item: Item) -> Result<Option<u64>, SessionError> {
        let data = match item {
            Item::Frame(data) => data,
            Item::Oversized { bytes } => {
                self.counters.undecodable.fetch_add(1, Ordering::Relaxed);
                warn!(host = %self.name, bytes, cap = FRAME_CAP, "frame over the cap skipped");
                return Ok(None);
            }
            Item::NotUtf8 { bytes } => {
                self.counters.undecodable.fetch_add(1, Ordering::Relaxed);
                warn!(host = %self.name, bytes, "frame is not utf-8, skipped");
                return Ok(None);
            }
        };
        let decoded = match cmx2::decode_frame(&data) {
            Ok(decoded) => decoded,
            Err(error) => {
                self.counters.undecodable.fetch_add(1, Ordering::Relaxed);
                warn!(host = %self.name, bytes = data.len(), %error, "undecodable frame skipped");
                return Ok(None);
            }
        };
        self.counters.decoded.fetch_add(1, Ordering::Relaxed);
        let event = decoded.event;
        match event.kind() {
            EventKind::ServerConnected | EventKind::ServerHeartbeat | EventKind::GlobalDisposed => {
                return Ok(None);
            }
            EventKind::StreamReset => {
                let reason = match &event {
                    Event::StreamReset(reset) => reset.properties.reason.to_string(),
                    _ => "unknown".into(),
                };
                return Err(SessionError::Reset {
                    cursor: self.cursor_text(),
                    reason,
                });
            }
            _ => {}
        }
        let seq = match (event.seq(), event.epoch()) {
            (Some(seq), Some(epoch)) => {
                let seq = u64::try_from(seq).unwrap_or(0);
                if let Some(held) = &self.cursor {
                    if held.epoch != epoch {
                        return Err(SessionError::EpochChanged {
                            held: held.epoch.clone(),
                            got: epoch.to_owned(),
                        });
                    }
                    if seq <= held.seq {
                        self.counters.duplicates.fetch_add(1, Ordering::Relaxed);
                        debug!(host = %self.name, seq, cursor = held.seq, kind = event.kind().as_str(), "event at or below the cursor dropped");
                        return Ok(None);
                    }
                }
                self.cursor = Some(Cursor {
                    epoch: epoch.to_owned(),
                    seq,
                });
                Some(seq)
            }
            _ => None,
        };
        debug!(
            host = %self.name,
            kind = event.kind().as_str(),
            seq,
            directory = decoded.directory.as_deref().unwrap_or("-"),
            "event"
        );
        let decoded = crate::cmx2::Decoded {
            directory: decoded.directory,
            event,
            payload: decoded.payload,
        };
        if let Some((translated, payload)) = crate::source::cmx2::from_frame(&self.name, decoded) {
            self.emit(seq, translated, Some(payload))
                .await
                .map_err(|_| SessionError::FleetStopped)?;
        }
        Ok(seq)
    }

    /// one event for this host's agent, which is the connection itself.
    async fn emit(
        &self,
        seq: Option<u64>,
        event: SourceEvent,
        raw: Option<Box<serde_json::value::RawValue>>,
    ) -> Result<(), crate::source::FleetGone> {
        self.fleet.send(&self.name, seq, event, raw).await
    }

    async fn health(&self) -> Result<Health, SessionError> {
        let started = Instant::now();
        let response = timeout(ANSWER_TIMEOUT, get(&self.client, &self.host, HEALTH).send())
            .await
            .map_err(|_| SessionError::Timeout { route: HEALTH })?
            .map_err(|source| SessionError::Request {
                route: HEALTH,
                source,
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(refusal(HEALTH, response).await);
        }
        let body = read_small(response)
            .await
            .map_err(|source| SessionError::Request {
                route: HEALTH,
                source,
            })?;
        let answer: cmx2::HealthResponse =
            serde_json::from_slice(&body).map_err(|source| SessionError::Decode {
                route: HEALTH,
                source,
            })?;
        let latency = started.elapsed();
        let contract_matches = answer.contract == cmx2::CONTRACT_VERSION;
        info!(
            host = %self.name,
            route = HEALTH,
            status = status.as_u16(),
            latency_ms = millis(latency),
            version = %answer.version,
            contract = answer.contract,
            healthy = answer.healthy,
            "host health"
        );
        if !contract_matches {
            warn!(
                host = %self.name,
                contract = answer.contract,
                built_against = cmx2::CONTRACT_VERSION,
                "host speaks a different cmx2 contract; frames may not decode"
            );
        }
        Ok(Health {
            healthy: answer.healthy,
            version: answer.version,
            contract: answer.contract,
            contract_matches,
            checked_at: crate::now_ms(),
            latency_ms: millis(latency),
        })
    }

    fn cursor_text(&self) -> String {
        self.cursor
            .as_ref()
            .map_or_else(|| "none".into(), ToString::to_string)
    }

    /// records a connection change and tells the fleet, which journals it.
    async fn set_connection(&self, connection: Connection, error: Option<&str>) {
        let cursor = self.cursor.as_ref().map(ToString::to_string);
        let changed = self.status.send_if_modified(|status| {
            let changed = status.connection != connection;
            if changed {
                status.connection = connection;
                status.since = crate::now_ms();
            }
            if let Some(error) = error {
                status.last_error = Some(error.to_owned());
            }
            status.cursor.clone_from(&cursor);
            changed || error.is_some()
        });
        if changed {
            let mut snapshot = self.status.borrow().clone();
            snapshot.frames = super::FrameCounts {
                decoded: self.counters.decoded.load(Ordering::Relaxed),
                undecodable: self.counters.undecodable.load(Ordering::Relaxed),
                duplicates: self.counters.duplicates.load(Ordering::Relaxed),
            };
            // a stopped fleet means the server is stopping; the loop ends on the token
            let _ = self
                .emit(
                    None,
                    SourceEvent::Connection(translate::connection(snapshot)),
                    None,
                )
                .await;
        }
    }
}

/// a non-2xx answer, with cmx2's `ErrorBody` message when it sent one.
async fn refusal(route: &'static str, response: reqwest::Response) -> SessionError {
    let status = response.status();
    let message = match read_small(response).await {
        Ok(body) => match serde_json::from_slice::<cmx2::ErrorBody>(&body) {
            Ok(error) => error.data.message,
            Err(_) => "no error body".into(),
        },
        Err(error) => format!("the error body could not be read: {error}"),
    };
    SessionError::Status {
        route,
        status,
        message,
    }
}

/// reads a body that should be small, stopping at the cap.
async fn read_small(response: reqwest::Response) -> Result<Vec<u8>, reqwest::Error> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let room = SMALL_BODY_CAP.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= SMALL_BODY_CAP {
            break;
        }
    }
    Ok(body)
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}
