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

use axum::body::HttpBody;
use axum::http::{Response, header};
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
        let client = reqwest::Client::new();
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
        let client = reqwest::Client::new();
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
        let mut answer = reqwest::Client::new()
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
