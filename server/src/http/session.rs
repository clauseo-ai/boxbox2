//! the session routes that pass the daemon's answer through: a queued
//! prompt, run now, an unsend, and the composer's providers and file
//! search, read through the server with the host's credential added here
//! (docs/thread.md, routes). what the composer sends that boxbox shapes or
//! arms for push (a steer, a slash command, a shell line, a new thread) is
//! `compose.rs`; a prompt and a stop are m4's, in `asks.rs`.
//!
//! every send carries a `clientID` the client picks (cmx2-asks a4): the
//! daemon answers a repeat with the first answer and does nothing, and the
//! stream's message for it carries the same id, which is how the composer
//! knows its send landed. the daemon's answer passes through with its
//! status and body byte for byte, refusals included (a 409 for a settled
//! ask carries who settled it, a6); only a host that cannot be reached, or
//! one that refuses boxbox's credential, answers in boxbox's own shape.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::agents;
use super::error::{ApiError, ErrorBody};
use crate::wire::Capability;

/// a send with a few clamped photos; the router's default is too small for one.
pub const SEND_BODY: usize = 8 * 1024 * 1024;
/// how many attachments one send may carry.
const MAX_PARTS: usize = 8;

/// a prompt, a queued prompt or a steer: what the person typed, with what
/// they attached and the model and effort they chose for it.
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Send {
    /// a uuid the client picks and keeps for a retry, so a flaky network
    /// cannot double a prompt (cmx2-asks a4).
    #[serde(rename = "clientID")]
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// attachments: a photo or document as a data url, or an `@` mention as a file url.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<SendPart>>,
    /// the model for this message; the session's default when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// the effort for this message: low, medium, high, xhigh or max.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// an agent to address, by name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

/// one attachment of a send.
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SendPart {
    /// `text` or `file`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// a `data:` url for a photo or document, a `file://` url for a mention.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// a model, as cmx2 names one.
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

#[derive(Debug, Deserialize, IntoParams)]
// query parameters, not path ones: without this the document puts them in the path and the typed client cannot call it
#[into_params(parameter_in = Query)]
pub struct Scope {
    /// the project directory the list is for.
    directory: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
// query parameters, not path ones: without this the document puts them in the path and the typed client cannot call it
#[into_params(parameter_in = Query)]
pub struct FileQuery {
    /// what the person typed after `@`.
    query: Option<String>,
    /// the project directory to search.
    directory: Option<String>,
    /// at most this many, 1 to 200; the daemon's default is 10.
    limit: Option<u32>,
}

macro_rules! send_route {
    ($name:ident, $route:literal, $doc:literal, $verb:ident) => {
        #[doc = $doc]
        #[utoipa::path(
            post,
            path = $route,
            request_body = Send,
            params(
                ("host" = String, Path, description = "the host's name in boxbox.toml"),
                ("session" = String, Path, description = "the daemon's session id"),
            ),
            responses(
                (status = 202, description = "accepted: cmx2's answer, byte for byte, with `messageID`", body = Object),
                (status = 400, description = "the send was malformed", body = ErrorBody),
                (status = 401, description = "not signed in", body = ErrorBody),
                (status = 404, description = "no such host or session", body = ErrorBody),
                (status = 409, description = "the daemon refused it: cmx2's `{name, data}`", body = Object),
                (status = 502, description = "the host did not answer", body = ErrorBody),
            ),
        )]
        pub async fn $name(
            State(state): State<Arc<AppState>>,
            Path((host, session)): Path<(String, String)>,
            Json(send): Json<Send>,
        ) -> Result<Response, ApiError> {
            check_send(&send)?;
            let session = segment(&session)?;
            let source = agents::cmx2(&state, &host, Some(Capability::Queue))?;
            source.$verb(session, to_json(&send)?).await
        }
    };
}

send_route!(
    queue,
    "/api/hosts/{host}/sessions/{session}/queue",
    "a prompt for after the running turn; on an idle session it starts one.",
    queue_raw
);

/// runs what is queued now, on an idle session ("run now" after a stop).
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/loop",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
    ),
    responses(
        (status = 200, description = "started", body = Object),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host or session", body = ErrorBody),
        (status = 409, description = "a turn is running", body = Object),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn run_now(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let session = segment(&session)?;
    let source = agents::cmx2(&state, &host, Some(Capability::Queue))?;
    source.run_now_raw(session).await
}

/// takes back a queued prompt before the model sees it ("unsend").
#[utoipa::path(
    delete,
    path = "/api/hosts/{host}/sessions/{session}/messages/{message}",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        ("session" = String, Path, description = "the daemon's session id"),
        ("message" = String, Path, description = "the queued message's id"),
    ),
    responses(
        (status = 200, description = "taken back", body = Object),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host, session or queued message", body = ErrorBody),
        (status = 409, description = "the model already has it", body = Object),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn unsend(
    State(state): State<Arc<AppState>>,
    Path((host, session, message)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let (session, message) = (segment(&session)?, segment(&message)?);
    let source = agents::cmx2(&state, &host, Some(Capability::Queue))?;
    source.unsend_raw(session, message).await
}

/// the host's providers and models, and its defaults, for the composer's
/// model and effort row.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/providers",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        Scope,
    ),
    responses(
        (status = 200, description = "cmx2's `{providers, default}`, byte for byte", body = Object),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn providers(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
    Query(scope): Query<Scope>,
) -> Result<Response, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Model))?;
    source.providers_raw(scope.directory.as_deref()).await
}

