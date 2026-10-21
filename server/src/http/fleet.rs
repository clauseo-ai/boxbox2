//! `GET /api/fleet`: the whole fleet model at once, for debugging and for
//! tools that do not keep a stream. clients keep `GET /api/stream`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};

use super::AppState;
use super::error::{ApiError, ErrorBody};
use crate::wire::Fleet;

/// the fleet model now, with `x-boxbox-seq`: the journal position it
/// reflects, so a stream resumed from it carries every later change.
#[utoipa::path(
    get,
    path = "/api/fleet",
    responses(
        (status = 200, description = "every agent, thread and ask, and the window order, with `x-boxbox-seq: <epoch>:<seq>`", body = Fleet),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn snapshot(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let (json, at) = state
        .fleet
        .snapshot()
        .await
        .map_err(|_| ApiError::Stopping)?;
    let mut response = json.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if let Ok(seq) = HeaderValue::from_str(&at.to_string()) {
        response.headers_mut().insert("x-boxbox-seq", seq);
    }
    Ok(response)
}
