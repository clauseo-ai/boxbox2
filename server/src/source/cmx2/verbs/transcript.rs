//! the cmx2 source's a thread's transcript and one message, passed through
//! (`http/transcript.rs`): the body streams through as the daemon writes it,
//! never buffered whole, with `x-cmx2-seq` (the daemon event the read
//! reflects, cmx2-asks a2) and `x-next-cursor`.

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tracing::info;

use crate::http::error::ApiError;
use crate::source::cmx2::Cmx2Source;
use crate::upstream::{get, plain};

/// how long the daemon may take to begin its answer.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// the daemon's headers a client needs; nothing else crosses.
const PASSED: [&str; 3] = ["x-cmx2-seq", "x-next-cursor", "x-cmx2-repeat"];

impl Cmx2Source {
    /// the session's messages (`GET /session/:id/message`); `query` is already
    /// in the daemon's query form and `session` one segment.
    ///
    /// # Errors
    /// the host could not be reached in time.
    pub async fn transcript_raw(
        &self,
        session: &str,
        query: &[String],
    ) -> Result<Response, ApiError> {
        let mut route = format!("/session/{session}/message");
        if !query.is_empty() {
            route = format!("{route}?{}", query.join("&"));
        }
        self.proxy(&route).await
    }

    /// one message of the session (`GET /session/:id/message/:id`).
    ///
    /// # Errors
    /// as `transcript_raw`.
    pub async fn message_raw(&self, session: &str, message: &str) -> Result<Response, ApiError> {
        let route = format!("/session/{session}/message/{message}");
        self.proxy(&route).await
    }

    async fn proxy(&self, route: &str) -> Result<Response, ApiError> {
        let host = self.host().name.as_str();
        let started = Instant::now();
        let answer =
            tokio::time::timeout(ANSWER_TIMEOUT, get(&self.client, self.host(), route).send())
                .await
                .map_err(|_| ApiError::HostUnreachable {
                    host: host.to_owned(),
                    reason: format!("no answer within {}s", ANSWER_TIMEOUT.as_secs()),
                })?
                .map_err(|e| ApiError::HostUnreachable {
                    host: host.to_owned(),
                    reason: plain(&e),
                })?;
        let status =
            StatusCode::from_u16(answer.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let seq = answer
            .headers()
            .get("x-cmx2-seq")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("-")
            .to_owned();
        info!(
            host,
            route = route.split('?').next().unwrap_or(route),
            status = status.as_u16(),
            latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            seq,
            "transcript read"
        );
        let mut headers = Vec::with_capacity(PASSED.len() + 1);
        if let Some(kind) = answer.headers().get(reqwest::header::CONTENT_TYPE) {
            headers.push((header::CONTENT_TYPE, kind.as_bytes().to_vec()));
        }
        let passed: Vec<(&'static str, Vec<u8>)> = PASSED
            .iter()
            .filter_map(|name| {
                answer
                    .headers()
                    .get(*name)
                    .map(|v| (*name, v.as_bytes().to_vec()))
            })
            .collect();
        let mut response = Body::from_stream(answer.bytes_stream()).into_response();
        *response.status_mut() = status;
        let out = response.headers_mut();
        for (name, value) in headers {
            if let Ok(value) = HeaderValue::from_bytes(&value) {
                out.insert(name, value);
            }
        }
        for (name, value) in passed {
            if let Ok(value) = HeaderValue::from_bytes(&value) {
                out.insert(name, value);
            }
        }
        if status == StatusCode::OK
            && let Some(tag) = (seq != "-")
                .then(|| crate::http::transcript::etag(&seq))
                .flatten()
        {
            out.insert(header::ETAG, tag);
        }
        out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        Ok(response)
    }
}
