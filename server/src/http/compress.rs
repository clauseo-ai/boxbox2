//! gzip for the api's json answers, and for nothing else. a transcript is
//! ten megabytes of json that compresses tenfold, and the link to a phone
//! is the slowest hop there is (architecture: transcripts).
//!
//! the rule is a whitelist, not a list of exceptions: only a body announced
//! as json is compressed, so the event stream (which has to flush every
//! frame the moment it is written), the terminal's websocket upgrade,
//! images, and anything a future route adds start out untouched. the app's
//! own files are served precompressed (`assets.rs`) and are left alone by
//! the same rule.
//!
//! the event streams (`/api/stream`, `/api/board/stream`) are compressed by
//! their own handlers instead, never by the layer: `Framed` keeps one gzip
//! context per connection and sync-flushes it after every batch the
//! handler writes, so each batch decodes the moment it arrives and later
//! frames still borrow from earlier ones. a stream is compressed only for a
//! request that sends `Accept-Encoding: gzip`; any other gets the same
//! bytes as before, unchanged. at most `GZIP_STREAMS` streams hold a gzip
//! context at once (`GzipStreams`); past that a new stream is identity,
//! and the server says so once each time the cap is reached
//! (`docs/protocol.md`, sections 2 and 17a).

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use axum::body::HttpBody;
use axum::http::{HeaderMap, HeaderValue, Response, header};
use bytes::Bytes;
use flate2::Compression;
use flate2::write::GzEncoder;
use tower_http::compression::predicate::Predicate;
use tower_http::compression::{CompressionLayer, CompressionLevel};

/// bodies under this size are not worth the header they would cost
const MIN_BYTES: u64 = 512;

/// compress a response when it is json and not tiny
#[derive(Clone, Copy, Debug)]
pub struct Json;

impl Predicate for Json {
    fn should_compress<B>(&self, response: &Response<B>) -> bool
    where
        B: HttpBody,
    {
        let json = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|kind| {
                let kind = kind.split(';').next().unwrap_or("").trim();
                kind.eq_ignore_ascii_case("application/json")
            });
        json && known_size(response).is_none_or(|bytes| bytes >= MIN_BYTES)
    }
}

/// the size the answer will have, when it is known: the header, or the body's own exact size. axum's json and its
/// errors announce neither as a header at the point the layer sees them, and a body that streams (the transcript, as
/// the daemon writes it) has no size at all: it is compressed
fn known_size<B: HttpBody>(response: &Response<B>) -> Option<u64> {
    response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| response.body().size_hint().exact())
}

/// the layer the gated api wears: gzip at the default level, for json only
pub fn layer() -> CompressionLayer<Json> {
    CompressionLayer::new()
        .quality(CompressionLevel::Default)
        .compress_when(Json)
}

/// whether a request takes gzip: `Accept-Encoding` names `gzip` (any case)
/// with a quality above zero.
pub fn takes_gzip(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|coding| {
            let mut parts = coding.split(';');
            let name = parts.next().unwrap_or("").trim();
            let quality = parts
                .filter_map(|p| p.trim().strip_prefix("q="))
                .find_map(|q| q.trim().parse::<f32>().ok())
                .unwrap_or(1.0);
            name.eq_ignore_ascii_case("gzip") && quality > 0.0
        })
}

/// the headers a gzipped stream answers with.
pub fn mark_gzip(headers: &mut HeaderMap) {
    headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
}

/// one event stream's gzip context, owned by its connection. a 32 kb
/// window and the deflate state, about 300 kb in all, for as long as the
/// connection lives.
pub struct Framed {
    encoder: Option<GzEncoder<Vec<u8>>>,
    /// its place among the gzip streams, freed when the stream ends.
    slot: Option<Slot>,
}

/// event streams that may hold a gzip context at once: 64 of about 300 kb.
pub const GZIP_STREAMS: usize = 64;

/// the count of event streams holding a gzip context, shared by every
/// stream route; each `Framed` it hands out frees its place on drop.
#[derive(Clone, Debug, Default)]
pub struct GzipStreams {
    inner: Arc<Places>,
}

#[derive(Debug, Default)]
struct Places {
    held: AtomicUsize,
    /// the cap was met and said; cleared when a place frees, so the next
    /// time it is met is said again.
    said: AtomicBool,
}

/// one place held, given back on drop.
#[derive(Debug)]
struct Slot(Arc<Places>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.held.fetch_sub(1, Ordering::AcqRel);
        self.0.said.store(false, Ordering::Release);
    }
}

