//! every error a route returns, and the one place each becomes a status
//! and a body. messages follow the voice: what happened, what to do.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("sign in first")]
    SignInFirst,
    #[error("wrong password")]
    WrongPassword,
    #[error("{0}")]
    BadRequest(String),
    #[error("{got} events in one batch; send at most {max}")]
    BatchTooLarge { got: usize, max: usize },
    #[error("telemetry is backed up; send the batch again in a moment")]
    TelemetryBusy,
    #[error("the server's store is not answering; try again in a moment")]
    StoreDown,
    #[error("no such route")]
    NotFound,
    #[error(
        "the app is not built into this server: run `just build`, or `just dev` for the dev server"
    )]
    AppMissing,
    #[error("the vite dev server is not answering: {0}")]
    ViteDown(String),
    #[error("no machine named \"{0}\"")]
    UnknownHost(String),
    #[error("a machine named \"{0}\" is already here. give this one another name")]
    HostTaken(String),
    #[error("\"{0}\" already watches that address")]
    AddressTaken(String),
    #[error("\"{0}\" is set in boxbox.toml. remove it there")]
    ConfiguredHost(String),
    #[error(
        "the daemon refused that token: it was used already or its 10 minutes ran out. run cmx2 pair on that machine again and paste the new one"
    )]
    PairRefused,
    #[error(
        "{0} does not pair: it runs a cmx2 older than 0.8. update it, or add it to boxbox.toml with its password"
    )]
    PairUnsupported(String),
    #[error(
        "cannot reach {url} ({reason}). check the address, and that the daemon listens beyond its own machine"
    )]
    PairUnreachable { url: String, reason: String },
    #[error("pairing failed: {0}")]
    PairFailed(String),
    #[error("the host \"{host}\" failed: {detail}")]
    HostFailed { host: String, detail: String },
    #[error(
        "the host \"{0}\" no longer accepts boxbox's credential. forget it here, then pair it again"
    )]
    CredentialRevoked(String),
    #[error("the host \"{host}\" did not answer ({reason}). check its daemon is running")]
    HostUnreachable { host: String, reason: String },
    #[error("the host \"{0}\" refused boxbox's credential; check its password in boxbox.toml")]
    HostRefused(String),
    #[error("no terminal {0} on this host; it may have exited")]
    NoSuchTerminal(String),
    #[error("this request came from a page that is not boxbox; open boxbox itself")]
    ForeignOrigin,
    #[error("the server is stopping; try again in a moment")]
    Stopping,
    #[error("other photos kept boxbox busy for two minutes, so it could not take this message")]
    PhotosBusy,
    #[error("this message is bigger than boxbox takes. send fewer or smaller photos")]
    MessageTooLarge,
    #[error("that thread is not on {} any more. it may have been archived", machine_of(.0))]
    NoSuchSession(String),
    #[error("this is gone: it was answered, or its turn ended")]
    Gone,
    #[error("already answered on {by}")]
    Settled { by: String, at: Option<i64> },
    #[error("already sent: the agent has it, so it cannot be taken back")]
    AlreadySent,
    #[error("the host \"{host}\" refused it: {message}")]
    HostSaid {
        host: String,
        status: u16,
        message: String,
    },
    #[error("that checkout is not on {0} any more. it may have been merged or discarded already")]
    NoSuchCheckout(String),
    /// a checkout's merge or discard the daemon refused with a 409: the body is the
    /// flat `CheckoutRefusal`, not `ErrorBody`, so a card can switch on `error` and read the files.
    #[error("{}", .0.message)]
    CheckoutRefused(CheckoutRefusal),
}

/// why the daemon would not merge or discard a checkout, as the review card reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct CheckoutRefusal {
    /// `busy` (a turn runs in the checkout), `conflict` (the branch conflicts with its
    /// base) or `refused` (see `reason`).
    pub error: RefusalKind,
    /// the daemon's words.
    pub message: String,
    /// on `conflict`: the files that conflict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    /// on `refused`: `dirty`, `nothing`, `detached` or `target_dirty`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RefusalKind {
    Busy,
    Conflict,
    Refused,
}

impl RefusalKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Conflict => "conflict",
            Self::Refused => "refused",
        }
    }
}

/// the body of every error answer.
#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorDetail {
    /// stable, for code: `sign-in`, `wrong-password`, `bad-request`,
    /// `batch-too-large`, `busy`, `store-down`, `not-found`, `app-missing`,
    /// `vite-down`, `unknown-host`, `host-taken`, `address-taken`,
    /// `configured-host`, `pair-refused`, `pair-unsupported`,
    /// `pair-unreachable`, `pair-failed`, `host-failed`,
    /// `credential-revoked`, `host-unreachable`, `host-refused`,
    /// `no-such-terminal`, `foreign-origin`, `stopping`, `no-such-session`,
    /// `gone`, `settled`, `already-sent`, `host-said`, `no-such-checkout`,
    /// `checkout-refused` (whose body is a `CheckoutRefusal`, not this one).
    pub code: &'static str,
    /// for people, in the interface's voice.
    pub message: String,
    /// on `settled`: who answered first, and when.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled: Option<SettledBy>,
}

