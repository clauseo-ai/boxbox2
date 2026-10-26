//! a thread leaving and returning: clear it off home, bring it back
//! (unclear), acknowledge what the sweep cleared while nobody looked, archive
//! it, and open one the fleet does not hold (`docs/home.md`, clearing; `docs/design.md`,
//! the thread menu).
//!
//! clearing is boxbox's own state (`fleet/clears.rs`) and never touches the
//! daemon: the thread stays in history. archiving is the daemon's
//! (cmx2's `PATCH /session/:id` with `time.archived`): the thread leaves
//! every listing and its history stays on disk. opening a thread from
//! history reads it from its daemon and lets the fleet adopt it, so the
//! stage and every device's cache know it like any other session.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::value::RawValue;
use tracing::info;
use utoipa::ToSchema;

use super::AppState;
use super::agents;
use super::asks::{device_of, segment};
use super::error::{ApiError, ErrorBody};
use crate::fleet::model::{ClearRefused, UnclearRefused, session_key};
use crate::push::Thread;
use crate::source::cmx2::translate;
#[cfg(test)]
use crate::source::cmx2::verbs::threads::{MAX_ANSWER, daemon};
use crate::wire::Capability;
#[cfg(test)]
use {crate::config::HostConfig, reqwest::Method};

/// threads one clear may name: more than a phone can show windows for
/// (`fleet::model::MAX_ORDER`).
const MAX_KEYS: usize = 300;

/// threads to clear off home, and from which control.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearBody {
    pub device: String,
    pub device_class: String,
    /// `host:session`, at most 300.
    pub keys: Vec<String>,
    pub source: ClearSource,
}

/// which control cleared them, for telemetry.
#[derive(Clone, Copy, Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ClearSource {
    /// one window's clear.
    Window,
    /// the bar's "clear done".
    Done,
}

impl ClearSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Done => "done",
        }
    }
}

/// how a clear went: the threads now off home, and the ones that could not be.
#[derive(Debug, Serialize, ToSchema)]
pub struct Cleared {
    /// the threads that left home.
    pub cleared: Vec<String>,
    pub refused: Vec<NotCleared>,
}

/// a thread that stayed on home, and why, in words a window can show.
#[derive(Debug, Serialize, ToSchema)]
pub struct NotCleared {
    pub key: String,
    pub why: NotClearedWhy,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NotClearedWhy {
    Working,
    Asking,
    Subagent,
    Unknown,
}

impl From<ClearRefused> for NotClearedWhy {
    fn from(refused: ClearRefused) -> Self {
        match refused {
            ClearRefused::Working => Self::Working,
            ClearRefused::Asking => Self::Asking,
            ClearRefused::Subagent => Self::Subagent,
            ClearRefused::NoSuchSession => Self::Unknown,
        }
    }
}

impl NotClearedWhy {
    fn words(self) -> &'static str {
        match self {
            Self::Working => "it is working, so it stays. clear it when it finishes",
            Self::Asking => "it is waiting on an answer. answer it first",
            Self::Subagent => "a subagent has no window of its own",
            Self::Unknown => "boxbox does not hold that thread any more",
        }
    }
}

/// clears threads off home on every device. a thread comes back on its own
/// when it works again, asks, or is updated; it stays in history.
#[utoipa::path(
    post,
    path = "/api/clear",
    request_body = ClearBody,
    responses(
        (status = 200, description = "which threads left home and which could not", body = Cleared),
        (status = 400, description = "not a clear", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn clear(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ClearBody>,
) -> Result<Json<Cleared>, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    if body.keys.is_empty() || body.keys.len() > MAX_KEYS {
        return Err(ApiError::BadRequest(format!(
            "send between 1 and {MAX_KEYS} threads to clear"
        )));
    }
    if let Some(bad) = body.keys.iter().find(|key| Thread::parse(key).is_none()) {
        return Err(ApiError::BadRequest(format!(
            "\"{bad}\" is not a thread; send host:session"
        )));
    }
    let answers = state
        .fleet
        .clear(body.keys, device)
        .await
        .map_err(|_| ApiError::Stopping)?;
    let mut done = Cleared {
        cleared: Vec::new(),
        refused: Vec::new(),
    };
    for (key, answer) in answers {
        match answer {
            Ok(()) => done.cleared.push(key),
            Err(refused) => {
                let why = NotClearedWhy::from(refused);
                done.refused.push(NotCleared {
                    key,
                    why,
                    message: why.words().to_owned(),
                });
            }
        }
    }
    info!(
        cleared = done.cleared.len(),
        refused = done.refused.len(),
        source = body.source.as_str(),
        "threads cleared off home"
    );
    state.telemetry.record(&json!({
        "kind": "thread.cleared",
        "ok": done.refused.is_empty(),
        "props": {
            "source": body.source.as_str(),
            "count": done.cleared.len(),
            "refused": done.refused.len(),
        },
    }));
    Ok(Json(done))
}

/// threads to bring back to home, and from which control.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnclearBody {
    pub device: String,
    pub device_class: String,
    /// `host:session`, at most 300.
    pub keys: Vec<String>,
    pub source: UnclearSource,
}