impl GzipStreams {
    /// a gzip context for a stream whose client takes gzip, or none when
    /// `GZIP_STREAMS` already hold one: that stream is identity.
    #[must_use]
    pub fn take(&self) -> Option<Framed> {
        let places = &self.inner;
        let taken = places
            .held
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |held| {
                (held < GZIP_STREAMS).then_some(held + 1)
            })
            .is_ok();
        if !taken {
            if !places.said.swap(true, Ordering::AcqRel) {
                tracing::warn!(
                    cap = GZIP_STREAMS,
                    "{GZIP_STREAMS} event streams already hold a gzip context; new streams go uncompressed until one ends"
                );
            }
            return None;
        }
        Some(Framed {
            encoder: Some(GzEncoder::new(Vec::new(), Compression::default())),
            slot: Some(Slot(Arc::clone(places))),
        })
    }

    /// how many streams hold a gzip context now.
    #[cfg(test)]
    #[must_use]
    pub fn held(&self) -> usize {
        self.inner.held.load(Ordering::Acquire)
    }
}

impl std::fmt::Debug for Framed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Framed")
            .field("finished", &self.encoder.is_none())
            .field("counted", &self.slot.is_some())
            .finish()
    }
}

impl Default for Framed {
    fn default() -> Self {
        Self::new()
    }
}

impl Framed {
    #[must_use]
    pub fn new() -> Self {
        Self {
            encoder: Some(GzEncoder::new(Vec::new(), Compression::default())),
            slot: None,
        }
    }

