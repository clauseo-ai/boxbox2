//! `GET /api/stream`: the fleet as one sse stream with a cursor.
//!
//! a client sends its cursor (`Last-Event-ID`, or `?after=` where a header
//! cannot be set) and gets `hello`, then every journal entry after the
//! cursor, then live entries; or, when the cursor cannot be replayed, a
//! `reset` carrying the whole fleet, then live entries. a comment every
//! 15 s keeps proxies and the client's 45 s watchdog content.
//!
//! the stream owns nothing but its place: the fleet actor hands it pages
//! and then a live feed bounded at 512 kb of plain frames (its queue in the
//! actor; what hyper and the kernel already hold is on top, see
//! architecture.md, memory caps). when the actor closes that feed
//! (the client stopped reading), the body ends with an error, so hyper
//! drops the connection instead of holding what it had buffered; the
//! client resumes from its cursor.
//!
//! hyper polls a body only when the socket takes bytes, so a reader that
//! is stalled, not gone, meets that error when it next reads. until then
//! the stream costs what it already held (its queue, at most the cap, and
//! hyper's write buffer) and nothing more: the actor feeds it no longer.
//!
//! with `[board]` configured, a window that sends `board=1` also gets the
//! board's frames when it is on the board's mac (`board/mod.rs`): id-less
//! data lines outside the journal, never replayed, interleaved once the
//! stream is live. without `[board]` the flag is ignored.
//!
//! a stream that sends `colours=1` also gets repo colours
//! (`fleet/colours.rs`), id-less too, but from the fleet actor in journal
//! order: the whole map after `hello` and before any page it moved under,
//! then each change ahead of the entry that first shows its repo.
//!
//! every frame ready when the socket takes bytes goes out in one write, up
//! to `BATCH_BYTES` (the queue, the live feed and the board's feed drained
//! in that order), so a burst costs one tls record and one radio wakeup,
//! not one per frame. the bytes are the same, in the same order. a client
//! that sends `Accept-Encoding: gzip` gets each batch through its own gzip
//! context, sync-flushed (`compress::Framed`), so nothing waits on the
//! next batch to decode.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde::Deserialize;
use tokio::time::{Interval, MissedTickBehavior, interval_at};
use tokio_util::sync::CancellationToken;
use tracing::info;
use utoipa::IntoParams;

use super::AppState;
use super::compress::{self, Framed};
use super::error::ErrorBody;
use crate::fleet::change::StreamFrame;
use crate::fleet::{Fleet, From, Live};
use crate::journal::Cursor;

const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
const HEARTBEAT: &[u8] = b": hb\n\n";
/// a write gathers ready frames until it holds this much; one frame larger
/// goes whole, alone.
const BATCH_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StreamQuery {
    /// the cursor, `<epoch>:<seq>`, for clients that cannot set
    /// `Last-Event-ID`; the header wins when both are sent.
    after: Option<String>,
    /// a desktop window that would show the board's digits and obey its
    /// focus and compose (`docs/board.md`, where the board is). ignored
    /// unless the server has `[board]`.
    /// `board=1`, as the app sends it; `true` reads the same.
    #[serde(default, deserialize_with = "flag")]
    #[param(value_type = Option<bool>)]
    board: Option<bool>,
    /// `colours=1`: the stream also carries repo colours as id-less
    /// `ColourFrame`s outside the journal: the whole map after `hello`, then
    /// each change ahead of the entry that first shows its repo. a stream
    /// that does not ask gets contract 1 exactly as it was.
    #[serde(default, deserialize_with = "flag")]
    #[param(value_type = Option<bool>)]
    colours: Option<bool>,
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

/// the fleet, live.
#[utoipa::path(
    get,
    path = "/api/stream",
    params(
        StreamQuery,
        ("Last-Event-ID" = Option<String>, Header, description = "the id of the last frame applied, `<epoch>:<seq>`"),
    ),
    responses(
        (status = 200, description = "an sse stream: `hello`, then a replay or a `reset`, then live entries; each frame's data is one of these", body = StreamFrame, content_type = "text/event-stream"),
        (status = 401, description = "not signed in", body = ErrorBody),
    ),
)]
pub async fn stream(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<StreamQuery>,
) -> Response {
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
    let gzip = compress::takes_gzip(&headers);
    info!(stream = %format_args!("{id:08x}"), cursor = cursor.as_deref().unwrap_or("none"), gzip, "client stream open");
    let client = ClientStream {
        id,
        fleet: state.fleet.clone(),
        shutdown: state.shutdown.clone(),
        from: Some(from),
        next: None,
        pending: VecDeque::new(),
        live: None,
        board,
        colours: (query.colours == Some(true)).then_some(0),
        heartbeat: None,
        finished: false,
        gzip: gzip.then(Framed::new),
        opened: Instant::now(),
        frames: 0,
        bytes: 0,
        wire: 0,
        ended: "the client went away",
    };
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
    response
}

