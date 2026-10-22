//! contract 2's routes: one per verb, `/api/agents/{agent}/...`, through
//! the `AgentSource` trait (`docs/agents.md`, section 4, the routes). every
//! write carries `{device, deviceClass, clientID}` as contract 1's do, and
//! the capability check comes before anything reaches the source.
//!
//! a send (prompt, steer, queue, a new thread) goes through the send
//! ledger (`source/sends.rs`) so it never runs twice: it answers 202
//! `accepted` when the agent took it, or `checking` when the agent's
//! acknowledgement was lost or did not come within 10 s; it never answers
//! 5xx for a send that may have reached an agent that does not dedupe
//! retries itself. the call runs in its own task, so a client that gives up
//! (or a dropped connection) cannot cut a send off halfway.
//!
//! the cmx2-only capabilities that have no verb on the trait (terminals,
//! branch review, places, files, shell lines, slash commands, admin) are
//! served by contract 1's handlers behind the same check (`super::guard`),
//! in the shapes they answer today.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::json;
use tracing::info;
use utoipa::{IntoParams, ToSchema};

use super::{Found, find};
use crate::http::AppState;
use crate::http::asks::{Verb as VerbBody, answer_review, client_id, device_of, segment};
use crate::http::error::{ApiError, ErrorBody};
use crate::media::{Lookup, UPLOAD_PIN_MS};
use crate::source::sends::{Answer, Claim};
use crate::source::{AskRef, Reply, ThreadRef, VerbError};
use crate::wire::{
    Accepted, AcceptedState, Agent, AskKind, Attachment, Born, Capability, ModelEntry, Models,
    Send, Start,
};

/// a send's text, at most (contract 1's composer limit).
const MAX_TEXT: usize = 100_000;
/// an emoji is a short grapheme cluster; anything longer is not one.
const MAX_EMOJI: usize = 32;

/// a prompt, a steer or a queued prompt: the device, then the send.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendBody {
    pub device: String,
    pub device_class: String,
    #[serde(flatten)]
    pub send: Send,
}

/// a new thread: the device, then its first send and where it starts.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartBody {
    pub device: String,
    pub device_class: String,
    #[serde(flatten)]
    pub start: Start,
}

/// a fork: the device, and the message the fork is cut before. without
/// one the fork holds the whole thread.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkBody {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    /// the first message of this thread the fork leaves out.
    #[serde(default)]
    pub before: Option<String>,
}

/// a reaction put on or taken off a message (the reactions capability).
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReactBody {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub emoji: String,
    pub on: bool,
}

/// pairing a connection: which kind of runtime, then what its pairing printed.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionPair {
    pub source: crate::wire::Source,
    pub url: String,
    pub token: String,
    pub name: Option<String>,
}

/// a catalog's scope, for an agent with places.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ModelScope {
    /// the directory a thread runs in.
    pub directory: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendVerb {
    Prompt,
    Steer,
    Queue,
}

/// every agent of every connection, with its connection's state: the
/// agents screen's data (`docs/agents.md`, section 8).
#[utoipa::path(
    get,
    path = "/api/agents",
    responses(
        (status = 200, description = "every agent, grouped by connection in config order", body = Vec<Agent>),
        (status = 401, description = "not signed in", body = ErrorBody),
    ),
)]
pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<Agent>> {
    let mut agents = Vec::new();
    for source in state.upstreams.sources() {
        let status = source.connection_status();
        for facts in source.agents().borrow().iter() {
            agents.push(Agent {
                key: facts.key.clone(),
                label: facts.label.clone(),
                kind: facts.kind,
                source: facts.source,
                mark: facts.mark,
                palette: facts.palette.clone(),
                status: status.status,
                connection: status.connection.clone(),
                capabilities: facts.capabilities.clone(),
                runs: None,
            });
        }
    }
    Json(agents)
}

