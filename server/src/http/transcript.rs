//! a session's transcript, read through the server from the host that
//! holds it (architecture: transcripts). the body streams through as the
//! daemon writes it, never buffered whole, with `x-cmx2-seq` (the daemon
//! event the read reflects, cmx2-asks a2), so a client applies only the
//! stream's transcript events after it.
//!
//! the stamp is also the answer's etag (weak: the bytes may go gzipped or
//! not). a client that holds a read sends it back as `If-None-Match`, and
//! when the fleet has seen nothing that changed the session's transcript
//! since (`fleet/model/marks.rs`) the answer is 304 with the same stamp,
//! without asking the daemon. a session that is not plain idle always goes
//! to the daemon.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tracing::info;
use utoipa::IntoParams;

use super::AppState;
use super::agents;
use super::error::{ApiError, ErrorBody};
use crate::journal::Cursor;

#[derive(Debug, Deserialize, IntoParams)]
pub struct PageQuery {
    /// at most this many messages, newest last; all of them when absent.
    limit: Option<u32>,
    /// the `x-next-cursor` of the page after this one.
    before: Option<u64>,
}

/// the session's messages, as cmx2's `GET /session/{session}/message`
/// answers them, the one still streaming included (cmx2-asks a5).
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/sessions/{session}/messages",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
        PageQuery,
        ("If-None-Match" = Option<String>, Header, description = "the etag of a read the client holds"),
    ),
    responses(
        (status = 200, description = "cmx2's message list, byte for byte, with `x-cmx2-seq` and the same stamp as a weak etag", body = [Object]),
        (status = 304, description = "the read whose etag was sent is still the transcript; `x-cmx2-seq` is its stamp"),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host, or the daemon has no such session", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn messages(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Query(page): Query<PageQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let session = segment(&session)?;
    let mut query = Vec::new();
    if let Some(limit) = page.limit {
        query.push(format!("limit={limit}"));
    }
    if let Some(before) = page.before {
        query.push(format!("before={before}"));
    }
    let source = agents::cmx2(&state, &host, None)?;
    if let Some(unchanged) = unchanged(&state, &host, session, &headers).await {
        return Ok(unchanged);
    }
    source.transcript_raw(session, &query).await
}

/// one message of the session, `{info, parts}`, streaming or finished; a
/// client re-reads a part through this when a delta shows it missed text.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/sessions/{session}/messages/{message}",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
        ("message" = String, Path, description = "the daemon's message id"),
        ("If-None-Match" = Option<String>, Header, description = "the etag of a read the client holds"),
    ),
    responses(
        (status = 200, description = "cmx2's `{info, parts}`, byte for byte, with `x-cmx2-seq` and the same stamp as a weak etag", body = Object),
        (status = 304, description = "the read whose etag was sent still holds; `x-cmx2-seq` is its stamp"),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host, session or message", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn message(
    State(state): State<Arc<AppState>>,
    Path((host, session, message)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (session, message) = (segment(&session)?, segment(&message)?);
    let source = agents::cmx2(&state, &host, None)?;
    if let Some(unchanged) = unchanged(&state, &host, session, &headers).await {
        return Ok(unchanged);
    }
    source.message_raw(session, message).await
}

/// the etag a read stamped `stamp` goes out with.
#[must_use]
pub fn etag(stamp: &str) -> Option<HeaderValue> {
    HeaderValue::from_str(&format!("W/\"{stamp}\"")).ok()
}

/// the stamps an `If-None-Match` names, weak or strong; none for `*` or
/// anything that is not a stamp.
fn stamps(headers: &HeaderMap) -> Vec<Cursor> {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|tag| {
            let tag = tag.trim();
            let tag = tag.strip_prefix("W/").unwrap_or(tag);
            Cursor::parse(tag.strip_prefix('"')?.strip_suffix('"')?)
        })
        .collect()
}

