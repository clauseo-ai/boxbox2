//! the cmx2 source's terminals (`pty/routes.rs`, `pty/dial.rs`): the
//! host's `/pty` rest api, bodies passed through byte for byte with the
//! host's own errors turned into boxbox's, and the dial of a terminal's
//! websocket with the host's credential added here.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use reqwest::{Method, Url};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{StatusCode as WsStatus, header as ws_header};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{self, Error as WsError};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};
use tracing::info;

use crate::http::error::ApiError;
use crate::source::cmx2::Cmx2Source;
use crate::upstream::{plain, request, route_url};

/// how long the host may take to answer a rest call.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// a terminal list or a shell list is a few kb; this is far past any real one.
const MAX_ANSWER: usize = 1024 * 1024;

/// the connection to one terminal on its host.
pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// how long a dial may take, the tcp and tls handshakes and the upgrade.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// cmx2 sends output in frames of at most 64k utf-16 units, which is at
/// most 192 kb of utf-8; anything larger is not the contract.
const MAX_MESSAGE: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum DialError {
    #[error("the host has no such terminal")]
    NotFound,
    #[error("the host refused boxbox's credential; check its password in boxbox.toml")]
    Refused,
    #[error("{0}")]
    Unreachable(String),
}

impl Cmx2Source {
    /// the host's open terminals (`GET /pty`).
    ///
    /// # Errors
    /// the host did not answer, refused the credential, or refused the call.
    pub async fn terminals_raw(&self) -> Result<Response, ApiError> {
        self.terminal_call(Method::GET, "/pty", None).await
    }

    /// the login shells the host lists (`GET /pty/shells`).
    ///
    /// # Errors
    /// as `terminals_raw`.
    pub async fn terminal_shells_raw(&self) -> Result<Response, ApiError> {
        self.terminal_call(Method::GET, "/pty/shells", None).await
    }

    /// opens a terminal (`POST /pty`); `body` is cmx2's `CreatePtyBody`.
    ///
    /// # Errors
    /// as `terminals_raw`.
    pub async fn create_terminal_raw(&self, body: Vec<u8>) -> Result<Response, ApiError> {
        self.terminal_call(Method::POST, "/pty", Some(body)).await
    }

    /// one terminal (`GET /pty/:id`); `id` is checked already.
    ///
    /// # Errors
    /// as `terminals_raw`, or the host has no such terminal.
    pub async fn terminal_raw(&self, id: &str) -> Result<Response, ApiError> {
        let route = format!("/pty/{id}");
        self.terminal_call(Method::GET, &route, None).await
    }

    /// renames or resizes a terminal (`PUT /pty/:id`); `body` is cmx2's
    /// `UpdatePtyBody`.
    ///
    /// # Errors
    /// as `terminal_raw`.
    pub async fn change_terminal_raw(&self, id: &str, body: Vec<u8>) -> Result<Response, ApiError> {
        let route = format!("/pty/{id}");
        self.terminal_call(Method::PUT, &route, Some(body)).await
    }

    /// kills a terminal (`DELETE /pty/:id`).
    ///
    /// # Errors
    /// as `terminal_raw`.
    pub async fn kill_terminal_raw(&self, id: &str) -> Result<Response, ApiError> {
        let route = format!("/pty/{id}");
        self.terminal_call(Method::DELETE, &route, None).await
    }

