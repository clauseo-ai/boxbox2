//! `POST /api/login` and `POST /api/logout`.

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use utoipa::ToSchema;

use super::AppState;
use super::error::{ApiError, ErrorBody};
use crate::auth::FLAT_DELAY;

#[derive(Debug, Deserialize, ToSchema)]
pub struct Login {
    pub password: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub signed_in: bool,
}

/// exchanges the password for the session cookie.
#[utoipa::path(
    post,
    path = "/api/login",
    request_body = Login,
    responses(
        (status = 200, description = "signed in; the session cookie is set", body = Session),
        (status = 400, description = "the body is not a login", body = ErrorBody),
        (status = 401, description = "wrong password, answered after the flat delay", body = ErrorBody),
    ),
)]
pub async fn login(State(state): State<Arc<AppState>>, body: Bytes) -> Result<Response, ApiError> {
    let received = Instant::now();
    let login: Login = serde_json::from_slice(&body)
        .map_err(|_| ApiError::BadRequest("send {\"password\": \"...\"} as json".into()))?;
    if state.auth.password_matches(&login.password) {
        let token = state.auth.issue(crate::now_ms());
        info!("signed in");
        let cookie = state.auth.session_cookie(&token);
        return Ok((
            [(header::SET_COOKIE, cookie)],
            Json(Session { signed_in: true }),
        )
            .into_response());
    }
    tokio::time::sleep_until((received + FLAT_DELAY).into()).await;
    warn!(delay_ms = FLAT_DELAY.as_millis(), "wrong password refused");
    Err(ApiError::WrongPassword)
}

/// clears the session cookie.
#[utoipa::path(
    post,
    path = "/api/logout",
    responses((status = 200, description = "signed out; the session cookie is cleared", body = Session)),
)]
pub async fn logout(State(state): State<Arc<AppState>>) -> Response {
    let cookie = state.auth.cleared_cookie();
    (
        [(header::SET_COOKIE, cookie)],
        Json(Session { signed_in: false }),
    )
        .into_response()
}
