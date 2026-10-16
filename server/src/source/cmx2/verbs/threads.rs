//! the cmx2 source's archive and adopt (`http/threads.rs`): one read or
//! patch of a session, its answer kept raw and its refusals turned into what
//! they mean for a thread.

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
        .map_err(|_| unreachable(format!("no answer within {}s", DAEMON_TIMEOUT.as_secs())))?
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
