//! the composer's verbs that boxbox shapes (docs/composer.md, the wire):
//! steering a running turn, a `!` line, a `/` command, the command and repo
//! lists the menus draw from, and a new thread in a repo. a steer, a command
//! and a new thread arm their turn for the device that sent them, so its
//! "done" can push. the passthroughs (a queued prompt, run now, an unsend,
//! providers, file search) are `session.rs`. every verb carries the device's
//! `clientID` to the daemon, so a retry acts once (cmx2 a4); the composer
//! settles a send on the daemon's echo of that id, never on these answers.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::info;
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::asks::{
    Done, answer_review, client_id, device_of, post_body, segment, upstream, upstream_within,
};
use super::error::{ApiError, ErrorBody};
use super::session::urlencode;
use crate::fleet::model::session_key;

/// a prompt's text, at most.
const MAX_TEXT: usize = 100_000;
/// photos on one message. the composer clamps to this before it sends.
const MAX_PHOTOS: usize = 4;
/// one resized photo's `data:` url, at most. the composer resizes a photo to 1568 px on its long side as jpeg,
/// which lands well under this; a larger one was not resized and is refused rather than relayed.
const MAX_PHOTO: usize = 1536 * 1024;
/// one heic or heif photo's file, at most: the original bytes of a photo a browser cannot decode (chrome and
/// firefox), which cmx2 converts to jpeg on the host. a phone's heic is 2 to 5 MB and a 48 mp one up to about
/// 9, and a model reads such a photo at 1568 px whatever its size, so the limit buys originals and nothing
/// more. it is the size the person sees in their files, and a photo past it is refused in words they can act
/// on (the size and what to do), never relayed.
const MAX_HEIC_FILE: usize = 9 * 1024 * 1024;
/// that file as a `data:` url: base64 is four characters for every three bytes, and the head
/// (`data:image/heic;base64,`, the same 23 characters for heif) comes before it.
const MAX_HEIC: usize = 12 * 1024 * 1024 + 23;
/// every photo of one message together, as data urls (18 MiB of files): two photos at the heic limit fit
/// and a third does not; four resized jpegs (6 MiB) always do. it is also what bounds the body the routes
/// take and the bytes the outbox holds per message (the composer's `MAX_MESSAGE_URL`).
const MAX_PHOTOS_TOTAL: usize = 24 * 1024 * 1024 + 46;
/// the kinds cmx2 converts on the host before a model reads them.
const CONVERTED_KINDS: [&str; 2] = ["image/heic", "image/heif"];
/// the kinds a model reads, and the ones cmx2 turns into one; anything else the daemon would turn into
/// a placeholder.
const PHOTO_KINDS: [&str; 6] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
];
/// how long a daemon may take to take a message, whatever it carries.
const ACCEPT_BASE: Duration = Duration::from_secs(15);
/// cmx2 converts each heic or heif before it answers, and gives one 60 s in all (each converter gets what is
/// left of it, 45 s at most); 15 s more is the margin for a host busy with something else.
const ACCEPT_PER_CONVERTED: Duration = Duration::from_secs(75);
/// the slowest link a photo is allowed to cross to a host: 256 KiB a second, about 2 mbit. a host
/// beyond a vpn is not on a faster one than the phone's.
const ACCEPT_BYTES_PER_SECOND: usize = 256 * 1024;
/// cmx2's own effort names; any other variant goes by its name.
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// how long a read for a menu may take; the menu says so when it does not come.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// a `!` line runs to the end before the daemon answers; its own limit is 600 s.
const SHELL_TIMEOUT: Duration = Duration::from_secs(610);
/// making a fresh worktree copies the checkout before it answers.
const BIRTH_TIMEOUT: Duration = Duration::from_secs(60);
/// new threads remembered by client id, so a retried birth returns the first thread instead of making
/// a second. the composer retries for at most a few minutes; 64 covers any burst a person can make.
const BIRTHS_KEPT: usize = 64;

/// a photo on a message.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Photo {
    /// `image/png`, `image/jpeg`, `image/webp`, `image/gif`, or `image/heic` or `image/heif` (the
    /// original of a photo the browser could not decode; the host converts it to jpeg).
    pub mime: String,
    pub filename: Option<String>,
    /// `data:<mime>;base64,...`: at most 1.5 mb, or for heic and heif a file of at most 9 mb; the photos of
    /// one message at most 18 mb of files together.
    pub url: String,
}

/// text with photos, steered into the running turn.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Steer {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub text: String,
    #[serde(default)]
    pub photos: Vec<Photo>,
}

/// a `!` line.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shell {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    /// the line, without its `!`.
    pub command: String,
}

/// a `/` command and what was typed after its name.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlashCommand {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    /// the name, without its `/`.
    pub command: String,
    pub arguments: Option<String>,
}

/// where a new thread runs.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Place {
    /// the repo's own checkout.
    Checkout,
    /// a new branch in a worktree of its own (`/experimental/worktree`).
    Fresh,
}