    /// one batch, compressed and sync-flushed: the bytes to write now, which
    /// decode to `plain` exactly, with nothing held back.
    ///
    /// # Errors
    /// the compressor failed, or the stream was already finished.
    pub fn batch(&mut self, plain: &[u8]) -> std::io::Result<Bytes> {
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| std::io::Error::other("the gzip stream was finished"))?;
        encoder.write_all(plain)?;
        // flate2's flush is a sync flush: the batch ends on a byte boundary, decodable at once
        encoder.flush()?;
        Ok(Bytes::from(std::mem::take(encoder.get_mut())))
    }

    /// the gzip trailer, once, when the stream ends cleanly.
    pub fn finish(&mut self) -> Option<Bytes> {
        let encoder = self.encoder.take()?;
        encoder.finish().ok().map(Bytes::from)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use axum::body::Body;

    /// an answer of `kind`, whose body is `length` bytes of known size, or a stream of no known size
    fn answer(kind: Option<&str>, length: Option<usize>) -> Response<Body> {
        let mut builder = Response::builder();
        if let Some(kind) = kind {
            builder = builder.header(header::CONTENT_TYPE, kind);
        }
        let body = match length {
            Some(length) => Body::from(vec![b'x'; length]),
            None => Body::from_stream(futures_util::stream::once(async {
                Ok::<_, std::convert::Infallible>(bytes::Bytes::from_static(b"{}"))
            })),
        };
        builder.body(body).unwrap()
    }

    #[test]
    fn the_gzip_streams_give_out_64_places_and_take_each_back_when_it_ends() {
        let streams = GzipStreams::default();
        let held: Vec<Framed> = (0..GZIP_STREAMS).map_while(|_| streams.take()).collect();
        assert_eq!(held.len(), GZIP_STREAMS);
        assert!(streams.take().is_none());
        assert!(
            streams.inner.said.load(Ordering::Acquire),
            "the cap was said"
        );
        assert_eq!(streams.held(), GZIP_STREAMS);
        drop(held);
        assert_eq!(streams.held(), 0);
        assert!(!streams.inner.said.load(Ordering::Acquire));
        assert!(streams.take().is_some());
    }

    #[test]
    fn json_is_compressed_whatever_its_charset_or_case() {
        for kind in [
            "application/json",
            "application/json; charset=utf-8",
            "Application/JSON",
        ] {
            assert!(Json.should_compress(&answer(Some(kind), None)), "{kind}");
        }
    }

    #[test]
    fn the_event_stream_and_everything_not_json_is_left_alone() {
        for kind in [
            Some("text/event-stream"),
            Some("text/event-stream; charset=utf-8"),
            Some("text/html"),
            Some("image/png"),
            Some("application/octet-stream"),
            Some("application/jsonl"),
            None,
        ] {
            assert!(!Json.should_compress(&answer(kind, None)), "{kind:?}");
        }
    }

    #[test]
    fn a_small_body_is_not_worth_it_and_one_of_unknown_size_is() {
        assert!(!Json.should_compress(&answer(Some("application/json"), Some(100))));
        assert!(Json.should_compress(&answer(Some("application/json"), Some(100_000))));
        assert!(Json.should_compress(&answer(Some("application/json"), None)));
    }

    #[test]
    fn a_size_announced_by_the_header_counts_as_well_as_the_bodys_own() {
        let mut small = answer(Some("application/json"), None);
        small
            .headers_mut()
            .insert(header::CONTENT_LENGTH, 65.into());
        assert!(!Json.should_compress(&small));
    }

    /// the layer on a router of two routes, one json and one that writes an event, then waits to be told to write the next
    async fn serve() -> (std::net::SocketAddr, tokio::sync::mpsc::Sender<()>) {
        use axum::response::sse::{Event, Sse};
        use axum::routing::get;
        use futures_util::stream;
        let (next, wanted) = tokio::sync::mpsc::channel::<()>(1);
        let wanted = std::sync::Arc::new(tokio::sync::Mutex::new(wanted));
        let router = axum::Router::new()
            .route(
                "/json",
                get(|| async { axum::Json(serde_json::json!({ "text": "word ".repeat(2000) })) }),
            )
            .route(
                "/small",
                get(|| async { axum::Json(serde_json::json!({ "ok": true })) }),
            )
            .route(
                "/error",
                get(|| async { crate::http::error::ApiError::BadRequest("nothing here".into()) }),
            )
            .route(
                "/streamed",
                get(|| async {
                    let chunks = futures_util::stream::iter((0..400).map(|_| {
                        Ok::<_, std::convert::Infallible>(bytes::Bytes::from_static(
                            b"{\"word\":\"word\"},",
                        ))
                    }));
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        axum::body::Body::from_stream(chunks),
                    )
                }),
            )
            .route(
                "/stream",
                get(move || {
                    let wanted = std::sync::Arc::clone(&wanted);
                    async move {
                        let frames = stream::unfold((wanted, 0u32), |(wanted, n)| async move {
                            if n > 0 {
                                wanted.lock().await.recv().await?;
                            }
                            let event: Result<Event, std::convert::Infallible> =
                                Ok(Event::default().data(format!("frame {n}")));
                            Some((event, (wanted, n + 1)))
                        });
                        Sse::new(frames)
                    }
                }),
            )
            .layer(layer());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        (addr, next)
    }

    #[tokio::test]
    async fn a_json_answer_goes_as_gzip_to_a_client_that_takes_it_and_plain_to_one_that_does_not() {
        use std::io::Read;
        let (addr, _next) = serve().await;
        let client = reqwest::Client::builder().no_gzip().build().unwrap();
        let plain = client
            .get(format!("http://{addr}/json"))
            .send()
            .await
            .unwrap();
        assert!(plain.headers().get("content-encoding").is_none());
        let plain = plain.bytes().await.unwrap();
        let zipped = client
            .get(format!("http://{addr}/json"))
            .header("accept-encoding", "gzip")
            .send()
            .await
            .unwrap();
        assert_eq!(zipped.headers()["content-encoding"], "gzip");
        assert_eq!(zipped.headers()["vary"], "accept-encoding");
        let zipped = zipped.bytes().await.unwrap();
        assert!(
            zipped.len() * 10 < plain.len(),
            "{} of {}",
            zipped.len(),
            plain.len()
        );
        let mut unzipped = Vec::new();
        flate2::read::GzDecoder::new(&zipped[..])
            .read_to_end(&mut unzipped)
            .unwrap();
        assert_eq!(unzipped, plain);
    }

    #[tokio::test]
    async fn a_small_json_answer_and_an_error_go_plain_whatever_the_client_takes_and_a_streamed_one_goes_as_gzip()
     {
        let (addr, _next) = serve().await;
        let client = reqwest::Client::builder().no_gzip().build().unwrap();
        let get = |path: &'static str| {
            let client = client.clone();
            async move {
                client
                    .get(format!("http://{addr}{path}"))
                    .header("accept-encoding", "gzip")
                    .send()
                    .await
                    .unwrap()
            }
        };
        let small = get("/small").await;
        assert!(small.headers().get("content-encoding").is_none());
        assert_eq!(small.text().await.unwrap(), r#"{"ok":true}"#);
        let error = get("/error").await;
        assert_eq!(error.status(), 400);
        assert!(error.headers().get("content-encoding").is_none());
        assert!(error.text().await.unwrap().contains("nothing here"));
        let streamed = get("/streamed").await;
        assert_eq!(streamed.headers()["content-encoding"], "gzip");
    }

    #[tokio::test]
    async fn the_event_stream_is_never_compressed_and_every_frame_is_flushed_as_it_is_written() {
        let (addr, next) = serve().await;
        let mut answer = reqwest::Client::builder()
            .no_gzip()
            .build()
            .unwrap()
            .get(format!("http://{addr}/stream"))
            .header("accept-encoding", "gzip, br")
            .send()
            .await
            .unwrap();
        assert!(answer.headers().get("content-encoding").is_none());
        for n in 0..3 {
            let chunk = tokio::time::timeout(Duration::from_secs(2), answer.chunk())
                .await
                .expect("the frame was held back, not flushed")
                .unwrap()
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&chunk),
                format!("data: frame {n}\n\n")
            );
            next.send(()).await.unwrap();
        }
    }
}
