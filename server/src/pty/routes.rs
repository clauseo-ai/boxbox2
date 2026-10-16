//! the terminal routes. the rest ones are the host's `/pty` api read
//! through the server, behind the gate, with the host's credential added
//! here; bodies from the host pass through byte for byte. `connect`
//! upgrades to a websocket and starts a relay.

use std::sync::Arc;

use axum::Json;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, header};
use axum::response::Response;
use serde::Deserialize;
use tracing::info;
use utoipa::{IntoParams, ToSchema};

use super::relay::{CAP, Relay, Target};
use super::telemetry::Stamp;
use crate::cmx2::{CreatePtyBody, CreatePtyBodyOrigin, UpdatePtyBody, UpdatePtyBodySize};
use crate::http::error::{ApiError, ErrorBody};
use crate::http::{AppState, agents};
#[cfg(test)]
use crate::source::cmx2::verbs::pty::host_message;
use crate::wire::Capability;
#[cfg(test)]
use axum::http::HeaderValue;
/// rows and columns a terminal may be resized to; a phone is about 45 by
/// 20, a wide monitor under 400 by 120.
const MAX_SIZE: u16 = 1000;

/// a new terminal. with no command it is the host's login shell.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct NewTerminal {
    /// a program to run instead of the login shell, such as another
    /// shell's path from `/shells`.
    pub command: Option<String>,
    /// its arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// where it starts; the host's home when absent.
    pub cwd: Option<String>,
    pub title: Option<String>,
}

/// a rename, a resize, or both.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TerminalChange {
    pub title: Option<String>,
    pub size: Option<TerminalSize>,
}

#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TerminalSize {
    /// 1 to 1000.
    pub rows: u16,
    /// 1 to 1000.
    pub cols: u16,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ConnectQuery {
    /// resume from here, in utf-16 units: the cursor of the last output
    /// applied. `-1` is from now on; absent replays everything retained.
    cursor: Option<i64>,
    /// the pane's device id, for the relay's telemetry rows.
    device: Option<String>,
    /// the pane's device class, for the same.
    class: Option<String>,
}

/// the host's open terminals: running ones, and exited ones a session
/// started (cmx2 drops a person's once it exits).
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/pty",
    operation_id = "terminals",
    params(("host" = String, Path, description = "the host's name in boxbox.toml")),
    responses(
        (status = 200, description = "cmx2's `PtyInfo` list, byte for byte", body = [Object]),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer or refused the credential", body = ErrorBody),
    ),
)]
pub async fn list(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
) -> Result<Response, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Terminal))?;
    source.terminals_raw().await
}

/// the login shells the host lists, the host user's own first.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/pty/shells",
    operation_id = "terminalShells",
    params(("host" = String, Path, description = "the host's name in boxbox.toml")),
    responses(
        (status = 200, description = "cmx2's `{path, name, acceptable}` list, byte for byte", body = [Object]),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer or refused the credential", body = ErrorBody),
    ),
)]
pub async fn shells(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
) -> Result<Response, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Terminal))?;
    source.terminal_shells_raw().await
}

/// opens a terminal on the host, as a person's (it goes when it exits).
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/pty",
    operation_id = "createTerminal",
    params(("host" = String, Path, description = "the host's name in boxbox.toml")),
    request_body = NewTerminal,
    responses(
        (status = 200, description = "the new terminal, cmx2's `PtyInfo`", body = Object),
        (status = 400, description = "not a new terminal, or the directory does not exist", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer or refused the credential", body = ErrorBody),
    ),
)]
pub async fn create(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
    Json(new): Json<NewTerminal>,
) -> Result<Response, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Terminal))?;
    let body = CreatePtyBody {
        command: new.command.filter(|c| !c.trim().is_empty()),
        args: new.args,
        cwd: new.cwd.filter(|c| !c.trim().is_empty()),
        title: new.title.filter(|t| !t.trim().is_empty()),
        origin: Some(CreatePtyBodyOrigin::Tui),
        ..CreatePtyBody::default()
    };
    source.create_terminal_raw(to_json(&body)?).await
}

