//! `GET /api/fleet`: the whole fleet model at once, for debugging and for
//! tools that do not keep a stream. clients keep `GET /api/stream`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};

use super::AppState;
use super::error::{ApiError, ErrorBody};
use crate::fleet::change::FleetSnapshot;

/// the fleet model now.
#[utoipa::path(
    get,
    path = "/api/fleet",
    responses(
        (status = 200, description = "every host, session and ask, and the window order", body = FleetSnapshot),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn snapshot(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let json = state
        .fleet
        .snapshot()
        .await
        .map_err(|_| ApiError::Stopping)?;
    let mut response = json.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(response)
}
