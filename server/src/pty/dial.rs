//! dialling a host's pty websocket: `ws(s)://<daemon>/pty/:id/connect`,
//! with the host's credential added here, since it never leaves the
//! server, and the answer sorted into what the relay does next.

use std::sync::Arc;
use std::time::Duration;

use reqwest::Url;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{StatusCode, header};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{self, Error as WsError};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

use crate::config::HostConfig;
use crate::upstream::route_url;

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

#[derive(Debug, thiserror::Error)]
pub enum TlsSetupError {
    #[error("the tls settings did not build: {0}")]
    Rustls(#[from] rustls::Error),
}

/// what every dial shares: the tls settings, built once, trusting what
/// the operating system trusts (the same verifier reqwest uses).
#[derive(Clone)]
pub struct Dialer {
    tls: Arc<rustls::ClientConfig>,
}

impl std::fmt::Debug for Dialer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Dialer")
    }
}

impl Dialer {
    /// # Errors
    /// the platform's certificate verifier or the protocol versions did
    /// not build.
    pub fn new() -> Result<Self, TlsSetupError> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let verifier = rustls_platform_verifier::Verifier::new(Arc::clone(&provider))?;
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        Ok(Self { tls: Arc::new(tls) })
    }

    /// opens terminal `pty` on `host` from `cursor` (`None`: replay
    /// everything retained).
    ///
    /// # Errors
    /// the host does not know the terminal, refused the credential, or
    /// could not be reached; each in words a person can act on.
    pub async fn dial(
        &self,
        host: &HostConfig,
        pty: &str,
        cursor: Option<i64>,
    ) -> Result<Socket, DialError> {
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
            request.headers_mut().insert(header::AUTHORIZATION, value);
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let connector = Connector::Rustls(Arc::clone(&self.tls));
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
                StatusCode::NOT_FOUND => DialError::NotFound,
                StatusCode::UNAUTHORIZED => DialError::Refused,
                status => DialError::Unreachable(format!("the host answered {status}")),
            }),
            Err(e) => Err(DialError::Unreachable(plain(&e))),
        }
    }
}

/// the daemon's http(s) url as the ws(s) url of the same place.
fn websocket_url(url: &Url) -> Result<Url, DialError> {
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
pub fn plain(error: &WsError) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_daemon_url_becomes_the_same_place_over_websocket() {
        let at = |base: &str| {
            let url = route_url(&Url::parse(base).unwrap(), "/pty/pty_1/connect?cursor=42");
            websocket_url(&url).unwrap().to_string()
        };
        assert_eq!(
            at("http://127.0.0.1:4890"),
            "ws://127.0.0.1:4890/pty/pty_1/connect?cursor=42"
        );
        assert_eq!(
            at("https://vm.example/cmx2/"),
            "wss://vm.example/cmx2/pty/pty_1/connect?cursor=42"
        );
        let ftp = Url::parse("ftp://example/pty").unwrap();
        assert!(websocket_url(&ftp).is_err());
    }

    #[test]
    fn the_tls_settings_build_with_the_platform_verifier() {
        assert!(Dialer::new().is_ok());
    }
}
