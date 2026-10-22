//! the cmx2 source's archive, adopt and fork (`http/threads.rs`,
//! `http/agents/routes.rs`): one read, patch or fork of a session, its answer
//! kept raw and its refusals turned into what they mean for a thread.

use std::time::Duration;

use reqwest::Method;
use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;

use crate::config::HostConfig;
use crate::http::asks::read_capped;
use crate::http::error::ApiError;
use crate::source::cmx2::Cmx2Source;
use crate::upstream::{plain, request};

/// how long the daemon may take to answer an archive or a read of one session.
const DAEMON_TIMEOUT: Duration = Duration::from_secs(15);
/// a session's info is a few kb; a daemon answering more is not one.
pub const MAX_ANSWER: usize = 1024 * 1024;

impl Cmx2Source {
    /// one session as the daemon has it (`GET /session/:id`), kept raw.
    ///
    /// # Errors
    /// the daemon does not know it (`Gone`), refused, could not be reached
    /// or answered something that is not json.
    pub async fn session_info(&self, session: &str) -> Result<Box<RawValue>, ApiError> {
        let route = format!("/session/{session}");
        daemon(&self.client, self.host(), Method::GET, &route, None).await
    }

    /// archives a session at `asked`, ms since the epoch (`PATCH /session/:id`
    /// with `time.archived`), and returns the session as the daemon answered.
    ///
    /// # Errors
    /// as `session_info`.
    pub async fn archive_session(
        &self,
        session: &str,
        asked: f64,
    ) -> Result<Box<RawValue>, ApiError> {
        let route = format!("/session/{session}");
        let sent = json!({ "time": { "archived": asked } });
        daemon(
            &self.client,
            self.host(),
            Method::PATCH,
            &route,
            Some(&sent),
        )
        .await
    }

    /// renames a session (`PATCH /session/:id` with `title`) and returns the
    /// session as the daemon answered. the daemon's `session.updated` carries
    /// the new title to the fleet like any other change.
    ///
    /// # Errors
    /// as `session_info`.
    pub async fn rename_session(
        &self,
        session: &str,
        title: &str,
    ) -> Result<Box<RawValue>, ApiError> {
        let route = format!("/session/{session}");
        let sent = json!({ "title": title });
        daemon(
            &self.client,
            self.host(),
            Method::PATCH,
            &route,
            Some(&sent),
        )
        .await
    }

    /// a new session holding this one's history up to, not including,
    /// `before` (one of its message ids), or all of it (`POST
    /// /session/:id/fork`); returns the new session as the daemon answered.
    ///
    /// # Errors
    /// as `session_info`; the daemon answers 409 for history imported from
    /// cmx (browse only) and 404 for a session or a message it does not have.
    pub async fn fork_session(
        &self,
        session: &str,
        before: Option<&str>,
        client_id: &str,
    ) -> Result<Box<RawValue>, ApiError> {
        let route = format!("/session/{session}/fork");
        let sent = fork_body(before, client_id);
        daemon(&self.client, self.host(), Method::POST, &route, Some(&sent)).await
    }
}

/// what a fork sends: the cut, and the client id a retry repeats. a daemon
/// before the once rule for forks reads past the field (its fork body
/// allows more than it names).
fn fork_body(before: Option<&str>, client_id: &str) -> serde_json::Value {
    let mut sent = json!({ "clientID": client_id });
    if let Some(message) = before {
        sent["messageID"] = json!(message);
    }
    sent
}

/// the reason `daemon` gives when the daemon took the request and did not
/// answer in time: what it asked may have been done.
const NO_ANSWER: &str = "no answer within";

/// whether a call's failure leaves its outcome unknown: the daemon did not
/// answer in time, or answered something that could not be read.
#[must_use]
pub fn unanswered(error: &ApiError) -> bool {
    match error {
        ApiError::HostUnreachable { reason, .. } => reason.starts_with(NO_ANSWER),
        ApiError::HostFailed { .. } => true,
        _ => false,
    }
}

/// one call to a daemon whose answer is a session, kept raw. its refusals
/// become what they mean for a thread: gone, or the daemon's own words.
///
/// # Errors
/// as `Cmx2Source::session_info`.
pub async fn daemon(
    client: &reqwest::Client,
    host: &HostConfig,
    method: Method,
    route: &str,
    sent: Option<&serde_json::Value>,
) -> Result<Box<RawValue>, ApiError> {
    let unreachable = |reason: String| ApiError::HostUnreachable {
        host: host.name.clone(),
        reason,
    };
    let mut call = request(client, host, method, route);
    if let Some(sent) = sent {
        call = call
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(sent.to_string());
    }
    let answer = tokio::time::timeout(DAEMON_TIMEOUT, call.send())
        .await
        .map_err(|_| unreachable(format!("{NO_ANSWER} {}s", DAEMON_TIMEOUT.as_secs())))?
        .map_err(|e| unreachable(plain(&e)))?;
    let status = answer.status().as_u16();
    // read in chunks up to the cap: a host that sends more is a failure, never a buffer
    let body = read_capped(answer, &host.name, DAEMON_TIMEOUT, MAX_ANSWER).await?;
    match status {
        200..=299 => {
            RawValue::from_string(String::from_utf8_lossy(&body).into_owned()).map_err(|error| {
                ApiError::HostFailed {
                    host: host.name.clone(),
                    detail: format!("its answer was not json: {error}"),
                }
            })
        }
        401 => Err(ApiError::HostRefused(host.name.clone())),
        404 => Err(ApiError::Gone),
        _ => {
            let named: Option<DaemonError> = serde_json::from_slice(&body).ok();
            Err(ApiError::HostSaid {
                host: host.name.clone(),
                status,
                message: named
                    .and_then(|e| e.data)
                    .and_then(|d| d.message)
                    .unwrap_or_else(|| format!("status {status}")),
            })
        }
    }
}

#[derive(Deserialize)]
struct DaemonError {
    data: Option<DaemonErrorData>,
}

#[derive(Deserialize)]
struct DaemonErrorData {
    message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fork_sends_its_client_id_and_its_cut_only_when_it_has_one() {
        assert_eq!(fork_body(None, "c-1"), json!({ "clientID": "c-1" }));
        assert_eq!(
            fork_body(Some("msg_9"), "c-2"),
            json!({ "clientID": "c-2", "messageID": "msg_9" })
        );
    }

    #[test]
    fn only_a_request_taken_and_not_answered_leaves_its_outcome_unknown() {
        let host = || "desk".to_owned();
        assert!(unanswered(&ApiError::HostUnreachable {
            host: host(),
            reason: format!("{NO_ANSWER} 15s"),
        }));
        assert!(unanswered(&ApiError::HostFailed {
            host: host(),
            detail: "its answer was not json".into(),
        }));
        assert!(!unanswered(&ApiError::HostUnreachable {
            host: host(),
            reason: "cannot connect (refused)".into(),
        }));
        assert!(!unanswered(&ApiError::Gone));
    }
}
