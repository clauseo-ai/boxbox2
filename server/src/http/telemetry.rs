//! `POST /api/telemetry`: a batch of events from the app or the board,
//! normalized against the dictionary and handed to the writer.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::{ApiError, ErrorBody};
use crate::telemetry::{self, Batch, MAX_BATCH, Origin, dictionary, mint_id};

const MAX_DEVICE_CHARS: usize = 40;

/// the body is read whatever its content type says, because
/// `navigator.sendBeacon` posts `text/plain`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryBatch {
    /// the producer's device id, minted once per browser profile or board.
    pub device: String,
    /// one of the dictionary's device classes, claimed explicitly.
    pub device_class: String,
    /// raw events: `{kind, id?, at?, surface?, host?, session?, repo?, ok?, ms?, props?}`.
    #[schema(value_type = Vec<Object>)]
    pub events: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Accepted {
    /// events stored.
    pub accepted: usize,
    /// events dropped whole (unknown kind, or a kind the server owns).
    pub dropped: usize,
}

#[utoipa::path(
    post,
    path = "/api/telemetry",
    request_body = TelemetryBatch,
    responses(
        (status = 200, description = "normalized and queued for the day file", body = Accepted),
        (status = 400, description = "not a telemetry batch", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 413, description = "more than 500 events", body = ErrorBody),
        (status = 503, description = "the writer is backed up; send again", body = ErrorBody),
    ),
)]
pub async fn ingest(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Json<Accepted>, ApiError> {
    let batch: TelemetryBatch = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("the body is not a telemetry batch: {e}")))?;
    if batch.device.trim().is_empty() {
        return Err(ApiError::BadRequest("device is empty".into()));
    }
    if !dictionary::is_device_class(&batch.device_class) {
        let known = dictionary::DEVICE_CLASSES.join(", ");
        return Err(ApiError::BadRequest(format!(
            "deviceClass must be one of {known}"
        )));
    }
    if batch.events.len() > MAX_BATCH {
        return Err(ApiError::BatchTooLarge {
            got: batch.events.len(),
            max: MAX_BATCH,
        });
    }

    let device: String = batch.device.chars().take(MAX_DEVICE_CHARS).collect();
    let received_at = crate::now_ms();
    let origin = Origin {
        device: &device,
        device_class: &batch.device_class,
        received_at,
        server: false,
    };
    let mut mint = || mint_id(received_at);
    let mut dropped = Vec::new();
    let rows: Vec<_> = batch
        .events
        .iter()
        .filter_map(|raw| telemetry::normalize::normalize(raw, origin, &mut mint, &mut dropped))
        .collect();
    let answer = Accepted {
        accepted: rows.len(),
        dropped: batch.events.len() - rows.len(),
    };
    state
        .telemetry
        .send(Batch { rows, dropped })
        .map_err(|_| ApiError::TelemetryBusy)?;
    Ok(Json(answer))
}