/// who settled an ask first, as the daemon says (cmx2 a6).
#[derive(Debug, Serialize, ToSchema)]
pub struct SettledBy {
    /// the device class or client that answered ("iphone", "mac").
    pub by: String,
    /// when, ms since the epoch; null when the daemon did not say.
    pub at: Option<i64>,
}

/// the machine a `host:session` key names, for words a person reads.
fn machine_of(key: &str) -> &str {
    key.split_once(':').map_or(key, |(host, _)| host)
}

impl ApiError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::SignInFirst => (StatusCode::UNAUTHORIZED, "sign-in"),
            Self::WrongPassword => (StatusCode::UNAUTHORIZED, "wrong-password"),
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad-request"),
            Self::BatchTooLarge { .. } => (StatusCode::PAYLOAD_TOO_LARGE, "batch-too-large"),
            Self::MessageTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "message-too-large"),
            Self::TelemetryBusy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Self::PhotosBusy => (StatusCode::SERVICE_UNAVAILABLE, "photos-busy"),
            Self::StoreDown => (StatusCode::SERVICE_UNAVAILABLE, "store-down"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not-found"),
            Self::AppMissing => (StatusCode::NOT_FOUND, "app-missing"),
            Self::ViteDown(_) => (StatusCode::BAD_GATEWAY, "vite-down"),
            Self::UnknownHost(_) => (StatusCode::NOT_FOUND, "unknown-host"),
            Self::HostTaken(_) => (StatusCode::CONFLICT, "host-taken"),
            Self::AddressTaken(_) => (StatusCode::CONFLICT, "address-taken"),
            Self::ConfiguredHost(_) => (StatusCode::CONFLICT, "configured-host"),
            Self::PairRefused => (StatusCode::UNPROCESSABLE_ENTITY, "pair-refused"),
            Self::PairUnsupported(_) => (StatusCode::UNPROCESSABLE_ENTITY, "pair-unsupported"),
            Self::PairUnreachable { .. } => (StatusCode::BAD_GATEWAY, "pair-unreachable"),
            Self::PairFailed(_) => (StatusCode::BAD_GATEWAY, "pair-failed"),
            Self::HostFailed { .. } => (StatusCode::BAD_GATEWAY, "host-failed"),
            Self::CredentialRevoked(_) => (StatusCode::BAD_GATEWAY, "credential-revoked"),
            Self::HostUnreachable { .. } => (StatusCode::BAD_GATEWAY, "host-unreachable"),
            Self::HostRefused(_) => (StatusCode::BAD_GATEWAY, "host-refused"),
            Self::NoSuchTerminal(_) => (StatusCode::NOT_FOUND, "no-such-terminal"),
            Self::ForeignOrigin => (StatusCode::FORBIDDEN, "foreign-origin"),
            Self::Stopping => (StatusCode::SERVICE_UNAVAILABLE, "stopping"),
            Self::NoSuchSession(_) => (StatusCode::NOT_FOUND, "no-such-session"),
            Self::Gone => (StatusCode::NOT_FOUND, "gone"),
            Self::Settled { .. } => (StatusCode::CONFLICT, "settled"),
            Self::AlreadySent => (StatusCode::CONFLICT, "already-sent"),
            // a daemon's own refusal (its 4xx) is an answer about the request, never a failure to reach it: a client
            // must not retry it. only a daemon that failed itself (its 5xx) is the gateway's trouble
            Self::HostSaid { status, .. } if (400..500).contains(status) => {
                (StatusCode::UNPROCESSABLE_ENTITY, "host-said")
            }
            Self::HostSaid { .. } => (StatusCode::BAD_GATEWAY, "host-said"),
            Self::NoSuchCheckout(_) => (StatusCode::NOT_FOUND, "no-such-checkout"),
            Self::CheckoutRefused(_) => (StatusCode::CONFLICT, "checkout-refused"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        if let Self::CheckoutRefused(refusal) = self {
            return (status, Json(refusal)).into_response();
        }
        let settled = match &self {
            Self::Settled { by, at } => Some(SettledBy {
                by: by.clone(),
                at: *at,
            }),
            _ => None,
        };
        let body = ErrorBody {
            error: ErrorDetail {
                code,
                message: self.to_string(),
                settled,
            },
        };
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(status: u16) -> ApiError {
        ApiError::HostSaid {
            host: "desk".into(),
            status,
            message: "directory /x does not exist".into(),
        }
    }

    #[test]
    fn a_daemons_refusal_is_422_so_a_client_never_retries_it() {
        for status in [400, 403, 409, 422] {
            assert_eq!(
                said(status).status_and_code().0,
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }

    #[test]
    fn a_daemon_that_failed_itself_is_still_a_bad_gateway() {
        for status in [500, 503] {
            assert_eq!(said(status).status_and_code().0, StatusCode::BAD_GATEWAY);
        }
    }

    #[test]
    fn a_refusal_reads_in_the_voice_without_its_status() {
        let text = said(400).to_string();
        assert!(!text.contains("400") && !text.contains("said no"), "{text}");
        assert!(text.contains("does not exist"), "{text}");
    }
}
