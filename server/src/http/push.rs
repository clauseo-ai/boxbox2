//! push and presence: `GET /api/push`, `POST /api/push/subscribe`,
//! `POST /api/push/unsubscribe`, `POST /api/push/test` and
//! `POST /api/presence`. the rules behind them are `docs/push.md`.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use tracing::warn;
use utoipa::ToSchema;

use super::AppState;
use super::error::{ApiError, ErrorBody};
use crate::push::devices::{self, Device};
use crate::push::presence::{MAX_WINDOWS, Report};
use crate::push::{About, AskKind, Kind, KindSet, Notice, Origin, Thread};
use crate::telemetry::dictionary;

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushState {
    /// the vapid public key, base64url: pass it to `pushManager.subscribe`
    /// as `applicationServerKey`.
    pub public_key: String,
    /// every subscribed device, oldest first.
    pub devices: Vec<PushDevice>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushDevice {
    pub device: String,
    pub device_class: String,
    /// the kinds this device is pushed.
    pub kinds: Vec<Kind>,
    /// when it first subscribed, ms since the epoch.
    pub since: i64,
}

impl From<&Device> for PushDevice {
    fn from(device: &Device) -> Self {
        Self {
            device: device.id.clone(),
            device_class: device.class.clone(),
            kinds: device.kinds.kinds(),
            since: device.since,
        }
    }
}

/// a `PushSubscription` as `toJSON()` gives it, plus who it belongs to.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Subscribe {
    pub device: String,
    /// one of the telemetry dictionary's device classes.
    pub device_class: String,
    pub endpoint: String,
    pub keys: SubscriptionKeys,
    /// the kinds to push; all four when absent.
    pub kinds: Option<Vec<Kind>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct Unsubscribe {
    pub device: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Unsubscribed {
    /// false when the device had no subscription.
    pub removed: bool,
}

/// a test notice to one device: the kind picks the shape (an ask carries
/// answer and open), and a real thread and ask make the links land.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushTest {
    pub device: String,
    pub kind: Kind,
    /// `host:session`; a placeholder thread when absent.
    pub thread: Option<String>,
    /// the ask to focus, for kind ask.
    pub ask: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TestQueued {
    /// the notice id, the join key in `push.decided`, `push.sent` and
    /// `push.delivered`.
    pub id: String,
}

/// the push key and every subscribed device.
#[utoipa::path(
    get,
    path = "/api/push",
    responses(
        (status = 200, description = "the vapid key and the subscribed devices", body = PushState),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the store is not answering", body = ErrorBody),
    ),
)]
pub async fn state(State(state): State<Arc<AppState>>) -> Result<Json<PushState>, ApiError> {
    let listed = state.push.devices().await.map_err(|e| store_down(&e))?;
    Ok(Json(PushState {
        public_key: state.push.public_key().to_owned(),
        devices: listed.iter().map(PushDevice::from).collect(),
    }))
}

