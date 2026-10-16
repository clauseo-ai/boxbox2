//! the daemon's own memory report (`GET /global/memory`), sampled while
//! its host is connected: once as each connection opens, then every
//! minute. a daemon that answers 404 does not report memory; it is asked
//! again only on its next connection, since it may have been upgraded.
//! the sampler is its own task so a slow answer never holds up the event
//! stream, and it stops with its watcher.

use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::debug;
use utoipa::ToSchema;

use super::{Connection, HostStatus, get, plain};
use crate::config::HostConfig;

const ROUTE: &str = "/global/memory";
const EVERY: Duration = Duration::from_secs(60);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);
/// the answer is a handful of numbers; nothing larger is read.
const BODY_CAP: usize = 4 * 1024;

/// what the daemon says about its own memory.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = HostMemory)]
pub struct Memory {
    /// resident set size, in bytes.
    pub rss: u64,
    /// sessions the daemon holds in memory; none means it is idle.
    pub live_sessions: u32,
    pub uptime_s: u64,
    /// when the sample was taken, ms since the epoch.
    pub sampled_at: i64,
}

#[derive(Deserialize)]
struct Answer {
    rss: u64,
    live_sessions: u32,
    uptime_s: u64,
}

pub(super) async fn sample(
    host: Arc<HostConfig>,
    client: reqwest::Client,
    mut status: watch::Receiver<HostStatus>,
    memory: watch::Sender<Option<Memory>>,
    stop: CancellationToken,
) {
    loop {
        let connected = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            seen = status.wait_for(|s| s.connection == Connection::Connected) => seen.is_ok(),
        };
        if !connected {
            return;
        }
        let mut reports = true;
        loop {
            if reports {
                match read(&client, &host).await {
                    Ok(Some(sample)) => {
                        memory.send_replace(Some(sample));
                    }
                    Ok(None) => {
                        debug!(host = %host.name, route = ROUTE, "the daemon does not report memory");
                        memory.send_replace(None);
                        reports = false;
                    }
                    Err(error) => {
                        debug!(host = %host.name, route = ROUTE, %error, "memory sample failed; the last one stays");
                    }
                }
            }
            tokio::select! {
                biased;
                () = stop.cancelled() => return,
                left = status.wait_for(|s| s.connection != Connection::Connected) => {
                    if left.is_err() {
                        return;
                    }
                    break;
                }
                () = tokio::time::sleep(EVERY), if reports => {}
            }
        }
    }
}

/// one sample; `None` when the daemon has no such route.
async fn read(client: &reqwest::Client, host: &HostConfig) -> Result<Option<Memory>, String> {
    let mut response = tokio::time::timeout(ANSWER_TIMEOUT, get(client, host, ROUTE).send())
        .await
        .map_err(|_| format!("no answer within {}s", ANSWER_TIMEOUT.as_secs()))?
        .map_err(|e| plain(&e))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("answered {}", response.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| plain(&e))? {
        if body.len() + chunk.len() > BODY_CAP {
            return Err(format!("the answer passed {BODY_CAP} bytes"));
        }
        body.extend_from_slice(&chunk);
    }
    let answer: Answer = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(Some(Memory {
        rss: answer.rss,
        live_sessions: answer.live_sessions,
        uptime_s: answer.uptime_s,
        sampled_at: crate::now_ms(),
    }))
}
