//! `GET /api/stream`: the fleet as one sse stream with a cursor, and
//! `POST /api/stream/{stream}/interest`, what the stream shows.
//!
//! a client sends its cursor (`Last-Event-ID`, or `?after=` where a header
//! cannot be set) and what it shows (`thread`, `under`, `holds`, with
//! `since` for each of those it already holds), and gets `hello` (with the
//! stream's id), then the compact catch-up from its cursor ending in
//! `caught`, or, when the cursor cannot be caught up, a `reset` carrying the
//! whole fleet; then live entries: the overview, and the transcript of the
//! threads in its interest (`docs/protocol.md`, sections 2, 5 and 9). a
//! comment every 15 s keeps proxies and the client's 45 s watchdog content.
//!
//! the stream owns nothing but its place: the fleet actor opens it in one
//! step and hands it a live feed bounded at 512 kb of plain frames (its
//! queue in the actor; what hyper and the kernel already hold is on top,
//! see architecture.md, memory caps). an interest confirm arrives on the
//! same feed as one block, outside that cap: the stream moves it into its
//! `pending` queue and drains it before the next live frame, then says so,
//! which answers any post that waited for it. when the actor closes the
//! feed (the client stopped reading, or did not read a confirm within a
//! post's 30 s), the body ends with an error, so hyper drops the connection
//! instead of holding what it had buffered; the client resumes from its
//! cursor.
//!
//! hyper polls a body only when the socket takes bytes, so a reader that
//! is stalled, not gone, meets that error when it next reads. until then
//! the stream costs what it already held (its queue, at most the cap, and
//! hyper's write buffer) and nothing more: the actor feeds it no longer.
//!
//! `?view=board` is the board daemon's stream: board/wire's frames from the
//! board's projection, nothing of the journal (`board/routes.rs`).
//!
//! with `[board]` configured, a window that sends `board=1` also gets the
//! board's frames when it is on the board's mac (`board/mod.rs`): id-less
//! data lines outside the journal, never replayed, interleaved once the
//! stream is live. without `[board]` the flag is ignored.
//!
//! every stream gets repo colours (`fleet/colours.rs`), id-less too, but
//! from the fleet actor in journal order: the whole map after `hello`, then
//! each change ahead of the entry that first shows its repo.
//!
//! every frame ready when the socket takes bytes goes out in one write, up
//! to `BATCH_BYTES` (the queue, the live feed and the board's feed drained
//! in that order), so a burst costs one tls record and one radio wakeup,
//! not one per frame. the bytes are the same, in the same order. a client
//! that sends `Accept-Encoding: gzip` gets each batch through its own gzip
//! context, sync-flushed (`compress::Framed`), so nothing waits on the
//! next batch to decode.