/// which control brought them back, for telemetry.
#[derive(Clone, Copy, Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum UnclearSource {
    /// the undo after a clear, from this device or the sweep.
    Undo,
    /// "bring back" in the away summary.
    Away,
}

impl UnclearSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Undo => "undo",
            Self::Away => "away",
        }
    }
}

/// how an unclear went: the threads back on home, and the ones that were not cleared.
#[derive(Debug, Serialize, ToSchema)]
pub struct Uncleared {
    /// the threads back on home, kept from the sweep until they are updated.
    pub uncleared: Vec<String>,
    pub refused: Vec<NotUncleared>,
}

/// a thread that was not brought back, and why.
#[derive(Debug, Serialize, ToSchema)]
pub struct NotUncleared {
    pub key: String,
    pub why: NotUnclearedWhy,
    pub message: String,
}

/// `notcleared`: it is on home already (it came back by itself), so a client
/// may take it as done; `unknown`: the fleet does not hold it.
#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NotUnclearedWhy {
    Notcleared,
    Unknown,
}

impl NotUnclearedWhy {
    fn words(self) -> &'static str {
        match self {
            Self::Notcleared => "it is on home already",
            Self::Unknown => "boxbox does not hold that thread any more",
        }
    }
}

/// brings threads back to home on every device, where their order puts
/// them, and keeps the sweep off each until it is updated again
/// (decision 93).
#[utoipa::path(
    post,
    path = "/api/unclear",
    request_body = UnclearBody,
    responses(
        (status = 200, description = "which threads came back and which were not cleared", body = Uncleared),
        (status = 400, description = "not an unclear", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn unclear(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UnclearBody>,
) -> Result<Json<Uncleared>, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    if body.keys.is_empty() || body.keys.len() > MAX_KEYS {
        return Err(ApiError::BadRequest(format!(
            "send between 1 and {MAX_KEYS} threads to bring back"
        )));
    }
    if let Some(bad) = body.keys.iter().find(|key| Thread::parse(key).is_none()) {
        return Err(ApiError::BadRequest(format!(
            "\"{bad}\" is not a thread; send host:session"
        )));
    }
    let answers = state
        .fleet
        .unclear(body.keys)
        .await
        .map_err(|_| ApiError::Stopping)?;
    let mut done = Uncleared {
        uncleared: Vec::new(),
        refused: Vec::new(),
    };
    for (key, answer) in answers {
        match answer {
            Ok(()) => done.uncleared.push(key),
            Err(refused) => {
                let why = match refused {
                    UnclearRefused::NotCleared => NotUnclearedWhy::Notcleared,
                    UnclearRefused::NoSuchSession => NotUnclearedWhy::Unknown,
                };
                done.refused.push(NotUncleared {
                    key,
                    why,
                    message: why.words().to_owned(),
                });
            }
        }
    }
    info!(
        device = %device.id,
        uncleared = done.uncleared.len(),
        refused = done.refused.len(),
        source = body.source.as_str(),
        "threads brought back to home"
    );
    state.telemetry.record(&json!({
        "kind": "thread.uncleared",
        "ok": done.refused.is_empty(),
        "props": {
            "source": body.source.as_str(),
            "count": done.uncleared.len(),
            "refused": done.refused.len(),
        },
    }));
    Ok(Json(done))
}

/// the device that acknowledged the away summary.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AwaySeenBody {
    pub device: String,
    pub device_class: String,
}

