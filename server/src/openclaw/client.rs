//! what the rest of boxbox holds of an openclaw connection: a `Client`
//! for requests, one `Events` stream, and the connection's state.
//! `connection.rs` is the task behind them.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};

use super::protocol::HelloOk;
use super::scheduler::{MAX_IN_FLIGHT, MAX_QUEUED};
use super::state::ConnectionState;
use super::wire::Allowed;

/// frames the event stream holds before the reader stops reading (3.6).
pub const EVENT_FRAMES: usize = 4096;
/// bytes of frame payload the event stream holds before the reader stops
/// reading (3.6). a single frame counts at most this much.
pub const EVENT_BYTES: usize = 16 * 1024 * 1024;
/// how long a request may wait for its answer before it is uncertain (3.7).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// what a busy answer suggests waiting (section 10, 503 `agent-busy`).
pub const BUSY_RETRY_AFTER: Duration = Duration::from_secs(1);

/// a handle for requests. cheap to clone; every clone shares the
/// connection's queue and limits.
#[derive(Debug, Clone)]
pub struct Client {
    pub(super) commands: mpsc::Sender<Command>,
    /// `MAX_IN_FLIGHT + MAX_QUEUED` permits: one per request admitted and
    /// not yet answered, so the queue can never pass `MAX_QUEUED`.
    pub(super) admission: Arc<Semaphore>,
    pub(super) state: watch::Receiver<ConnectionState>,
}

/// one request on its way to the connection task.
#[derive(Debug)]
pub(super) struct Command {
    pub request: Allowed,
    pub reply: oneshot::Sender<Result<Response, RequestError>>,
    /// held until the answer, so admission counts queued and in-flight work.
    pub permit: OwnedSemaphorePermit,
}

/// an answer's payload, as the gateway wrote it.
#[derive(Debug)]
pub struct Response {
    pub payload: Option<Box<RawValue>>,
}

impl Response {
    /// the payload as `T` (a generated result type, usually).
    ///
    /// # Errors
    /// the payload is absent or does not match `T`.
    pub fn decode<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        let text = self.payload.as_deref().map_or("null", RawValue::get);
        serde_json::from_str(text)
    }
}

/// the gateway's own error answer (`ErrorShape`).
#[derive(Debug, Clone, PartialEq)]
pub struct GatewayError {
    pub code: String,
    pub message: String,
    /// `details.code`, when the gateway gave one (`PAIRING_REQUIRED`, ...).
    pub detail: Option<String>,
    pub details: Option<serde_json::Value>,
    pub retryable: bool,
    pub retry_after: Option<Duration>,
}

