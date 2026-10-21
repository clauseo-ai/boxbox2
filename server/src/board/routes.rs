//! the board's routes (`docs/board.md`, the channel), registered only with
//! `[board]` in `boxbox.toml` and behind the gate like every api route:
//!
//! - the board view of `GET /api/stream` (`?view=board&protocol=3&device=…`,
//!   `docs/protocol.md`, section 5, the board): the daemon's sse stream:
//!   `hello`, the view whenever it changes, `pin` when the app arms a
//!   pairing, `: hb` every 15 s, and `replaced` when another board stream
//!   takes over. no journal entries, no colours, no cursor; it takes no
//!   interest posts.
//! - `POST /api/board/act`: one verb. 204 when it was carried out: for a
//!   focus or a compose, when a window on the board's mac took it; for a
//!   reply or a flush, when the agent took it. so the daemon's telemetry
//!   `ok` is honest.
//! - `POST /api/board/pin`: from the app, arms the next digit pressed.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use boxbox_board_wire::{
    Act, Answer, AppFrame, Binding, Frame, PROTOCOL, PinRequest, Seat, StreamQuery,
};
use bytes::Bytes;
use tokio::sync::{mpsc, watch};
use tokio::time::{Interval, MissedTickBehavior, interval_at};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::{Board, Refused, addr, store};
use crate::fleet::Fleet;
use crate::fleet::board::{Holds, Wanted};
use crate::fleet::model::Device;
use crate::fleet::model::ReadRefused;
use crate::fleet::model::board::MAX_OPTIONS;
use crate::http::AppState;
use crate::http::agents::find;
use crate::http::agents::routes::answer_ask;
use crate::http::error::{ApiError, ErrorBody};
use crate::push::devices::is_device_id;
use crate::source::{Reply, ThreadRef};
use crate::wire::{AskKind, Capability};

const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
const HEARTBEAT: &[u8] = b": hb\n\n";
/// how long an armed pairing waits for a digit.
pub const PIN_MS: u32 = 30_000;
/// the device class a board's marks and answers carry.
const BOARD_CLASS: &str = "board";
/// a machine name in a compose, at most (`[board] machines`' rule).
const MAX_MACHINE: usize = 64;

fn board(state: &AppState) -> Result<&Arc<Board>, ApiError> {
    // the routes exist only with a board; this is the same answer as no route
    state.board.as_ref().ok_or(ApiError::NotFound)
}

fn refused(refusal: Refused) -> ApiError {
    match refusal {
        Refused::NoBoard => ApiError::NoBoard,
        Refused::NoWindow => ApiError::NoBoardWindow,
        Refused::Busy => ApiError::BoardBusy,
    }
}

/// a thread key as every route takes it: `<agent>:<thread>`, the agent
/// by `boxbox.toml`'s naming rule, the thread an id (cmx2's may hold `.`).
fn thread_of(key: &str) -> Result<ThreadRef, ApiError> {
    let fits = |agent: &str, id: &str| {
        crate::config::is_host_name(agent)
            && !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    };
    match key.split_once(':') {
        Some((agent, id)) if fits(agent, id) => Ok(ThreadRef {
            agent: agent.to_owned(),
            id: id.to_owned(),
        }),
        _ => Err(ApiError::BadRequest(format!(
            "\"{key}\" is not a thread; send agent:thread"
        ))),
    }
}