macro_rules! send_route {
    ($name:ident, $path:literal, $verb:expr, $doc:literal) => {
        #[doc = $doc]
        #[utoipa::path(
            post,
            path = $path,
            params(("agent" = String, Path), ("thread" = String, Path)),
            request_body = SendBody,
            responses(
                (status = 202, description = "accepted, or checking: the agent's acknowledgement was lost and the outcome follows on the thread", body = Accepted),
                (status = 400, description = "not a send", body = ErrorBody),
                (status = 404, description = "no such agent or thread", body = ErrorBody),
                (status = 409, description = "the conversation changed (`generation-changed`), or a retry of a send that was not confirmed (`not-confirmed`)", body = ErrorBody),
                (status = 413, description = "an attachment past the agent's limits", body = ErrorBody),
                (status = 415, description = "an attachment of a kind the agent does not take", body = ErrorBody),
                (status = 422, description = "the agent lacks the capability (`unsupported`), or refused it (`host-said`)", body = ErrorBody),
                (status = 503, description = "the agent is busy; nothing reached it", body = ErrorBody),
            ),
        )]
        pub async fn $name(
            State(state): State<Arc<AppState>>,
            Path((agent, thread)): Path<(String, String)>,
            Json(body): Json<SendBody>,
        ) -> Result<Response, ApiError> {
            send(state, agent, thread, body, $verb).await
        }
    };
}

send_route!(
    prompt,
    "/api/agents/{agent}/threads/{thread}/prompt",
    SendVerb::Prompt,
    "a prompt: it starts a turn (or queues, where the agent queues), armed for done."
);
send_route!(
    steer,
    "/api/agents/{agent}/threads/{thread}/steer",
    SendVerb::Steer,
    "a prompt that joins the running turn at its next step (the steer capability)."
);
send_route!(
    queue,
    "/api/agents/{agent}/threads/{thread}/queue",
    SendVerb::Queue,
    "a prompt for after the running turn (the queue capability)."
);

async fn send(
    state: Arc<AppState>,
    agent: String,
    thread: String,
    body: SendBody,
    verb: SendVerb,
) -> Result<Response, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    client_id(&body.send.client_id)?;
    segment(&thread)?;
    let found = find(&state, &agent)?;
    match verb {
        SendVerb::Steer => found.needs(Capability::Steer)?,
        SendVerb::Queue => found.needs(Capability::Queue)?,
        SendVerb::Prompt => {}
    }
    check_send(&found, &body.send)?;
    let pins = attachments(&state, &found, &body.send.attachments).await?;
    let key = format!("{agent}:{thread}");
    sidecars(&state, &body.send.attachments, &key, &device.id).await?;
    if verb != SendVerb::Queue {
        state
            .fleet
            .arm(key.clone(), body.send.client_id.clone(), device.clone())
            .await
            .map_err(|_| ApiError::Stopping)?;
    }
    let reference = ThreadRef {
        agent: agent.clone(),
        id: thread.clone(),
    };
    let source = Arc::clone(&found.source);
    let media = state.media.clone();
    let client = body.send.client_id.clone();
    let send = body.send;
    let (answer, _) = once(&state, &found, &thread, &client, move || {
        Box::pin(async move {
            let answered = match verb {
                SendVerb::Prompt => source.prompt(&reference, send).await,
                SendVerb::Steer => source.steer(&reference, send).await,
                SendVerb::Queue => source.queue(&reference, send).await,
            };
            let settled = match &answered {
                Ok(accepted) => accepted.state == AcceptedState::Accepted,
                Err(error) => !matches!(error, VerbError::Unreachable { .. }),
            };
            release(&media, pins, settled).await;
            answered.map(Answer::Accepted)
        })
    })
    .await?;
    if verb != SendVerb::Queue {
        answer_review(&state, key, device).await;
    }
    match answer {
        Answer::Accepted(accepted) => Ok((StatusCode::ACCEPTED, Json(accepted)).into_response()),
        Answer::Born(born) => Ok((StatusCode::OK, Json(born)).into_response()),
    }
}

/// what every send must be before it reaches an agent: words or an
/// attachment, under the text limit, and a quote only where the agent has
/// quotes.
fn check_send(found: &Found, send: &Send) -> Result<(), ApiError> {
    if send.text.len() > MAX_TEXT {
        return Err(ApiError::BadRequest(
            "write a message of at most 100,000 characters".into(),
        ));
    }
    if send.text.trim().is_empty() && send.attachments.is_empty() {
        return Err(ApiError::BadRequest(
            "write something, or attach something".into(),
        ));
    }
    if let Some(quote) = &send.quote {
        found.needs(Capability::Quotes)?;
        segment(quote)?;
    }
    if let Some(generation) = &send.generation
        && (generation.is_empty() || generation.len() > 256)
    {
        return Err(ApiError::BadRequest(
            "send the generation as the thread gave it".into(),
        ));
    }
    Ok(())
}