/// saves this device's subscription (replacing any it had).
#[utoipa::path(
    post,
    path = "/api/push/subscribe",
    request_body = Subscribe,
    responses(
        (status = 200, description = "subscribed", body = PushDevice),
        (status = 400, description = "not a subscription boxbox can push to; the message says which part", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the store is not answering", body = ErrorBody),
    ),
)]
pub async fn subscribe(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Json<PushDevice>, ApiError> {
    let subscribe: Subscribe = parse(&body, "a push subscription")?;
    if !dictionary::is_device_class(&subscribe.device_class) {
        let known = dictionary::DEVICE_CLASSES.join(", ");
        return Err(ApiError::BadRequest(format!(
            "deviceClass must be one of {known}"
        )));
    }
    let kinds = subscribe.kinds.as_deref().map_or(KindSet::ALL, KindSet::of);
    let device = devices::parse(
        &subscribe.device,
        &subscribe.device_class,
        &subscribe.endpoint,
        &subscribe.keys.p256dh,
        &subscribe.keys.auth,
        kinds,
    )
    .map_err(|refused| ApiError::BadRequest(refused.to_string()))?;
    let mut view = PushDevice::from(&device);
    view.since = state
        .push
        .subscribe(device)
        .await
        .map_err(|e| store_down(&e))?;
    Ok(Json(view))
}

/// forgets this device's subscription.
#[utoipa::path(
    post,
    path = "/api/push/unsubscribe",
    request_body = Unsubscribe,
    responses(
        (status = 200, description = "the device is no longer pushed", body = Unsubscribed),
        (status = 400, description = "not an unsubscribe", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the store is not answering", body = ErrorBody),
    ),
)]
pub async fn unsubscribe(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Json<Unsubscribed>, ApiError> {
    let unsubscribe: Unsubscribe = parse(&body, "{\"device\": \"...\"}")?;
    if !devices::is_device_id(&unsubscribe.device) {
        return Err(ApiError::BadRequest(devices::Refused::DeviceId.to_string()));
    }
    let removed = state
        .push
        .unsubscribe(&unsubscribe.device)
        .await
        .map_err(|e| store_down(&e))?;
    Ok(Json(Unsubscribed { removed }))
}

/// pushes a test notice to one device, through the same decision, rate
/// and dedupe as every other.
#[utoipa::path(
    post,
    path = "/api/push/test",
    request_body = PushTest,
    responses(
        (status = 202, description = "queued; `push.decided` says what became of it", body = TestQueued),
        (status = 400, description = "not a test the server can send", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
    ),
)]
pub async fn test(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<(StatusCode, Json<TestQueued>), ApiError> {
    let request: PushTest = parse(&body, "a push test")?;
    if !devices::is_device_id(&request.device) {
        return Err(ApiError::BadRequest(devices::Refused::DeviceId.to_string()));
    }
    let thread = match request.thread.as_deref() {
        Some(key) => Thread::parse(key)
            .ok_or_else(|| ApiError::BadRequest("thread must be host:session".into()))?,
        None => Thread::parse("boxbox:test").ok_or(ApiError::NotFound)?,
    };
    let stamp = crate::now_ms();
    let (about, title, text) = match request.kind {
        Kind::Ask => (
            About::Ask {
                id: request.ask.unwrap_or_else(|| format!("test-{stamp}")),
                kind: AskKind::Question,
            },
            format!("{} wants you", thread.host()),
            "this is a test. answer opens the thread with the question in front.",
        ),
        Kind::Done => (
            About::Done,
            format!("{} is done", thread.host()),
            "this is a test. a turn you start ends like this.",
        ),
        Kind::Fault => (
            About::Fault,
            format!("{} stopped", thread.host()),
            "this is a test. a real fault says why, in plain words.",
        ),
        Kind::Ready => (
            About::Ready,
            format!("{} is ready to merge", thread.host()),
            "this is a test. 4 files, +120 -31.",
        ),
    };
    let id = format!("test:{stamp}");
    state.push.test(
        request.device,
        Notice {
            id: id.clone(),
            about,
            thread,
            title,
            body: text.into(),
            // a test is a turn the person started, so a "done" test is armed
            origin: Origin {
                armed: true,
                ..Origin::default()
            },
            badge: None,
        },
    );
    Ok((StatusCode::ACCEPTED, Json(TestQueued { id })))
}

/// what this device is showing; sent on every change and every 30 s while
/// the app is visible and focused.
#[utoipa::path(
    post,
    path = "/api/presence",
    request_body = Report,
    responses(
        (status = 204, description = "noted"),
        (status = 400, description = "not a presence report", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
    ),
)]
pub async fn presence(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let report: Report = parse(&body, "a presence report")?;
    if !devices::is_device_id(&report.device) {
        return Err(ApiError::BadRequest(devices::Refused::DeviceId.to_string()));
    }
    let threads = report.thread.iter().chain(&report.windows_in_view);
    if let Some(bad) = threads.clone().find(|key| Thread::parse(key).is_none()) {
        return Err(ApiError::BadRequest(format!(
            "\"{bad}\" is not a thread; send host:session"
        )));
    }
    if report.windows_in_view.len() > MAX_WINDOWS {
        return Err(ApiError::BadRequest(format!(
            "send at most {MAX_WINDOWS} windows in view"
        )));
    }
    state.push.presence(report);
    Ok(StatusCode::NO_CONTENT)
}

/// every body here is json, read whatever its content type says, because
/// `navigator.sendBeacon` posts presence on the way out as `text/plain`.
fn parse<T: serde::de::DeserializeOwned>(body: &Bytes, what: &str) -> Result<T, ApiError> {
    serde_json::from_slice(body)
        .map_err(|e| ApiError::BadRequest(format!("the body is not {what}: {e}")))
}

fn store_down(error: &crate::store::StoreError) -> ApiError {
    warn!(%error, "the store did not answer a push route");
    ApiError::StoreDown
}