/// one terminal.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/pty/{id}",
    operation_id = "terminal",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("id" = String, Path, description = "the terminal's id on the host"),
    ),
    responses(
        (status = 200, description = "cmx2's `PtyInfo`", body = Object),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host or terminal", body = ErrorBody),
        (status = 502, description = "the host did not answer or refused the credential", body = ErrorBody),
    ),
)]
pub async fn one(
    State(state): State<Arc<AppState>>,
    Path((host, id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Terminal))?;
    let id = terminal_id(&id)?;
    source.terminal_raw(id).await
}

/// renames or resizes a terminal.
#[utoipa::path(
    put,
    path = "/api/hosts/{host}/pty/{id}",
    operation_id = "changeTerminal",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("id" = String, Path, description = "the terminal's id on the host"),
    ),
    request_body = TerminalChange,
    responses(
        (status = 200, description = "the terminal after the change, cmx2's `PtyInfo`", body = Object),
        (status = 400, description = "not a change, or a size out of range", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host or terminal", body = ErrorBody),
        (status = 502, description = "the host did not answer or refused the credential", body = ErrorBody),
    ),
)]
pub async fn update(
    State(state): State<Arc<AppState>>,
    Path((host, id)): Path<(String, String)>,
    Json(change): Json<TerminalChange>,
) -> Result<Response, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Terminal))?;
    let id = terminal_id(&id)?;
    let size = change.size.map(size).transpose()?;
    let title = change.title.filter(|t| !t.trim().is_empty());
    if size.is_none() && title.is_none() {
        return Err(ApiError::BadRequest("send a title, a size, or both".into()));
    }
    let body = UpdatePtyBody { size, title };
    source.change_terminal_raw(id, to_json(&body)?).await
}

/// kills a terminal and has the host forget it.
#[utoipa::path(
    delete,
    path = "/api/hosts/{host}/pty/{id}",
    operation_id = "killTerminal",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("id" = String, Path, description = "the terminal's id on the host"),
    ),
    responses(
        (status = 200, description = "`true`: killed, or already gone", body = bool),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer or refused the credential", body = ErrorBody),
    ),
)]
pub async fn kill(
    State(state): State<Arc<AppState>>,
    Path((host, id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Terminal))?;
    let id = terminal_id(&id)?;
    source.kill_terminal_raw(id).await
}

/// the terminal's bytes, as a websocket: cmx2's pty stream relayed, plus
/// the relay's replay and heartbeat frames (docs/terminal.md).
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/pty/{id}/connect",
    operation_id = "connectTerminal",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("id" = String, Path, description = "the terminal's id on the host"),
        ConnectQuery,
    ),
    responses(
        (status = 101, description = "the websocket; every later outcome is a close code (docs/terminal.md)"),
        (status = 400, description = "not a websocket request, or a cursor below -1", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 403, description = "the page asking is not boxbox's", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
    ),
)]
pub async fn connect(
    State(state): State<Arc<AppState>>,
    Path((host, id)): Path<(String, String)>,
    Query(query): Query<ConnectQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    same_origin(&headers)?;
    let source = agents::cmx2(&state, &host, Some(Capability::Terminal))?;
    let pty = terminal_id(&id)?.to_owned();
    if query.cursor.is_some_and(|c| c < -1) {
        return Err(ApiError::BadRequest("the cursor is -1 or more".into()));
    }
    let relay = Relay {
        stamp: Stamp::new(
            query.device.as_deref(),
            query.class.as_deref(),
            source.name(),
        ),
        target: Target { source, pty },
        dialer: state.terminals.dialer.clone(),
        telemetry: state.telemetry.clone(),
        shutdown: state.shutdown.clone(),
        id: format!("{:08x}", rand::random::<u32>()),
    };
    info!(
        relay = %relay.id,
        host = %relay.target.source.name(),
        pty = %relay.target.pty,
        cursor = query.cursor.unwrap_or(-2),
        "terminal connect"
    );
    let relays = state.terminals.relays.clone();
    let cursor = query.cursor;
    Ok(upgrade
        .max_message_size(CAP)
        .max_frame_size(CAP)
        .on_upgrade(move |socket| relays.track_future(relay.run(socket, cursor))))
}

