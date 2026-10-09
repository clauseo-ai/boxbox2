//! the worktree review: what a checkout's branch holds beyond its base, and
//! merging or discarding it (`docs/design.md`, needs: review).
//!
//! the person names a session, never a path: the directory comes from the
//! fleet's own info for it, so a client cannot point the daemon at a
//! directory the session does not work in. the daemon's answers pass
//! through as it wrote them (cmx2's `/experimental/worktree/diff`, `merge`
//! and `discard`); the read adds `checkout`, the name on the open review
//! need, so a card can tell a checkout the agent asked about from one the
//! person opened.
//!
//! the daemon refuses a merge or a discard with a 409 that names why (a turn
//! running in the checkout, a conflict, a dirty tree). those come back as
//! 409 with the flat `CheckoutRefusal`, which a card switches on; every other
//! failure is boxbox's usual error body.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tracing::info;
use utoipa::ToSchema;

use super::AppState;
use super::asks::{read_capped, segment};
use super::error::{ApiError, CheckoutRefusal, ErrorBody, RefusalKind};
use super::session::{CLIENT_NAME, find_host, urlencode};
use crate::config::HostConfig;
use crate::fleet::model::{ReviewTarget, session_key};
use crate::upstream::{plain, request};

/// how long the daemon may take to read a branch's diff: git over a large checkout.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// how long a merge or a discard may take: git, and the processes it stops.
const ACT_TIMEOUT: Duration = Duration::from_secs(90);
/// the diff is 2 MB at most in the daemon's own words, and json escaping can double it.
const MAX_DIFF_ANSWER: usize = 8 * 1024 * 1024;
/// a merge's or a discard's answer is a few lines.
const MAX_ACT_ANSWER: usize = 256 * 1024;
/// the squash commit's message, in bytes: a commit message is never this long.
const MAX_MESSAGE: usize = 64 * 1024;

/// a file the branch changes.
#[derive(Debug, Serialize, ToSchema)]
pub struct WorktreeFile {
    pub path: String,
    /// `added`, `deleted`, `modified` or `renamed`.
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
}

/// what a checkout's branch holds beyond its base: cmx2's answer as it came,
/// with `checkout` added.
#[derive(Debug, Serialize, ToSchema)]
pub struct WorktreeReview {
    pub branch: Option<String>,
    pub base: String,
    #[serde(rename = "baseRef")]
    pub base_ref: String,
    /// commits on the branch beyond its base.
    pub commits: u64,
    /// uncommitted changes in the checkout: merge refuses until they are committed.
    pub dirty: bool,
    /// false when the branch conflicts with its base; absent when the daemon did not say.
    pub mergeable: Option<bool>,
    pub additions: u64,
    pub deletions: u64,
    pub files: Vec<WorktreeFile>,
    /// the unified patch of the commits, 2 MB at most.
    pub diff: String,
    pub truncated: bool,
    /// the checkout's name when the session has an open review need, else null.
    #[schema(required = true)]
    pub checkout: Option<String>,
}

/// the squash commit's message.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MergeBody {
    /// made from the branch's commits when absent or blank.
    pub message: Option<String>,
}

/// cmx2's answer to a merge, as it came.
#[derive(Debug, Serialize, ToSchema)]
pub struct WorktreeMerged {
    pub merged: bool,
    /// the squash commit.
    pub commit: String,
    pub base: String,
    pub branch: String,
    pub commits: u64,
    /// where the base is checked out; the merge ran there.
    pub into: Option<String>,
    /// processes stopped because they ran in the checkout.
    pub stopped: Vec<String>,
}

/// cmx2's answer to a discard, as it came.
#[derive(Debug, Serialize, ToSchema)]
pub struct WorktreeDiscarded {
    pub discarded: bool,
    /// the commit that keeps the checkout's last state, when it held work.
    pub snapshot: Option<String>,
    /// the ref that names it.
    #[serde(rename = "ref")]
    pub rescue_ref: Option<String>,
    /// processes stopped because they ran in the checkout.
    pub stopped: Vec<String>,
}