use std::collections::{BTreeMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::time::{Interval, MissedTickBehavior, interval_at};
use tokio_util::sync::CancellationToken;
use tracing::info;
use utoipa::IntoParams;

use super::AppState;
use super::compress::{self, Framed};
use super::error::{ApiError, ErrorBody};
use crate::fleet::{Confirm, Feed, Fleet, From, Live, MAX_HOLDS, MAX_UNDER, Opening, Owner};
use crate::journal::Cursor;
use crate::wire::{Interest, InterestPost, StreamFrame};

const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
const HEARTBEAT: &[u8] = b": hb\n\n";
/// a write gathers ready frames until it holds this much; one frame larger
/// goes whole, alone.
const BATCH_BYTES: usize = 64 * 1024;
/// how long an interest post waits for the stream to read its last
/// confirm; past it the stream is stalled and closed.
pub const CONFIRM_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StreamQuery {
    /// the cursor, `<epoch>:<seq>`, for clients that cannot set
    /// `Last-Event-ID`; the header wins when both are sent.
    after: Option<String>,
    /// the open thread, `<agent>:<thread>`; absent for the overview only.
    thread: Option<String>,
    /// the layers under the stage, comma separated, at most 8.
    under: Option<String>,
    /// the children held for the stage and its layers, comma separated, at
    /// most 16.
    holds: Option<String>,
    /// for each interest key the client already holds, its `left`:
    /// `<key>:<seq>,<key>:<seq>`. ignored when the stream starts with a reset.
    since: Option<String>,
    /// a desktop window that would show the board's digits and obey its
    /// focus and compose (`docs/board.md`, where the board is). ignored
    /// unless the server has `[board]`.
    /// `board=1`, as the app sends it; `true` reads the same.
    #[serde(default, deserialize_with = "flag")]
    #[param(value_type = Option<bool>)]
    board: Option<bool>,
    /// `board`: the board daemon's stream, with `protocol`, `device` and
    /// `addrs` (board/wire's stream query); it gets board/wire's frames only.
    view: Option<String>,
    // the board view's own fields, here for the api document: the board's
    // route reads them with board/wire's query
    /// with `view=board`: the board protocol the daemon speaks; another
    /// than the server's answers 409.
    #[allow(dead_code, reason = "read by board/wire's query on the board view")]
    protocol: Option<u32>,
    /// with `view=board`: the daemon's device id.
    #[allow(dead_code, reason = "read by board/wire's query on the board view")]
    device: Option<String>,
    /// with `view=board`: every address of the board's mac, comma separated.
    #[allow(dead_code, reason = "read by board/wire's query on the board view")]
    addrs: Option<String>,
}

/// a query flag: `1` or `true` is on, `0` or `false` off.
fn flag<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<bool>, D::Error> {
    let text = Option::<String>::deserialize(deserializer)?;
    match text.as_deref() {
        None => Ok(None),
        Some("1" | "true") => Ok(Some(true)),
        Some("0" | "false") => Ok(Some(false)),
        Some(other) => Err(serde::de::Error::custom(format!(
            "a flag is 1 or 0, not \"{other}\""
        ))),
    }
}

/// a thread key as every route takes it: `<agent>:<thread>`, the agent by
/// `boxbox.toml`'s naming rule, the thread an id (cmx2's may hold `.`).
fn is_thread_key(key: &str) -> bool {
    key.split_once(':').is_some_and(|(agent, id)| {
        crate::config::is_host_name(agent)
            && !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    })
}

/// what a stream shows, checked: at most 8 layers and 16 holds, every key
/// well formed.
fn checked(
    thread: Option<String>,
    under: Vec<String>,
    holds: Vec<String>,
    since: &BTreeMap<String, u64>,
) -> Result<Interest, ApiError> {
    if under.len() > MAX_UNDER {
        return Err(ApiError::BadRequest(format!(
            "{} layers under the stage; send at most {MAX_UNDER}",
            under.len()
        )));
    }
    if holds.len() > MAX_HOLDS {
        return Err(ApiError::BadRequest(format!(
            "{} held children; send at most {MAX_HOLDS}",
            holds.len()
        )));
    }
    if let Some(bad) = thread
        .iter()
        .chain(&under)
        .chain(&holds)
        .chain(since.keys())
        .find(|key| !is_thread_key(key))
    {
        return Err(ApiError::BadRequest(format!(
            "\"{bad}\" is not a thread; send agent:thread"
        )));
    }
    Ok(Interest {
        thread,
        under,
        holds,
    })
}

fn list(text: Option<&str>) -> Vec<String> {
    text.map(|t| {
        t.split(',')
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

/// `<key>:<seq>,…`: the seq after the key's last colon.
fn since_list(text: Option<&str>) -> Result<BTreeMap<String, u64>, ApiError> {
    let mut since = BTreeMap::new();
    for item in list(text) {
        let parsed = item
            .rsplit_once(':')
            .and_then(|(key, seq)| Some((key.to_owned(), seq.parse::<u64>().ok()?)));
        let Some((key, seq)) = parsed else {
            return Err(ApiError::BadRequest(format!(
                "\"{item}\" is not a since; send agent:thread:seq"
            )));
        };
        since.insert(key, seq);
    }
    Ok(since)
}

/// the signed-in session asking, as the stream map keeps it: a digest of
/// its token, so the map holds no credential.
fn owner(state: &AppState, headers: &HeaderMap) -> Owner {
    let token = state.auth.token_in(headers).unwrap_or_default();
    Sha256::digest(token.as_bytes()).into()
}

/// the fleet, live.
#[utoipa::path(
    get,
    path = "/api/stream",
    params(
        StreamQuery,
        ("Last-Event-ID" = Option<String>, Header, description = "the id of the last frame applied, `<epoch>:<seq>`"),
    ),
    responses(
        (status = 200, description = "an sse stream: `hello`, then the catch-up ending in `caught` or a `reset`, then live entries; each frame's data is one of these (`view=board`: board/wire's frames instead)", body = StreamFrame, content_type = "text/event-stream"),
        (status = 400, description = "more than 8 layers or 16 holds, a malformed key or since, or a view other than board", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "`view=board` on a server without `[board]`", body = ErrorBody),
        (status = 409, description = "`view=board` with another board protocol than the server's: update the daemon", body = ErrorBody),
    ),
)]
pub async fn stream(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<StreamQuery>,
) -> Result<Response, ApiError> {
    match query.view.as_deref() {
        None => {}
        Some("board") => return crate::board::routes::view(state, peer, &headers, &uri).await,
        Some(other) => {
            return Err(ApiError::BadRequest(format!(
                "no view named \"{other}\"; send view=board or none"
            )));
        }
    }
    let since = since_list(query.since.as_deref())?;
    let interest = checked(
        query.thread.filter(|t| !t.is_empty()),
        list(query.under.as_deref()),
        list(query.holds.as_deref()),
        &since,
    )?;
    let board = match (&state.board, query.board) {
        (Some(board), Some(true)) => {
            let addr = crate::board::addr::client(peer, &headers);
            tracing::debug!(%addr, "a window asks for the board's frames");
            Some(board.window(addr))
        }
        _ => None,
    };
    let cursor = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or(query.after);
    let from = match cursor.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        None => From::Start,
        Some(text) => Cursor::parse(text).map_or(From::Malformed, From::At),
    };
    let id = rand::random::<u32>();
    // past the cap on gzip streams a client that takes gzip gets identity
    let framed = if compress::takes_gzip(&headers) {
        state.gzip_streams.take()
    } else {
        None
    };
    let gzip = framed.is_some();
    info!(stream = %format_args!("{id:08x}"), cursor = cursor.as_deref().unwrap_or("none"), thread = interest.thread.as_deref().unwrap_or("none"), under = interest.under.len(), holds = interest.holds.len(), since = since.len(), gzip, "client stream open");
    let opening = Opening {
        from,
        interest,
        since,
        owner: owner(&state, &headers),
        log: id,
    };
    let client = ClientStream::new(
        id,
        state.fleet.clone(),
        state.shutdown.clone(),
        opening,
        board,
        framed,
    );
    let body = futures_util::stream::unfold(client, |mut client| async move {
        let item = client.next().await?;
        Some((item, client))
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
        compress::mark_gzip(headers);
    }
    Ok(response)
}

/// what a stream shows from now on (`docs/protocol.md`, section 5): the
/// confirm arrives on the stream itself, its catch-up ahead of it.
#[utoipa::path(
    post,
    path = "/api/stream/{stream}/interest",
    params(("stream" = String, Path, description = "the stream's id, as its `hello` named it")),
    request_body = InterestPost,
    responses(
        (status = 202, description = "taken: its confirm (or none, for an `ask` not above the last applied) comes on the stream"),
        (status = 400, description = "more than 8 layers or 16 holds, or a malformed key", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "`no-such-stream`: it ended, is another session's or a board stream, or did not read its last confirm in 30 s; reconnect with the interest in the query", body = ErrorBody),
    ),
)]
pub async fn interest(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(stream): Path<String>,
    Json(post): Json<InterestPost>,
) -> Result<StatusCode, ApiError> {
    checked(
        post.thread.clone(),
        post.under.clone(),
        post.holds.clone(),
        &post.since,
    )?;
    let id = (stream.len() == 32
        && stream
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
    .then(|| u128::from_str_radix(&stream, 16).ok())
    .flatten()
    .ok_or(ApiError::NoSuchStream)?;
    confirmed(&state.fleet, id, owner(&state, &headers), post).await
}

/// a post taken by the actor, waiting while the stream's last confirm block
/// is unread: until that block drains, or is `CONFIRM_WAIT` old counted
/// from when the actor handed it to the stream (not from when this post
/// came), and then the stream is stalled and closed.
async fn confirmed(
    fleet: &Fleet,
    id: u128,
    owner: Owner,
    post: InterestPost,
) -> Result<StatusCode, ApiError> {
    loop {
        let confirm = fleet
            .interest(id, owner, post.clone())
            .await
            .map_err(|_| ApiError::Stopping)?;
        match confirm {
            Confirm::Applied | Confirm::Older => return Ok(StatusCode::ACCEPTED),
            Confirm::NoSuchStream => return Err(ApiError::NoSuchStream),
            Confirm::Busy {
                drained,
                closed,
                handed,
                ask,
            } => {
                // a block drained at the deadline counts as drained
                tokio::select! {
                    biased;
                    () = drained.cancelled() => {}
                    () = closed.cancelled() => {}
                    () = tokio::time::sleep_until(handed + CONFIRM_WAIT) => {
                        fleet.stalled(id, ask).await.map_err(|_| ApiError::Stopping)?;
                        return Err(ApiError::NoSuchStream);
                    }
                }
            }
        }
    }
}

/// why a stream's body ended early; hyper drops the connection on it.
#[derive(Debug, thiserror::Error)]
enum Closed {
    #[error(
        "the fleet closed the stream: it fell 512 KB of plain frames behind, or did not read its interest confirm in 30 s"
    )]
    Behind,
    #[error("the fleet stopped feeding the stream")]
    Gone,
    #[error("the stream's gzip failed: {0}")]
    Gzip(std::io::Error),
}