/// each attachment checked against the agent's `attachments` capability
/// (kind, count, and size per file) before anything reaches it, then pinned
/// in the store until its send settles. answers the pins to release.
async fn attachments(
    state: &AppState,
    found: &Found,
    list: &[Attachment],
) -> Result<Vec<(String, i64)>, ApiError> {
    if list.is_empty() {
        return Ok(Vec::new());
    }
    found.needs(Capability::Attachments)?;
    let Some(allowed) = found.facts.capabilities.attachments.as_ref() else {
        return Err(found.refusal(None, VerbError::Unsupported(Capability::Attachments)));
    };
    let name = found.name();
    if list.len() > allowed.max_count as usize {
        return Err(ApiError::AttachmentTooLarge(format!(
            "{name} takes at most {} attachments with one message; send fewer",
            allowed.max_count
        )));
    }
    let until = crate::now_ms() + UPLOAD_PIN_MS;
    let mut pins = Vec::with_capacity(list.len());
    for attachment in list {
        if !crate::media::is_id(&attachment.media) {
            return Err(ApiError::BadRequest(format!(
                "\"{}\" is not a media id; upload the file first",
                attachment.media
            )));
        }
        let object = match state
            .media
            .lookup(&attachment.media)
            .await
            .map_err(|_| ApiError::StoreDown)?
        {
            Lookup::Ready(object) => object,
            Lookup::Evicted => {
                return Err(ApiError::BadRequest(
                    "an attachment is no longer on the server; attach it again".into(),
                ));
            }
            Lookup::Unknown => {
                return Err(ApiError::BadRequest(
                    "an attachment was never uploaded; attach it again".into(),
                ));
            }
        };
        if !allowed
            .kinds
            .iter()
            .any(|kind| kind_matches(kind, &object.mime))
        {
            return Err(ApiError::AttachmentKind(format!(
                "{name} does not take a {}; send one of {}",
                object.mime,
                allowed.kinds.join(", ")
            )));
        }
        if object.size > allowed.max_bytes {
            return Err(ApiError::AttachmentTooLarge(format!(
                "{} is {} MiB, over the {} MiB {name} takes; send a smaller one",
                object.filename.as_deref().unwrap_or("an attachment"),
                object.size.div_ceil(1024 * 1024),
                allowed.max_bytes / (1024 * 1024)
            )));
        }
        if attachment.transcript.is_some() && !object.mime.starts_with("audio/") {
            return Err(ApiError::BadRequest(
                "a transcript belongs to a voice note; send it with the audio".into(),
            ));
        }
        if state
            .media
            .pin(&attachment.media, until)
            .await
            .map_err(|_| ApiError::StoreDown)?
        {
            pins.push((attachment.media.clone(), until));
        }
    }
    Ok(pins)
}

/// a capability's kind pattern, `image/png` or `image/*`, against a type.
fn kind_matches(pattern: &str, mime: &str) -> bool {
    match pattern.strip_suffix("/*") {
        Some(family) => mime
            .split_once('/')
            .is_some_and(|(top, _)| top.eq_ignore_ascii_case(family)),
        None => pattern.eq_ignore_ascii_case(mime),
    }
}

/// your device's transcript of each voice note, written before the agent is
/// called (`agents.md`, section 6, sidecars). it is never sent to the agent.
async fn sidecars(
    state: &AppState,
    list: &[Attachment],
    thread_key: &str,
    device: &str,
) -> Result<(), ApiError> {
    for attachment in list {
        let Some(transcript) = &attachment.transcript else {
            continue;
        };
        state
            .media
            .put_sidecar(
                &attachment.media,
                thread_key,
                &transcript.text,
                transcript.lang.as_deref(),
                Some(device),
            )
            .await
            .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    }
    Ok(())
}

/// lets a send's pins go once it is settled: taken, or refused before it
/// reached the agent. one still being checked keeps its pin until the pin
/// lapses, since the agent may yet read the file.
async fn release(media: &crate::media::Media, pins: Vec<(String, i64)>, settled: bool) {
    if !settled {
        return;
    }
    for (id, until) in pins {
        // a store that is not answering lets the pin lapse on its own
        let _ = media.release(&id, until).await;
    }
}

fn checking() -> Answer {
    Answer::Accepted(Accepted {
        state: AcceptedState::Checking,
        message: None,
    })
}

