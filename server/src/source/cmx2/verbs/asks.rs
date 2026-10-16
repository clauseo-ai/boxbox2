//! the cmx2 source's a prompt, a stop, a compaction and the answers to asks
//! (`http/asks.rs`): each goes to the daemon with the device's `clientID`,
//! logged once, the daemon's answer passed back whole and its refusals
//! mapped to what they mean here.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tracing::info;

use crate::config::HostConfig;
use crate::fleet::model::session_key;
use crate::http::asks::{Done, read_capped, segment};
use crate::http::error::ApiError;
use crate::source::cmx2::Cmx2Source;
use crate::upstream::{plain, request};

/// how long the daemon may take to answer a verb.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// the most of a host's answer one call reads: past it the answer is the host's failure.
pub const BODY_MAX: usize = 16 * 1024 * 1024;
/// how long the daemon may take to compact a thread: it answers once the summary is in, and a long thread's summary
/// is a model call of its own.
pub const COMPACT_TIMEOUT: Duration = Duration::from_secs(300);

impl Cmx2Source {
    /// answers a permission (`POST /permission/:id/reply`); `ask` is already one segment.
    ///
    /// # Errors
    /// the host could not be reached or refused boxbox's credential, or the
    /// daemon refused the answer (gone, already settled).
    pub async fn permission(&self, ask: &str, sent: &Value) -> Result<Done, ApiError> {
        self.post(&format!("/permission/{ask}/reply"), sent).await
    }

    /// answers a question (`POST /question/:id/reply`).
    ///
    /// # Errors
    /// as `permission`.
    pub async fn question(&self, ask: &str, sent: &Value) -> Result<Done, ApiError> {
        self.post(&format!("/question/{ask}/reply"), sent).await
    }

    /// dismisses a question (`POST /question/:id/reject`).
    ///
    /// # Errors
    /// as `permission`.
    pub async fn reject(&self, ask: &str, sent: &Value) -> Result<Done, ApiError> {
        self.post(&format!("/question/{ask}/reject"), sent).await
    }

    /// sends a prompt (`POST /session/:id/prompt_async`); `session` is already
    /// one segment and `limit` the daemon's own time to take it.
    ///
    /// # Errors
    /// as `permission`.
    pub async fn prompt(
        &self,
        session: &str,
        sent: Value,
        limit: Duration,
    ) -> Result<Done, ApiError> {
        let route = format!("/session/{session}/prompt_async");
        self.post_body(&route, sent, limit).await
    }

    /// stops the running turn (`POST /session/:id/abort`).
    ///
    /// # Errors
    /// as `permission`.
    pub async fn abort(&self, session: &str) -> Result<Done, ApiError> {
        let route = format!("/session/{session}/abort");
        self.post(&route, &json!({})).await
    }

    /// compacts the thread now (`POST /session/:id/summarize`), within `COMPACT_TIMEOUT`.
    ///
    /// # Errors
    /// as `permission`, the refusals said in words that fit a compaction.
    pub async fn compact(&self, session: &str) -> Result<Done, ApiError> {
        summarize(&self.client, self.host(), session, COMPACT_TIMEOUT).await
    }

    /// a verb posted with its json body, within `ANSWER_TIMEOUT`.
    ///
    /// # Errors
    /// as `permission`.
    pub async fn post(&self, route: &str, sent: &Value) -> Result<Done, ApiError> {
        self.upstream(
            reqwest::Method::POST,
            route,
            Some(sent),
            None,
            ANSWER_TIMEOUT,
        )
        .await
    }

    /// a message with photos, which can be tens of megabytes: the body is written once and the value it came from
    /// is dropped before the call, so what is held while the daemon takes it (and converts a heic, which can take
    /// a minute) is the body alone, not the body and a tree of the same strings (`AGENTS.md`, memory and latency). `limit` is the daemon's
    /// own time to answer (`accept_timeout`).
    ///
    /// # Errors
    /// as `permission`.
    pub async fn post_body(
        &self,
        route: &str,
        sent: Value,
        limit: Duration,
    ) -> Result<Done, ApiError> {
        let text = body_bytes(&sent);
        drop(sent);
        call_host_text(
            &self.client,
            self.host(),
            reqwest::Method::POST,
            route,
            Some(text),
            None,
            limit,
            BODY_MAX,
        )
        .await
    }

    /// one call to the host on a person's behalf: logged once, the daemon's
    /// answer passed back whole, its refusals mapped to what they mean here.
    /// `directory` scopes a read the way cmx2 scopes them (`x-cmx2-directory`).
    ///
    /// # Errors
    /// as `permission`.
    pub async fn upstream(
        &self,
        method: reqwest::Method,
        route: &str,
        sent: Option<&Value>,
        directory: Option<&str>,
        limit: Duration,
    ) -> Result<Done, ApiError> {
        self.upstream_within(method, route, sent, directory, limit, BODY_MAX)
            .await
    }

    /// `upstream` with the most body it will read: an answer past it is the host's failure, not a buffer
    /// that grows to the size of whatever a host sends (`AGENTS.md`, memory and latency).
    ///
    /// # Errors
    /// as `permission`, or the answer was past `cap`.
    pub async fn upstream_within(
        &self,
        method: reqwest::Method,
        route: &str,
        sent: Option<&Value>,
        directory: Option<&str>,
        limit: Duration,
        cap: usize,
    ) -> Result<Done, ApiError> {
        call_host_text(
            &self.client,
            self.host(),
            method,
            route,
            sent.map(|sent| sent.to_string().into_bytes()),
            directory,
            limit,
            cap,
        )
        .await
    }
}

