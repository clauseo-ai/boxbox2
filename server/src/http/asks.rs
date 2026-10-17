//! a person's verbs on a thread that needs and push hang on: answering a
//! permission or a question, sending a prompt (which arms "done"), and
//! stopping a turn (which makes what follows their own action), and
//! compacting one. each goes
//! to the daemon with the device's `clientID`, so a retry after a flaky
//! network acts once (cmx2 a4), and tells the fleet first, so the need it
//! serves or the turn it starts is attributed to the device.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::ToSchema;

use super::AppState;
use super::agents;
use super::compose::{
    Document, Message, Photo, accept_timeout, content, message_body, model_and_effort,
};
use super::error::{ApiError, ErrorBody};
#[cfg(test)]
use crate::config::HostConfig;
use crate::fleet::model::{Device, session_key};
use crate::push::devices;
#[cfg(test)]
use crate::source::cmx2::verbs::asks::{ANSWER_TIMEOUT, COMPACT_TIMEOUT, summarize};
use crate::telemetry::dictionary;
use crate::upstream::plain;
use crate::wire::Capability;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PermissionReply {
    /// yes, this once.
    Once,
    /// yes, and save the patterns for the project.
    Always,
    /// no.
    Reject,
}

/// an answer to a permission.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionAnswer {
    pub device: String,
    pub device_class: String,
    /// a uuid the device picks once per answer and reuses on a retry.
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub reply: PermissionReply,
    /// with reject: what the agent should do instead.
    pub message: Option<String>,
}

/// an answer to a question: one list of chosen labels (or typed text) per
/// question it asked.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionAnswer {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub answers: Vec<Vec<String>>,
}

/// dismissing a question, or stopping a turn.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verb {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
}

/// a prompt from a device; the turn it starts is armed for "done".
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prompt {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub text: String,
    /// photos, resized on the device, as `data:` urls.
    #[serde(default)]
    pub photos: Vec<Photo>,
    /// files that are not photos (a pdf, text, json), as their own bytes in `data:` urls.
    #[serde(default)]
    pub files: Vec<Document>,
    /// `provider/model`, from `/api/hosts/{host}/models`; cmx2 makes it the
    /// thread's model from this message on.
    pub model: Option<String>,
    /// one of the model's efforts; cmx2 makes it the thread's effort from
    /// this message on.
    pub effort: Option<String>,
}

/// the daemon took the verb.
#[derive(Debug, Serialize, ToSchema)]
pub struct Done {
    /// true when the daemon had already acted on this `clientID` and
    /// repeated its first answer.
    pub repeat: bool,
    /// the daemon's answer, as it wrote it.
    #[schema(value_type = Object)]
    pub answer: Value,
}