/// what the branch of a session's checkout holds beyond its base: commits,
/// files with line counts, the patch, and whether it merges clean.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/sessions/{session}/review",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
    ),
    responses(
        (status = 200, description = "cmx2's diff of the checkout, byte for byte, with `checkout`", body = WorktreeReview),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host, session or checkout", body = ErrorBody),
        (status = 422, description = "the daemon refused, with its own words (`host-said`)", body = ErrorBody),
        (status = 502, description = "the host did not answer or failed", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn show(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
) -> Result<Json<Map<String, Value>>, ApiError> {
    let config = find_host(&state, &host)?;
    let target = target(&state, &host, &session).await?;
    let read = diff(&state.client, &config, &target.directory).await;
    serve_gone(&state, &host, &session, &read).await;
    let mut review = read?;
    review.insert(
        "checkout".to_owned(),
        target.checkout.map_or(Value::Null, Value::String),
    );
    Ok(Json(review))
}

/// squash-merges the session's checkout into its base on its machine, then
/// removes the checkout and its branch. nothing is pushed.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/review/merge",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
    ),
    request_body(content = MergeBody, description = "the commit message; optional"),
    responses(
        (status = 200, description = "merged: cmx2's answer, byte for byte", body = WorktreeMerged),
        (status = 400, description = "the message was too long", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host, session or checkout", body = ErrorBody),
        (status = 409, description = "the daemon would not merge it: `busy`, `conflict` (with `files`) or `refused` (with `reason`)", body = CheckoutRefusal),
        (status = 422, description = "the daemon refused, with its own words (`host-said`)", body = ErrorBody),
        (status = 502, description = "the host did not answer or failed", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn merge(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    // no body is no message: a client that posts with nothing to say sends nothing
    let message = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<MergeBody>(&body)
            .map_err(|error| ApiError::BadRequest(format!("the body is not a merge: {error}")))?
            .message
    };
    if message.as_ref().is_some_and(|m| m.len() > MAX_MESSAGE) {
        return Err(ApiError::BadRequest(format!(
            "a commit message is at most {} kb",
            MAX_MESSAGE / 1024
        )));
    }
    let config = find_host(&state, &host)?;
    let target = target(&state, &host, &session).await?;
    let outcome = act(
        &state.client,
        &config,
        Act::Merge {
            directory: &target.directory,
            message: message.as_deref(),
        },
    )
    .await;
    serve_gone(&state, &host, &session, &outcome).await;
    record(&state, "review.merged", &host, &session, &outcome);
    Ok(json_response(outcome?))
}

/// removes the session's checkout and its branch without merging. when it
/// held work, its last state is kept first under a ref the answer names.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/review/discard",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
    ),
    responses(
        (status = 200, description = "discarded: cmx2's answer, byte for byte", body = WorktreeDiscarded),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host, session or checkout", body = ErrorBody),
        (status = 409, description = "a turn is running in the checkout: `busy`", body = CheckoutRefusal),
        (status = 422, description = "the daemon refused, with its own words (`host-said`)", body = ErrorBody),
        (status = 502, description = "the host did not answer or failed", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn discard(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let config = find_host(&state, &host)?;
    let target = target(&state, &host, &session).await?;
    let outcome = act(
        &state.client,
        &config,
        Act::Discard {
            directory: &target.directory,
        },
    )
    .await;
    serve_gone(&state, &host, &session, &outcome).await;
    record(&state, "review.discarded", &host, &session, &outcome);
    Ok(json_response(outcome?))
}

/// a checkout the daemon says it no longer has (merged or discarded where boxbox did not see it)
/// leaves its session's review with nothing to wait on: serve it, so the badge and the card go.
async fn serve_gone<T>(state: &AppState, host: &str, session: &str, outcome: &Result<T, ApiError>) {
    if matches!(outcome, Err(ApiError::NoSuchCheckout(_))) {
        // a stopped fleet is a server shutting down: there is nothing left to serve
        let _ = state.fleet.review_gone(session_key(host, session)).await;
    }
}

/// where the session works, from the fleet; a session the fleet does not hold is unknown.
async fn target(state: &AppState, host: &str, session: &str) -> Result<ReviewTarget, ApiError> {
    segment(session)?;
    let key = session_key(host, session);
    state
        .fleet
        .review_target(key.clone())
        .await
        .map_err(|_| ApiError::Stopping)?
        .ok_or(ApiError::NoSuchSession(key))
}

/// `review.merged` or `review.discarded`: `ok` is the daemon's answer, and `outcome`
/// says which refusal when it was one. no path, message or file name leaves here.
fn record(
    state: &AppState,
    kind: &str,
    host: &str,
    session: &str,
    outcome: &Result<Vec<u8>, ApiError>,
) {
    let result = match outcome {
        Ok(_) => "done",
        Err(ApiError::CheckoutRefused(refusal)) => refusal.error.as_str(),
        Err(ApiError::NoSuchCheckout(_)) => "gone",
        Err(_) => "failed",
    };
    state.telemetry.record(&json!({
        "kind": kind,
        "host": host,
        "session": format!("{host}:{session}"),
        "ok": outcome.is_ok(),
        "props": { "outcome": result },
    }));
}

/// the daemon's answer, valid json by now, handed on as it was written.
fn json_response(bytes: Vec<u8>) -> Response {
    let mut response = Body::from(bytes).into_response();
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// the verbs that change a checkout.
enum Act<'a> {
    Merge {
        directory: &'a str,
        message: Option<&'a str>,
    },
    Discard {
        directory: &'a str,
    },
}

/// reads the checkout's diff, as the object the daemon wrote.
async fn diff(
    client: &reqwest::Client,
    host: &HostConfig,
    directory: &str,
) -> Result<Map<String, Value>, ApiError> {
    let route = format!(
        "/experimental/worktree/diff?directory={}",
        urlencode(directory)
    );
    let body = daemon(
        client,
        host,
        Method::GET,
        &route,
        None,
        READ_TIMEOUT,
        MAX_DIFF_ANSWER,
    )
    .await?;
    match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(review)) => Ok(review),
        _ => Err(ApiError::HostFailed {
            host: host.name.clone(),
            detail: "its answer was not a diff".to_owned(),
        }),
    }
}

/// merges or discards, and returns the daemon's answer bytes (json, checked).
async fn act(
    client: &reqwest::Client,
    host: &HostConfig,
    act: Act<'_>,
) -> Result<Vec<u8>, ApiError> {
    let (route, sent) = match act {
        Act::Merge { directory, message } => {
            let mut sent = json!({ "directory": directory });
            // a blank message is no message: the daemon makes one from the commits
            if let Some(message) = message.map(str::trim).filter(|m| !m.is_empty()) {
                sent["message"] = json!(message);
            }
            ("/experimental/worktree/merge", sent)
        }
        Act::Discard { directory } => (
            "/experimental/worktree/discard",
            json!({ "directory": directory }),
        ),
    };
    let body = daemon(
        client,
        host,
        Method::POST,
        route,
        Some(&sent),
        ACT_TIMEOUT,
        MAX_ACT_ANSWER,
    )
    .await?;
    serde_json::from_slice::<&RawValue>(&body).map_err(|error| ApiError::HostFailed {
        host: host.name.clone(),
        detail: format!("its answer was not json: {error}"),
    })?;
    Ok(body)
}

/// one call to the daemon, its 2xx body back as bytes and its refusals as what
/// they mean for a checkout.
async fn daemon(
    client: &reqwest::Client,
    host: &HostConfig,
    method: Method,
    route: &str,
    sent: Option<&Value>,
    timeout: Duration,
    cap: usize,
) -> Result<Vec<u8>, ApiError> {
    let started = Instant::now();
    let unreachable = |reason: String| ApiError::HostUnreachable {
        host: host.name.clone(),
        reason,
    };
    let mut call =
        request(client, host, method.clone(), route).header("x-cmx2-client", CLIENT_NAME);
    if let Some(sent) = sent {
        call = call
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(sent.to_string());
    }
    let answer = tokio::time::timeout(timeout, call.send())
        .await
        .map_err(|_| unreachable(format!("no answer within {}s", timeout.as_secs())))?
        .map_err(|e| unreachable(plain(&e)))?;
    let status = answer.status().as_u16();
    let body = read_capped(answer, &host.name, timeout, cap).await?;
    info!(
        host = %host.name,
        %method,
        route = route.split('?').next().unwrap_or(route),
        status,
        latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "review call"
    );
    if (200..300).contains(&status) {
        Ok(body)
    } else {
        Err(refusal(&host.name, status, &body))
    }
}

/// the daemon's error body: its name, and the data a refusal carries.
#[derive(Deserialize)]
struct DaemonError {
    name: Option<String>,
    data: Option<DaemonErrorData>,
}

#[derive(Deserialize)]
struct DaemonErrorData {
    message: Option<String>,
    files: Option<Vec<String>>,
    reason: Option<String>,
}

/// what a daemon's non-2xx answer means: the three 409s a card acts on, a checkout
/// that is gone, a credential refused, and anything else in the daemon's own words.
fn refusal(host: &str, status: u16, body: &[u8]) -> ApiError {
    let error: Option<DaemonError> = serde_json::from_slice(body).ok();
    let name = error
        .as_ref()
        .and_then(|e| e.name.clone())
        .unwrap_or_default();
    let data = error.and_then(|e| e.data);
    let message = data.as_ref().and_then(|d| d.message.clone());
    let refused = |kind, fallback: &str| CheckoutRefusal {
        error: kind,
        message: message.clone().unwrap_or_else(|| fallback.to_owned()),
        files: None,
        reason: None,
    };
    match (status, name.as_str()) {
        (401, _) => ApiError::HostRefused(host.to_owned()),
        // only the worktree's own 404: a bare NotFoundError is a route or a session the daemon
        // lacks, which says nothing about the checkout
        (404, "WorktreeNotFoundError") => ApiError::NoSuchCheckout(host.to_owned()),
        // a checkout that was merged or discarded leaves its session homed at a path the daemon
        // reads as the repository's own checkout: refused as `primary`, with a 400
        (400, "WorktreeRefusedError")
            if data.as_ref().and_then(|d| d.reason.as_deref()) == Some("primary") =>
        {
            ApiError::NoSuchCheckout(host.to_owned())
        }
        (409, "BusyError") => ApiError::CheckoutRefused(refused(
            RefusalKind::Busy,
            "a turn is running in that checkout. wait for it to finish, or stop it first",
        )),
        (409, "WorktreeMergeConflictError") => ApiError::CheckoutRefused(CheckoutRefusal {
            files: Some(data.and_then(|d| d.files).unwrap_or_default()),
            ..refused(
                RefusalKind::Conflict,
                "the branch conflicts with its base. rebase it in the checkout, then merge again",
            )
        }),
        (409, "WorktreeRefusedError") => ApiError::CheckoutRefused(CheckoutRefusal {
            reason: data.and_then(|d| d.reason),
            ..refused(
                RefusalKind::Refused,
                "the daemon would not do that to this checkout",
            )
        }),
        _ => ApiError::HostSaid {
            host: host.to_owned(),
            status,
            message: message.unwrap_or_else(|| format!("status {status}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;
    use crate::config::Origin;

    /// a daemon that answers one request with `status` and `body`, and hands back the
    /// request line and the body it was sent.
    fn daemon_saying(
        status: u16,
        body: &'static str,
    ) -> (HostConfig, std::sync::mpsc::Receiver<(String, String)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
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
            origin: Origin::Config,
        };
        (config, received)
    }

    async fn answer_of(error: ApiError) -> (StatusCode, Value) {
        let response = error.into_response();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn merge_refused(status: u16, body: &'static str) -> ApiError {
        let (host, _) = daemon_saying(status, body);
        act(
            &reqwest::Client::new(),
            &host,
            Act::Merge {
                directory: "/w/site",
                message: None,
            },
        )
        .await
        .unwrap_err()
    }

    #[tokio::test]
    async fn a_diff_asks_for_the_sessions_directory_and_returns_the_object() {
        let (host, received) = daemon_saying(
            200,
            r#"{"branch":"cmx2/fix","base":"main","baseRef":"abc","commits":2,"dirty":false,"mergeable":true,"additions":3,"deletions":1,"files":[],"diff":"","truncated":false}"#,
        );
        let review = diff(&reqwest::Client::new(), &host, "/w/site fix")
            .await
            .unwrap();
        assert_eq!(review["commits"], 2);
        assert_eq!(review["baseRef"], "abc");
        let (line, _) = received.recv().unwrap();
        assert_eq!(
            line,
            "GET /experimental/worktree/diff?directory=%2Fw%2Fsite%20fix HTTP/1.1"
        );
    }

    #[tokio::test]
    async fn a_merge_sends_the_directory_and_a_trimmed_message_and_returns_the_answer_as_it_came() {
        let answer = r#"{"merged":true,"commit":"abc","base":"main","branch":"cmx2/fix","commits":2,"stopped":[]}"#;
        let (host, received) = daemon_saying(200, answer);
        let body = act(
            &reqwest::Client::new(),
            &host,
            Act::Merge {
                directory: "/w/site",
                message: Some("  fix the login  \n"),
            },
        )
        .await
        .unwrap();
        assert_eq!(String::from_utf8(body).unwrap(), answer);
        let (line, sent) = received.recv().unwrap();
        assert_eq!(line, "POST /experimental/worktree/merge HTTP/1.1");
        assert_eq!(
            serde_json::from_str::<Value>(&sent).unwrap(),
            json!({ "directory": "/w/site", "message": "fix the login" })
        );
    }

    #[tokio::test]
    async fn a_blank_message_is_not_sent() {
        let (host, received) = daemon_saying(200, r#"{"merged":true}"#);
        act(
            &reqwest::Client::new(),
            &host,
            Act::Merge {
                directory: "/w/site",
                message: Some("   "),
            },
        )
        .await
        .unwrap();
        let (_, sent) = received.recv().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&sent).unwrap(),
            json!({ "directory": "/w/site" })
        );
    }

    #[tokio::test]
    async fn a_discard_sends_only_the_directory_and_returns_the_answer_as_it_came() {
        let answer =
            r#"{"discarded":true,"snapshot":"abc","ref":"refs/cmx2/rescue/fix","stopped":["dev"]}"#;
        let (host, received) = daemon_saying(200, answer);
        let body = act(
            &reqwest::Client::new(),
            &host,
            Act::Discard {
                directory: "/w/site",
            },
        )
        .await
        .unwrap();
        assert_eq!(String::from_utf8(body).unwrap(), answer);
        let (line, sent) = received.recv().unwrap();
        assert_eq!(line, "POST /experimental/worktree/discard HTTP/1.1");
        assert_eq!(
            serde_json::from_str::<Value>(&sent).unwrap(),
            json!({ "directory": "/w/site" })
        );
    }

    #[tokio::test]
    async fn a_turn_running_in_the_checkout_is_409_busy_with_the_daemons_words() {
        let error = merge_refused(
            409,
            r#"{"name":"BusyError","data":{"message":"session ses_1 is running a turn"}}"#,
        )
        .await;
        let (status, body) = answer_of(error).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body,
            json!({ "error": "busy", "message": "session ses_1 is running a turn" })
        );
    }

    #[tokio::test]
    async fn a_conflict_is_409_conflict_naming_the_files() {
        let error = merge_refused(
            409,
            r#"{"name":"WorktreeMergeConflictError","data":{"message":"main moved","files":["a.ts","b/c.ts"],"base":"main","branch":"cmx2/fix"}}"#,
        )
        .await;
        let (status, body) = answer_of(error).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body,
            json!({ "error": "conflict", "message": "main moved", "files": ["a.ts", "b/c.ts"] })
        );
    }

    #[tokio::test]
    async fn a_refusal_is_409_refused_with_its_reason() {
        for reason in ["dirty", "nothing", "detached", "target_dirty"] {
            let text: &'static str = Box::leak(
                format!(
                    r#"{{"name":"WorktreeRefusedError","data":{{"message":"no","reason":"{reason}"}}}}"#
                )
                .into_boxed_str(),
            );
            let (status, body) = answer_of(merge_refused(409, text).await).await;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(
                body,
                json!({ "error": "refused", "message": "no", "reason": reason })
            );
        }
    }

    #[tokio::test]
    async fn a_409_without_the_daemons_words_still_says_what_to_do() {
        let (status, body) = answer_of(merge_refused(409, r#"{"name":"BusyError"}"#).await).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "busy");
        let words = body["message"].as_str().unwrap();
        assert!(words.contains("wait for it to finish"), "{words}");
        assert!(words.chars().all(|c| !c.is_uppercase()), "{words}");
    }

    #[tokio::test]
    async fn a_checkout_the_daemon_does_not_know_is_404_in_boxboxs_body() {
        let error = merge_refused(
            404,
            r#"{"name":"WorktreeNotFoundError","data":{"message":"no checkout there"}}"#,
        )
        .await;
        let (status, body) = answer_of(error).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "no-such-checkout");
        let words = body["error"]["message"].as_str().unwrap();
        assert!(words.contains("merged or discarded"), "{words}");
    }

    #[tokio::test]
    async fn a_session_no_longer_in_a_checkout_is_404_no_such_checkout() {
        let error = merge_refused(
            400,
            r#"{"name":"WorktreeRefusedError","data":{"message":"/w is the repository's main checkout","reason":"primary"}}"#,
        )
        .await;
        let (status, body) = answer_of(error).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "no-such-checkout");
    }

    #[tokio::test]
    async fn a_bare_not_found_is_the_daemons_words_not_a_checkout_that_is_gone() {
        // a route or a session the daemon lacks says nothing about the checkout, so nothing is served
        let error = merge_refused(
            404,
            r#"{"name":"NotFoundError","data":{"message":"no such route"}}"#,
        )
        .await;
        assert!(
            matches!(&error, ApiError::HostSaid { status: 404, message, .. } if message == "no such route"),
            "{error:?}"
        );
    }

    #[test]
    fn a_merge_body_may_be_absent_empty_or_an_object_and_nothing_else() {
        assert!(serde_json::from_slice::<MergeBody>(b"{}").is_ok());
        assert!(serde_json::from_slice::<MergeBody>(br#"{"message":"x"}"#).is_ok());
        assert!(serde_json::from_slice::<MergeBody>(br#"{"msg":"x"}"#).is_err());
    }

    #[tokio::test]
    async fn another_409_is_the_daemons_refusal_in_boxboxs_usual_shape() {
        let error = merge_refused(
            409,
            r#"{"name":"ConflictError","data":{"message":"history imported from cmx; read only"}}"#,
        )
        .await;
        assert!(
            matches!(&error, ApiError::HostSaid { status: 409, message, .. } if message.contains("read only")),
            "{error:?}"
        );
        let (status, body) = answer_of(error).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"]["code"], "host-said");
    }

    #[tokio::test]
    async fn a_daemon_that_fails_itself_is_a_bad_gateway_and_one_that_refuses_the_credential_says_so()
     {
        let error = merge_refused(
            500,
            r#"{"name":"WorktreeFailedError","data":{"message":"git failed"}}"#,
        )
        .await;
        assert_eq!(answer_of(error).await.0, StatusCode::BAD_GATEWAY);
        let error = merge_refused(
            401,
            r#"{"name":"UnauthorizedError","data":{"message":"no"}}"#,
        )
        .await;
        let (status, body) = answer_of(error).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body["error"]["code"], "host-refused");
    }

    #[tokio::test]
    async fn a_diff_that_is_not_an_object_is_the_hosts_failure() {
        let (host, _) = daemon_saying(200, "[1]");
        let error = diff(&reqwest::Client::new(), &host, "/w")
            .await
            .unwrap_err();
        assert!(matches!(error, ApiError::HostFailed { .. }), "{error:?}");
    }

    #[test]
    fn a_session_id_that_could_step_out_of_a_path_is_refused_before_the_fleet_is_asked() {
        assert!(segment("ses_1").is_ok());
        assert!(segment("../x").is_err());
    }
}