/// runs a send at most once per client id, through the ledger: the first
/// call goes to the source in its own task; a retry shares the running
/// call's answer or gets the one kept. for an agent that does not dedupe
/// retries itself, an answer that takes past `ANSWER_WITHIN` is `checking`
/// and the call carries on. answers whether this request made the call.
async fn once<F>(
    state: &AppState,
    found: &Found,
    thread: &str,
    client: &str,
    call: F,
) -> Result<(Answer, bool), ApiError>
where
    F: FnOnce() -> BoxFuture<'static, Result<Answer, VerbError>> + std::marker::Send,
{
    let agent: Arc<str> = Arc::from(found.key());
    let connection = found.connection();
    let deadline = (!found.dedupes()).then_some(state.sends.answer_within());
    let mut call = Some(call);
    // a running send that is forgotten (nothing reached the agent) lets a
    // waiting retry claim it; three rounds is past any real interleaving
    for _ in 0..3 {
        match state.sends.claim(&connection, &agent, thread, client).await {
            Claim::Known(known) => {
                return known
                    .answer()
                    .map(|a| (a, false))
                    .map_err(|e| found.refusal(Some(thread), e));
            }
            Claim::Waiting(waiter) => {
                let shared = match deadline {
                    Some(limit) => tokio::time::timeout(limit, waiter.wait()).await.ok(),
                    None => Some(waiter.wait().await),
                };
                match shared {
                    // the first request may be gone (its client hung up): the
                    // thread is told it is checking, whoever answers first
                    None => {
                        if state.sends.told_checking(&agent, client).await {
                            return Ok((checking(), false));
                        }
                    }
                    Some(Some(known)) => {
                        return known
                            .answer()
                            .map(|a| (a, false))
                            .map_err(|e| found.refusal(Some(thread), e));
                    }
                    Some(None) => {}
                }
            }
            Claim::Go(ticket) => {
                let Some(call) = call.take() else { break };
                let running = call();
                let dedupes = found.dedupes();
                let mut task = tokio::spawn(async move {
                    if let Ok(answered) = AssertUnwindSafe(running).catch_unwind().await {
                        ticket.settle(&answered).await;
                        Some(answered)
                    } else {
                        // a panic proves nothing about the agent: cmx2 dedupes a
                        // retry, so it may go again; any other ends uncertain
                        if dedupes {
                            drop(ticket);
                        } else {
                            ticket.uncertain().await;
                        }
                        None
                    }
                });
                let joined = match deadline {
                    Some(limit) => {
                        if let Ok(joined) = tokio::time::timeout(limit, &mut task).await {
                            joined
                        } else if state.sends.told_checking(&agent, client).await {
                            info!(agent = %agent, "a send had no answer in time; answered checking while it carries on");
                            return Ok((checking(), true));
                        } else {
                            // it answered as the time ran out: give that answer
                            task.await
                        }
                    }
                    None => task.await,
                };
                return match joined {
                    Ok(Some(Ok(answer))) => Ok((answer, true)),
                    Ok(Some(Err(error))) => Err(found.refusal(Some(thread), error)),
                    Ok(None) | Err(_) if !dedupes => Ok((checking(), true)),
                    Ok(None) | Err(_) => Err(ApiError::AgentUnreachable {
                        agent: found.name(),
                        reason: "the send failed inside the server".into(),
                    }),
                };
            }
        }
    }
    Err(ApiError::AgentBusy(found.name()))
}

