//! dialling a host's pty websocket: `ws(s)://<daemon>/pty/:id/connect`,
//! with the host's credential added here, since it never leaves the
//! server, and the answer sorted into what the relay does next. the dial
//! itself is the cmx2 source's (`source/cmx2/verbs/pty.rs`); this holds the
//! tls settings every dial shares.

use std::sync::Arc;

use crate::source::cmx2::Cmx2Source;
#[cfg(test)]
use crate::source::cmx2::verbs::pty::websocket_url;
pub use crate::source::cmx2::verbs::pty::{DialError, Socket, ws_plain as plain};
#[cfg(test)]
use crate::upstream::route_url;
#[cfg(test)]
use reqwest::Url;

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

    /// opens terminal `pty` of `source` from `cursor` (`None`: replay
    /// everything retained).
    ///
    /// # Errors
    /// the host does not know the terminal, refused the credential, or
    /// could not be reached; each in words a person can act on.
    pub async fn dial(
        &self,
        source: &Cmx2Source,
        pty: &str,
        cursor: Option<i64>,
    ) -> Result<Socket, DialError> {
        source.dial_terminal(&self.tls, pty, cursor).await
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
