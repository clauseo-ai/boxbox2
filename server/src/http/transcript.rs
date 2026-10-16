//! a session's transcript, read through the server from the host that
//! holds it (architecture: transcripts). the body streams through as the
//! daemon writes it, never buffered whole, with `x-cmx2-seq` (the daemon
//! event the read reflects, cmx2-asks a2), so a client applies only the
//! stream's transcript events after it.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::Deserialize;
use utoipa::IntoParams;

use super::AppState;
use super::agents;
use super::error::{ApiError, ErrorBody};

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
    let session = segment(&session)?;
    let mut query = Vec::new();
    if let Some(limit) = page.limit {
        query.push(format!("limit={limit}"));
    }
    if let Some(before) = page.before {
        query.push(format!("before={before}"));
    }
    let source = agents::cmx2(&state, &host, None)?;
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
    let (session, message) = (segment(&session)?, segment(&message)?);
    let source = agents::cmx2(&state, &host, None)?;
    source.message_raw(session, message).await
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