/// starts a thread with its first send. a place goes only to an agent with
/// places (and a fresh worktree only with worktree); an agent with places
/// needs one. a retry with the same client id answers the thread the first
/// try made.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/threads",
    params(("agent" = String, Path)),
    request_body = StartBody,
    responses(
        (status = 201, description = "the new thread", body = Born),
        (status = 200, description = "a retry: the thread the first try made", body = Born),
        (status = 202, description = "checking: the agent did not answer in time; the thread comes on the stream if it was made", body = Accepted),
        (status = 400, description = "not a thread, or a place missing for an agent with places", body = ErrorBody),
        (status = 404, description = "no such agent", body = ErrorBody),
        (status = 422, description = "the agent cannot start threads, or has no places or worktrees", body = ErrorBody),
    ),
)]
pub async fn start(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
    Json(body): Json<StartBody>,
) -> Result<Response, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    client_id(&body.start.send.client_id)?;
    let found = find(&state, &agent)?;
    found.needs(Capability::Threads)?;
    if body.start.place.is_some() {
        found.needs(Capability::Places)?;
    } else if found.facts.capabilities.places {
        return Err(ApiError::BadRequest(format!(
            "pick a place on {} to start in",
            found.name()
        )));
    }
    if body.start.worktree {
        found.needs(Capability::Worktree)?;
    }
    check_send(&found, &body.start.send)?;
    let pins = attachments(&state, &found, &body.start.send.attachments).await?;
    let source = Arc::clone(&found.source);
    let media = state.media.clone();
    let client = body.start.send.client_id.clone();
    let transcripts = body.start.send.attachments.clone();
    let start = body.start;
    let named = agent.clone();
    let (answer, fresh) = once(&state, &found, "", &client, move || {
        Box::pin(async move {
            let answered = source.start(&named, start).await;
            let settled = !matches!(answered, Err(VerbError::Unreachable { .. }));
            release(&media, pins, settled).await;
            answered.map(Answer::Born)
        })
    })
    .await?;
    let born = match answer {
        Answer::Born(born) => born,
        // no answer in time from an agent that does not dedupe: the thread
        // may exist, and it comes on the stream when it does
        Answer::Accepted(accepted) => {
            return Ok((StatusCode::ACCEPTED, Json(accepted)).into_response());
        }
    };
    // a retry that shares the first answer arms and writes again: both are
    // idempotent, and the first request may have gone before it did
    state
        .fleet
        .arm(born.key.clone(), client, device.clone())
        .await
        .map_err(|_| ApiError::Stopping)?;
    if let Err(error) = sidecars(&state, &transcripts, &born.key, &device.id).await {
        // the thread is born and its send went: the transcript is the device's own copy
        tracing::warn!(agent, thread = %born.thread, %error, "a voice note's transcript was not kept for a new thread");
    }
    if fresh {
        info!(agent, thread = %born.thread, "a new thread was started");
    }
    let status = if fresh {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(born)).into_response())
}

/// answers an ask: a permission with `option`, a question with `answers` or
/// `reject`.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/asks/{id}",
    params(("agent" = String, Path), ("id" = String, Path)),
    request_body = crate::wire::AnswerBody,
    responses(
        (status = 204, description = "answered"),
        (status = 400, description = "not an answer", body = ErrorBody),
        (status = 404, description = "no such agent, or the ask is gone", body = ErrorBody),
        (status = 409, description = "already settled; `error.settled` says by whom and when", body = ErrorBody),
        (status = 422, description = "the agent has no approvals or no questions", body = ErrorBody),
    ),
)]
pub async fn answer(
    State(state): State<Arc<AppState>>,
    Path((agent, id)): Path<(String, String)>,
    Json(body): Json<crate::wire::AnswerBody>,
) -> Result<StatusCode, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    client_id(&body.client_id)?;
    segment(&id)?;
    let (kind, reply) = match (body.option, body.answers, body.reject) {
        (Some(option), None, false) => (AskKind::Permission, Reply::Option(option)),
        (None, Some(answers), false) => {
            if answers.is_empty() || answers.iter().any(Vec::is_empty) {
                return Err(ApiError::BadRequest(
                    "choose an answer for every question".into(),
                ));
            }
            (AskKind::Question, Reply::Answers(answers))
        }
        (None, None, true) => (AskKind::Question, Reply::Reject),
        _ => {
            return Err(ApiError::BadRequest(
                "send one of option, answers or reject".into(),
            ));
        }
    };
    answer_ask(&state, agent, id, kind, device, body.client_id, reply).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// answers an ask through its agent once the answer is checked: the fleet
/// hears who is answering first, so the need it serves names the device.
/// the board's reply takes the same path (`board/routes.rs`).
///
/// # Errors
/// no such agent, the agent lacks the capability, or it refused.
pub async fn answer_ask(
    state: &AppState,
    agent: String,
    id: String,
    kind: AskKind,
    device: crate::fleet::model::Device,
    client_id: String,
    reply: Reply,
) -> Result<(), ApiError> {
    let found = find(state, &agent)?;
    found.needs(match kind {
        AskKind::Permission => Capability::Approvals,
        AskKind::Question => Capability::Questions,
    })?;
    state
        .fleet
        .answering(agent.clone(), id.clone(), device.clone())
        .await
        .map_err(|_| ApiError::Stopping)?;
    let ask = AskRef {
        agent,
        id,
        kind,
        thread: None,
    };
    found
        .source
        .answer(
            &ask,
            crate::source::Answer {
                device: device.id,
                device_class: device.class,
                client_id,
                reply,
            },
        )
        .await
        .map_err(|e| found.refusal(None, e))
}

