//! the cmx2 source's machine verbs (`http/hosts.rs`): reload, restart and
//! the model list, each one request logged in one line with host, route,
//! status and latency.

use std::time::{Duration, Instant};

use axum::http::StatusCode;
use reqwest::Method;
use serde::Deserialize;
use tracing::{info, warn};

use crate::config::Origin;
use crate::http::error::ApiError;
use crate::http::hosts::{McpServer, Reloaded};
use crate::source::cmx2::Cmx2Source;
use crate::upstream::{plain, request};

/// `/global/reload` waits up to 15 s for mcp servers to reconnect.
const RELOAD_TIMEOUT: Duration = Duration::from_secs(20);
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
/// a pairing, a restart or a reload answers in a few hundred bytes; the
/// model list of a host with every provider configured stays well under.
const BODY_CAP: usize = 1024 * 1024;

#[derive(Deserialize)]
struct ReloadAnswer {
    changed: Vec<String>,
    flushed: Vec<String>,
    mcp: Vec<McpServer>,
}

impl Cmx2Source {
    /// the daemon re-reads its config and flushes what it caches
    /// (`POST /global/reload`).
    ///
    /// # Errors
    /// the host did not answer, refused the credential, failed, or its
    /// answer did not read.
    pub async fn reload_global(&self) -> Result<Reloaded, ApiError> {
        let bytes = self
            .machine_call(Method::POST, "/global/reload", RELOAD_TIMEOUT)
            .await?;
        let answer: ReloadAnswer =
            serde_json::from_slice(&bytes).map_err(|e| ApiError::HostFailed {
                host: self.host().name.clone(),
                detail: format!("its reload answer did not read ({e})"),
            })?;
        Ok(Reloaded {
            changed: answer.changed,
            flushed: answer.flushed,
            mcp: answer.mcp,
        })
    }

    /// the daemon aborts every running turn and exits for its supervisor
    /// to start a fresh one (`POST /global/restart`).
    ///
    /// # Errors
    /// the host did not answer, refused the credential or failed.
    pub async fn restart_global(&self) -> Result<(), ApiError> {
        self.machine_call(Method::POST, "/global/restart", ANSWER_TIMEOUT)
            .await?;
        Ok(())
    }

    /// the providers and their models (`GET /config/providers`), as json.
    ///
    /// # Errors
    /// as `reload_global`.
    pub async fn provider_models(&self) -> Result<serde_json::Value, ApiError> {
        let bytes = self
            .machine_call(Method::GET, "/config/providers", ANSWER_TIMEOUT)
            .await?;
        serde_json::from_slice(&bytes).map_err(|e| ApiError::HostFailed {
            host: self.host().name.clone(),
            detail: format!("its model list did not read ({e})"),
        })
    }

    /// one request to a host on the machines screen's behalf, logged in one
    /// line with host, route, status and latency.
    async fn machine_call(
        &self,
        method: Method,
        route: &'static str,
        limit: Duration,
    ) -> Result<Vec<u8>, ApiError> {
        let config = self.host();
        let host = config.name.clone();
        let started = Instant::now();
        let sent = tokio::time::timeout(
            limit,
            request(&self.client, config, method.clone(), route).send(),
        )
        .await;
        let response = match sent {
            Err(_) => {
                warn!(%host, %method, route, latency_ms = started.elapsed().as_millis(), "host did not answer in time");
                return Err(ApiError::HostUnreachable {
                    host,
                    reason: format!("no answer within {}s", limit.as_secs()),
                });
            }
            Ok(Err(error)) => {
                let reason = plain(&error);
                warn!(%host, %method, route, %reason, latency_ms = started.elapsed().as_millis(), "host did not answer");
                return Err(ApiError::HostUnreachable { host, reason });
            }
            Ok(Ok(response)) => response,
        };
        let status = response.status();
        info!(%host, %method, route, status = status.as_u16(), latency_ms = started.elapsed().as_millis(), "host answered");
        if status == StatusCode::UNAUTHORIZED {
            return Err(match config.origin {
                Origin::Config => ApiError::HostRefused(host),
                Origin::Paired => ApiError::CredentialRevoked(host),
            });
        }
        let bytes = read_capped(response)
            .await
            .map_err(|reason| ApiError::HostUnreachable {
                host: host.clone(),
                reason,
            })?;
        if !status.is_success() {
            return Err(ApiError::HostFailed {
                host,
                detail: format!("it answered {status}: {}", message_of(&bytes)),
            });
        }
        Ok(bytes)
    }
}

/// a host's answer body, at most `BODY_CAP` bytes.
///
/// # Errors
/// the body could not be read, or passed the cap.
pub async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| plain(&e))? {
        if body.len() + chunk.len() > BODY_CAP {
            return Err(format!("the answer passed {} kb", BODY_CAP / 1024));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// the message in a cmx2 error body, or the start of whatever came back.
#[must_use]
pub fn message_of(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["data"]["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| String::from_utf8_lossy(&body[..body.len().min(200)]).into_owned())
}