/// a frame waiting to be written, or the end of a confirm block.
#[derive(Debug)]
enum Pending {
    Frame(Bytes),
    /// the confirm block before it has been taken: say so.
    Drained(CancellationToken),
}

#[derive(Debug)]
struct ClientStream {
    id: u32,
    fleet: Fleet,
    shutdown: CancellationToken,
    /// what it asks for when it opens; taken by the open.
    opening: Option<Opening>,
    /// its id in the stream map, once open.
    stream: Option<u128>,
    pending: VecDeque<Pending>,
    live: Option<Live>,
    /// the board's frames for this window, when it asked and a board is configured.
    board: Option<crate::board::WindowFeed>,
    heartbeat: Option<Interval>,
    finished: bool,
    /// the connection's gzip context, when the client takes gzip.
    gzip: Option<Framed>,
    opened: Instant,
    frames: u64,
    /// frame bytes before compression.
    bytes: u64,
    /// bytes written to the socket.
    wire: u64,
    ended: &'static str,
}

impl ClientStream {
    fn new(
        id: u32,
        fleet: Fleet,
        shutdown: CancellationToken,
        opening: Opening,
        board: Option<crate::board::WindowFeed>,
        gzip: Option<Framed>,
    ) -> Self {
        Self {
            id,
            fleet,
            shutdown,
            opening: Some(opening),
            stream: None,
            pending: VecDeque::new(),
            live: None,
            board,
            heartbeat: None,
            finished: false,
            gzip,
            opened: Instant::now(),
            frames: 0,
            bytes: 0,
            wire: 0,
            ended: "the client went away",
        }
    }

