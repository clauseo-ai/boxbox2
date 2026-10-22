//! the btw verbs (`docs/agents.md`, the btw): a side question about a
//! thread, answered from its context with no tools and kept out of it. the
//! btw capability is checked before anything reaches the source, and each
//! verb's outcome is recorded from the agent's answer, never the question.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::json;
use utoipa::ToSchema;

use super::{Found, find};
use crate::http::AppState;
use crate::http::asks::{client_id, device_of, segment};
use crate::http::error::{ApiError, ErrorBody};
use crate::source::{ThreadRef, VerbError};
use crate::wire::{Btw, BtwPromoted, Capability, MAX_BTW_TEXT};

/// a side question, from a device.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schema(as = AgentBtwAsk)]
pub struct BtwAsk {
    pub device: String,
    pub device_class: String,
    /// the client's id for the question; a retry carries the same one.
    #[serde(rename = "clientID")]
    pub client_id: String,
    /// at most 32 KiB, and not empty.
    pub question: String,
}

/// dismissing a btw or adding it to the thread, from a device.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schema(as = AgentBtwVerb)]
pub struct BtwVerb {
    pub device: String,
    pub device_class: String,
}

/// the agent and its thread, once the thread id is checked. the btw
/// capability is checked after, by `gate`, so its refusal is recorded.
fn target(state: &AppState, agent: &str, thread: &str) -> Result<(Found, ThreadRef), ApiError> {
    segment(thread)?;
    let found = find(state, agent)?;
    Ok((
        found,
        ThreadRef {
            agent: agent.to_owned(),
            id: thread.to_owned(),
        },
    ))
}

/// how a btw verb went, for telemetry: the agent's answer, never the words.
fn outcome<T>(answered: &Result<T, VerbError>) -> &'static str {
    match answered {
        Ok(_) => "done",
        Err(VerbError::Missing { .. } | VerbError::Gone) => "gone",
        Err(VerbError::Unsupported(_)) => "unsupported",
        Err(
            VerbError::Refused { .. }
            | VerbError::Bad(_)
            | VerbError::GenerationChanged
            | VerbError::Settled { .. }
            | VerbError::AlreadySent
            | VerbError::NotConfirmed,
        ) => "refused",
        Err(VerbError::Unreachable { .. } | VerbError::Busy | VerbError::NotBuilt(_)) => "failed",
    }
}

/// one `btw.*` row: `ok` and `outcome` from the agent's answer.
fn record(
    state: &AppState,
    kind: &str,
    reference: &ThreadRef,
    outcome: &str,
    chars: Option<usize>,
) {
    let mut props = json!({ "outcome": outcome });
    if let Some(chars) = chars {
        props["chars"] = json!(chars);
    }
    state.telemetry.record(&json!({
        "kind": kind,
        "host": reference.agent,
        "session": reference.key(),
        "ok": outcome == "done",
        "props": props,
    }));
}

/// 422 `unsupported` unless the agent has btw, recorded as `kind` with
/// outcome unsupported when it has not: nothing reaches the source.
fn gate(
    state: &AppState,
    found: &Found,
    reference: &ThreadRef,
    kind: &str,
    chars: Option<usize>,
) -> Result<(), ApiError> {
    found.needs(Capability::Btw).inspect_err(|_| {
        record(state, kind, reference, "unsupported", chars);
    })
}

/// the question's checks: words, under the cap.
fn check_question(question: &str) -> Result<(), ApiError> {
    if question.trim().is_empty() {
        return Err(ApiError::BadRequest("write a question to ask".into()));
    }
    if question.len() > MAX_BTW_TEXT {
        return Err(ApiError::BadRequest(
            "write a question of at most 32 KiB; shorten it".into(),
        ));
    }
    Ok(())
}