/// why a request has no answer. the variants say whether the request
/// could have reached the gateway: a timed-out or lost write is
/// uncertain, never failed (3.7), and a send goes to reconciliation.
#[derive(Debug, thiserror::Error)]
pub enum RequestError {
    #[error("{method} writes, and this connection is in watch mode")]
    Watch { method: &'static str },
    #[error("{method} starts a turn, and the gateway did not grant operator.admin")]
    NoAdmin { method: &'static str },
    #[error("the gateway does not offer {method}")]
    Unsupported { method: &'static str },
    #[error("the connection has {MAX_QUEUED} requests waiting; try again shortly")]
    Busy { retry_after: Duration },
    #[error("the gateway is not connected")]
    NotConnected,
    #[error("the gateway refused {method}: {} ({})", .error.message, .error.code)]
    Gateway {
        method: &'static str,
        error: GatewayError,
    },
    /// written, and no answer within `REQUEST_TIMEOUT`: it may have applied.
    #[error("no answer to {method} within 30 s; it may have applied")]
    Timeout { method: &'static str },
    /// written, and the socket went away before the answer: it may have applied.
    #[error("the connection dropped before {method} was answered; it may have applied")]
    Lost { method: &'static str },
    #[error("the openclaw connection has stopped")]
    Stopped,
}

impl RequestError {
    /// true when the gateway cannot have seen the request, so a retry
    /// cannot double it.
    #[must_use]
    pub fn never_sent(&self) -> bool {
        matches!(
            self,
            Self::Watch { .. }
                | Self::NoAdmin { .. }
                | Self::Unsupported { .. }
                | Self::Busy { .. }
                | Self::NotConnected
                | Self::Stopped
        )
    }
}

impl Client {
    /// sends `request` and waits for its answer, queueing behind the
    /// connection's limits (section 10) when the queue has room and waiting
    /// for room when it has none: the call for sync reads.
    ///
    /// # Errors
    /// see `RequestError`; refusals that never reach the socket come first.
    pub async fn request(&self, request: Allowed) -> Result<Response, RequestError> {
        let permit = Arc::clone(&self.admission)
            .acquire_owned()
            .await
            .map_err(|_| RequestError::Stopped)?;
        self.submit(request, permit).await
    }

    /// as `request`, but answers `Busy` at once when `MAX_QUEUED` requests
    /// already wait: the call for a verb a person is waiting on.
    ///
    /// # Errors
    /// see `RequestError`.
    pub async fn try_request(&self, request: Allowed) -> Result<Response, RequestError> {
        let permit = Arc::clone(&self.admission)
            .try_acquire_owned()
            .map_err(|_| RequestError::Busy {
                retry_after: BUSY_RETRY_AFTER,
            })?;
        self.submit(request, permit).await
    }

    /// the connection's state as it changes.
    #[must_use]
    pub fn state(&self) -> watch::Receiver<ConnectionState> {
        self.state.clone()
    }

    async fn submit(
        &self,
        request: Allowed,
        permit: OwnedSemaphorePermit,
    ) -> Result<Response, RequestError> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command {
                request,
                reply,
                permit,
            })
            .await
            .map_err(|_| RequestError::Stopped)?;
        answer.await.map_err(|_| RequestError::Stopped)?
    }
}

pub(super) fn admission() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(MAX_IN_FLIGHT + MAX_QUEUED))
}

/// one item of the event stream.
#[derive(Debug)]
pub enum Event {
    /// a `hello-ok` was accepted; every frame after this belongs to the new
    /// socket. sent on every connect, first or not.
    Connected(Arc<Hello>),
    /// one gateway event frame (`chat`, `session.message`, `health`, ...).
    Frame(Frame),
    /// the socket is gone; requests in flight answered `Lost`. subscriptions
    /// died with it (5.8).
    Disconnected { why: String },
}

/// an accepted `hello-ok` and what boxbox made of it.
#[derive(Debug)]
#[allow(
    clippy::struct_field_names,
    clippy::struct_excessive_bools,
    reason = "`hello` is the gateway's own hello-ok; each flag is a separate fact a consumer reads"
)]
pub struct Hello {
    pub hello: HelloOk,
    /// the boot id of the gateway process boxbox saw last on this
    /// connection, if any.
    pub previous_boot_id: Option<String>,
    /// the gateway restarted since the last hello (5.8): its `bootId`
    /// changed, or with no boot id its uptime went backwards. false on the
    /// first hello of a connection.
    pub restarted: bool,
    /// `server.version` differs from the pin (2.5).
    pub untested: bool,
    /// the hello handed this device a device token (kept in
    /// `source_secrets`, and taken out of `hello` so it travels nowhere).
    pub got_device_token: bool,
    /// this connect presented the kept device token (a paired device), not
    /// the shared token (3.4).
    pub used_device_token: bool,
    /// requested scopes the gateway did not grant (3.3 step 7).
    pub missing_scopes: Vec<&'static str>,
    pub methods: BTreeSet<String>,
    pub events: BTreeSet<String>,
}

impl Hello {
    /// whether `method` is offered (`features.methods`, 2.5).
    #[must_use]
    pub fn offers(&self, method: &str) -> bool {
        self.methods.contains(method)
    }
}

/// a gateway event frame. its bytes count against the stream's budget
/// until it is dropped.
#[derive(Debug)]
pub struct Frame {
    pub event: String,
    /// the gateway's outer sequence; `None` on targeted events.
    pub seq: Option<u64>,
    /// set when `seq` skipped numbers since the last frame on this socket
    /// (a dropped `dropIfSlow` frame, 5.1): the first missing and how many.
    pub gap: Option<(u64, u64)>,
    pub payload: Option<Box<RawValue>>,
    pub(super) _budget: Option<OwnedSemaphorePermit>,
}