    /// the next write: one frame, waited for, and every frame ready behind
    /// it up to `BATCH_BYTES`, compressed when the client takes gzip.
    async fn next(&mut self) -> Option<Result<Bytes, Closed>> {
        let first = match self.frame().await {
            Some(Ok(frame)) => frame,
            Some(Err(closed)) => return Some(Err(closed)),
            None => {
                let trailer = self.gzip.as_mut().and_then(Framed::finish)?;
                self.wire += trailer.len() as u64;
                return Some(Ok(trailer));
            }
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
        let out = match self.gzip.as_mut().map(|gzip| gzip.batch(&plain)) {
            None => plain,
            Some(Ok(zipped)) => zipped,
            Some(Err(error)) => {
                self.ended = "its gzip failed";
                return Some(Err(Closed::Gzip(error)));
            }
        };
        self.wire += out.len() as u64;
        Some(Ok(out))
    }

    /// the next queued frame; the end of a confirm block on the way is said.
    fn queued(&mut self) -> Option<Bytes> {
        loop {
            match self.pending.pop_front()? {
                Pending::Frame(frame) => return Some(self.count(frame)),
                Pending::Drained(drained) => drained.cancel(),
            }
        }
    }

    /// a feed item: a frame to write, or a confirm block queued.
    fn took(&mut self, feed: Feed) -> Option<Bytes> {
        match feed {
            Feed::Frame(frame) => {
                if let Some(live) = &self.live {
                    live.queued.fetch_sub(frame.len(), Ordering::AcqRel);
                }
                Some(self.count(frame))
            }
            Feed::Block { frames, drained } => {
                self.pending.extend(frames.into_iter().map(Pending::Frame));
                self.pending.push_back(Pending::Drained(drained));
                self.queued()
            }
        }
    }

    /// a frame that is ready now, without waiting: the queue first, then
    /// the live feed, then the board's. none before the stream is open or
    /// once it is finishing.
    fn ready(&mut self) -> Option<Bytes> {
        if let Some(frame) = self.queued() {
            return Some(frame);
        }
        if self.finished || self.shutdown.is_cancelled() {
            return None;
        }
        let live = self.live.as_mut()?;
        if live.closed.is_cancelled() {
            return None;
        }
        if let Ok(feed) = live.frames.try_recv() {
            return self.took(feed).or_else(|| self.ready());
        }
        let frame = self.board.as_mut()?.frames.try_recv().ok()?;
        Some(self.count(frame))
    }

    /// one frame, waited for.
    async fn frame(&mut self) -> Option<Result<Bytes, Closed>> {
        loop {
            if let Some(frame) = self.queued() {
                return Some(Ok(frame));
            }
            if self.finished {
                return None;
            }
            let Some(live) = &mut self.live else {
                if self.shutdown.is_cancelled() {
                    self.ended = "the server is stopping";
                    return None;
                }
                let opening = self.opening.take()?;
                let Ok(opened) = self.fleet.open(opening).await else {
                    self.ended = "the server is stopping";
                    return None;
                };
                self.pending
                    .extend(opened.frames.into_iter().map(Pending::Frame));
                self.stream = Some(opened.stream);
                self.live = Some(opened.live);
                let mut heartbeat = interval_at(
                    tokio::time::Instant::now() + HEARTBEAT_EVERY,
                    HEARTBEAT_EVERY,
                );
                heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
                self.heartbeat = Some(heartbeat);
                continue;
            };
            let heartbeat = self.heartbeat.as_mut()?;
            tokio::select! {
                biased;
                () = live.closed.cancelled() => {
                    self.ended = "the fleet closed it: 512 KB of plain frames behind, or an interest confirm unread for 30 s";
                    return Some(Err(Closed::Behind));
                }
                () = self.shutdown.cancelled() => {
                    // a last word, so the client resumes at once instead of waiting out its watchdog
                    self.finished = true;
                    self.ended = "the server is stopping";
                    return Some(Ok(self.count(Bytes::from_static(HEARTBEAT))));
                }
                feed = live.frames.recv() => {
                    let Some(feed) = feed else {
                        self.ended = "the fleet stopped";
                        return Some(Err(Closed::Gone));
                    };
                    if let Some(frame) = self.took(feed) {
                        return Some(Ok(frame));
                    }
                }
                Some(frame) = next_board(self.board.as_mut()) => return Some(Ok(self.count(frame))),
                _ = heartbeat.tick() => return Some(Ok(self.count(Bytes::from_static(HEARTBEAT)))),
            }
        }
    }

    fn count(&mut self, frame: Bytes) -> Bytes {
        self.frames += 1;
        self.bytes += frame.len() as u64;
        frame
    }
}

/// the next board frame; pending for good when the window has no feed.
async fn next_board(feed: Option<&mut crate::board::WindowFeed>) -> Option<Bytes> {
    match feed {
        Some(feed) => feed.frames.recv().await,
        None => std::future::pending().await,
    }
}

impl Drop for ClientStream {
    fn drop(&mut self) {
        // a post waiting on this stream's confirm stops waiting, and the map lets it go
        if let Some(live) = &self.live {
            live.closed.cancel();
        }
        if let Some(stream) = self.stream {
            self.fleet.stream_ended(stream);
        }
        info!(
            stream = %format_args!("{:08x}", self.id),
            frames = self.frames,
            bytes = self.bytes,
            wire = self.wire,
            open_ms = u64::try_from(self.opened.elapsed().as_millis()).unwrap_or(u64::MAX),
            reason = self.ended,
            "client stream closed"
        );
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write;

    use tokio::sync::{mpsc, watch};

    use super::*;
    use crate::fleet::{self, Upstream};

    pub(crate) fn real_fleet(
        shutdown: &CancellationToken,
    ) -> (Fleet, watch::Sender<Vec<crate::push::presence::Looking>>) {
        let (looking_tx, looking) = watch::channel(Vec::new());
        let (fleet, _task) = fleet::spawn(
            "test".into(),
            fleet::Wiring {
                push: crate::push::Push::detached(),
                telemetry: crate::telemetry::Sender::detached(),
                store: crate::store::Store::detached(),
                looking,
                needs: fleet::needs::Needs::default(),
                reads: fleet::read::Reads::default(),
                clears: fleet::clears::Clears::default(),
                adopted: Vec::new(),
                colours: fleet::colours::Colours::default(),
                tails: mpsc::channel(fleet::TAIL_REQUESTS).0,
                resumed: fleet::persist::Resumed::fresh(),
            },
            shutdown.clone(),
        );
        (fleet, looking_tx)
    }

    /// a thread event for session `id`, as a cmx2 source sends one.
    fn thread(id: &str) -> Upstream {
        titled(
            id,
            &format!("thread {id} with a title long enough to repeat"),
        )
    }

    /// the same with its title.
    fn titled(id: &str, title: &str) -> Upstream {
        let title = serde_json::to_string(title).unwrap();
        let info = serde_json::value::RawValue::from_string(format!(
            r#"{{"id":"{id}","slug":"s","projectID":"/w","directory":"/w","title":{title},"version":"0","source":"cmx2","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":{{"created":1,"updated":2}}}}"#
        ))
        .unwrap();
        let thread = crate::source::cmx2::translate::thread_from_json(info).unwrap();
        Upstream::Source {
            connection: Arc::from("desk"),
            agent: Arc::from("desk"),
            seq: None,
            event: crate::source::SourceEvent::Thread {
                thread: Box::new(thread),
                born: true,
            },
        }
    }

    fn open(fleet: &Fleet, shutdown: &CancellationToken, gzip: bool) -> ClientStream {
        ClientStream::new(
            rand::random(),
            fleet.clone(),
            shutdown.clone(),
            Opening {
                from: From::Start,
                interest: Interest::default(),
                since: BTreeMap::new(),
                owner: [0; 32],
                log: 0,
            },
            None,
            gzip.then(Framed::new),
        )
    }

    async fn write(stream: &mut ClientStream) -> Bytes {
        tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .expect("a write was held back")
            .expect("the stream ended")
            .expect("the stream broke")
    }

    /// the data frames in a write, each whole: the write ends at a frame's end.
    fn frames(write: &[u8]) -> Vec<String> {
        let text = std::str::from_utf8(write).unwrap();
        assert!(
            text.ends_with("\n\n"),
            "a write ends inside a frame: {text:?}"
        );
        text.split_terminator("\n\n").map(str::to_owned).collect()
    }

    #[tokio::test]
    async fn a_burst_goes_out_in_one_write_whole_and_in_order_and_gzip_decodes_each_write_on_arrival_to_the_same_bytes()
     {
        let shutdown = CancellationToken::new();
        let (fleet, _looking) = real_fleet(&shutdown);
        let mut plain = open(&fleet, &shutdown, false);
        let mut zipped = open(&fleet, &shutdown, true);
        let mut decoder = flate2::write::GzDecoder::new(Vec::new());
        let mut unzip = |write: &[u8]| -> Vec<u8> {
            decoder.write_all(write).unwrap();
            decoder.flush().unwrap();
            std::mem::take(decoder.get_mut())
        };
        let (mut sent, mut wire) = (0usize, 0usize);
        // hello, the colour map and the reset, read as one page
        let first = write(&mut plain).await;
        let first_zipped = write(&mut zipped).await;
        assert_eq!(frames(&first).len(), 3);
        // each stream's hello names its own id; the rest is the same bytes
        let unnamed = |bytes: &[u8]| {
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            let at = text.find("\"stream\":\"").unwrap() + "\"stream\":\"".len();
            format!("{}{}", &text[..at], &text[at + 32..])
        };
        assert_eq!(
            unnamed(&unzip(&first_zipped)),
            unnamed(&first),
            "the first write did not decode on arrival"
        );
        (sent, wire) = (sent + first.len(), wire + first_zipped.len());
        for round in 0..3 {
            for n in 0..40 {
                fleet
                    .upstream()
                    .send(thread(&format!("s{round}_{n}")))
                    .await
                    .unwrap();
            }
            // the actor has journaled the burst when a read answers behind it
            fleet.snapshot().await.unwrap();
            let burst = write(&mut plain).await;
            let seqs: Vec<u64> = frames(&burst)
                .iter()
                .map(|frame| {
                    let id = frame
                        .strip_prefix("id: ")
                        .unwrap()
                        .split('\n')
                        .next()
                        .unwrap();
                    id.rsplit(':').next().unwrap().parse().unwrap()
                })
                .collect();
            // every entry the burst made (a session and the order it moved), in one write
            assert!(
                seqs.len() >= 40,
                "the burst took more than one write: {seqs:?}"
            );
            assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "{seqs:?}");
            let burst_zipped = write(&mut zipped).await;
            assert_eq!(
                unzip(&burst_zipped),
                burst.to_vec(),
                "round {round} did not decode on arrival"
            );
            (sent, wire) = (sent + burst.len(), wire + burst_zipped.len());
        }
        assert!(wire * 4 < sent, "{wire} on the wire for {sent}");
        assert_eq!((plain.bytes, plain.wire), (sent as u64, sent as u64));
        assert_eq!(zipped.wire, wire as u64);
        // a stopping server: the last heartbeat, then the trailer, and the whole body checks out
        shutdown.cancel();
        let last = write(&mut zipped).await;
        assert_eq!(unzip(&last), HEARTBEAT.to_vec());
        let trailer = write(&mut zipped).await;
        decoder.write_all(&trailer).unwrap();
        assert!(decoder.finish().unwrap().is_empty());
        assert!(zipped.next().await.is_none());
    }