/// asks a side question about the thread; it works mid-turn and changes
/// neither the thread's status nor its queue.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/threads/{thread}/btw",
    params(("agent" = String, Path), ("thread" = String, Path)),
    request_body = BtwAsk,
    responses(
        (status = 200, description = "the btw, running; its answer streams as `btw.delta` entries", body = Btw),
        (status = 400, description = "not a question: empty, or past 32 KiB", body = ErrorBody),
        (status = 404, description = "no such agent or thread", body = ErrorBody),
        (status = 422, description = "the agent has no btw (`unsupported`), or refused it (`host-said`)", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn btw_ask(
    State(state): State<Arc<AppState>>,
    Path((agent, thread)): Path<(String, String)>,
    Json(body): Json<BtwAsk>,
) -> Result<Json<Btw>, ApiError> {
    device_of(&body.device, &body.device_class)?;
    client_id(&body.client_id)?;
    check_question(&body.question)?;
    let (found, reference) = target(&state, &agent, &thread)?;
    gate(
        &state,
        &found,
        &reference,
        "btw.asked",
        Some(body.question.chars().count()),
    )?;
    let answered = found
        .source
        .btw_ask(&reference, &body.client_id, &body.question)
        .await;
    record(
        &state,
        "btw.asked",
        &reference,
        outcome(&answered),
        Some(body.question.chars().count()),
    );
    answered
        .map(Json)
        .map_err(|e| found.refusal(Some(&thread), e))
}

/// the thread's btws, oldest first: what a client reads again when it
/// cannot place an answer's text.
#[utoipa::path(
    get,
    path = "/api/agents/{agent}/threads/{thread}/btw",
    params(("agent" = String, Path), ("thread" = String, Path)),
    responses(
        (status = 200, description = "every btw of the thread, oldest first", body = Vec<Btw>),
        (status = 404, description = "no such agent or thread", body = ErrorBody),
        (status = 422, description = "the agent has no btw", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn btw_list(
    State(state): State<Arc<AppState>>,
    Path((agent, thread)): Path<(String, String)>,
) -> Result<Json<Vec<Btw>>, ApiError> {
    let (found, reference) = target(&state, &agent, &thread)?;
    found.needs(Capability::Btw)?;
    found
        .source
        .btws(&reference)
        .await
        .map(Json)
        .map_err(|e| found.refusal(Some(&thread), e))
}

/// dismisses a btw on every device.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/threads/{thread}/btw/{btw}/dismiss",
    params(("agent" = String, Path), ("thread" = String, Path), ("btw" = String, Path)),
    request_body = BtwVerb,
    responses(
        (status = 200, description = "the btw, dismissed", body = Btw),
        (status = 404, description = "no such agent or thread, or the btw is gone (`gone`)", body = ErrorBody),
        (status = 422, description = "the agent has no btw, or refused", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn btw_dismiss(
    State(state): State<Arc<AppState>>,
    Path((agent, thread, btw)): Path<(String, String, String)>,
    Json(body): Json<BtwVerb>,
) -> Result<Json<Btw>, ApiError> {
    device_of(&body.device, &body.device_class)?;
    segment(&btw)?;
    let (found, reference) = target(&state, &agent, &thread)?;
    gate(&state, &found, &reference, "btw.dismissed", None)?;
    let answered = found.source.btw_dismiss(&reference, &btw).await;
    record(
        &state,
        "btw.dismissed",
        &reference,
        outcome(&answered),
        None,
    );
    answered
        .map(Json)
        .map_err(|e| found.refusal(Some(&thread), e))
}

/// adds a btw's question and answer to the thread as a user message: it
/// joins the running turn, or starts one, so the turn is armed for done.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/threads/{thread}/btw/{btw}/promote",
    params(("agent" = String, Path), ("thread" = String, Path), ("btw" = String, Path)),
    request_body = BtwVerb,
    responses(
        (status = 200, description = "the user message the btw became", body = BtwPromoted),
        (status = 404, description = "no such agent or thread, or the btw is gone (`gone`)", body = ErrorBody),
        (status = 422, description = "the agent has no btw, or refused (a btw still running, or added already)", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn btw_promote(
    State(state): State<Arc<AppState>>,
    Path((agent, thread, btw)): Path<(String, String, String)>,
    Json(body): Json<BtwVerb>,
) -> Result<Json<BtwPromoted>, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    segment(&btw)?;
    let (found, reference) = target(&state, &agent, &thread)?;
    gate(&state, &found, &reference, "btw.promoted", None)?;
    // the message it becomes carries no client id of ours, so the arm is
    // keyed by the btw: it serves through the turn starting while it is fresh
    state
        .fleet
        .arm(reference.key(), format!("btw:{btw}"), device)
        .await
        .map_err(|_| ApiError::Stopping)?;
    let answered = found.source.btw_promote(&reference, &btw).await;
    record(&state, "btw.promoted", &reference, outcome(&answered), None);
    answered
        .map(|message_id| Json(BtwPromoted { message_id }))
        .map_err(|e| found.refusal(Some(&thread), e))
}