/// acknowledges the away summary on every device: the threads it held stay
/// cleared and leave it (decision 94). every stream hears the empty summary.
#[utoipa::path(
    post,
    path = "/api/away/seen",
    request_body = AwaySeenBody,
    responses(
        (status = 204, description = "acknowledged"),
        (status = 400, description = "not a device", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn away_seen(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AwaySeenBody>,
) -> Result<StatusCode, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    let held = state
        .fleet
        .away_seen()
        .await
        .map_err(|_| ApiError::Stopping)?;
    info!(device = %device.id, held, "the away summary was acknowledged");
    state.telemetry.record(&json!({
        "kind": "away.seen",
        "ok": true,
        "props": { "count": held, "class": device.class },
    }));
    Ok(StatusCode::NO_CONTENT)
}

/// the part of a session an archive's answer is read for.
#[derive(Deserialize)]
struct Archives {
    time: ArchiveTimes,
}

#[derive(Deserialize)]
struct ArchiveTimes {
    archived: Option<f64>,
}

/// tries a daemon gets to answer a thread's confirmation, two seconds apart, before the thread is kept as the
/// store had it.
const CONFIRM_TRIES: u32 = 15;

/// the threads the store kept as adopted are asked of their daemons once, after a start: one archived or deleted
/// while boxbox was down is dropped (the stored copy dates from the adoption, so it cannot say), and one still
/// live is refreshed from the daemon, so a rename made meanwhile shows. at most `MAX_ADOPTED` threads. a daemon
/// that does not answer is asked again for half a minute, then the thread stays as stored.
pub async fn confirm_adopted(state: Arc<AppState>) {
    let Ok(keys) = state.fleet.adopted_keys().await else {
        return;
    };
    for key in keys {
        confirm_one(&state, key).await;
    }
}

async fn confirm_one(state: &AppState, key: String) {
    let Some((host, session)) = key.split_once(':') else {
        return;
    };
    let Ok(id) = segment(session) else {
        return;
    };
    for attempt in 0..CONFIRM_TRIES {
        if attempt > 0 {
            tokio::select! {
                () = tokio::time::sleep(Duration::from_secs(2)) => {}
                () = state.shutdown.cancelled() => return,
            }
        }
        let Ok(source) = agents::cmx2(state, host, Some(Capability::History)) else {
            continue;
        };
        match source.session_info(id).await {
            Ok(info) if archived_at(&info).is_none() => {
                #[cfg(feature = "record")]
                crate::fleet::record::adopt_info(host, &info);
                if let Ok(thread) = translate::thread_from_json(info) {
                    let _ = state.fleet.adopt(host.to_owned(), thread).await;
                }
                return;
            }
            Ok(_) | Err(ApiError::Gone) => {
                info!(
                    host,
                    session,
                    "an adopted thread was archived or deleted while boxbox was away; dropped"
                );
                let _ = state.fleet.unadopt(key).await;
                return;
            }
            Err(_) => {}
        }
    }
}

/// when a session was archived, if it was.
fn archived_at(info: &RawValue) -> Option<f64> {
    serde_json::from_str::<Archives>(info.get())
        .ok()
        .and_then(|a| a.time.archived)
}

/// the daemon's answer to an archive.
#[derive(Debug, Serialize, ToSchema)]
pub struct Archived {
    /// when the daemon archived it, ms since the epoch on its clock.
    pub archived: f64,
}

/// archives a thread through its daemon: it leaves every listing and its
/// history stays on disk. a turn that is running is stopped first, by the
/// daemon.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/archive",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
    ),
    responses(
        (status = 200, description = "archived", body = Archived),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host or thread", body = ErrorBody),
        (status = 422, description = "the daemon refused, with its own words (`host-said`)", body = ErrorBody),
        (status = 502, description = "the host did not answer or failed", body = ErrorBody),
    ),
)]
pub async fn archive(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
) -> Result<Json<Archived>, ApiError> {
    let id = segment(&session)?;
    let source = agents::cmx2(&state, &host, Some(Capability::Archive))?;
    let key = session_key(&host, &session);
    #[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
    let asked = crate::now_ms() as f64;
    // archiving stops the turn: a stop push for it would tell a device about what its owner just did
    state
        .fleet
        .own_action(key.clone())
        .await
        .map_err(|_| ApiError::Stopping)?;
    let outcome = source
        .archive_session(id, asked)
        .await
        .map_err(|error| match error {
            ApiError::Gone => ApiError::NoSuchSession(key.clone()),
            other => other,
        });
    state.telemetry.record(&json!({
        "kind": "thread.archived",
        "host": host,
        "session": format!("{host}:{session}"),
        // a patch the daemon took and did not answer in time may have landed: not known, not a failure
        "ok": outcome.as_ref().map_or_else(|e| (!crate::source::cmx2::verbs::threads::unanswered(e)).then_some(false), |_| Some(true)),
    }));
    let info = outcome?;
    info!(host, session, "thread archived");
    // the daemon's stamp, so a second device reading history sees the same time
    let archived = archived_at(&info).unwrap_or(asked);
    Ok(Json(Archived { archived }))
}