/// the board's view of `/api/stream`: daemon only, its frames are
/// `board/wire`'s (`http/stream.rs` hands the request here).
///
/// # Errors
/// no `[board]`, another protocol, a bad device or address list, the store
/// or the fleet down.
pub async fn view(
    state: Arc<AppState>,
    peer: SocketAddr,
    headers: &HeaderMap,
    uri: &axum::http::Uri,
) -> Result<Response, ApiError> {
    let board = Arc::clone(board(&state)?);
    let Query(query) = Query::<StreamQuery>::try_from_uri(uri)
        .map_err(|rejection| ApiError::BadRequest(rejection.body_text()))?;
    if query.protocol != PROTOCOL {
        return Err(ApiError::BoardProtocol {
            asked: query.protocol,
            speaks: PROTOCOL,
        });
    }
    if !is_device_id(&query.device) {
        return Err(ApiError::BadRequest(
            "device must be 1 to 64 letters, digits, - or _".into(),
        ));
    }
    let addrs = addr::list(&query.addrs).map_err(ApiError::BadRequest)?;
    let observed = addr::client(peer, headers);
    let bindings = state
        .store
        .call(|connection| store::load(connection))
        .await
        .map_err(|error| {
            warn!(%error, "the board's pairings could not be read");
            ApiError::StoreDown
        })?;
    // a request cancelled between here and the body leaves the projection to
    // the actor's next change, which finds no receiver and drops it: memory
    // for a moment, never a timer (`Fleet::board_left`)
    let view = state
        .fleet
        .board_subscribe(Wanted {
            machines: board.machines(),
            bindings,
            roster: Arc::new(state.upstreams.clone()),
        })
        .await
        .map_err(|_| ApiError::Stopping)?;
    let joined = board.join(&query.device, addrs, observed);
    let mut pending = VecDeque::new();
    pending.extend(super::encode(&Frame::Hello {
        protocol: PROTOCOL,
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }));
    let framed = if crate::http::compress::takes_gzip(headers) {
        state.gzip_streams.take()
    } else {
        None
    };
    let gzip = framed.is_some();
    let stream = BoardStream {
        gzip: framed,
        board,
        fleet: state.fleet.clone(),
        generation: joined.generation,
        view: Some(view),
        first: true,
        frames: joined.frames,
        replaced: joined.replaced,
        shutdown: state.shutdown.clone(),
        heartbeat: heartbeat(),
        pending,
        finished: false,
    };
    let body = futures_util::stream::unfold(stream, |mut stream| async move {
        let batch = stream.batch().await?;
        Some((batch, stream))
    });
    let mut response = Body::from_stream(body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    if gzip {
        crate::http::compress::mark_gzip(headers);
    }
    Ok(response)
}

fn heartbeat() -> Interval {
    let mut heartbeat = interval_at(
        tokio::time::Instant::now() + HEARTBEAT_EVERY,
        HEARTBEAT_EVERY,
    );
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    heartbeat
}

#[derive(Debug)]
struct BoardStream {
    board: Arc<Board>,
    fleet: Fleet,
    generation: u64,
    /// taken on drop, so the actor sees it gone when told.
    view: Option<watch::Receiver<Bytes>>,
    /// the view the receiver holds at subscribe is sent before any change.
    first: bool,
    frames: mpsc::Receiver<Bytes>,
    replaced: CancellationToken,
    shutdown: CancellationToken,
    heartbeat: Interval,
    pending: VecDeque<Bytes>,
    finished: bool,
    /// the connection's gzip context, when the client takes gzip.
    gzip: Option<crate::http::compress::Framed>,
}

/// a write gathers ready frames until it holds this much (as `/api/stream` does).
const BATCH_BYTES: usize = 64 * 1024;

impl BoardStream {
    /// the next write: one frame, waited for, every frame ready behind it up
    /// to `BATCH_BYTES`, compressed and sync-flushed when the client takes
    /// gzip. the same bytes in the same order as one write per frame.
    async fn batch(&mut self) -> Option<Result<Bytes, std::io::Error>> {
        let Some(first) = self.next().await else {
            return self.gzip.as_mut()?.finish().map(Ok);
        };
        let mut size = first.len();
        let mut batch = vec![first];
        while size < BATCH_BYTES {
            let Some(frame) = self.ready() else { break };
            size += frame.len();
            batch.push(frame);
        }
        let plain = if batch.len() == 1 {
            batch.pop().unwrap_or_default()
        } else {
            Bytes::from(batch.concat())
        };
        match self.gzip.as_mut() {
            None => Some(Ok(plain)),
            Some(gzip) => Some(gzip.batch(&plain)),
        }
    }

    /// a frame ready now, without waiting, in the order `next` prefers them;
    /// none once the stream is ending.
    fn ready(&mut self) -> Option<Bytes> {
        if let Some(frame) = self.pending.pop_front() {
            return Some(frame);
        }
        if self.finished
            || self.first
            || self.shutdown.is_cancelled()
            || self.replaced.is_cancelled()
        {
            return None;
        }
        if let Ok(frame) = self.frames.try_recv() {
            return Some(frame);
        }
        let view = self.view.as_mut()?;
        if view.has_changed().ok()? {
            return Some(view.borrow_and_update().clone());
        }
        None
    }

    async fn next(&mut self) -> Option<Bytes> {
        if let Some(frame) = self.pending.pop_front() {
            return Some(frame);
        }
        if self.finished {
            return None;
        }
        let view = self.view.as_mut()?;
        if self.first {
            self.first = false;
            let frame = view.borrow_and_update().clone();
            if !frame.is_empty() {
                return Some(frame);
            }
        }
        tokio::select! {
            biased;
            () = self.shutdown.cancelled() => {
                self.finished = true;
                Some(Bytes::from_static(HEARTBEAT))
            }
            // ahead of the frames: a replacement drops this stream's sender too
            () = self.replaced.cancelled() => {
                self.finished = true;
                super::encode(&Frame::Replaced)
            }
            frame = self.frames.recv() => frame,
            changed = view.changed() => match changed {
                Ok(()) => Some(view.borrow_and_update().clone()),
                Err(_) => None,
            },
            _ = self.heartbeat.tick() => Some(Bytes::from_static(HEARTBEAT)),
        }
    }
}

impl Drop for BoardStream {
    fn drop(&mut self) {
        drop(self.view.take());
        self.fleet.board_left();
        self.board.left(self.generation);
    }
}

/// one verb from the board: daemon only, like the stream.
pub async fn act(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(act): Json<Act>,
) -> Result<StatusCode, ApiError> {
    let board = board(&state)?;
    // every verb is the present board's: none is taken with no board here
    let device = board_device(board)?;
    match act {
        Act::Focus { key } => {
            thread_of(&key)?;
            if !holds(&state, Holds::Thread(key.clone())).await? {
                return Err(ApiError::NoSuchSession(key));
            }
            board.relay(&AppFrame::Focus { key }).map_err(refused)?;
        }
        Act::Compose { machine } => {
            if machine.trim().is_empty() || machine.chars().count() > MAX_MACHINE {
                return Err(ApiError::BadRequest(
                    "send the machine's name, as its light carries it".into(),
                ));
            }
            if !holds(&state, Holds::Machine(machine.clone())).await? {
                return Err(ApiError::NoSuchMachine(machine));
            }
            board
                .relay(&AppFrame::Compose { machine })
                .map_err(refused)?;
        }
        Act::Read { key } => {
            thread_of(&key)?;
            match state
                .fleet
                .board_read(key, device)
                .await
                .map_err(|_| ApiError::Stopping)?
            {
                Ok(()) => {}
                Err(ReadRefused::NoSuchSession(key)) => return Err(ApiError::NoSuchSession(key)),
            }
        }
        Act::Reply { key, ask, answer } => reply(&state, device, &key, ask, answer).await?,
        Act::Flush { key } => flush(&state, &key).await?,
        Act::Seats { seats } => {
            check_seats(&seats)?;
            board.seats(seats).map_err(refused)?;
        }
        Act::Bind(binding) => {
            check_wire(binding.wire)?;
            thread_of(&binding.key)?;
            let at = crate::now_ms();
            let bindings = state
                .store
                .call(move |connection| store::bind(connection, &binding, at))
                .await
                .map_err(|e| store_down(&e))?;
            pairings(&state, bindings).await?;
        }
        Act::Unbind { wire } => {
            check_wire(wire)?;
            let bindings = state
                .store
                .call(move |connection| store::unbind(connection, wire))
                .await
                .map_err(|e| store_down(&e))?;
            pairings(&state, bindings).await?;
        }
        Act::Gone => board.gone(addr::client(peer, &headers)),
    }
    Ok(StatusCode::NO_CONTENT)
}

/// whether the fleet holds a thread, or the board's view a machine light:
/// a focus or a compose for neither would reach a window and answer 204
/// for nothing.
async fn holds(state: &AppState, what: Holds) -> Result<bool, ApiError> {
    state
        .fleet
        .board_holds(what)
        .await
        .map_err(|_| ApiError::Stopping)
}

fn board_device(board: &Board) -> Result<Device, ApiError> {
    let id = board.device().ok_or(ApiError::NoBoard)?;
    Ok(Device {
        id,
        class: BOARD_CLASS.to_owned(),
    })
}

fn store_down(error: &crate::store::StoreError) -> ApiError {
    warn!(%error, "the board's pairings could not be written");
    ApiError::StoreDown
}

async fn pairings(state: &AppState, bindings: Vec<Binding>) -> Result<(), ApiError> {
    info!(pairs = bindings.len(), "the board's pairings changed");
    state
        .fleet
        .board_bindings(bindings)
        .await
        .map_err(|_| ApiError::Stopping)
}

fn check_wire(wire: u8) -> Result<(), ApiError> {
    if store::is_digit_wire(wire) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "wire {wire} is not a digit key; pair 1 to 9 only"
        )))
    }
}