/// a new thread in a repo, with its first message.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewThread {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    /// the repo's directory on the host.
    pub directory: String,
    pub place: Place,
    pub text: String,
    #[serde(default)]
    pub photos: Vec<Photo>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// the thread a birth made.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Born {
    /// the new session's id; with the host it is the thread's key.
    pub session: String,
    /// where it runs: the checkout, or the fresh worktree.
    pub directory: String,
    /// true when this answers a retry of a birth already made.
    pub repeat: bool,
}

/// the births the server remembers by client id, oldest first, at most `BIRTHS_KEPT`.
#[derive(Debug, Default)]
pub struct Births(Mutex<VecDeque<(String, Born)>>);

impl Births {
    fn get(&self, client_id: &str) -> Option<Born> {
        let kept = self.0.lock().ok()?;
        kept.iter()
            .find(|(id, _)| id == client_id)
            .map(|(_, born)| born.clone())
    }

    fn keep(&self, client_id: &str, born: &Born) {
        let Ok(mut kept) = self.0.lock() else { return };
        if kept.len() == BIRTHS_KEPT {
            kept.pop_front();
        }
        kept.push_back((client_id.to_owned(), born.clone()));
    }
}

/// a `/` command a menu can offer.
#[derive(Debug, Serialize, ToSchema)]
pub struct CommandChoice {
    pub name: String,
    pub description: Option<String>,
    /// `$1`, `$ARGUMENTS`: what it takes after its name.
    pub hints: Vec<String>,
    /// `command` (a command file) or `skill`.
    pub source: String,
}

/// a repo a new thread can start in, newest activity first.
#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectChoice {
    /// the repo's main checkout on the host.
    pub directory: String,
    /// last activity, ms since the epoch.
    pub updated: Option<i64>,
}

/// a menu's read, scoped to where the thread runs.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct Scope {
    /// the session's directory on the host.
    pub directory: String,
}

/// text and photos as cmx2 parts, after the composer's own limits.
pub fn content(text: &str, photos: Vec<Photo>) -> Result<Vec<Value>, ApiError> {
    if text.len() > MAX_TEXT {
        return Err(ApiError::BadRequest(
            "write a message of at most 100,000 characters".into(),
        ));
    }
    if text.trim().is_empty() && photos.is_empty() {
        return Err(ApiError::BadRequest(
            "write something, or add a photo".into(),
        ));
    }
    if photos.len() > MAX_PHOTOS {
        return Err(ApiError::BadRequest(format!(
            "send at most {MAX_PHOTOS} photos with one message"
        )));
    }
    if photos.iter().map(|photo| photo.url.len()).sum::<usize>() > MAX_PHOTOS_TOTAL {
        let files: usize = photos.iter().map(|photo| file_bytes(&photo.url)).sum();
        return Err(ApiError::BadRequest(format!(
            "the photos on one message add up to {} mb, over the {} mb that goes in one; send fewer or smaller ones",
            megabytes(files),
            MAX_HEIC_FILE * 2 / MIB
        )));
    }
    let mut parts = Vec::with_capacity(photos.len() + 1);
    if !text.trim().is_empty() {
        parts.push(json!({ "type": "text", "text": text }));
    }
    for photo in photos {
        if !PHOTO_KINDS.contains(&photo.mime.as_str()) {
            return Err(ApiError::BadRequest(format!(
                "a {} is not a photo the model can read; send png, jpeg, webp, gif, heic or heif",
                photo.mime
            )));
        }
        if !photo
            .url
            .starts_with(&format!("data:{};base64,", photo.mime))
        {
            return Err(ApiError::BadRequest(
                "send a photo as a base64 data url of its own kind".into(),
            ));
        }
        if CONVERTED_KINDS.contains(&photo.mime.as_str()) {
            if photo.url.len() > MAX_HEIC {
                return Err(ApiError::BadRequest(format!(
                    "a {} photo is {} mb, over the {} mb that goes; export it as a jpeg, or shoot it at a lower resolution",
                    photo.mime.trim_start_matches("image/"),
                    megabytes(file_bytes(&photo.url)),
                    MAX_HEIC_FILE / MIB
                )));
            }
        } else if photo.url.len() > MAX_PHOTO {
            return Err(ApiError::BadRequest(
                "a photo is over 1.5 mb after resizing; pick a smaller one".into(),
            ));
        }
        // the url moves into the part: a copy of a 12 MiB string is 12 MiB held for as long as the daemon takes to answer
        let mut part = serde_json::Map::new();
        part.insert("type".into(), Value::String("file".into()));
        part.insert("mime".into(), Value::String(photo.mime));
        part.insert("url".into(), Value::String(photo.url));
        if let Some(name) = photo.filename {
            part.insert("filename".into(), Value::String(name));
        }
        parts.push(Value::Object(part));
    }
    Ok(parts)
}

const MIB: usize = 1024 * 1024;

/// a size in mb as the person reads it: one decimal, none when it is whole.
fn megabytes(bytes: usize) -> String {
    let tenths = (bytes * 10).div_ceil(MIB);
    if tenths.is_multiple_of(10) {
        format!("{}", tenths / 10)
    } else {
        format!("{}.{}", tenths / 10, tenths % 10)
    }
}