/// files in a project matching what was typed after `@`, relative paths.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/find/file",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        FileQuery,
    ),
    responses(
        (status = 200, description = "cmx2's paths, byte for byte", body = [String]),
        (status = 400, description = "malformed", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn find_file(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
    Query(find): Query<FileQuery>,
) -> Result<Response, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Files))?;
    let mut query = Vec::new();
    if let Some(q) = find.query.as_deref().filter(|q| !q.is_empty()) {
        query.push(format!("query={}", urlencode(q)));
    }
    if let Some(limit) = find.limit {
        if !(1..=200).contains(&limit) {
            return Err(ApiError::BadRequest("limit is 1 to 200".into()));
        }
        query.push(format!("limit={limit}"));
    }
    source
        .find_file_raw(&query, find.directory.as_deref())
        .await
}

fn check_send(send: &Send) -> Result<(), ApiError> {
    check_client_id(&send.client_id)?;
    let text = send.text.as_deref().unwrap_or("");
    let parts = send.parts.as_deref().unwrap_or(&[]);
    if text.trim().is_empty() && parts.is_empty() {
        return Err(ApiError::BadRequest(
            "a send needs words or an attachment".into(),
        ));
    }
    if text.len() > 512 * 1024 {
        return Err(ApiError::BadRequest(
            "a send is at most 512 kb of text".into(),
        ));
    }
    if parts.len() > MAX_PARTS {
        return Err(ApiError::BadRequest(format!(
            "a send carries at most {MAX_PARTS} attachments"
        )));
    }
    for part in parts {
        match part.kind.as_str() {
            "text" => {
                if part.text.is_none() {
                    return Err(ApiError::BadRequest("a text part needs text".into()));
                }
            }
            "file" => {
                let url = part.url.as_deref().unwrap_or("");
                if !(url.starts_with("data:") || url.starts_with("file://")) {
                    return Err(ApiError::BadRequest(
                        "a file part is a data url or a file url".into(),
                    ));
                }
            }
            other => {
                return Err(ApiError::BadRequest(format!(
                    "\"{other}\" is not a part type"
                )));
            }
        }
    }
    if send
        .effort
        .as_deref()
        .is_some_and(|effort| !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max"))
    {
        return Err(ApiError::BadRequest(
            "effort is low, medium, high, xhigh or max".into(),
        ));
    }
    Ok(())
}

/// the id a client picked: a uuid or anything as plain, 8 to 64 characters.
fn check_client_id(id: &str) -> Result<(), ApiError> {
    let fits = (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if fits {
        Ok(())
    } else {
        Err(ApiError::BadRequest(
            "clientID is 8 to 64 letters, digits, dashes or underscores".into(),
        ))
    }
}

/// a daemon id as one path segment; anything that could step out of it is refused.
fn segment(id: &str) -> Result<&str, ApiError> {
    let fits = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.');
    if fits && id != "." && id != ".." {
        Ok(id)
    } else {
        Err(ApiError::BadRequest(format!("\"{id}\" is not an id")))
    }
}

fn to_json(body: &impl Serialize) -> Result<Vec<u8>, ApiError> {
    serde_json::to_vec(body)
        .map_err(|e| ApiError::BadRequest(format!("the body did not serialize: {e}")))
}

/// the query form of what was typed: letters and digits as they are, the rest as bytes.
pub(crate) fn urlencode(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(char::from(b));
            }
            // writing into a string cannot fail
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_send_needs_words_or_an_attachment_and_a_plain_client_id() {
        let ok = Send {
            client_id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0".into(),
            text: Some("hello".into()),
            parts: None,
            model: None,
            effort: None,
            agent: None,
        };
        assert!(check_send(&ok).is_ok());
        let empty = Send {
            text: Some("  ".into()),
            ..ok
        };
        assert!(check_send(&empty).is_err());
        assert!(check_client_id("short").is_err());
        assert!(check_client_id("has space 12345").is_err());
    }

    #[test]
    fn a_file_part_is_a_data_or_file_url() {
        let part = |url: &str| SendPart {
            kind: "file".into(),
            text: None,
            mime: None,
            filename: None,
            url: Some(url.into()),
        };
        let with = |p: SendPart| Send {
            client_id: "abcdefgh".into(),
            text: None,
            parts: Some(vec![p]),
            model: None,
            effort: None,
            agent: None,
        };
        assert!(check_send(&with(part("data:image/jpeg;base64,AAAA"))).is_ok());
        assert!(check_send(&with(part("file:///home/dev/code/x.ts"))).is_ok());
        assert!(check_send(&with(part("https://example.com/x"))).is_err());
    }

    #[test]
    fn what_was_typed_after_at_survives_the_query() {
        assert_eq!(urlencode("src/x y.ts"), "src%2Fx%20y.ts");
        assert_eq!(urlencode("plain-name_1.ts"), "plain-name_1.ts");
    }

    #[test]
    fn the_daemon_body_uses_the_daemon_names() {
        let send = Send {
            client_id: "abcdefgh".into(),
            text: Some("hi".into()),
            parts: None,
            model: Some(ModelRef {
                provider_id: "anthropic".into(),
                model_id: "claude".into(),
            }),
            effort: Some("high".into()),
            agent: None,
        };
        let json = String::from_utf8(to_json(&send).unwrap()).unwrap();
        assert!(json.contains("\"clientID\":\"abcdefgh\""));
        assert!(json.contains("\"providerID\":\"anthropic\""));
        assert!(!json.contains("\"parts\""));
    }
}