fn check_seats(seats: &[Seat]) -> Result<(), ApiError> {
    if seats.len() > 9 {
        return Err(ApiError::BadRequest("send at most nine seats".into()));
    }
    for (at, seat) in seats.iter().enumerate() {
        if !(1..=9).contains(&seat.digit) || seats[..at].iter().any(|s| s.digit == seat.digit) {
            return Err(ApiError::BadRequest(
                "each seat takes its own digit, 1 to 9".into(),
            ));
        }
        thread_of(&seat.key)?;
    }
    Ok(())
}

/// answers an ask from the pit, through contract 2's answer path.
async fn reply(
    state: &AppState,
    device: Device,
    key: &str,
    ask: String,
    answer: Answer,
) -> Result<(), ApiError> {
    let thread = thread_of(key)?;
    crate::http::asks::segment(&ask)?;
    let neutral = state
        .fleet
        .board_ask(thread.agent.clone(), ask.clone())
        .await
        .map_err(|_| ApiError::Stopping)?
        .filter(|a| a.key == key)
        .ok_or(ApiError::Gone)?;
    let (kind, reply) = match (neutral.kind, answer) {
        (AskKind::Permission, Answer::Once) => (AskKind::Permission, Reply::Option("once".into())),
        (AskKind::Permission, Answer::Always) => {
            (AskKind::Permission, Reply::Option("always".into()))
        }
        (AskKind::Permission, Answer::Reject) => {
            (AskKind::Permission, Reply::Option("reject".into()))
        }
        (AskKind::Question, Answer::Reject) => (AskKind::Question, Reply::Reject),
        (AskKind::Question, Answer::Option { index }) => {
            let options = crate::fleet::model::board::options_of(&neutral);
            let label = options.get(usize::from(index)).ok_or_else(|| {
                ApiError::BadRequest(format!(
                    "this question has {} options the keys can pick (at most {MAX_OPTIONS}); option {index} is not one",
                    options.len()
                ))
            })?;
            (AskKind::Question, Reply::Answers(vec![vec![label.clone()]]))
        }
        (AskKind::Permission, Answer::Option { .. }) => {
            return Err(ApiError::BadRequest(
                "a permission takes once, always or reject".into(),
            ));
        }
        (AskKind::Question, Answer::Once | Answer::Always) => {
            return Err(ApiError::BadRequest(
                "a question takes one of its options, or reject".into(),
            ));
        }
    };
    let client_id = format!("board-{:016x}", rand::random::<u64>());
    answer_ask(state, thread.agent, ask, kind, device, client_id, reply).await
}