/// a 304 when the client holds a read the fleet says is still the session's
/// transcript; none sends the request on to the daemon.
async fn unchanged(
    state: &AppState,
    host: &str,
    session: &str,
    headers: &HeaderMap,
) -> Option<Response> {
    let started = Instant::now();
    for stamp in stamps(headers) {
        let text = stamp.to_string();
        let held = state
            .fleet
            .transcript_unchanged(host.to_owned(), session.to_owned(), stamp)
            .await
            .unwrap_or(false);
        if !held {
            continue;
        }
        info!(
            host,
            session,
            status = 304,
            latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            seq = text,
            "transcript read"
        );
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        let out = response.headers_mut();
        if let (Some(tag), Ok(seq)) = (etag(&text), HeaderValue::from_str(&text)) {
            out.insert(header::ETAG, tag);
            out.insert("x-cmx2-seq", seq);
        }
        out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Some(response);
    }
    None
}

/// a daemon id as one path segment; anything that could step out of it is refused.
fn segment(id: &str) -> Result<&str, ApiError> {
    let fits = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.');
    if fits && id != "." && id != ".." {
        Ok(id)
    } else {
        Err(ApiError::BadRequest(format!(
            "\"{id}\" is not a session or message id"
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::fleet::Upstream;
    use crate::source::{Floors, Snapshot, SourceEvent};

    /// a daemon that answers every transcript read with an empty list stamped
    /// `e1:<stamp>`, counting the reads.
    async fn daemon(stamp: u64) -> (SocketAddr, Arc<AtomicUsize>) {
        let reads = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&reads);
        let router = axum::Router::new().route(
            "/session/{session}/message",
            axum::routing::get(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                async move {
                    (
                        [("x-cmx2-seq", format!("e1:{stamp}"))],
                        axum::Json(serde_json::json!([])),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        (addr, reads)
    }

    /// the host's connection as its watcher reports it.
    fn connection(connection: crate::upstream::Connection, cursor: Option<&str>) -> Upstream {
        let status = crate::upstream::HostStatus {
            name: "desk".into(),
            url: "http://127.0.0.1:9/".into(),
            origin: crate::config::Origin::Config,
            memory: None,
            system: None,
            reports_system: None,
            connection,
            since: 0,
            health: None,
            last_error: None,
            connects: 1,
            frames: crate::upstream::FrameCounts::default(),
            cursor: cursor.map(str::to_owned),
        };
        event(
            None,
            SourceEvent::Connection(crate::source::cmx2::translate::connection(status)),
        )
    }

    fn event(seq: Option<u64>, event: SourceEvent) -> Upstream {
        Upstream::Source {
            connection: Arc::from("desk"),
            agent: Arc::from("desk"),
            seq,
            event,
            raw: None,
        }
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines, reason = "one story, read by read")]
    async fn a_read_the_client_holds_is_answered_304_without_the_daemon_until_its_session_changes()
    {
        let (daemon, reads) = daemon(10).await;
        let shutdown = CancellationToken::new();
        let (fleet, _looking) = crate::http::stream::tests::real_fleet(&shutdown);
        let host = crate::upstream::HostView::detached(
            crate::config::HostConfig {
                name: "desk".into(),
                url: reqwest::Url::parse(&format!("http://{daemon}/")).unwrap(),
                credential: None,
                origin: crate::config::Origin::Config,
            },
            crate::wire::Capabilities::default(),
        );
        let upstream = fleet.upstream();
        let addr = crate::http::tests::serve_state(
            Duration::from_secs(1),
            crate::upstream::Upstreams::fixed(vec![host], Vec::new(), Vec::new()),
            crate::source::sends::Sends::new(mpsc::channel(1).0),
            crate::media::Media::detached(),
            crate::store::Store::detached(),
            fleet.clone(),
        )
        .await;
        let cookie = crate::http::tests::sign_in(addr).await;
        let client = reqwest::Client::new();
        let read = |tag: Option<&'static str>| {
            let mut request = client
                .get(format!("http://{addr}/api/hosts/desk/sessions/s1/messages"))
                .header("cookie", &cookie);
            if let Some(tag) = tag {
                request = request.header("if-none-match", tag);
            }
            async move {
                let answer = request.send().await.unwrap();
                let status = answer.status().as_u16();
                let tag = answer
                    .headers()
                    .get("etag")
                    .map(|v| v.to_str().unwrap().to_owned());
                (status, tag)
            }
        };
        // a host never read: every read goes to the daemon, and comes back tagged
        assert_eq!(
            read(Some("W/\"e1:10\"")).await,
            (200, Some("W/\"e1:10\"".into()))
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        upstream
            .send(event(
                None,
                SourceEvent::Snapshot(Box::new(Snapshot {
                    epoch: Some("e1".into()),
                    floors: Floors {
                        threads: 5,
                        activities: 6,
                        permissions: 5,
                        questions: 7,
                    },
                    threads: Vec::new(),
                    activities: Vec::new(),
                    asks: Vec::new(),
                })),
            ))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        // read, but its stream not yet open: the daemon answers
        assert_eq!(read(Some("W/\"e1:10\"")).await.0, 200);
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        upstream
            .send(connection(
                crate::upstream::Connection::Connected,
                Some("e1:5"),
            ))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        // read at 10, nothing since: unchanged, and the daemon is not asked
        assert_eq!(
            read(Some("W/\"e1:10\"")).await,
            (304, Some("W/\"e1:10\"".into()))
        );
        assert_eq!(
            read(Some("\"e0:1\", \"e1:10\"")).await.0,
            304,
            "a strong tag in a list"
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        // before the read's floor, another epoch, or no tag: the daemon answers
        for tag in [Some("W/\"e1:4\""), Some("W/\"e2:10\""), Some("*"), None] {
            assert_eq!(read(tag).await.0, 200, "{tag:?}");
        }
        assert_eq!(reads.load(Ordering::SeqCst), 6);
        // a delta: marked one past the last seq seen (5), so a read at 10 still holds
        upstream
            .send(event(
                None,
                SourceEvent::Delta {
                    thread: "s1".into(),
                    message: "m1".into(),
                    part: "p1".into(),
                    field: "text".into(),
                    delta: "hi".into(),
                    offset: 0,
                },
            ))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        assert_eq!(read(Some("W/\"e1:10\"")).await.0, 304);
        // a transcript event after the read: it goes to the daemon; one at or before a read's stamp leaves it
        upstream
            .send(event(
                Some(12),
                SourceEvent::MessageRemoved {
                    thread: "s1".into(),
                    message: "m1".into(),
                },
            ))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        assert_eq!(read(Some("W/\"e1:10\"")).await.0, 200);
        assert_eq!(read(Some("W/\"e1:12\"")).await.0, 304);
        // a frame the watcher skipped: nothing holds until the next seq, which becomes the floor
        upstream
            .send(event(None, SourceEvent::Skipped))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        assert_eq!(read(Some("W/\"e1:12\"")).await.0, 200);
        upstream
            .send(event(
                Some(14),
                SourceEvent::MessageRemoved {
                    thread: "s2".into(),
                    message: "m9".into(),
                },
            ))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        assert_eq!(read(Some("W/\"e1:13\"")).await.0, 200);
        assert_eq!(read(Some("W/\"e1:14\"")).await.0, 304);
        // the stream drops: nothing holds, whatever was marked
        upstream
            .send(connection(crate::upstream::Connection::Down, Some("e1:14")))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        assert_eq!(read(Some("W/\"e1:14\"")).await.0, 200);
        // back from its cursor: from the cursor on
        upstream
            .send(connection(
                crate::upstream::Connection::Connected,
                Some("e1:14"),
            ))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        assert_eq!(read(Some("W/\"e1:14\"")).await.0, 304);
        // a session that is busy always goes to the daemon
        upstream
            .send(event(
                Some(15),
                SourceEvent::Activity {
                    thread: "s1".into(),
                    activity: crate::wire::Activity::Busy { since: 1.0 },
                },
            ))
            .await
            .unwrap();
        fleet.snapshot().await.unwrap();
        assert_eq!(read(Some("W/\"e1:15\"")).await.0, 200);
        assert_eq!(reads.load(Ordering::SeqCst), 11);
    }

    #[test]
    fn only_a_plain_id_is_a_path_segment() {
        assert!(segment("ses_98e744eb52534d939ab7").is_ok());
        assert!(segment("msg_98e744eb_00004").is_ok());
        for bad in ["", "..", ".", "a/b", "a?b", "a%2fb", &"x".repeat(129)] {
            assert!(segment(bad).is_err(), "{bad:?}");
        }
    }
}