impl Frame {
    /// the payload as `T`.
    ///
    /// # Errors
    /// the payload is absent or does not match `T`.
    pub fn decode<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        let text = self.payload.as_deref().map_or("null", RawValue::get);
        serde_json::from_str(text)
    }
}

/// the one event stream of a connection, across every reconnect.
#[derive(Debug)]
pub struct Events {
    pub(super) receiver: mpsc::Receiver<Event>,
    pub(super) budget: Arc<Semaphore>,
}

/// how full the event stream is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backlog {
    pub frames: usize,
    pub bytes: usize,
}

impl Backlog {
    /// past half of either bound: shed subscriptions now (5.8).
    #[must_use]
    pub fn past_half(&self) -> bool {
        self.frames * 2 > EVENT_FRAMES || self.bytes * 2 > EVENT_BYTES
    }
}

impl Events {
    /// the next event; `None` once the connection task has stopped.
    pub async fn recv(&mut self) -> Option<Event> {
        self.receiver.recv().await
    }

    #[must_use]
    pub fn backlog(&self) -> Backlog {
        Backlog {
            frames: self.receiver.len(),
            bytes: EVENT_BYTES.saturating_sub(self.budget.available_permits()),
        }
    }
}

pub(super) fn events() -> (mpsc::Sender<Event>, Events) {
    let (sender, receiver) = mpsc::channel(EVENT_FRAMES);
    let budget = Arc::new(Semaphore::new(EVENT_BYTES));
    (sender, Events { receiver, budget })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_refusals_before_the_socket_are_safe_to_retry_blindly() {
        assert!(RequestError::NotConnected.never_sent());
        assert!(
            RequestError::Busy {
                retry_after: BUSY_RETRY_AFTER
            }
            .never_sent()
        );
        assert!(
            RequestError::Watch {
                method: "chat.send"
            }
            .never_sent()
        );
        assert!(
            !RequestError::Timeout {
                method: "chat.send"
            }
            .never_sent()
        );
        assert!(
            !RequestError::Lost {
                method: "chat.send"
            }
            .never_sent()
        );
    }

    #[test]
    fn the_backlog_is_past_half_on_either_bound() {
        assert!(
            !Backlog {
                frames: 2048,
                bytes: 0
            }
            .past_half()
        );
        assert!(
            Backlog {
                frames: 2049,
                bytes: 0
            }
            .past_half()
        );
        assert!(
            Backlog {
                frames: 1,
                bytes: EVENT_BYTES / 2 + 1
            }
            .past_half()
        );
    }

    #[tokio::test]
    async fn try_request_is_busy_once_the_queue_is_full_and_request_waits() {
        let (commands, mut held) = mpsc::channel(64);
        let (_tx, state) = watch::channel(ConnectionState::default());
        let client = Client {
            commands,
            admission: admission(),
            state,
        };
        // fill every slot with requests the test never answers
        let mut waiting = Vec::new();
        for _ in 0..MAX_IN_FLIGHT + MAX_QUEUED {
            let client = client.clone();
            waiting.push(tokio::spawn(async move {
                client.request(Allowed::AgentsList).await
            }));
        }
        let mut commands = Vec::new();
        for _ in 0..MAX_IN_FLIGHT + MAX_QUEUED {
            commands.push(held.recv().await.expect("a command"));
        }
        assert!(matches!(
            client.try_request(Allowed::AgentsList).await,
            Err(RequestError::Busy { .. })
        ));
        // answering one frees one slot
        let first = commands.remove(0);
        let _ = first.reply.send(Ok(Response { payload: None }));
        drop(first.permit);
        let next = tokio::spawn({
            let client = client.clone();
            async move { client.try_request(Allowed::AgentsList).await }
        });
        let command = held.recv().await.expect("the freed slot is used");
        let _ = command.reply.send(Err(RequestError::NotConnected));
        assert!(matches!(
            next.await.expect("joins"),
            Err(RequestError::NotConnected)
        ));
        for task in waiting {
            task.abort();
        }
    }
}