    #[tokio::test]
    async fn the_route_gzips_for_a_client_that_takes_it_and_sends_plain_bytes_to_one_that_does_not()
    {
        use std::io::Read;
        let shutdown = CancellationToken::new();
        let (fleet, _looking) = real_fleet(&shutdown);
        let addr = crate::http::tests::serve_state(
            Duration::from_secs(1),
            crate::upstream::Upstreams::fixed(Vec::new(), Vec::new(), Vec::new()),
            crate::source::sends::Sends::new(mpsc::channel(1).0),
            crate::media::Media::detached(),
            crate::store::Store::detached(),
            fleet,
        )
        .await;
        let cookie = crate::http::tests::sign_in(addr).await;
        let client = reqwest::Client::builder().no_gzip().build().unwrap();
        let open = |encoding: Option<&'static str>| {
            let mut request = client
                .get(format!("http://{addr}/api/stream"))
                .header("cookie", &cookie);
            if let Some(encoding) = encoding {
                request = request.header("accept-encoding", encoding);
            }
            request.send()
        };
        let mut plain = open(None).await.unwrap();
        assert!(plain.headers().get("content-encoding").is_none());
        let chunk = plain.chunk().await.unwrap().unwrap();
        assert!(chunk.starts_with(b"data: {\"type\":\"hello\""));
        let mut zipped = open(Some("gzip, deflate, br")).await.unwrap();
        assert_eq!(zipped.headers()["content-encoding"], "gzip");
        assert_eq!(zipped.headers()["vary"], "accept-encoding");
        assert_eq!(zipped.headers()["content-type"], "text/event-stream");
        let chunk = tokio::time::timeout(Duration::from_secs(2), zipped.chunk())
            .await
            .expect("the first write was held back")
            .unwrap()
            .unwrap();
        // the first write decodes alone, without the stream's end
        let mut decoder = flate2::read::GzDecoder::new(&chunk[..]);
        let mut text = Vec::new();
        let _ = decoder.read_to_end(&mut text);
        assert!(
            text.starts_with(b"data: {\"type\":\"hello\""),
            "{}",
            String::from_utf8_lossy(&text)
        );
        assert!(text.ends_with(b"\n\n"));
    }