/// the longest title a rename takes, in characters: past a phone's two lines.
const MAX_TITLE: usize = 200;

/// a thread's new name.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameBody {
    /// 1 to 200 characters on one line; trimmed.
    pub title: String,
}

/// the daemon's answer to a rename.
#[derive(Debug, Serialize, ToSchema)]
pub struct Renamed {
    /// the title the daemon now holds.
    pub title: String,
}

/// the part of a session a rename's answer is read for.
#[derive(Deserialize)]
struct Titled {
    title: String,
}

/// renames a thread through its daemon (cmx2's `PATCH /session/:id` with
/// `title`). the new title reaches every device on the daemon's own update.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/title",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
    ),
    request_body = RenameBody,
    responses(
        (status = 200, description = "renamed", body = Renamed),
        (status = 400, description = "not a title", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host or thread", body = ErrorBody),
        (status = 422, description = "the daemon refused, with its own words (`host-said`)", body = ErrorBody),
        (status = 502, description = "the host did not answer or failed", body = ErrorBody),
    ),
)]
pub async fn rename(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Json(body): Json<RenameBody>,
) -> Result<Json<Renamed>, ApiError> {
    let id = segment(&session)?;
    let title = body.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE {
        return Err(ApiError::BadRequest(format!(
            "a title is 1 to {MAX_TITLE} characters"
        )));
    }
    if title.chars().any(char::is_control) {
        return Err(ApiError::BadRequest(
            "a title is one line. take out the line breaks".to_owned(),
        ));
    }
    let source = agents::cmx2(&state, &host, None)?;
    let key = session_key(&host, &session);
    let outcome = source
        .rename_session(id, title)
        .await
        .map_err(|error| match error {
            ApiError::Gone => ApiError::NoSuchSession(key.clone()),
            other => other,
        });
    state.telemetry.record(&json!({
        "kind": "thread.renamed",
        "host": host,
        "session": key,
        "ok": outcome.as_ref().map_or_else(|e| (!crate::source::cmx2::verbs::threads::unanswered(e)).then_some(false), |_| Some(true)),
    }));
    let info = outcome?;
    info!(host, session, "thread renamed");
    let title =
        serde_json::from_str::<Titled>(info.get()).map_or_else(|_| title.to_owned(), |t| t.title);
    Ok(Json(Renamed { title }))
}