/// stops the running turn and runs the queue now: the abort and run-now
/// verbs, in that order, as a person's own action.
async fn flush(state: &AppState, key: &str) -> Result<(), ApiError> {
    let thread = thread_of(key)?;
    let found = find(state, &thread.agent)?;
    found.needs(Capability::Queue)?;
    state
        .fleet
        .own_action(thread.key())
        .await
        .map_err(|_| ApiError::Stopping)?;
    found
        .source
        .abort(&thread)
        .await
        .map_err(|e| found.refusal(Some(&thread.id), e))?;
    found
        .source
        .run_now(&thread)
        .await
        .map_err(|e| found.refusal(Some(&thread.id), e))
}

/// arms the board: the next digit key pressed pairs with this thread.
#[utoipa::path(
    post,
    path = "/api/board/pin",
    request_body = PinRequest,
    responses(
        (status = 204, description = "armed: the next digit pressed on the board pairs with the thread, for 30 s"),
        (status = 400, description = "not a thread key", body = ErrorBody),
        (status = 404, description = "no `[board]` in boxbox.toml", body = ErrorBody),
        (status = 409, description = "no board is here to arm", body = ErrorBody),
        (status = 503, description = "the board's stream is not reading; pair again in a moment", body = ErrorBody),
    ),
)]
pub async fn pin(
    State(state): State<Arc<AppState>>,
    Json(pin): Json<PinRequest>,
) -> Result<StatusCode, ApiError> {
    let board = board(&state)?;
    thread_of(&pin.key)?;
    board
        .to_board(&Frame::Pin {
            key: pin.key,
            color: pin.color,
            expires_in_ms: PIN_MS,
        })
        .map_err(refused)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests;