    /// one call to the host, answered with its status and body as they came.
    /// the host's own errors become boxbox's, so the app reads one shape.
    async fn terminal_call(
        &self,
        method: Method,
        route: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Response, ApiError> {
        let host = self.host();
        let started = Instant::now();
        let mut call = request(&self.client, host, method.clone(), route);
        if let Some(body) = body {
            call = call
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        let unreachable = |reason: String| ApiError::HostUnreachable {
            host: host.name.clone(),
            reason,
        };
        let answer = tokio::time::timeout(ANSWER_TIMEOUT, async {
            let answer = call.send().await?;
            let status = answer.status();
            let kind = answer.headers().get(reqwest::header::CONTENT_TYPE).cloned();
            let bytes = answer.bytes().await?;
            Ok::<_, reqwest::Error>((status, kind, bytes))
        })
        .await
        .map_err(|_| unreachable(format!("no answer within {}s", ANSWER_TIMEOUT.as_secs())))?
        .map_err(|e| unreachable(plain(&e)))?;
        let (status, kind, bytes) = answer;
        info!(
            host = %host.name,
            %method,
            route,
            status = status.as_u16(),
            latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "terminal call"
        );
        if bytes.len() > MAX_ANSWER {
            return Err(unreachable(format!(
                "the answer was {} kb, past any terminal list",
                bytes.len() / 1024
            )));
        }
        match status.as_u16() {
            200..=299 => {
                let mut response = Body::from(bytes).into_response();
                let headers = response.headers_mut();
                if let Some(kind) = kind.and_then(|k| HeaderValue::from_bytes(k.as_bytes()).ok()) {
                    headers.insert(header::CONTENT_TYPE, kind);
                }
                headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                *response.status_mut() =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK);
                Ok(response)
            }
            400 => Err(ApiError::BadRequest(
                host_message(&bytes).unwrap_or_else(|| "the host refused the request".into()),
            )),
            401 => Err(ApiError::HostRefused(host.name.clone())),
            404 => Err(ApiError::NoSuchTerminal(
                route.rsplit('/').next().unwrap_or(route).to_owned(),
            )),
            other => Err(unreachable(match host_message(&bytes) {
                Some(message) => format!("it answered {other}: {message}"),
                None => format!("it answered {other}"),
            })),
        }
    }

    /// opens terminal `pty` from `cursor` (`None`: replay everything
    /// retained), over `tls` for a `wss://` host.
    ///
    /// # Errors
    /// the host does not know the terminal, refused the credential, or
    /// could not be reached; each in words a person can act on.
    pub async fn dial_terminal(
        &self,
        tls: &Arc<rustls::ClientConfig>,
        pty: &str,
        cursor: Option<i64>,
    ) -> Result<Socket, DialError> {
        let host = self.host();
        let route = match cursor {
            Some(cursor) => format!("/pty/{pty}/connect?cursor={cursor}"),
            None => format!("/pty/{pty}/connect"),
        };
        let url = websocket_url(&route_url(&host.url, &route))?;
        let mut request = url.as_str().into_client_request().map_err(|e| {
            DialError::Unreachable(format!("the terminal address is not valid: {e}"))
        })?;
        if let Some(credential) = &host.credential {
            let value = credential.header().ok_or_else(|| {
                DialError::Unreachable("the host's credential is not a valid header".into())
            })?;
            request
                .headers_mut()
                .insert(ws_header::AUTHORIZATION, value);
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let connector = Connector::Rustls(Arc::clone(tls));
        let dialled = tokio::time::timeout(
            DIAL_TIMEOUT,
            tokio_tungstenite::connect_async_tls_with_config(
                request,
                Some(config),
                true,
                Some(connector),
            ),
        )
        .await
        .map_err(|_| {
            DialError::Unreachable(format!("no answer within {}s", DIAL_TIMEOUT.as_secs()))
        })?;
        match dialled {
            Ok((socket, _)) => Ok(socket),
            Err(WsError::Http(answer)) => Err(match answer.status() {
                WsStatus::NOT_FOUND => DialError::NotFound,
                WsStatus::UNAUTHORIZED => DialError::Refused,
                status => DialError::Unreachable(format!("the host answered {status}")),
            }),
            Err(e) => Err(DialError::Unreachable(ws_plain(&e))),
        }
    }
}

/// the message in cmx2's error body, `{name, data: {message}}`.
#[must_use]
pub fn host_message(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<crate::cmx2::ErrorBody>(body)
        .ok()
        .map(|e| e.data.message)
        .filter(|m| !m.is_empty())
}

/// the daemon's http(s) url as the ws(s) url of the same place.
///
/// # Errors
/// the url is neither http nor https.
pub fn websocket_url(url: &Url) -> Result<Url, DialError> {
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        other => {
            return Err(DialError::Unreachable(format!(
                "the host's url uses {other}, not http or https"
            )));
        }
    };
    let mut url = url.clone();
    // both are special schemes, which the url crate lets swap
    url.set_scheme(scheme)
        .map_err(|()| DialError::Unreachable("the host's url cannot carry a websocket".into()))?;
    Ok(url)
}

/// a websocket failure in plain words, naming the innermost cause, as
/// `upstream::plain` does for reqwest.
#[must_use]
pub fn ws_plain(error: &WsError) -> String {
    match error {
        WsError::Io(io) => match io.kind() {
            std::io::ErrorKind::ConnectionRefused => "cannot connect (connection refused)".into(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe => {
                "the connection dropped".into()
            }
            std::io::ErrorKind::UnexpectedEof => "the connection ended mid-frame".into(),
            _ => format!("the connection failed ({})", io.to_string().to_lowercase()),
        },
        WsError::Tls(tls) => format!("the tls handshake failed ({tls})"),
        WsError::ConnectionClosed | WsError::AlreadyClosed => "the connection closed".into(),
        WsError::Protocol(tungstenite::error::ProtocolError::ResetWithoutClosingHandshake) => {
            "the connection dropped without a close".into()
        }
        WsError::Capacity(what) => format!("the host sent more than a frame may hold ({what})"),
        other => other.to_string().to_lowercase(),
    }
}