/// the agent, its thread checked, and the device a plain verb came from.
fn verb_target(
    state: &AppState,
    agent: &str,
    thread: &str,
    body: &VerbBody,
) -> Result<(Found, ThreadRef), ApiError> {
    device_of(&body.device, &body.device_class)?;
    client_id(&body.client_id)?;
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

/// stops the running turn; a fault that follows is the person's own action.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/threads/{thread}/abort",
    params(("agent" = String, Path), ("thread" = String, Path)),
    request_body = VerbBody,
    responses(
        (status = 204, description = "stopped"),
        (status = 404, description = "no such agent or thread", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn abort(
    State(state): State<Arc<AppState>>,
    Path((agent, thread)): Path<(String, String)>,
    Json(body): Json<VerbBody>,
) -> Result<StatusCode, ApiError> {
    let (found, reference) = verb_target(&state, &agent, &thread, &body)?;
    state
        .fleet
        .own_action(reference.key())
        .await
        .map_err(|_| ApiError::Stopping)?;
    found
        .source
        .abort(&reference)
        .await
        .map_err(|e| found.refusal(Some(&thread), e))?;
    Ok(StatusCode::NO_CONTENT)
}

macro_rules! plain_route {
    ($name:ident, $path:literal, $capability:expr, $call:ident, $doc:literal) => {
        #[doc = $doc]
        #[utoipa::path(
            post,
            path = $path,
            params(("agent" = String, Path), ("thread" = String, Path)),
            request_body = VerbBody,
            responses(
                (status = 204, description = "done"),
                (status = 404, description = "no such agent or thread", body = ErrorBody),
                (status = 422, description = "the agent lacks the capability, or refused", body = ErrorBody),
                (status = 502, description = "the agent did not answer", body = ErrorBody),
            ),
        )]
        pub async fn $name(
            State(state): State<Arc<AppState>>,
            Path((agent, thread)): Path<(String, String)>,
            Json(body): Json<VerbBody>,
        ) -> Result<StatusCode, ApiError> {
            let (found, reference) = verb_target(&state, &agent, &thread, &body)?;
            found.needs($capability)?;
            found
                .source
                .$call(&reference)
                .await
                .map_err(|e| found.refusal(Some(&thread), e))?;
            Ok(StatusCode::NO_CONTENT)
        }
    };
}

plain_route!(
    compact,
    "/api/agents/{agent}/threads/{thread}/compact",
    Capability::Compact,
    compact,
    "compacts the thread now (the compact capability)."
);
plain_route!(
    run_now,
    "/api/agents/{agent}/threads/{thread}/run-now",
    Capability::Queue,
    run_now,
    "runs what is queued now (the queue capability)."
);

/// takes back a queued prompt (the queue capability).
#[utoipa::path(
    delete,
    path = "/api/agents/{agent}/threads/{thread}/messages/{message}",
    params(("agent" = String, Path), ("thread" = String, Path), ("message" = String, Path)),
    responses(
        (status = 204, description = "taken back"),
        (status = 404, description = "no such agent, thread or message", body = ErrorBody),
        (status = 409, description = "already sent: the agent has it", body = ErrorBody),
        (status = 422, description = "the agent has no queue", body = ErrorBody),
    ),
)]
pub async fn unsend(
    State(state): State<Arc<AppState>>,
    Path((agent, thread, message)): Path<(String, String, String)>,
) -> Result<StatusCode, ApiError> {
    segment(&thread)?;
    segment(&message)?;
    let found = find(&state, &agent)?;
    found.needs(Capability::Queue)?;
    let reference = ThreadRef {
        agent,
        id: thread.clone(),
    };
    found
        .source
        .unsend(&reference, &message)
        .await
        .map_err(|e| found.refusal(Some(&thread), e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// puts a reaction on a message or takes it off (the reactions capability).
#[utoipa::path(
    put,
    path = "/api/agents/{agent}/threads/{thread}/messages/{message}/reactions",
    params(("agent" = String, Path), ("thread" = String, Path), ("message" = String, Path)),
    request_body = ReactBody,
    responses(
        (status = 204, description = "done; the whole list follows as a `reactions` change"),
        (status = 400, description = "not an emoji", body = ErrorBody),
        (status = 404, description = "no such agent, thread or message", body = ErrorBody),
        (status = 422, description = "the agent has no reactions", body = ErrorBody),
    ),
)]
pub async fn react(
    State(state): State<Arc<AppState>>,
    Path((agent, thread, message)): Path<(String, String, String)>,
    Json(body): Json<ReactBody>,
) -> Result<StatusCode, ApiError> {
    device_of(&body.device, &body.device_class)?;
    client_id(&body.client_id)?;
    segment(&thread)?;
    segment(&message)?;
    let emoji = body.emoji.trim();
    if emoji.is_empty() || emoji.len() > MAX_EMOJI || emoji.chars().any(char::is_alphanumeric) {
        return Err(ApiError::BadRequest("react with one emoji".into()));
    }
    let found = find(&state, &agent)?;
    found.needs(Capability::Reactions)?;
    let reference = ThreadRef {
        agent,
        id: thread.clone(),
    };
    found
        .source
        .react(&reference, &message, emoji, body.on)
        .await
        .map_err(|e| found.refusal(Some(&thread), e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// archives a thread (the archive capability): it leaves the fleet.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/threads/{thread}/archive",
    params(("agent" = String, Path), ("thread" = String, Path)),
    request_body = VerbBody,
    responses(
        (status = 200, description = "archived", body = crate::wire::verbs::Archived),
        (status = 404, description = "no such agent or thread", body = ErrorBody),
        (status = 422, description = "the agent has no archive, or refused", body = ErrorBody),
    ),
)]
pub async fn archive(
    State(state): State<Arc<AppState>>,
    Path((agent, thread)): Path<(String, String)>,
    Json(body): Json<VerbBody>,
) -> Result<Json<crate::wire::verbs::Archived>, ApiError> {
    let (found, reference) = verb_target(&state, &agent, &thread, &body)?;
    found.needs(Capability::Archive)?;
    // archiving stops the turn: a stop push for it would tell a device about what its owner just did
    state
        .fleet
        .own_action(reference.key())
        .await
        .map_err(|_| ApiError::Stopping)?;
    let outcome = found.source.archive(&reference).await;
    state.telemetry.record(&json!({
        "kind": "thread.archived",
        "host": agent,
        "session": reference.key(),
        "ok": outcome.as_ref().map_or_else(|e| (!matches!(e, VerbError::Uncertain { .. })).then_some(false), |_| Some(true)),
    }));
    let archived = outcome.map_err(|e| found.refusal(Some(&thread), e))?;
    info!(agent, thread, "thread archived");
    Ok(Json(crate::wire::verbs::Archived {
        key: archived.key,
        at: archived.at,
    }))
}

/// forks a thread (the fork capability): a new thread holding its history
/// up to, not including, `before`, or all of it. the new thread is the
/// agent's to name; it reaches the fleet on the agent's events like any
/// other, and the answer names it so the device can open it once it does.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/threads/{thread}/fork",
    params(("agent" = String, Path), ("thread" = String, Path)),
    request_body = ForkBody,
    responses(
        (status = 201, description = "the new thread", body = Born),
        (status = 400, description = "not a fork", body = ErrorBody),
        (status = 404, description = "no such agent or thread (`no-such-session`), or the message is not in it (`no-such-turn`)", body = ErrorBody),
        (status = 409, description = "the agent refused: history it holds as browse only", body = ErrorBody),
        (status = 422, description = "the agent cannot fork", body = ErrorBody),
        (status = 502, description = "the agent could not be reached (`agent-unreachable`), or took the fork and did not answer in time (`agent-uncertain`: a retry with the same clientID answers the first fork)", body = ErrorBody),
    ),
)]
pub async fn fork(
    State(state): State<Arc<AppState>>,
    Path((agent, thread)): Path<(String, String)>,
    Json(body): Json<ForkBody>,
) -> Result<(StatusCode, Json<Born>), ApiError> {
    device_of(&body.device, &body.device_class)?;
    client_id(&body.client_id)?;
    segment(&thread)?;
    if let Some(before) = &body.before {
        segment(before)?;
    }
    let found = find(&state, &agent)?;
    found.needs(Capability::Fork)?;
    let reference = ThreadRef {
        agent: agent.clone(),
        id: thread.clone(),
    };
    let cut = if body.before.is_some() {
        "turn"
    } else {
        "whole"
    };
    let fork = crate::source::Fork {
        before: body.before,
        client_id: body.client_id,
    };
    let outcome = found.source.fork(&reference, fork).await;
    let (ok, told) = fork_outcome(&outcome);
    state.telemetry.record(&json!({
        "kind": "thread.forked",
        "host": agent,
        "session": reference.key(),
        "ok": ok,
        "props": { "cut": cut, "outcome": told },
    }));
    let born = outcome.map_err(|e| found.refusal(Some(&thread), e))?;
    info!(agent, thread, forked = %born.thread, "thread forked");
    Ok((StatusCode::CREATED, Json(born)))
}