/// how long the daemon gets to take a message: a base, then for each photo the time to cross a slow
/// link and, for a heic or heif, to be converted. a text-only message keeps the base. the device's post
/// is given this, the time to upload to boxbox, and a margin (`postBudgetMs`), so the answer of the
/// host, not the device's own timeout, is what a slow host produces.
pub fn accept_timeout(photos: &[Photo]) -> Duration {
    let mut limit = ACCEPT_BASE;
    for photo in photos {
        limit += Duration::from_secs((photo.url.len() / ACCEPT_BYTES_PER_SECOND) as u64);
        if CONVERTED_KINDS.contains(&photo.mime.as_str()) {
            limit += ACCEPT_PER_CONVERTED;
        }
    }
    limit
}

/// the bytes a base64 `data:` url carries, as the person sees them in the file it came from.
fn file_bytes(url: &str) -> usize {
    let data = url.len() - url.find(',').map_or(0, |at| at + 1);
    (data * 3).div_ceil(4)
}

/// a message's json body, read straight into one buffer of the announced size and parsed from it. axum's `Json`
/// collects the frames and then joins them into a second buffer, which for a message with photos is the whole
/// body twice over before a byte is parsed (rule 7); a body past what the routes take is refused as it passes
/// that size, not after it has all arrived.
pub struct Message<T>(pub T);

impl<S, T> axum::extract::FromRequest<S> for Message<T>
where
    S: Send + Sync,
    T: serde::de::DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: axum::extract::Request, _: &S) -> Result<Self, ApiError> {
        use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
        use futures_util::StreamExt;
        let headers = request.headers();
        let json = headers
            .get(CONTENT_TYPE)
            .and_then(|kind| kind.to_str().ok())
            .is_some_and(|kind| kind.starts_with("application/json"));
        if !json {
            return Err(ApiError::BadRequest("send the message as json".into()));
        }
        let announced = headers
            .get(CONTENT_LENGTH)
            .and_then(|length| length.to_str().ok())
            .and_then(|length| length.parse::<usize>().ok())
            .unwrap_or(0);
        if announced > super::PROMPT_BODY {
            return Err(ApiError::MessageTooLarge);
        }
        let mut body = request.into_body().into_data_stream();
        let mut buffer = Vec::with_capacity(announced);
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|_| {
                ApiError::BadRequest("the message did not arrive whole; send it again".into())
            })?;
            if buffer.len() + chunk.len() > super::PROMPT_BODY {
                return Err(ApiError::MessageTooLarge);
            }
            buffer.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&buffer)
            .map(Message)
            .map_err(|error| {
                ApiError::BadRequest(format!("that is not a message boxbox can read: {error}"))
            })
    }
}

/// a message's body as cmx2 takes it: the parts and the client id. the parts move in, so the photos'
/// bytes are not copied again on the way (rule 7).
pub fn message_body(parts: Vec<Value>, client_id: &str) -> Value {
    let mut body = serde_json::Map::new();
    body.insert("parts".into(), Value::Array(parts));
    body.insert("clientID".into(), Value::String(client_id.to_owned()));
    Value::Object(body)
}

/// a message's own model (`provider/model`) and effort, on the body cmx2 takes. an effort cmx2 names
/// goes as `effort`; a profile's named variant goes as `variant`.
pub fn model_and_effort(
    sent: &mut Value,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), ApiError> {
    if let Some(model) = model {
        let (provider, id) = model
            .split_once('/')
            .filter(|(p, m)| !p.is_empty() && !m.is_empty())
            .ok_or_else(|| ApiError::BadRequest(format!("\"{model}\" is not a provider/model")))?;
        sent["model"] = json!({ "providerID": provider, "modelID": id });
    }
    if let Some(effort) = effort.filter(|e| !e.is_empty()) {
        let key = if EFFORTS.contains(&effort) {
            "effort"
        } else {
            "variant"
        };
        sent[key] = Value::String(effort.to_owned());
    }
    Ok(())
}