    #[tokio::test]
    async fn past_64_gzip_streams_a_new_stream_is_identity_until_one_ends() {
        let shutdown = CancellationToken::new();
        let (fleet, _looking) = real_fleet(&shutdown);
        let addr = crate::http::tests::serve_state(
            Duration::from_secs(1),
            crate::upstream::Upstreams::fixed(Vec::new(), Vec::new(), Vec::new()),
            crate::source::sends::Sends::new(mpsc::channel(1).0),
            crate::media::Media::detached(),
            crate::store::Store::detached(),
            fleet,
        )
        .await;
        let cookie = crate::http::tests::sign_in(addr).await;
        let client = reqwest::Client::builder().no_gzip().build().unwrap();
        let open = || {
            client
                .get(format!("http://{addr}/api/stream"))
                .header("cookie", &cookie)
                .header("accept-encoding", "gzip")
                .send()
        };
        let zipped = |r: &reqwest::Response| r.headers().get("content-encoding").is_some();
        let mut held = Vec::new();
        for n in 0..compress::GZIP_STREAMS {
            let stream = open().await.unwrap();
            assert!(zipped(&stream), "stream {n} went plain under the cap");
            held.push(stream);
        }
        let mut plain = open().await.unwrap();
        assert_eq!(plain.status(), 200);
        assert!(!zipped(&plain), "a stream past the cap took gzip");
        assert!(plain.headers().get("vary").is_none());
        let chunk = plain.chunk().await.unwrap().unwrap();
        assert!(chunk.starts_with(b"data: {\"type\":\"hello\""));
        // a plain stream holds no place: one gzip stream ending frees one
        drop(plain);
        drop(held.pop());
        let mut again = None;
        for _ in 0..50 {
            let stream = open().await.unwrap();
            if zipped(&stream) {
                again = Some(stream);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(again.is_some(), "the freed place was not taken again");
    }

    /// what one stalled client holds once the fleet stops feeding it: its
    /// connection never reads, the fleet streams on, and the stream's own
    /// count of bytes it handed hyper (`wire`, from its closing log line) is
    /// what sits in hyper's write buffer and the kernel's socket buffers; the
    /// actor's queue holds at most `OUTBOUND_CAP` of plain frames on top. a
    /// measurement, run by hand:
    /// `cargo test -p boxbox --bin boxbox -- --ignored stalled --nocapture`.
    #[tokio::test]
    #[ignore = "a measurement, not a check"]
    async fn a_stalled_client_holds_a_bounded_amount_with_gzip_and_without() {
        use std::sync::Mutex;
        use tokio::io::AsyncWriteExt;
        #[derive(Clone, Default)]
        struct Log(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Log {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let log = Log::default();
        let writer = log.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let _quiet = tracing::subscriber::set_default(subscriber);
        let shutdown = CancellationToken::new();
        let (fleet, _looking) = real_fleet(&shutdown);
        let addr = crate::http::tests::serve_state(
            Duration::from_secs(1),
            crate::upstream::Upstreams::fixed(Vec::new(), Vec::new(), Vec::new()),
            crate::source::sends::Sends::new(mpsc::channel(1).0),
            crate::media::Media::detached(),
            crate::store::Store::detached(),
            fleet.clone(),
        )
        .await;
        let cookie = crate::http::tests::sign_in(addr).await;
        let words = [
            "the", "fleet", "streams", "a", "reply", "while", "tool", "runs", "on", "desk", "and",
            "reads", "files",
        ];
        for gzip in [true, false] {
            let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
            let encoding = if gzip {
                "accept-encoding: gzip\r\n"
            } else {
                ""
            };
            socket
                .write_all(
                    format!(
                        "GET /api/stream HTTP/1.1\r\nhost: x\r\ncookie: {cookie}\r\n{encoding}\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            for n in 0..6_000usize {
                let title: Vec<&str> = (0..60)
                    .map(|w| words[(n * 7 + w * 13 + w * w) % words.len()])
                    .collect();
                fleet
                    .upstream()
                    .send(titled(
                        &format!("s{}", n % 40),
                        &format!("{n} {:016x} {}", rand::random::<u64>(), title.join(" ")),
                    ))
                    .await
                    .unwrap();
            }
            fleet.snapshot().await.unwrap();
            drop(socket);
            tokio::time::sleep(Duration::from_millis(200)).await;
            let text = String::from_utf8(std::mem::take(&mut *log.0.lock().unwrap())).unwrap();
            let line = text
                .lines()
                .find(|l| l.contains("client stream closed"))
                .expect("the stream closed");
            let field = |name: &str| -> u64 {
                line.split_whitespace()
                    .find_map(|f| f.strip_prefix(&format!("{name}=")))
                    .unwrap()
                    .parse()
                    .unwrap()
            };
            println!(
                "gzip {gzip}: handed hyper {} bytes ({} plain) before the stall; the actor's queue holds up to {} plain on top",
                field("wire"),
                field("bytes"),
                crate::fleet::OUTBOUND_CAP
            );
        }
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines, reason = "one route, every answer it gives")]
    async fn an_interest_post_is_taken_for_the_session_s_own_stream_and_refused_otherwise() {
        let shutdown = CancellationToken::new();
        let (fleet, _looking) = real_fleet(&shutdown);
        let addr = crate::http::tests::serve_state(
            Duration::from_secs(1),
            crate::upstream::Upstreams::fixed(Vec::new(), Vec::new(), Vec::new()),
            crate::source::sends::Sends::new(mpsc::channel(1).0),
            crate::media::Media::detached(),
            crate::store::Store::detached(),
            fleet,
        )
        .await;
        let cookie = crate::http::tests::sign_in(addr).await;
        let client = reqwest::Client::builder().no_gzip().build().unwrap();
        // a connect that declares more than 8 layers is refused before it streams
        let refused = client
            .get(format!(
                "http://{addr}/api/stream?thread=desk:s0&under={}",
                (1..=9)
                    .map(|n| format!("desk:s{n}"))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), 400);
        let mut stream = client
            .get(format!(
                "http://{addr}/api/stream?thread=desk:ses_1&since=desk:ses_1:0"
            ))
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(stream.status(), 200);
        let mut read = String::new();
        while !read.contains("\n\n") {
            let chunk = stream.chunk().await.unwrap().unwrap();
            read.push_str(std::str::from_utf8(&chunk).unwrap());
        }
        let hello: serde_json::Value =
            serde_json::from_str(read.lines().next().unwrap().strip_prefix("data: ").unwrap())
                .unwrap();
        assert_eq!(hello["interest"]["thread"], "desk:ses_1");
        let id = hello["stream"].as_str().unwrap().to_owned();
        let post = |id: &str, cookie: &str, body: serde_json::Value| {
            client
                .post(format!("http://{addr}/api/stream/{id}/interest"))
                .header("cookie", cookie)
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
        };
        let ok = post(&id, &cookie, serde_json::json!({"ask": 1, "thread": null}))
            .await
            .unwrap();
        assert_eq!(ok.status(), 202);
        // its confirm comes on the stream
        while !read.contains("\"type\":\"interest\"") {
            let chunk = stream.chunk().await.unwrap().unwrap();
            read.push_str(std::str::from_utf8(&chunk).unwrap());
        }
        let holds: Vec<String> = (0..17).map(|n| format!("desk:s{n}")).collect();
        let too_many = post(
            &id,
            &cookie,
            serde_json::json!({"ask": 2, "thread": null, "holds": holds}),
        )
        .await
        .unwrap();
        assert_eq!(too_many.status(), 400);
        let malformed = post(
            &id,
            &cookie,
            serde_json::json!({"ask": 2, "thread": "no key"}),
        )
        .await
        .unwrap();
        assert_eq!(malformed.status(), 400);
        let other = crate::http::tests::sign_in(addr).await;
        let theirs = post(&id, &other, serde_json::json!({"ask": 3, "thread": null}))
            .await
            .unwrap();
        assert_eq!(theirs.status(), 404);
        let body: serde_json::Value = serde_json::from_str(&theirs.text().await.unwrap()).unwrap();
        assert_eq!(body["error"]["code"], "no-such-stream");
        let unknown = post(
            &"0".repeat(32),
            &cookie,
            serde_json::json!({"ask": 3, "thread": null}),
        )
        .await
        .unwrap();
        assert_eq!(unknown.status(), 404);
        // the stream ended: no such stream
        drop(stream);
        let mut gone = 0;
        for _ in 0..50 {
            gone = post(&id, &cookie, serde_json::json!({"ask": 4, "thread": null}))
                .await
                .unwrap()
                .status()
                .as_u16();
            if gone == 404 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(gone, 404);
    }

    #[tokio::test(start_paused = true)]
    async fn a_post_s_wait_runs_from_when_the_block_was_handed_not_from_when_the_post_came() {
        let shutdown = CancellationToken::new();
        let (fleet, _looking) = real_fleet(&shutdown);
        let mut stream = open(&fleet, &shutdown, false);
        // hello: the stream is open and has its id
        let _ = write(&mut stream).await;
        let id = stream.stream.unwrap();
        let post = |ask: u64| InterestPost {
            ask,
            thread: Some("desk:ses_1".into()),
            under: Vec::new(),
            holds: Vec::new(),
            since: BTreeMap::new(),
        };
        // block 1 goes on the stream's channel, and the stream does not read it
        assert_eq!(
            confirmed(&fleet, id, [0; 32], post(1)).await.unwrap(),
            StatusCode::ACCEPTED
        );
        let live = stream.live.as_ref().unwrap().closed.clone();
        tokio::time::sleep(Duration::from_secs(20)).await;
        // a post 20 s later waits for block 1's last 10 s, not 30 of its own
        let late = tokio::spawn({
            let fleet = fleet.clone();
            async move { confirmed(&fleet, id, [0; 32], post(2)).await }
        });
        tokio::time::sleep(Duration::from_secs(11)).await;
        assert!(late.is_finished(), "the late post got a fresh 30 s");
        assert!(matches!(late.await.unwrap(), Err(ApiError::NoSuchStream)));
        assert!(live.is_cancelled(), "the stalled stream stayed open");
    }

    #[test]
    fn gzip_is_taken_only_when_asked_for_with_a_quality_above_zero() {
        let headers = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::ACCEPT_ENCODING,
                HeaderValue::from_str(value).unwrap(),
            );
            headers
        };
        for yes in [
            "gzip",
            "gzip, deflate, br",
            "br;q=1.0, GZIP;q=0.5",
            "deflate, gzip",
        ] {
            assert!(compress::takes_gzip(&headers(yes)), "{yes}");
        }
        for no in [
            "br",
            "identity",
            "gzip;q=0",
            "deflate, gzip; q=0.0",
            "x-gzip-not",
        ] {
            assert!(!compress::takes_gzip(&headers(no)), "{no}");
        }
        assert!(!compress::takes_gzip(&HeaderMap::new()));
    }
}