/// what telemetry says of a fork: `ok` true when the agent answered with
/// the new thread, false when it refused or could not be reached, and null
/// when it took the fork and its answer was lost (it may exist), with the
/// outcome that says which.
fn fork_outcome(outcome: &Result<Born, VerbError>) -> (Option<bool>, &'static str) {
    match outcome {
        Ok(_) => (Some(true), "done"),
        Err(VerbError::Uncertain { .. }) => (None, "unknown"),
        Err(VerbError::Unreachable { .. } | VerbError::Busy) => (Some(false), "failed"),
        Err(_) => (Some(false), "refused"),
    }
}

/// holds a past thread in the fleet (the history capability): one opened
/// from history that the fleet does not hold.
#[utoipa::path(
    post,
    path = "/api/agents/{agent}/threads/{thread}/adopt",
    operation_id = "adoptThread",
    params(("agent" = String, Path), ("thread" = String, Path)),
    request_body = VerbBody,
    responses(
        (status = 204, description = "the fleet holds the thread now"),
        (status = 404, description = "no such agent or thread, or it was archived", body = ErrorBody),
        (status = 422, description = "the agent has no history", body = ErrorBody),
    ),
)]
pub async fn adopt(
    State(state): State<Arc<AppState>>,
    Path((agent, thread)): Path<(String, String)>,
    Json(body): Json<VerbBody>,
) -> Result<StatusCode, ApiError> {
    let (found, reference) = verb_target(&state, &agent, &thread, &body)?;
    found.needs(Capability::History)?;
    let facts = found
        .source
        .adopt(&reference)
        .await
        .map_err(|e| found.refusal(Some(&thread), e))?;
    state
        .fleet
        .adopt(agent, facts)
        .await
        .map_err(|_| ApiError::Stopping)?;
    Ok(StatusCode::NO_CONTENT)
}