/// why a stream's body ended early; hyper drops the connection on it.
#[derive(Debug, thiserror::Error)]
enum Closed {
    #[error("the client fell 512 KB of plain frames behind in the fleet's queue")]
    Behind,
    #[error("the fleet stopped feeding the stream")]
    Gone,
    #[error("the stream's gzip failed: {0}")]
    Gzip(std::io::Error),
}

#[derive(Debug)]
struct ClientStream {
    id: u32,
    fleet: Fleet,
    shutdown: CancellationToken,
    /// where the first request starts; taken by it.
    from: Option<From>,
    /// where the next replay page starts.
    next: Option<Cursor>,
    pending: VecDeque<Bytes>,
    live: Option<Live>,
    /// the board's frames for this window, when it asked and a board is configured.
    board: Option<crate::board::WindowFeed>,
    /// for a stream that asked for repo colours, the version of the map it
    /// was sent last (0 before the first page).
    colours: Option<u64>,
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

    /// a frame that is ready now, without waiting: the queue first, then
    /// the live feed, then the board's. none while a page is still to be read
    /// or once the stream is finishing.
    fn ready(&mut self) -> Option<Bytes> {
        if let Some(frame) = self.pending.pop_front() {
            return Some(self.count(frame));
        }
        if self.finished || self.shutdown.is_cancelled() {
            return None;
        }
        let live = self.live.as_mut()?;
        if live.closed.is_cancelled() {
            return None;
        }
        if let Ok(frame) = live.frames.try_recv() {
            live.queued.fetch_sub(frame.len(), Ordering::AcqRel);
            return Some(self.count(frame));
        }
        let frame = self.board.as_mut()?.frames.try_recv().ok()?;
        Some(self.count(frame))
    }

    /// one frame, waited for.
    async fn frame(&mut self) -> Option<Result<Bytes, Closed>> {
        loop {
            if let Some(frame) = self.pending.pop_front() {
                return Some(Ok(self.count(frame)));
            }
            if self.finished {
                return None;
            }
            let Some(live) = &mut self.live else {
                if self.shutdown.is_cancelled() {
                    self.ended = "the server is stopping";
                    return None;
                }
                let (from, first) = match (self.from.take(), self.next.take()) {
                    (Some(from), _) => (from, true),
                    (None, Some(next)) => (From::At(next), false),
                    (None, None) => return None,
                };
                let Ok(page) = self.fleet.read(from, first, self.id, self.colours).await else {
                    self.ended = "the server is stopping";
                    return None;
                };
                self.pending.extend(page.frames);
                self.next = Some(page.next);
                self.colours = page.colours;
                if page.live.is_some() {
                    self.live = page.live;
                    let mut heartbeat = interval_at(
                        tokio::time::Instant::now() + HEARTBEAT_EVERY,
                        HEARTBEAT_EVERY,
                    );
                    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
                    self.heartbeat = Some(heartbeat);
                }
                continue;
            };
            let heartbeat = self.heartbeat.as_mut()?;
            tokio::select! {
                biased;
                () = live.closed.cancelled() => {
                    self.ended = "it fell 512 KB of plain frames behind in the fleet's queue";
                    return Some(Err(Closed::Behind));
                }
                () = self.shutdown.cancelled() => {
                    // a last word, so the client resumes at once instead of waiting out its watchdog
                    self.finished = true;
                    self.ended = "the server is stopping";
                    return Some(Ok(self.count(Bytes::from_static(HEARTBEAT))));
                }
                frame = live.frames.recv() => {
                    let Some(frame) = frame else {
                        self.ended = "the fleet stopped";
                        return Some(Err(Closed::Gone));
                    };
                    live.queued.fetch_sub(frame.len(), Ordering::AcqRel);
                    return Some(Ok(self.count(frame)));
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
        info!(
            stream = %format_args!("{:08x}", self.id),
            frames = self.frames,
            bytes = self.bytes,
            wire = self.wire,
            open_ms = u64::try_from(self.opened.elapsed().as_millis()).unwrap_or(u64::MAX),
            live_from = %self.next.as_ref().map_or_else(|| "none".into(), ToString::to_string),
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
            raw: None,
        }
    }

    fn open(fleet: &Fleet, shutdown: &CancellationToken, gzip: bool) -> ClientStream {
        ClientStream {
            id: rand::random(),
            fleet: fleet.clone(),
            shutdown: shutdown.clone(),
            from: Some(From::Start),
            next: None,
            pending: VecDeque::new(),
            live: None,
            board: None,
            colours: None,
            heartbeat: None,
            finished: false,
            gzip: gzip.then(Framed::new),
            opened: Instant::now(),
            frames: 0,
            bytes: 0,
            wire: 0,
            ended: "the test ended",
        }
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
        // hello and the reset, read as one page
        let first = write(&mut plain).await;
        let first_zipped = write(&mut zipped).await;
        assert_eq!(frames(&first).len(), 2);
        assert_eq!(
            unzip(&first_zipped),
            first.to_vec(),
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
