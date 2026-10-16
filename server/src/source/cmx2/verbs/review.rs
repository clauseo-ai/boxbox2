//! the cmx2 source's worktree review (`http/review.rs`): the diff of a
//! checkout's branch, and merging or discarding it. the daemon's 2xx answer
//! comes back as it wrote it; its refusals become what they mean for a
//! checkout.

use std::time::{Duration, Instant};

use reqwest::Method;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use tracing::info;

use crate::config::HostConfig;
use crate::http::asks::read_capped;
use crate::http::error::{ApiError, CheckoutRefusal, RefusalKind};
use crate::http::session::urlencode;
use crate::source::cmx2::Cmx2Source;
use crate::source::cmx2::verbs::session::CLIENT_NAME;
use crate::upstream::{plain, request};

/// how long the daemon may take to read a branch's diff: git over a large checkout.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// how long a merge or a discard may take: git, and the processes it stops.
const ACT_TIMEOUT: Duration = Duration::from_secs(90);
/// the diff is 2 MB at most in the daemon's own words, and json escaping can double it.
const MAX_DIFF_ANSWER: usize = 8 * 1024 * 1024;
/// a merge's or a discard's answer is a few lines.
const MAX_ACT_ANSWER: usize = 256 * 1024;

/// the verbs that change a checkout.
pub enum Act<'a> {
    Merge {
        directory: &'a str,
        message: Option<&'a str>,
    },
    Discard {
        directory: &'a str,
    },
}

impl Cmx2Source {
    /// what the branch of the checkout at `directory` holds beyond its base
    /// (`GET /experimental/worktree/diff`), as the object the daemon wrote.
    ///
    /// # Errors
    /// the daemon refused (a checkout that is gone included), could not be
    /// reached, or answered something that is not a diff.
    pub async fn worktree_diff(&self, directory: &str) -> Result<Map<String, Value>, ApiError> {
        diff(&self.client, self.host(), directory).await
    }

    /// merges or discards a checkout (`POST /experimental/worktree/merge` or
    /// `discard`), and returns the daemon's answer bytes, checked as json.
    ///
    /// # Errors
    /// as `worktree_diff`, with the 409s a card acts on.
    pub async fn worktree_act(&self, act: Act<'_>) -> Result<Vec<u8>, ApiError> {
        self::act(&self.client, self.host(), act).await
    }
}

/// reads the checkout's diff, as the object the daemon wrote.
///
/// # Errors
/// as `Cmx2Source::worktree_diff`.
pub async fn diff(
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
///
/// # Errors
/// as `Cmx2Source::worktree_act`.
pub async fn act(
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