/// one compaction on one host. the daemon takes the thread's own model when the body names none, but holds the body
/// as required, so it gets an empty one.
///
/// # Errors
/// as `Cmx2Source::compact`, or `session` is not one segment.
pub async fn summarize(
    client: &reqwest::Client,
    host: &HostConfig,
    session: &str,
    limit: Duration,
) -> Result<Done, ApiError> {
    let route = format!("/session/{}/summarize", segment(session)?);
    let done = call_host_text(
        client,
        host,
        reqwest::Method::POST,
        &route,
        Some(json!({}).to_string().into_bytes()),
        None,
        limit,
        BODY_MAX,
    )
    .await;
    compaction_refusal(done, &host.name, session)
}

/// the daemon's refusals of a compaction, in the words that fit it: its generic ones (gone, already sent, already
/// answered) are written for asks and sends.
fn compaction_refusal(
    done: Result<Done, ApiError>,
    host: &str,
    session: &str,
) -> Result<Done, ApiError> {
    let said = |message: &str| ApiError::HostSaid {
        host: host.to_owned(),
        status: 409,
        message: message.to_owned(),
    };
    done.map_err(|error| match error {
        ApiError::Gone => ApiError::NoSuchSession(session_key(host, session)),
        ApiError::AlreadySent => said("a turn is running. stop it or wait for it, then compact"),
        ApiError::Settled { .. } => {
            said("this thread is history imported from cmx and cannot be compacted")
        }
        other => other,
    })
}

/// the daemon's error body, read loosely: a6's 409 carries who settled the
/// ask and when.
#[derive(Debug, Deserialize)]
struct HostError {
    name: Option<String>,
    data: Option<HostErrorData>,
}

#[derive(Debug, Deserialize)]
struct HostErrorData {
    message: Option<String>,
    by: Option<String>,
    #[serde(rename = "settledAt")]
    settled_at: Option<f64>,
}

/// a message's body as json, in a buffer made the size of the strings it holds: `to_string` grows by doubling, which for
/// tens of megabytes of photo is as much again held for the moment it takes.
fn body_bytes(sent: &Value) -> Vec<u8> {
    let strings: usize = sent["parts"].as_array().map_or(0, |parts| {
        parts
            .iter()
            .map(|part| {
                ["url", "text"]
                    .iter()
                    .filter_map(|field| part[field].as_str())
                    .map(str::len)
                    .sum::<usize>()
            })
            .sum()
    });
    let mut buffer = Vec::with_capacity(strings + 4096);
    // a Value always serializes
    if serde_json::to_writer(&mut buffer, sent).is_err() {
        buffer.clear();
    }
    buffer
}

/// `upstream_within` once the host is found: the call itself, apart from the state that holds the hosts.
#[allow(
    clippy::too_many_arguments,
    reason = "upstream's own arguments and the cap"
)]
async fn call_host_text(
    client: &reqwest::Client,
    config: &HostConfig,
    method: reqwest::Method,
    route: &str,
    sent: Option<Vec<u8>>,
    directory: Option<&str>,
    limit: Duration,
    cap: usize,
) -> Result<Done, ApiError> {
    let host = config.name.as_str();
    let started = Instant::now();
    let unreachable = |reason: String| ApiError::HostUnreachable {
        host: host.to_owned(),
        reason,
    };
    let mut call = request(client, config, method.clone(), route);
    if let Some(sent) = sent {
        call = call
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(sent);
    }
    if let Some(directory) = directory {
        call = call.header("x-cmx2-directory", directory);
    }
    let answer = tokio::time::timeout(limit, call.send())
        .await
        .map_err(|_| unreachable(format!("no answer within {}s", limit.as_secs())))?
        .map_err(|e| unreachable(plain(&e)))?;
    let status = answer.status().as_u16();
    let repeat = answer.headers().contains_key("x-cmx2-repeat");
    let body = read_capped(answer, host, limit, cap).await?;
    info!(
        host,
        %method,
        route,
        status,
        repeat,
        latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "verb sent to the host"
    );
    if (200..300).contains(&status) {
        // a blocking send starts its body with a space; json reads past it
        let answer = serde_json::from_slice(&body).unwrap_or(Value::Null);
        return Ok(Done { repeat, answer });
    }
    let error: Option<HostError> = serde_json::from_slice(&body).ok();
    let name = error
        .as_ref()
        .and_then(|e| e.name.clone())
        .unwrap_or_default();
    let data = error.and_then(|e| e.data);
    match (status, name.as_str()) {
        (401, _) => Err(ApiError::HostRefused(host.to_owned())),
        (404, _) => Err(ApiError::Gone),
        (409, "BusyError") => Err(ApiError::AlreadySent),
        (409, "ConflictError") => {
            let (by, at) = data.map_or((None, None), |d| (d.by, d.settled_at));
            #[allow(clippy::cast_possible_truncation, reason = "a ms stamp fits an i64")]
            let at = at.map(|at| at as i64);
            Err(ApiError::Settled {
                by: by.unwrap_or_else(|| "someone".into()),
                at,
            })
        }
        _ => Err(ApiError::HostSaid {
            host: host.to_owned(),
            status,
            message: data
                .and_then(|d| d.message)
                .unwrap_or_else(|| format!("status {status}")),
        }),
    }
}
