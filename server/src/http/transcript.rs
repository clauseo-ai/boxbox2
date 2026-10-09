//! a session's transcript, read through the server from the host that
//! holds it (architecture: transcripts). the body streams through as the
//! daemon writes it, never buffered whole, with `x-cmx2-seq` (the daemon
//! event the read reflects, cmx2-asks a2), so a client applies only the
//! stream's transcript events after it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use tracing::info;
use utoipa::IntoParams;

use super::AppState;
use super::error::{ApiError, ErrorBody};
use crate::upstream::{get, plain};

/// how long the daemon may take to begin its answer.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// the daemon's headers a client needs; nothing else crosses.
const PASSED: [&str; 3] = ["x-cmx2-seq", "x-next-cursor", "x-cmx2-repeat"];

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
    ),
    responses(
        (status = 200, description = "cmx2's message list, byte for byte, with `x-cmx2-seq`", body = [Object]),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host, or the daemon has no such session", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn messages(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Query(page): Query<PageQuery>,
) -> Result<Response, ApiError> {
    let mut route = format!("/session/{}/message", segment(&session)?);
    let mut query = Vec::new();
    if let Some(limit) = page.limit {
        query.push(format!("limit={limit}"));
    }
    if let Some(before) = page.before {
        query.push(format!("before={before}"));
    }
    if !query.is_empty() {
        route = format!("{route}?{}", query.join("&"));
    }
    proxy(&state, &host, &route).await
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
    ),
    responses(
        (status = 200, description = "cmx2's `{info, parts}`, byte for byte, with `x-cmx2-seq`", body = Object),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host, session or message", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn message(
    State(state): State<Arc<AppState>>,
    Path((host, session, message)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let route = format!(
        "/session/{}/message/{}",
        segment(&session)?,
        segment(&message)?
    );
    proxy(&state, &host, &route).await
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

async fn proxy(state: &AppState, host: &str, route: &str) -> Result<Response, ApiError> {
    let view = state
        .upstreams
        .hosts
        .borrow()
        .iter()
        .find(|h| h.config.name == host)
        .cloned()
        .ok_or_else(|| ApiError::UnknownHost(host.to_owned()))?;
    let started = Instant::now();
    let answer = tokio::time::timeout(
        ANSWER_TIMEOUT,
        get(&state.client, &view.config, route).send(),
    )
    .await
    .map_err(|_| ApiError::HostUnreachable {
        host: host.to_owned(),
        reason: format!("no answer within {}s", ANSWER_TIMEOUT.as_secs()),
    })?
    .map_err(|e| ApiError::HostUnreachable {
        host: host.to_owned(),
        reason: plain(&e),
    })?;
    let status = StatusCode::from_u16(answer.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
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
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_id_is_a_path_segment() {
        assert!(segment("ses_98e744eb52534d939ab7").is_ok());
        assert!(segment("msg_98e744eb_00004").is_ok());
        for bad in ["", "..", ".", "a/b", "a?b", "a%2fb", &"x".repeat(129)] {
            assert!(segment(bad).is_err(), "{bad:?}");
        }
    }
}
