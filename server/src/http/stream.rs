//! `GET /api/stream`: the fleet as one sse stream with a cursor.
//!
//! a client sends its cursor (`Last-Event-ID`, or `?after=` where a header
//! cannot be set) and gets `hello`, then every journal entry after the
//! cursor, then live entries; or, when the cursor cannot be replayed, a
//! `reset` carrying the whole fleet, then live entries. a comment every
//! 15 s keeps proxies and the client's 45 s watchdog content.
//!
//! the stream owns nothing but its place: the fleet actor hands it pages
//! and then a live feed bounded at 512 kb. when the actor closes that feed
//! (the client stopped reading), the body ends with an error, so hyper
//! drops the connection instead of holding what it had buffered; the
//! client resumes from its cursor.
//!
//! hyper polls a body only when the socket takes bytes, so a reader that
//! is stalled, not gone, meets that error when it next reads. until then
//! the stream costs what it already held (its queue, at most the cap, and
//! hyper's write buffer) and nothing more: the actor feeds it no longer.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde::Deserialize;
use tokio::time::{Interval, MissedTickBehavior, interval_at};
use tokio_util::sync::CancellationToken;
use tracing::info;
use utoipa::IntoParams;

use super::AppState;
use super::error::ErrorBody;
use crate::fleet::change::StreamFrame;
use crate::fleet::{Fleet, From, Live};
use crate::journal::Cursor;

const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
const HEARTBEAT: &[u8] = b": hb\n\n";

#[derive(Debug, Deserialize, IntoParams)]
pub struct StreamQuery {
    /// the cursor, `<epoch>:<seq>`, for clients that cannot set
    /// `Last-Event-ID`; the header wins when both are sent.
    after: Option<String>,
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
    headers: HeaderMap,
    Query(query): Query<StreamQuery>,
) -> Response {
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
    info!(stream = %format_args!("{id:08x}"), cursor = cursor.as_deref().unwrap_or("none"), "client stream open");
    let client = ClientStream {
        id,
        fleet: state.fleet.clone(),
        shutdown: state.shutdown.clone(),
        from: Some(from),
        next: None,
        pending: VecDeque::new(),
        live: None,
        heartbeat: None,
        finished: false,
        opened: Instant::now(),
        frames: 0,
        bytes: 0,
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
    response
}

/// why a stream's body ended early; hyper drops the connection on it.
#[derive(Debug, thiserror::Error)]
enum Closed {
    #[error("the client fell 512 KB behind")]
    Behind,
    #[error("the fleet stopped feeding the stream")]
    Gone,
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
    heartbeat: Option<Interval>,
    finished: bool,
    opened: Instant,
    frames: u64,
    bytes: u64,
    ended: &'static str,
}

impl ClientStream {
    async fn next(&mut self) -> Option<Result<Bytes, Closed>> {
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
                let Ok(page) = self.fleet.read(from, first, self.id).await else {
                    self.ended = "the server is stopping";
                    return None;
                };
                self.pending.extend(page.frames);
                self.next = Some(page.next);
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
                    self.ended = "it fell 512 KB behind";
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

impl Drop for ClientStream {
    fn drop(&mut self) {
        info!(
            stream = %format_args!("{:08x}", self.id),
            frames = self.frames,
            bytes = self.bytes,
            open_ms = u64::try_from(self.opened.elapsed().as_millis()).unwrap_or(u64::MAX),
            live_from = %self.next.as_ref().map_or_else(|| "none".into(), ToString::to_string),
            reason = self.ended,
            "client stream closed"
        );
    }
}