/// a browser sends the page's origin with every websocket request, and
/// cookies ride along even when another site opens it. a request whose
/// origin is not the host it was sent to is refused (a cookie with
/// `SameSite=Lax` already keeps other sites out; this does not rely on it).
fn same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        // not a browser: the board, a script, the tests
        return Ok(());
    };
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
    let origin_host = origin
        .to_str()
        .ok()
        .and_then(|o| o.split_once("://"))
        .map(|(_, rest)| rest.trim_end_matches('/'));
    match (origin_host, host) {
        (Some(from), Some(to)) if from.eq_ignore_ascii_case(to) => Ok(()),
        _ => Err(ApiError::ForeignOrigin),
    }
}

fn size(size: TerminalSize) -> Result<UpdatePtyBodySize, ApiError> {
    let fits = |n: u16| (1..=MAX_SIZE).contains(&n);
    if !fits(size.rows) || !fits(size.cols) {
        return Err(ApiError::BadRequest(format!(
            "a terminal is 1 to {MAX_SIZE} rows and columns, not {} by {}",
            size.cols, size.rows
        )));
    }
    let nonzero = |n: u16| std::num::NonZeroU64::new(u64::from(n));
    match (nonzero(size.rows), nonzero(size.cols)) {
        (Some(rows), Some(cols)) => Ok(UpdatePtyBodySize { rows, cols }),
        _ => Err(ApiError::BadRequest(
            "a terminal has at least one row and column".into(),
        )),
    }
}

fn to_json(body: &impl serde::Serialize) -> Result<Vec<u8>, ApiError> {
    serde_json::to_vec(body)
        .map_err(|e| ApiError::BadRequest(format!("the body did not serialize: {e}")))
}

/// a terminal id as one path segment; anything that could step out of it
/// is refused.
fn terminal_id(id: &str) -> Result<&str, ApiError> {
    let fits = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if fits {
        Ok(id)
    } else {
        Err(ApiError::BadRequest(format!(
            "\"{id}\" is not a terminal id"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_id_is_a_terminal_id() {
        assert!(terminal_id("pty_98e744eb52534d93").is_ok());
        for bad in ["", "..", "a/b", "a?b", "a.b", "a%2fb", &"x".repeat(129)] {
            assert!(terminal_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_size_is_one_to_a_thousand_each_way() {
        assert!(size(TerminalSize { rows: 24, cols: 80 }).is_ok());
        assert!(size(TerminalSize { rows: 0, cols: 80 }).is_err());
        assert!(
            size(TerminalSize {
                rows: 24,
                cols: 1001
            })
            .is_err()
        );
    }

    #[test]
    fn a_websocket_from_another_origin_is_refused() {
        let with = |origin: Option<&str>, host: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
            if let Some(origin) = origin {
                headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            }
            same_origin(&headers).is_ok()
        };
        assert!(with(Some("http://127.0.0.1:3031"), "127.0.0.1:3031"));
        assert!(with(Some("https://vm.tail.ts.net"), "vm.tail.ts.net"));
        assert!(with(None, "127.0.0.1:3031"), "no origin: not a browser");
        assert!(!with(Some("https://evil.example"), "vm.tail.ts.net"));
        assert!(!with(Some("null"), "vm.tail.ts.net"));
    }

    #[test]
    fn the_hosts_error_message_is_read_from_its_body() {
        let body =
            br#"{"name":"BadRequestError","data":{"message":"directory /nope does not exist"}}"#;
        assert_eq!(
            host_message(body).as_deref(),
            Some("directory /nope does not exist")
        );
        assert_eq!(host_message(b"<html>"), None);
    }
}