/// steers text into the running turn: the agent reads it at its next step. on an idle thread it
/// starts a turn, which is then armed for "done" like any prompt.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/steer",
    params(("host" = String, Path), ("session" = String, Path)),
    request_body = Steer,
    responses(
        (status = 202, description = "taken; the daemon's `{result, messageID}`", body = Done),
        (status = 400, description = "not a message", body = ErrorBody),
        (status = 404, description = "no such host or session", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn steer(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Message(mut body): Message<Steer>,
) -> Result<Response, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    let client_id = client_id(&body.client_id)?.to_owned();
    let limit = accept_timeout(&body.photos);
    let parts = content(&body.text, std::mem::take(&mut body.photos))?;
    let route = format!("/session/{}/steer", segment(&session)?);
    let key = session_key(&host, &session);
    state
        .fleet
        .arm(key.clone(), client_id.clone(), device.clone())
        .await
        .map_err(|_| ApiError::Stopping)?;
    let done = post_body(
        &state,
        &host,
        &route,
        message_body(parts, &client_id),
        limit,
    )
    .await?;
    answer_review(&state, key, device).await;
    Ok((StatusCode::ACCEPTED, Json(done)).into_response())
}

/// runs a `!` line in the thread's directory. it starts no turn; the agent reads the output on its
/// next one. the daemon answers when the line has finished, with the shell message.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/shell",
    params(("host" = String, Path), ("session" = String, Path)),
    request_body = Shell,
    responses(
        (status = 200, description = "ran; the daemon's shell message", body = Done),
        (status = 400, description = "an empty line", body = ErrorBody),
        (status = 404, description = "no such host or session", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn shell(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Json(body): Json<Shell>,
) -> Result<Json<Done>, ApiError> {
    device_of(&body.device, &body.device_class)?;
    let client_id = client_id(&body.client_id)?;
    let command = body.command.trim();
    if command.is_empty() || command.len() > MAX_TEXT {
        return Err(ApiError::BadRequest(
            "write the command to run after the !".into(),
        ));
    }
    let route = format!("/session/{}/shell", segment(&session)?);
    let sent = json!({ "command": command, "clientID": client_id });
    upstream(
        &state,
        &host,
        Method::POST,
        &route,
        Some(&sent),
        None,
        SHELL_TIMEOUT,
    )
    .await
    .map(Json)
}

/// runs a `/` command as a prompt. the daemon holds its answer until the command's turn settles, so
/// this answers 202 once the daemon has taken it and leaves the rest to the stream (the echo of the
/// client id), keeping the request alive in the background so the daemon is never cut off mid-turn.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions/{session}/command",
    params(("host" = String, Path), ("session" = String, Path)),
    request_body = SlashCommand,
    responses(
        (status = 202, description = "taken; the stream carries the rest", body = Done),
        (status = 400, description = "not a command", body = ErrorBody),
        (status = 404, description = "no such host, session, or command", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn command(
    State(state): State<Arc<AppState>>,
    Path((host, session)): Path<(String, String)>,
    Json(body): Json<SlashCommand>,
) -> Result<Response, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    let client_id = client_id(&body.client_id)?.to_owned();
    let name = body.command.trim().trim_start_matches('/');
    if name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.'))
    {
        return Err(ApiError::BadRequest(format!(
            "\"{name}\" is not a command name"
        )));
    }
    let route = format!("/session/{}/command", segment(&session)?);
    let mut sent = json!({ "command": name, "clientID": client_id });
    if let Some(arguments) = body.arguments.filter(|a| !a.trim().is_empty()) {
        sent["arguments"] = Value::String(arguments);
    }
    let key = session_key(&host, &session);
    state
        .fleet
        .arm(key.clone(), client_id, device.clone())
        .await
        .map_err(|_| ApiError::Stopping)?;
    let started = upstream_headers(&state, &host, &route, &sent).await?;
    answer_review(&state, key, device).await;
    Ok((StatusCode::ACCEPTED, Json(started)).into_response())
}

/// the `/` commands the thread's directory offers.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/commands",
    params(("host" = String, Path), Scope),
    responses(
        (status = 200, description = "the commands, by name", body = [CommandChoice]),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn commands(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
    Query(scope): Query<Scope>,
) -> Result<Json<Vec<CommandChoice>>, ApiError> {
    let read = upstream(
        &state,
        &host,
        Method::GET,
        "/command",
        None,
        Some(&scope.directory),
        READ_TIMEOUT,
    )
    .await?;
    let mut choices: Vec<CommandChoice> = read
        .answer
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            Some(CommandChoice {
                name: c["name"].as_str()?.to_owned(),
                description: c["description"].as_str().map(str::to_owned),
                hints: c["hints"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|h| h.as_str().map(str::to_owned))
                    .collect(),
                source: c["source"].as_str().unwrap_or("command").to_owned(),
            })
        })
        .collect();
    choices.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(choices))
}

/// the repos a new thread can start in, newest activity first.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/projects",
    params(("host" = String, Path)),
    responses(
        (status = 200, description = "the repos", body = [ProjectChoice]),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn projects(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
) -> Result<Json<Vec<ProjectChoice>>, ApiError> {
    let read = upstream(
        &state,
        &host,
        Method::GET,
        "/project",
        None,
        None,
        READ_TIMEOUT,
    )
    .await?;
    Ok(Json(
        read.answer
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some(ProjectChoice {
                    directory: p["worktree"].as_str()?.to_owned(),
                    updated: p["time"]["updated"].as_i64(),
                })
            })
            .collect(),
    ))
}

/// a folder on the host, for the new-thread sheet's picker.
#[derive(Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct Folder {
    /// the folder's own name.
    pub name: String,
    /// its absolute path on the host.
    pub directory: String,
    /// it holds a `.git`, so a fresh worktree can be made from it.
    pub repo: bool,
}

/// the folders inside one folder on a host.
#[derive(Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct Folders {
    /// the folder read, absolute and resolved.
    pub path: String,
    /// the folder above it; none at the root.
    pub parent: Option<String>,
    /// the host user's home, where a walk starts.
    pub home: String,
    /// the folders inside it that start with the prefix asked, visible first, then by name; at most 500.
    pub children: Vec<Folder>,
    /// more folders matched than `children` holds: type more of the name to narrow it.
    pub truncated: bool,
}

/// the most folders one answer carries.
const FOLDERS_MAX: usize = 500;
/// the most of a host's folder list one read takes in.
const FOLDERS_BODY: usize = 4 * 1024 * 1024;