/// reads a thread from its daemon and lets the fleet adopt it, for a thread
/// opened from history that the fleet does not hold. the fleet's stream
/// then carries its entry like any session's.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/adopt",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
    ),
    responses(
        (status = 204, description = "the fleet holds the thread now"),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host or thread, or it was archived", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn adopt(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let id = segment(&session)?;
    let source = agents::cmx2(&state, &host, Some(Capability::History))?;
    let key = format!("{host}:{session}");
    let info = source.session_info(id).await.map_err(|error| match error {
        ApiError::Gone => ApiError::NoSuchSession(key.clone()),
        other => other,
    })?;
    // an archived thread is in no listing: it is not opened from history, and the app is told so at once
    if archived_at(&info).is_some() {
        return Err(ApiError::NoSuchSession(key));
    }
    #[cfg(feature = "record")]
    crate::fleet::record::adopt_info(&host, &info);
    let thread = translate::thread_from_json(info).map_err(|error| ApiError::HostFailed {
        host: key.clone(),
        detail: format!("its answer was not a session: {error}"),
    })?;
    state
        .fleet
        .adopt(host, thread)
        .await
        .map_err(|_| ApiError::Stopping)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;
    use crate::config::Origin;

    /// a daemon that answers every request with one canned response, and
    /// the request line it was asked.
    fn daemon_saying(
        status: &'static str,
        body: &'static str,
    ) -> (HostConfig, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0_u8; 4096];
            let read = stream.read(&mut buf).unwrap();
            let asked = String::from_utf8_lossy(&buf[..read])
                .lines()
                .next()
                .unwrap_or("")
                .to_owned();
            write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            asked
        });
        let host = HostConfig {
            name: "desk".into(),
            url: format!("http://127.0.0.1:{port}").parse().unwrap(),
            credential: None,
            origin: Origin::Config,
        };
        (host, served)
    }

    #[tokio::test]
    async fn an_archive_sends_the_patch_and_returns_the_session_raw() {
        let (host, served) = daemon_saying("200 OK", r#"{"id":"ses_1","time":{"archived":5}}"#);
        let sent = json!({ "time": { "archived": 5.0 } });
        let info = daemon(
            &reqwest::Client::new(),
            &host,
            Method::PATCH,
            "/session/ses_1",
            Some(&sent),
        )
        .await
        .unwrap();
        assert_eq!(info.get(), r#"{"id":"ses_1","time":{"archived":5}}"#);
        assert_eq!(served.join().unwrap(), "PATCH /session/ses_1 HTTP/1.1");
    }

    #[tokio::test]
    async fn a_thread_the_daemon_does_not_know_is_gone() {
        let (host, _served) = daemon_saying(
            "404 Not Found",
            r#"{"name":"NotFoundError","data":{"message":"no such session"}}"#,
        );
        let error = daemon(
            &reqwest::Client::new(),
            &host,
            Method::GET,
            "/session/ses_9",
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ApiError::Gone), "{error:?}");
    }

    #[tokio::test]
    async fn a_refusal_carries_the_daemons_own_words() {
        let (host, _served) = daemon_saying(
            "409 Conflict",
            r#"{"name":"ConflictError","data":{"message":"session ses_1 is history imported from cmx; it is read only here"}}"#,
        );
        let error = daemon(
            &reqwest::Client::new(),
            &host,
            Method::PATCH,
            "/session/ses_1",
            Some(&json!({})),
        )
        .await
        .unwrap_err();
        match error {
            ApiError::HostSaid {
                status, message, ..
            } => {
                assert_eq!(status, 409);
                assert!(message.contains("read only"), "{message}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn an_answer_that_is_not_json_is_the_hosts_failure_not_a_panic() {
        let (host, _served) = daemon_saying("200 OK", "not json");
        let error = daemon(
            &reqwest::Client::new(),
            &host,
            Method::GET,
            "/session/ses_1",
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ApiError::HostFailed { .. }), "{error:?}");
    }

    #[test]
    fn a_session_says_when_it_was_archived_only_if_it_was() {
        let live = RawValue::from_string(r#"{"time":{"created":1,"updated":2}}"#.into()).unwrap();
        let gone = RawValue::from_string(r#"{"time":{"updated":2,"archived":7}}"#.into()).unwrap();
        assert_eq!(archived_at(&live), None);
        assert_eq!(archived_at(&gone), Some(7.0));
    }

    #[tokio::test]
    async fn an_answer_past_the_cap_is_refused_before_it_is_buffered() {
        let big: &'static str = Box::leak("x".repeat(MAX_ANSWER + 1).into_boxed_str());
        let (host, _served) = daemon_saying("200 OK", big);
        let error = daemon(
            &reqwest::Client::new(),
            &host,
            Method::GET,
            "/session/ses_1",
            None,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ApiError::HostFailed { .. }), "{error:?}");
    }

    #[test]
    fn every_refusal_to_clear_says_what_to_do_in_the_voice() {
        for why in [
            NotClearedWhy::Working,
            NotClearedWhy::Asking,
            NotClearedWhy::Subagent,
            NotClearedWhy::Unknown,
        ] {
            let words = why.words();
            assert!(words.chars().all(|c| !c.is_uppercase()), "{words}");
            assert!(
                !words.contains('\u{2014}') && !words.contains('\u{2013}'),
                "{words}"
            );
        }
        assert_eq!(
            NotClearedWhy::from(ClearRefused::Asking).words(),
            "it is waiting on an answer. answer it first"
        );
        assert_eq!(
            NotClearedWhy::from(ClearRefused::Working).words(),
            "it is working, so it stays. clear it when it finishes"
        );
    }
}
