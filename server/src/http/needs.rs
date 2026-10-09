//! needs and read state: `GET /api/needs` and `POST /api/read`. the fleet
//! derives both once (`fleet/needs.rs`, `fleet/read.rs`); these routes only
//! show them and take a device's mark.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::asks::device_of;
use super::error::{ApiError, ErrorBody};
use crate::fleet::model::ReadRefused;
use crate::fleet::needs::Need;
use crate::push::Thread;

/// what waits on the person, and what was served lately.
#[derive(Debug, Serialize, ToSchema)]
pub struct NeedsList {
    /// open needs in inbox order: wants you (oldest first), failed, then
    /// done and news (newest first).
    pub open: Vec<Need>,
    /// needs served lately, newest first, with who served them and when.
    pub served: Vec<Need>,
}

/// a device has seen a session through one message.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadBody {
    pub device: String,
    pub device_class: String,
    /// `host:session`.
    pub key: String,
    /// the newest message the device has in front of it.
    pub message: String,
    /// that message's `time.created`, as the daemon wrote it (ms).
    pub at: f64,
}

/// the open needs and the ones served lately, with `x-boxbox-seq`: the
/// journal position they reflect, so a stream resumed from it carries
/// every later move and nothing twice.
#[utoipa::path(
    get,
    path = "/api/needs",
    operation_id = "needs",
    responses(
        (status = 200, description = "the needs, with `x-boxbox-seq: <epoch>:<seq>`", body = NeedsList),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn list(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let now = state.fleet.needs().await.map_err(|_| ApiError::Stopping)?;
    let mut response = Json(NeedsList {
        open: now.open,
        served: now.served,
    })
    .into_response();
    if let Ok(seq) = HeaderValue::from_str(&now.at.to_string()) {
        response.headers_mut().insert("x-boxbox-seq", seq);
    }
    Ok(response)
}

/// marks a session seen by one device, through the message it shows. the
/// mark never moves back, and the session's mark is the furthest of its
/// devices' (`design.md`, unread from here).
#[utoipa::path(
    post,
    path = "/api/read",
    request_body = ReadBody,
    responses(
        (status = 204, description = "marked"),
        (status = 400, description = "not a read mark", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such session in the fleet", body = ErrorBody),
    ),
)]
pub async fn read(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ReadBody>,
) -> Result<StatusCode, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    if Thread::parse(&body.key).is_none() {
        return Err(ApiError::BadRequest(format!(
            "\"{}\" is not a thread; send host:session",
            body.key
        )));
    }
    if body.message.is_empty() || body.message.len() > 128 || !body.at.is_finite() {
        return Err(ApiError::BadRequest(
            "send the id and time.created of the newest message on screen".into(),
        ));
    }
    match state
        .fleet
        .mark_read(body.key, device, body.message, body.at)
        .await
        .map_err(|_| ApiError::Stopping)?
    {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(ReadRefused::NoSuchSession(key)) => Err(ApiError::NoSuchSession(key)),
    }
}