/// which folder to read.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct Browse {
    /// absolute, `~` or `~/...`; the host's home when left out.
    pub path: Option<String>,
    /// also list the folders whose names start with a dot.
    pub hidden: Option<bool>,
    /// only the folders whose names start with this, case aside: the server narrows a big folder
    /// before it answers, so a typed word never pulls the whole list to a phone.
    pub prefix: Option<String>,
}

/// cmx2's `/global/fs` answer as boxbox serves it, narrowed to a name prefix and bounded; none when it is
/// not that shape.
fn shape_folders(answer: &Value, prefix: &str) -> Option<Folders> {
    let prefix = prefix.to_lowercase();
    let mut matched = answer["entries"]
        .as_array()?
        .iter()
        .filter_map(|e| {
            let name = e["name"].as_str()?;
            if !name.to_lowercase().starts_with(&prefix) {
                return None;
            }
            Some(Folder {
                name: name.to_owned(),
                directory: e["absolute"].as_str()?.to_owned(),
                repo: e["git"].as_bool().unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    let truncated = matched.len() > FOLDERS_MAX;
    matched.truncate(FOLDERS_MAX);
    Some(Folders {
        path: answer["path"].as_str()?.to_owned(),
        parent: answer["parent"].as_str().map(str::to_owned),
        home: answer["home"].as_str()?.to_owned(),
        children: matched,
        truncated,
    })
}

/// what the daemon's refusal to list a folder means to the person, in words: nothing there, a file, or no
/// permission. anything else it said stays its own.
fn folder_refusal(host: &str, error: ApiError) -> ApiError {
    let ApiError::HostSaid {
        status: 400,
        message,
        ..
    } = &error
    else {
        return error;
    };
    let at = |prefix: &str| message.strip_prefix(prefix).map(str::to_owned);
    if let Some(path) = at("no such directory: ") {
        return ApiError::BadRequest(format!("there is no folder at {path} on {host}."));
    }
    if let Some(path) = at("not a directory: ") {
        let name = path.rsplit('/').next().unwrap_or(&path);
        return ApiError::BadRequest(format!("{name} is a file, not a folder."));
    }
    if let Some(path) = at("permission denied: ") {
        return ApiError::BadRequest(format!("{path} on {host} cannot be read."));
    }
    error
}

/// a thread asked to start where the host has no folder: said as what happened and what to do, a refusal the
/// client never retries (the daemon says "directory X does not exist" for a missing folder and for a file).
fn missing_directory(host: &str, directory: &str, error: ApiError) -> ApiError {
    match &error {
        ApiError::HostSaid {
            status: 400,
            message,
            ..
        } if message.contains("does not exist") => ApiError::BadRequest(format!(
            "nothing at {directory} on {host}, so the thread did not start. pick another folder, or make it and retry."
        )),
        _ => error,
    }
}

/// the folders inside a folder on the host, so a thread can start in a place no thread has been in yet.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/folders",
    params(("host" = String, Path), Browse),
    responses(
        (status = 200, description = "the folders inside it", body = Folders),
        (status = 400, description = "nothing at that path on the host, a file, or not readable", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer", body = ErrorBody),
    ),
)]
pub async fn folders(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
    Query(browse): Query<Browse>,
) -> Result<Json<Folders>, ApiError> {
    let mut query = Vec::new();
    if let Some(path) = browse.path.as_deref().filter(|p| !p.is_empty()) {
        if path.len() > 4096 || path.contains('\n') {
            return Err(ApiError::BadRequest("that is not a folder".into()));
        }
        query.push(format!("path={}", urlencode(path)));
    }
    if browse.hidden == Some(true) {
        query.push("hidden=true".to_owned());
    }
    let route = if query.is_empty() {
        "/global/fs".to_owned()
    } else {
        format!("/global/fs?{}", query.join("&"))
    };
    let read = upstream_within(
        &state,
        &host,
        Method::GET,
        &route,
        None,
        None,
        READ_TIMEOUT,
        FOLDERS_BODY,
    )
    .await
    .map_err(|error| folder_refusal(&host, error))?;
    shape_folders(&read.answer, browse.prefix.as_deref().unwrap_or(""))
        .map(Json)
        .ok_or_else(|| ApiError::HostFailed {
            host,
            detail: "its folder list came back in a shape this server does not read".into(),
        })
}

/// starts a thread in a repo with its first message: a fresh worktree first when asked, then the
/// session, then the prompt, armed for "done". a retry with the same client id answers the thread
/// the first try made.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/sessions",
    params(("host" = String, Path)),
    request_body = NewThread,
    responses(
        (status = 201, description = "the new thread", body = Born),
        (status = 200, description = "a retry: the thread the first try made", body = Born),
        (status = 400, description = "not a thread, or no folder there on the host", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer, or refused the worktree", body = ErrorBody),
    ),
)]
pub async fn start(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
    Message(mut body): Message<NewThread>,
) -> Result<Response, ApiError> {
    let device = device_of(&body.device, &body.device_class)?;
    let client_id = client_id(&body.client_id)?.to_owned();
    if let Some(born) = state.births.get(&client_id) {
        return Ok((
            StatusCode::OK,
            Json(Born {
                repeat: true,
                ..born
            }),
        )
            .into_response());
    }
    let limit = accept_timeout(&body.photos);
    let parts = content(&body.text, std::mem::take(&mut body.photos))?;
    if !body.directory.starts_with('/') {
        return Err(ApiError::BadRequest(
            "name the repo by its absolute directory on the host".into(),
        ));
    }
    let directory = match body.place {
        Place::Checkout => body.directory.clone(),
        Place::Fresh => {
            let made = upstream(
                &state,
                &host,
                Method::POST,
                "/experimental/worktree",
                Some(&json!({})),
                Some(&body.directory),
                BIRTH_TIMEOUT,
            )
            .await?;
            made.answer["directory"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| ApiError::HostFailed {
                    host: host.clone(),
                    detail: "its new worktree named no directory".into(),
                })?
        }
    };
    let mut session = json!({ "directory": directory });
    if let Some(model) = &body.model {
        session["model"] = Value::String(model.clone());
    }
    if let Some(effort) = body.effort.as_deref().filter(|e| EFFORTS.contains(e)) {
        session["effort"] = Value::String(effort.to_owned());
    }
    let made = upstream(
        &state,
        &host,
        Method::POST,
        "/session",
        Some(&session),
        None,
        READ_TIMEOUT,
    )
    .await
    .map_err(|error| missing_directory(&host, &directory, error))?;
    let id = made.answer["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| ApiError::HostFailed {
            host: host.clone(),
            detail: "its new session had no id".into(),
        })?;
    let born = Born {
        session: id.clone(),
        directory,
        repeat: false,
    };
    state.births.keep(&client_id, &born);
    state
        .fleet
        .arm(session_key(&host, &id), client_id.clone(), device)
        .await
        .map_err(|_| ApiError::Stopping)?;
    let mut prompt = message_body(parts, &client_id);
    model_and_effort(&mut prompt, body.model.as_deref(), body.effort.as_deref())?;
    post_body(
        &state,
        &host,
        &format!("/session/{}/prompt_async", segment(&id)?),
        prompt,
        limit,
    )
    .await?;
    info!(%host, session = %id, place = ?body.place, "a new thread was started");
    Ok((StatusCode::CREATED, Json(born)).into_response())
}

/// a call whose answer the daemon holds until a turn settles: answers once its headers say it was
/// taken, and reads the rest in a task of its own (bounded by the turn) so the daemon is not cut off.
async fn upstream_headers(
    state: &AppState,
    host: &str,
    route: &str,
    sent: &Value,
) -> Result<Done, ApiError> {
    let view = super::hosts::find(state, host)?;
    let unreachable = |reason: String| ApiError::HostUnreachable {
        host: host.to_owned(),
        reason,
    };
    let response = tokio::time::timeout(
        READ_TIMEOUT,
        crate::upstream::request(&state.client, &view.config, Method::POST, route)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(sent.to_string())
            .send(),
    )
    .await
    .map_err(|_| unreachable(format!("no answer within {}s", READ_TIMEOUT.as_secs())))?
    .map_err(|e| unreachable(crate::upstream::plain(&e)))?;
    let status = response.status().as_u16();
    info!(host, route, status, "command sent to the host");
    if status == 404 {
        return Err(ApiError::BadRequest(
            "the thread's directory has no command by that name".into(),
        ));
    }
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(ApiError::HostSaid {
            host: host.to_owned(),
            status,
            message: body.chars().take(200).collect(),
        });
    }
    let repeat = response.headers().contains_key("x-cmx2-repeat");
    tokio::spawn(async move {
        // the command's own turn ends the body; an hour is past any turn worth waiting for
        let _ = tokio::time::timeout(Duration::from_secs(3600), response.bytes()).await;
    });
    Ok(Done {
        repeat,
        answer: Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo(mime: &str, len: usize) -> Photo {
        let head = format!("data:{mime};base64,");
        Photo {
            mime: mime.into(),
            filename: None,
            url: format!("{head}{}", "A".repeat(len.saturating_sub(head.len()))),
        }
    }

    #[test]
    fn text_and_photos_become_parts_in_order() {
        let parts = content("see the gap right?", vec![photo("image/jpeg", 2000)]).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["mime"], "image/jpeg");
    }

    #[test]
    fn a_photo_is_a_part_with_its_name_and_its_bytes_moved_in() {
        let mut named = photo("image/png", 500);
        named.filename = Some("gap.png".into());
        let url = named.url.clone();
        let parts = content("", vec![named]).unwrap();
        assert_eq!(parts[0]["filename"], "gap.png");
        assert_eq!(parts[0]["url"], url.as_str());
        assert_eq!(parts[0]["type"], "file");
    }

    #[test]
    fn a_photo_alone_is_a_message_and_nothing_is_not() {
        assert_eq!(
            content("  ", vec![photo("image/png", 100)]).unwrap().len(),
            1
        );
        assert!(content("  ", vec![]).is_err());
    }

    #[test]
    fn a_heic_or_heif_original_goes_to_the_host_as_a_file_part() {
        for kind in ["image/heic", "image/heif"] {
            let parts = content("what is this?", vec![photo(kind, 3 * MIB)]).unwrap();
            assert_eq!(parts[1]["type"], "file");
            assert_eq!(parts[1]["mime"], kind);
        }
        assert!(content("x", vec![photo("image/heic", MAX_HEIC)]).is_ok());
    }

    #[test]
    fn the_limit_is_the_file_the_person_sees_and_its_url_is_that_file_in_base64() {
        for kind in ["image/heic", "image/heif"] {
            let head = format!("data:{kind};base64,").len();
            assert_eq!(MAX_HEIC, head + MAX_HEIC_FILE.div_ceil(3) * 4);
        }
    }

    #[test]
    fn a_heic_over_its_limit_is_refused_with_its_size_and_what_to_do() {
        let Err(ApiError::BadRequest(said)) = content("x", vec![photo("image/heic", MAX_HEIC + 4)])
        else {
            panic!("a heic over the limit was taken");
        };
        // the size reads as the file the person has, and is never the limit's own number
        assert!(said.contains("is 9.1 mb, over the 9 mb"), "{said}");
        assert!(said.contains("export it as a jpeg"), "{said}");
        let Err(ApiError::BadRequest(heif)) = content("x", vec![photo("image/heif", MAX_HEIC + 1)])
        else {
            panic!("a heif over the limit was taken");
        };
        assert!(heif.starts_with("a heif photo is 9.1 mb"), "{heif}");
    }

    #[test]
    fn the_larger_limit_is_for_heic_and_heif_alone() {
        assert!(content("x", vec![photo("image/jpeg", MAX_PHOTO + 1)]).is_err());
        assert!(content("x", vec![photo("image/png", MAX_PHOTO + 1)]).is_err());
        assert!(content("x", vec![photo("image/webp", MAX_HEIC)]).is_err());
    }

    #[test]
    fn a_message_holds_two_heics_at_the_limit_and_not_a_third() {
        let two = vec![photo("image/heic", MAX_HEIC), photo("image/heif", MAX_HEIC)];
        assert!(content("x", two).is_ok());
        let three = vec![
            photo("image/heic", MAX_HEIC),
            photo("image/heic", MAX_HEIC),
            photo("image/jpeg", 100),
        ];
        let Err(ApiError::BadRequest(said)) = content("x", three) else {
            panic!("photos past the message's total were taken");
        };
        assert!(said.contains("add up to 18.1 mb"), "{said}");
        assert!(said.contains("over the 18 mb"), "{said}");
        let four: Vec<Photo> = (0..4).map(|_| photo("image/jpeg", MAX_PHOTO)).collect();
        assert!(content("x", four).is_ok());
    }

    #[test]
    fn a_message_at_the_total_fits_the_body_the_routes_take() {
        let body = super::super::PROMPT_BODY;
        // json of a message at the text limit, every character a six-byte escape, and the photos at the total
        assert!(MAX_PHOTOS_TOTAL + MAX_TEXT * 6 + 4096 <= body);
    }

    #[test]
    fn a_host_gets_longer_to_take_photos_than_words() {
        assert_eq!(accept_timeout(&[]), ACCEPT_BASE);
        let jpeg = accept_timeout(&[photo("image/jpeg", MAX_PHOTO)]);
        assert!(jpeg > ACCEPT_BASE && jpeg < ACCEPT_BASE + Duration::from_secs(10));
        let heic = accept_timeout(&[photo("image/heic", MAX_HEIC)]);
        // 12 MiB over 256 KiB a second is 48 s, then the 75 s a conversion is given (cmx2's 60 s and a margin)
        assert_eq!(heic, ACCEPT_BASE + Duration::from_secs(48 + 75));
        let two = accept_timeout(&[photo("image/heic", MAX_HEIC), photo("image/heif", MAX_HEIC)]);
        assert_eq!(two, ACCEPT_BASE + Duration::from_secs(2 * (48 + 75)));
    }

    #[test]
    fn a_size_reads_in_mb_with_a_decimal_only_when_it_is_not_whole() {
        assert_eq!(megabytes(12 * MIB), "12");
        assert_eq!(megabytes(12 * MIB + 1), "12.1");
        assert_eq!(megabytes(MIB / 2), "0.5");
    }

    #[test]
    fn a_file_is_sized_from_its_base64() {
        assert_eq!(file_bytes("data:image/heic;base64,AAAA"), 3);
        assert_eq!(
            file_bytes(&format!("data:image/heic;base64,{}", "A".repeat(4000))),
            3000
        );
    }

    #[test]
    fn a_body_is_the_parts_and_the_client_id_and_the_photos_are_not_copied() {
        let parts = content("x", vec![photo("image/png", 100)]).unwrap();
        let body = message_body(parts, "c1");
        assert_eq!(body["clientID"], "c1");
        assert_eq!(body["parts"][1]["mime"], "image/png");
    }

    #[test]
    fn photos_the_composer_did_not_clamp_are_refused() {
        assert!(content("x", vec![photo("image/tiff", 100)]).is_err());
        assert!(content("x", vec![photo("image/jpeg", MAX_PHOTO + 1)]).is_err());
        let five: Vec<Photo> = (0..5).map(|_| photo("image/png", 100)).collect();
        assert!(content("x", five).is_err());
        let lying = Photo {
            mime: "image/png".into(),
            filename: None,
            url: "data:image/jpeg;base64,AAAA".into(),
        };
        assert!(content("x", vec![lying]).is_err());
    }

    #[test]
    fn a_model_splits_at_its_provider_and_an_effort_goes_by_its_kind() {
        let mut sent = json!({});
        model_and_effort(&mut sent, Some("anthropic/claude-opus-5-5"), Some("high")).unwrap();
        assert_eq!(
            sent["model"],
            json!({ "providerID": "anthropic", "modelID": "claude-opus-5-5" })
        );
        assert_eq!(sent["effort"], "high");
        let mut named = json!({});
        model_and_effort(&mut named, None, Some("thorough")).unwrap();
        assert_eq!(named["variant"], "thorough");
        assert!(model_and_effort(&mut json!({}), Some("no-slash"), None).is_err());
    }

    #[test]
    fn the_hosts_folder_list_is_served_as_folders_with_their_repo_mark() {
        let answer = json!({
            "path": "/home/dev/code",
            "parent": "/home/dev",
            "home": "/home/dev",
            "entries": [
                { "name": "api", "absolute": "/home/dev/code/api", "hidden": false, "git": true },
                { "name": "notes", "absolute": "/home/dev/code/notes", "hidden": false, "git": false },
                { "name": "broken" },
            ],
        });
        let shaped = shape_folders(&answer, "").unwrap();
        assert_eq!(shaped.parent.as_deref(), Some("/home/dev"));
        assert_eq!(
            shaped.children,
            vec![
                Folder {
                    name: "api".into(),
                    directory: "/home/dev/code/api".into(),
                    repo: true
                },
                Folder {
                    name: "notes".into(),
                    directory: "/home/dev/code/notes".into(),
                    repo: false
                },
            ]
        );
        assert!(shape_folders(&json!({ "entries": [] }), "").is_none());
        let root = json!({ "path": "/", "parent": null, "home": "/root", "entries": [] });
        assert_eq!(shape_folders(&root, "").unwrap().parent, None);
    }

    fn many(n: usize) -> Value {
        let entries: Vec<Value> = (0..n)
            .map(|i| json!({ "name": format!("dir{i:05}"), "absolute": format!("/big/dir{i:05}"), "git": false }))
            .collect();
        json!({ "path": "/big", "parent": "/", "home": "/home/dev", "entries": entries })
    }

    #[test]
    fn a_big_folder_is_cut_to_500_and_says_so() {
        let shaped = shape_folders(&many(6000), "").unwrap();
        assert_eq!(shaped.children.len(), FOLDERS_MAX);
        assert!(shaped.truncated);
        assert!(serde_json::to_vec(&shaped).unwrap().len() < 64 * 1024);
        let small = shape_folders(&many(40), "").unwrap();
        assert_eq!(small.children.len(), 40);
        assert!(!small.truncated);
    }

    #[test]
    fn a_prefix_narrows_the_list_on_the_server_case_aside() {
        let shaped = shape_folders(&many(6000), "DIR0012").unwrap();
        assert_eq!(shaped.children.len(), 10);
        assert!(!shaped.truncated);
        assert_eq!(shaped.children[0].name, "dir00120");
        assert!(shape_folders(&many(10), "zzz").unwrap().children.is_empty());
    }

    #[test]
    fn a_folder_the_host_cannot_list_is_said_in_words() {
        let said = |message: &str| ApiError::HostSaid {
            host: "desk".into(),
            status: 400,
            message: message.into(),
        };
        let words = |error: ApiError| match error {
            ApiError::BadRequest(words) => words,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            words(folder_refusal("desk", said("no such directory: /srv/nope"))),
            "there is no folder at /srv/nope on desk."
        );
        assert_eq!(
            words(folder_refusal(
                "desk",
                said("not a directory: /srv/app/notes.txt")
            )),
            "notes.txt is a file, not a folder."
        );
        assert_eq!(
            words(folder_refusal("desk", said("permission denied: /root"))),
            "/root on desk cannot be read."
        );
        // anything else the host said stays its own
        assert!(matches!(
            folder_refusal("desk", said("something else")),
            ApiError::HostSaid { .. }
        ));
    }

    #[test]
    fn a_thread_started_where_there_is_no_folder_says_what_to_do() {
        let refusal = ApiError::HostSaid {
            host: "desk".into(),
            status: 400,
            message: "directory /srv/nope does not exist".into(),
        };
        match missing_directory("desk", "/srv/nope", refusal) {
            ApiError::BadRequest(words) => assert_eq!(
                words,
                "nothing at /srv/nope on desk, so the thread did not start. pick another folder, or make it and retry."
            ),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_birth_is_remembered_by_client_id_and_the_oldest_leaves_first() {
        let births = Births::default();
        let born = |n: usize| Born {
            session: format!("ses_{n}"),
            directory: "/repo".into(),
            repeat: false,
        };
        for n in 0..=BIRTHS_KEPT {
            births.keep(&format!("c{n}"), &born(n));
        }
        assert!(births.get("c0").is_none());
        assert_eq!(
            births.get(&format!("c{BIRTHS_KEPT}")).map(|b| b.session),
            Some(format!("ses_{BIRTHS_KEPT}"))
        );
    }
}
