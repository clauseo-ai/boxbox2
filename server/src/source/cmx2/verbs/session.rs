//! the cmx2 source's queued prompt, run now, unsend, providers and file
//! search (`http/session.rs`): the daemon's answer passes through with its
//! status and body byte for byte, refusals included; only a host that
//! cannot be reached, or refuses boxbox's credential, answers in boxbox's
//! own shape.

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use reqwest::Method;
use tracing::info;

use crate::http::error::ApiError;
use crate::source::cmx2::Cmx2Source;
use crate::upstream::{plain, request};

/// how long the daemon may take to accept a send; it answers 202 at once.
pub const ACCEPT_TIMEOUT: Duration = Duration::from_secs(20);
/// a reply is small; a list of providers or files is a few hundred kb at most.
const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// the daemon's headers a client needs; nothing else crosses.
const PASSED: [&str; 2] = ["x-cmx2-seq", "x-cmx2-repeat"];
/// who is answering, as the daemon shows it to the next client that tries.
pub const CLIENT_NAME: &str = "boxbox";

impl Cmx2Source {
    /// a prompt for after the running turn (`POST /session/:id/queue`).
    ///
    /// # Errors
    /// the host could not be reached or refused boxbox's credential.
    pub async fn queue_raw(&self, session: &str, send: Vec<u8>) -> Result<Response, ApiError> {
        let route = format!("/session/{session}/queue");
        self.passed_call(Method::POST, &route, Some(send), ACCEPT_TIMEOUT)
            .await
    }

    /// runs what is queued now (`POST /session/:id/loop`).
    ///
    /// # Errors
    /// as `queue_raw`.
    pub async fn run_now_raw(&self, session: &str) -> Result<Response, ApiError> {
        let route = format!("/session/{session}/loop");
        self.passed_call(Method::POST, &route, None, ACCEPT_TIMEOUT)
            .await
    }

    /// takes back a queued prompt (`DELETE /session/:id/message/:id`).
    ///
    /// # Errors
    /// as `queue_raw`.
    pub async fn unsend_raw(&self, session: &str, message: &str) -> Result<Response, ApiError> {
        let route = format!("/session/{session}/message/{message}");
        self.passed_call(Method::DELETE, &route, None, ACCEPT_TIMEOUT)
            .await
    }

    /// the providers and models, and their defaults (`GET /config/providers`).
    ///
    /// # Errors
    /// as `queue_raw`, or the directory is not one.
    pub async fn providers_raw(&self, directory: Option<&str>) -> Result<Response, ApiError> {
        self.scoped("/config/providers", directory).await
    }

    /// files in a project matching a query (`GET /find/file`); `query` is
    /// already in the daemon's query form.
    ///
    /// # Errors
    /// as `providers_raw`.
    pub async fn find_file_raw(
        &self,
        query: &[String],
        directory: Option<&str>,
    ) -> Result<Response, ApiError> {
        let route = if query.is_empty() {
            "/find/file".to_owned()
        } else {
            format!("/find/file?{}", query.join("&"))
        };
        self.scoped(&route, directory).await
    }

    /// a read scoped to a project directory through the `x-cmx2-directory` header.
    ///
    /// # Errors
    /// as `providers_raw`.
    pub async fn scoped(&self, route: &str, directory: Option<&str>) -> Result<Response, ApiError> {
        let mut call = request(&self.client, self.host(), Method::GET, route);
        if let Some(directory) = directory {
            if directory.len() > 4096 || directory.contains('\n') {
                return Err(ApiError::BadRequest("that is not a directory".into()));
            }
            call = call.header("x-cmx2-directory", directory);
        }
        self.passed(call, Method::GET, route, ACCEPT_TIMEOUT).await
    }

    /// one call to the host, answered with its status and body as they came;
    /// only a host that cannot be reached, or refuses the credential, becomes
    /// boxbox's error.
    ///
    /// # Errors
    /// as `queue_raw`.
    pub async fn passed_call(
        &self,
        method: Method,
        route: &str,
        body: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Response, ApiError> {
        let mut call = request(&self.client, self.host(), method.clone(), route)
            .header("x-cmx2-client", CLIENT_NAME);
        if let Some(body) = body {
            call = call
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        self.passed(call, method, route, timeout).await
    }

    async fn passed(
        &self,
        call: reqwest::RequestBuilder,
        method: Method,
        route: &str,
        timeout: Duration,
    ) -> Result<Response, ApiError> {
        let host = self.host();
        let started = Instant::now();
        let unreachable = |reason: String| ApiError::HostUnreachable {
            host: host.name.clone(),
            reason,
        };
        let (status, kind, passed, bytes) = tokio::time::timeout(timeout, async {
            let answer = call.send().await?;
            let status = answer.status();
            let kind = answer.headers().get(reqwest::header::CONTENT_TYPE).cloned();
            let passed: Vec<(&'static str, Vec<u8>)> = PASSED
                .iter()
                .filter_map(|name| {
                    answer
                        .headers()
                        .get(*name)
                        .map(|v| (*name, v.as_bytes().to_vec()))
                })
                .collect();
            let bytes = answer.bytes().await?;
            Ok::<_, reqwest::Error>((status, kind, passed, bytes))
        })
        .await
        .map_err(|_| unreachable(format!("no answer within {}s", timeout.as_secs())))?
        .map_err(|e| unreachable(plain(&e)))?;
        info!(
            host = %host.name,
            %method,
            route = route.split('?').next().unwrap_or(route),
            status = status.as_u16(),
            latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "session call"
        );
        if bytes.len() > MAX_ANSWER {
            return Err(unreachable(format!(
                "the answer was {} kb, past any list",
                bytes.len() / 1024
            )));
        }
        if status.as_u16() == 401 {
            return Err(ApiError::HostRefused(host.name.clone()));
        }
        let mut response = Body::from(bytes).into_response();
        *response.status_mut() =
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let headers = response.headers_mut();
        if let Some(kind) = kind.and_then(|k| HeaderValue::from_bytes(k.as_bytes()).ok()) {
            headers.insert(header::CONTENT_TYPE, kind);
        }
        for (name, value) in passed {
            if let Ok(value) = HeaderValue::from_bytes(&value) {
                headers.insert(name, value);
            }
        }
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        Ok(response)
    }
}