/// answers a permission. an ask already settled is 409 with who settled it
/// and when; an ask the daemon does not know is 404.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/permissions/{ask}",
    params(("host" = String, Path), ("ask" = String, Path, description = "the permission's id")),
    request_body = PermissionAnswer,
    responses(
        (status = 200, description = "answered", body = Done),
        (status = 400, description = "not an answer", body = ErrorBody),
        (status = 404, description = "no such host, or the ask is gone", body = ErrorBody),
        (status = 409, description = "already settled; `error.settled` says by whom and when", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn permission(
    State(state): State<Arc<AppState>>,
    Path((host, ask)): Path<(String, String)>,
    Json(body): Json<PermissionAnswer>,
) -> Result<Json<Done>, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    let client_id = client_id(&body.client_id)?;
    let mut sent = json!({ "reply": body.reply, "by": device.class, "clientID": client_id });
    if let Some(message) = body.message.filter(|m| !m.trim().is_empty()) {
        sent["message"] = Value::String(message);
    }
    let id = segment(&ask)?;
    let source = agents::cmx2(&state, &host, Some(Capability::Approvals))?;
    answering(&state, &host, &ask, device).await?;
    source.permission(id, &sent).await.map(Json)
}

/// answers a question.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/questions/{ask}",
    params(("host" = String, Path), ("ask" = String, Path, description = "the question's id")),
    request_body = QuestionAnswer,
    responses(
        (status = 200, description = "answered", body = Done),
        (status = 400, description = "not an answer", body = ErrorBody),
        (status = 404, description = "no such host, or the ask is gone", body = ErrorBody),
        (status = 409, description = "already settled; `error.settled` says by whom and when", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn question(
    State(state): State<Arc<AppState>>,
    Path((host, ask)): Path<(String, String)>,
    Json(body): Json<QuestionAnswer>,
) -> Result<Json<Done>, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    let client_id = client_id(&body.client_id)?;
    if body.answers.is_empty() || body.answers.iter().any(Vec::is_empty) {
        return Err(ApiError::BadRequest(
            "choose an answer for every question".into(),
        ));
    }
    let sent = json!({ "answers": body.answers, "by": device.class, "clientID": client_id });
    let id = segment(&ask)?;
    let source = agents::cmx2(&state, &host, Some(Capability::Questions))?;
    answering(&state, &host, &ask, device).await?;
    source.question(id, &sent).await.map(Json)
}

/// dismisses a question without an answer.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/questions/{ask}/reject",
    params(("host" = String, Path), ("ask" = String, Path, description = "the question's id")),
    request_body = Verb,
    responses(
        (status = 200, description = "dismissed", body = Done),
        (status = 404, description = "no such host, or the ask is gone", body = ErrorBody),
        (status = 409, description = "already settled", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn reject(
    State(state): State<Arc<AppState>>,
    Path((host, ask)): Path<(String, String)>,
    Json(body): Json<Verb>,
) -> Result<Json<Done>, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    let client_id = client_id(&body.client_id)?;
    let sent = json!({ "by": device.class, "clientID": client_id });
    let id = segment(&ask)?;
    let source = agents::cmx2(&state, &host, Some(Capability::Questions))?;
    answering(&state, &host, &ask, device).await?;
    source.reject(id, &sent).await.map(Json)
}

/// sends a prompt (it starts a turn, or queues behind the running one) and
/// arms that turn: when it is done, the device's person hears of it.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/prompt",
    params(("host" = String, Path), ("session" = String, Path)),
    request_body = Prompt,
    responses(
        (status = 202, description = "taken; the daemon's `{messageID, queued}`", body = Done),
        (status = 400, description = "not a prompt", body = ErrorBody),
        (status = 404, description = "no such host or session", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn prompt(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Message(mut body): Message<Prompt>,
) -> Result<Response, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    let client_id = client_id(&body.client_id)?.to_owned();
    let limit = accept_timeout(&body.photos, &body.files);
    let parts = content(
        &body.text,
        std::mem::take(&mut body.photos),
        std::mem::take(&mut body.files),
    )?;
    let id = segment(&session)?;
    let key = session_key(&host, &session);
    state
        .fleet
        .arm(key.clone(), client_id.clone(), device.clone())
        .await
        .map_err(|_| ApiError::Stopping)?;
    let mut sent = message_body(parts, &client_id);
    model_and_effort(&mut sent, body.model.as_deref(), body.effort.as_deref())?;
    let source = agents::cmx2(&state, &host, None)?;
    let done = source.prompt(id, sent, limit).await?;
    answer_review(&state, key, device).await;
    Ok((StatusCode::ACCEPTED, Json(done)).into_response())
}

/// a reply from `device` was taken by the daemon: the review the agent asked for in this thread is
/// answered by it. the daemon says a session is busy before it says why, so the turn the reply
/// starts cannot be relied on to show it was the device's. a stopped fleet is a server shutting
/// down, and the reply has already gone.
pub(super) async fn answer_review(state: &AppState, key: String, device: Device) {
    let _ = state.fleet.review_answered(key, device).await;
}

/// stops the running turn. a fault that follows within 15 s is the
/// person's own action, never pushed.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/abort",
    params(("host" = String, Path), ("session" = String, Path)),
    request_body = Verb,
    responses(
        (status = 200, description = "stopped", body = Done),
        (status = 404, description = "no such host or session", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn abort(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Json(body): Json<Verb>,
) -> Result<Json<Done>, ApiError> {
    device_of(&body.device, &body.device_class)?;
    client_id(&body.client_id)?;
    let id = segment(&session)?;
    state
        .fleet
        .own_action(session_key(&host, &session))
        .await
        .map_err(|_| ApiError::Stopping)?;
    let source = agents::cmx2(&state, &host, None)?;
    source.abort(id).await.map(Json)
}

/// compacts the thread now, on the model it already uses. the daemon answers once the summary is in, so a thread with
/// a turn running is refused (stop it first), and a failed compaction leaves the thread as it was.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/compact",
    params(("host" = String, Path), ("session" = String, Path)),
    request_body = Verb,
    responses(
        (status = 200, description = "compacted; the summary is in the thread", body = Done),
        (status = 400, description = "not a verb", body = ErrorBody),
        (status = 404, description = "no such host or session", body = ErrorBody),
        (status = 422, description = "the daemon refused: a turn is running, or the thread is imported history", body = ErrorBody),
        (status = 502, description = "the host did not answer within five minutes, or the compaction failed and the thread is unchanged", body = ErrorBody),
    ),
)]
pub async fn compact(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Json(body): Json<Verb>,
) -> Result<Json<Done>, ApiError> {
    device_of(&body.device, &body.device_class)?;
    client_id(&body.client_id)?;
    segment(&session)?;
    let source = agents::cmx2(&state, &host, Some(Capability::Compact))?;
    source.compact(&session).await.map(Json)
}

/// the fleet is told `device` is answering `ask` before the answer goes, so the need it
/// serves is attributed to the device.
async fn answering(
    state: &AppState,
    host: &str,
    ask: &str,
    device: Device,
) -> Result<(), ApiError> {
    state
        .fleet
        .answering(host.to_owned(), ask.to_owned(), device)
        .await
        .map_err(|_| ApiError::Stopping)
}

/// a host's answer body, read at most `cap` bytes and within `limit` in all: past either the call fails instead of
/// buffering, or waiting on, whatever a host sends.
pub(crate) async fn read_capped(
    mut answer: reqwest::Response,
    host: &str,
    limit: Duration,
    cap: usize,
) -> Result<Vec<u8>, ApiError> {
    let unreachable = |reason: String| ApiError::HostUnreachable {
        host: host.to_owned(),
        reason,
    };
    let too_large = || ApiError::HostFailed {
        host: host.to_owned(),
        detail: format!("its answer was larger than {} kb", cap / 1024),
    };
    if answer
        .content_length()
        .is_some_and(|n| usize::try_from(n).map_or(true, |n| n > cap))
    {
        return Err(too_large());
    }
    // one deadline for the whole body: a timeout per chunk lets a host that drips a byte at a time hold the read for as
    // long as it likes, every chunk being inside its own limit
    let read = async {
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = answer.chunk().await.map_err(|e| unreachable(plain(&e)))? {
            if body.len() + chunk.len() > cap {
                return Err(too_large());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    };
    let body = tokio::time::timeout(limit, read)
        .await
        .map_err(|_| unreachable(format!("no answer within {}s", limit.as_secs())))??;
    Ok(body)
}

/// the device a verb came from, checked against the push rules and the
/// dictionary's classes.
pub fn device_of(device: &str, class: &str) -> Result<Device, ApiError> {
    if !devices::is_device_id(device) {
        return Err(ApiError::BadRequest(devices::Refused::DeviceId.to_string()));
    }
    if !dictionary::is_device_class(class) {
        let known = dictionary::DEVICE_CLASSES.join(", ");
        return Err(ApiError::BadRequest(format!(
            "\"{class}\" is not a device class; send one of {known}"
        )));
    }
    Ok(Device {
        id: device.to_owned(),
        class: class.to_owned(),
    })
}

/// cmx2's rule for a client id (a4): up to 128 of `[A-Za-z0-9_.:-]`.
pub(super) fn client_id(id: &str) -> Result<&str, ApiError> {
    let fits = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'));
    if fits {
        Ok(id)
    } else {
        Err(ApiError::BadRequest(
            "send a clientID of up to 128 letters, digits, _ . : or -".into(),
        ))
    }
}

/// a daemon id as one path segment.
pub(crate) fn segment(id: &str) -> Result<&str, ApiError> {
    let fits = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if fits {
        Ok(id)
    } else {
        Err(ApiError::BadRequest(format!("\"{id}\" is not an id")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a host that answers 200 with `bytes` of body, sent with or without a length.
    async fn served(bytes: usize, with_length: bool) -> reqwest::Response {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0_u8; 1024];
            let _ = stream.read(&mut buf);
            let length = if with_length {
                format!("content-length: {bytes}\r\n")
            } else {
                String::new()
            };
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\n{length}connection: close\r\n\r\n"
            );
            let chunk = vec![b' '; 64 * 1024];
            let mut sent = 0;
            while sent < bytes {
                let n = chunk.len().min(bytes - sent);
                if stream.write_all(&chunk[..n]).is_err() {
                    break;
                }
                sent += n;
            }
        });
        reqwest::get(format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap()
    }

    /// a host that sends its headers at once and then one byte every `every`, `bytes` times: each chunk is quick, the
    /// whole is slow.
    async fn dripping(bytes: usize, every: Duration) -> reqwest::Response {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0_u8; 1024];
            let _ = stream.read(&mut buf);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n");
            for _ in 0..bytes {
                std::thread::sleep(every);
                if stream
                    .write_all(b" ")
                    .and_then(|()| stream.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        reqwest::get(format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_host_that_drips_cannot_hold_the_read_past_its_limit() {
        // 40 bytes, 40 ms apart: 1.6 s in all, every chunk well inside the 300 ms a chunk was once allowed
        let answer = dripping(40, Duration::from_millis(40)).await;
        let started = std::time::Instant::now();
        let error = read_capped(answer, "desk", Duration::from_millis(300), 1024)
            .await
            .unwrap_err();
        assert!(
            matches!(error, ApiError::HostUnreachable { .. }),
            "{error:?}"
        );
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "the read ran {:?} on a 300 ms limit",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_slow_answer_inside_its_limit_is_still_read_whole() {
        let answer = dripping(5, Duration::from_millis(20)).await;
        let body = read_capped(answer, "desk", Duration::from_secs(5), 1024)
            .await
            .unwrap();
        assert_eq!(body.len(), 5);
    }

    #[tokio::test]
    async fn an_answer_within_the_cap_is_read_whole() {
        let body = read_capped(
            served(100_000, true).await,
            "desk",
            Duration::from_secs(5),
            200_000,
        )
        .await
        .unwrap();
        assert_eq!(body.len(), 100_000);
    }

    #[tokio::test]
    async fn an_answer_that_says_it_is_too_big_is_refused_before_it_is_read() {
        let error = read_capped(
            served(300_000, true).await,
            "desk",
            Duration::from_secs(5),
            200_000,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ApiError::HostFailed { .. }), "{error:?}");
    }

    #[tokio::test]
    async fn an_answer_that_never_says_how_big_it_is_stops_at_the_cap() {
        let error = read_capped(
            served(5_000_000, false).await,
            "desk",
            Duration::from_secs(5),
            200_000,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ApiError::HostFailed { .. }), "{error:?}");
    }

    /// a daemon that answers one request with `status` and `body` (after `pause`), and hands back what it was sent: the
    /// request line and the body.
    fn daemon(
        status: u16,
        body: &'static str,
        pause: Duration,
    ) -> (HostConfig, std::sync::mpsc::Receiver<(String, String)>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0_u8; 4096];
            let (head, length) = loop {
                let n = stream.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).into_owned();
                if let Some((head, _)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .and_then(|n| n.parse::<usize>().ok())
                        .unwrap_or(0);
                    if request.len() >= head.len() + 4 + length {
                        break (head.to_owned(), length);
                    }
                }
            };
            let sent = &request[head.len() + 4..head.len() + 4 + length];
            let line = head.lines().next().unwrap_or_default().to_owned();
            let _ = seen.send((line, String::from_utf8_lossy(sent).into_owned()));
            std::thread::sleep(pause);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        let config = HostConfig {
            name: "desk".into(),
            url: format!("http://127.0.0.1:{port}").parse().unwrap(),
            credential: None,
            origin: crate::config::Origin::Config,
        };
        (config, received)
    }

    #[tokio::test]
    async fn compacting_posts_an_empty_body_to_summarize_so_the_threads_own_model_is_used() {
        let (host, received) = daemon(200, "true", Duration::ZERO);
        let done = summarize(
            &reqwest::Client::new(),
            &host,
            "ses_1",
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(done.answer, json!(true));
        assert!(!done.repeat);
        let (line, body) = received.recv().unwrap();
        assert_eq!(line, "POST /session/ses_1/summarize HTTP/1.1");
        assert_eq!(body, "{}");
    }

    #[tokio::test]
    async fn a_compaction_that_takes_a_while_is_waited_for_within_its_limit() {
        let (host, _received) = daemon(200, "true", Duration::from_millis(300));
        summarize(
            &reqwest::Client::new(),
            &host,
            "ses_1",
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_daemon_that_never_finishes_compacting_is_the_hosts_failure_at_the_limit() {
        let (host, _received) = daemon(200, "true", Duration::from_secs(5));
        let error = summarize(
            &reqwest::Client::new(),
            &host,
            "ses_1",
            Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, ApiError::HostUnreachable { .. }),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn a_turn_running_is_said_in_words_that_fit_a_compaction() {
        let (host, _received) = daemon(
            409,
            r#"{"name":"BusyError","data":{"message":"session ses_1 is busy"}}"#,
            Duration::ZERO,
        );
        let error = summarize(
            &reqwest::Client::new(),
            &host,
            "ses_1",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        let text = error.to_string();
        assert!(
            matches!(&error, ApiError::HostSaid { status: 409, .. }),
            "{error:?}"
        );
        assert!(
            text.contains("a turn is running") && !text.contains("already sent"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn imported_history_is_refused_as_that_and_not_as_an_answered_ask() {
        let (host, _received) = daemon(
            409,
            r#"{"name":"ConflictError","data":{"message":"history imported from cmx"}}"#,
            Duration::ZERO,
        );
        let error = summarize(
            &reqwest::Client::new(),
            &host,
            "ses_1",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("imported from cmx"), "{error}");
    }

    #[tokio::test]
    async fn a_thread_the_daemon_does_not_know_is_no_such_session() {
        let (host, _received) =
            daemon(404, r#"{"name":"NotFoundError","data":{}}"#, Duration::ZERO);
        let error = summarize(
            &reqwest::Client::new(),
            &host,
            "ses_gone",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ApiError::NoSuchSession(key) if key == "desk:ses_gone"));
    }

    #[tokio::test]
    async fn a_failed_compaction_is_the_daemons_failure_and_says_the_thread_is_unchanged() {
        let (host, _received) = daemon(
            500,
            r#"{"name":"CompactionError","data":{"message":"the compaction did not happen: boom. the session is unchanged"}}"#,
            Duration::ZERO,
        );
        let error = summarize(
            &reqwest::Client::new(),
            &host,
            "ses_1",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&error, ApiError::HostSaid { status: 500, .. }),
            "{error:?}"
        );
        assert!(
            error.to_string().contains("session is unchanged"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_session_id_that_is_not_one_never_reaches_the_daemon() {
        let (host, received) = daemon(200, "true", Duration::ZERO);
        let error = summarize(
            &reqwest::Client::new(),
            &host,
            "a/../b",
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ApiError::BadRequest(_)), "{error:?}");
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn a_compaction_gets_minutes_where_a_verb_gets_seconds() {
        // the daemon answers once the summary is in, a model call of its own
        assert!(COMPACT_TIMEOUT >= Duration::from_secs(120));
        assert!(COMPACT_TIMEOUT > ANSWER_TIMEOUT * 4);
    }

    #[test]
    fn a_client_id_follows_the_daemons_rule() {
        assert!(client_id("2f1c7a9e-8b1d-4c2e-9f00-1a2b3c4d5e6f").is_ok());
        for bad in ["", "a b", "a/b", &"x".repeat(129)] {
            assert!(client_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_verb_names_a_real_device_and_class() {
        assert!(device_of("phone-1", "iphone").is_ok());
        assert!(device_of("phone 1", "iphone").is_err());
        assert!(device_of("phone-1", "toaster").is_err());
    }
}