/// the agent's model catalog (the model capability).
#[utoipa::path(
    get,
    path = "/api/agents/{agent}/models",
    params(("agent" = String, Path), ModelScope),
    responses(
        (status = 200, description = "the models a send may name", body = Models),
        (status = 404, description = "no such agent", body = ErrorBody),
        (status = 422, description = "the agent has no model picker", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn models(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
    Query(scope): Query<ModelScope>,
) -> Result<Json<Models>, ApiError> {
    let found = find(&state, &agent)?;
    found.needs(Capability::Model)?;
    let catalog = found
        .source
        .catalog(&agent, scope.directory.as_deref())
        .await
        .map_err(|e| found.refusal(None, e))?;
    Ok(Json(Models {
        models: catalog
            .models
            .into_iter()
            .map(|m| ModelEntry {
                id: m.id,
                name: m.name,
                provider: m.provider,
                levels: m.levels,
            })
            .collect(),
        default: catalog.default,
    }))
}

/// pairs a connection of one kind of runtime: cmx2 through its one-time
/// token, as contract 1's pairing does. other runtimes pair their own way
/// (the openclaw lane).
#[utoipa::path(
    post,
    path = "/api/connections/pair",
    request_body = ConnectionPair,
    responses(
        (status = 201, description = "paired", body = crate::http::hosts::PairedHost),
        (status = 400, description = "not a pairing", body = ErrorBody),
        (status = 409, description = "the name or address is taken", body = ErrorBody),
        (status = 501, description = "this runtime does not pair here yet", body = ErrorBody),
    ),
)]
pub async fn pair(
    state: State<Arc<AppState>>,
    Json(body): Json<ConnectionPair>,
) -> Result<Response, ApiError> {
    if body.source != crate::wire::Source::Cmx2 {
        return Err(ApiError::NotBuilt(
            "pairing a runtime other than cmx2 from here",
        ));
    }
    let pair = crate::http::hosts::Pair {
        url: body.url,
        token: body.token,
        name: body.name,
    };
    Ok(crate::http::hosts::pair(state, Json(pair))
        .await?
        .into_response())
}
