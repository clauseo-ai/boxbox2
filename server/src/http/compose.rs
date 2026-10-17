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
use base64ct::{Base64, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::info;
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::agents;
use super::asks::{Done, answer_review, client_id, device_of, segment};
use super::error::{ApiError, ErrorBody};
use super::session::urlencode;
use crate::fleet::model::session_key;
#[cfg(test)]
use crate::source::cmx2::verbs::compose::{
    FOLDERS_MAX, folder_refusal, missing_directory, shape_folders,
};
use crate::wire::Capability;

/// a prompt's text, at most.
const MAX_TEXT: usize = 100_000;
/// photos and files on one message together. the composer clamps to this before it sends.
const MAX_ATTACHMENTS: usize = 4;
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
/// every photo and file of one message together, as data urls (18 MiB of files): two photos at the heic
/// limit, or two pdfs at theirs, fit and a third does not; four resized jpegs (6 MiB) always do. the 56 is
/// two of the longest head a file of 9 MiB comes with (`data:application/pdf;base64,`, 28). it is also
/// what bounds the body the routes take and the bytes the outbox holds per message (the composer's
/// `MAX_MESSAGE_URL`).
const MAX_ATTACHMENTS_TOTAL: usize = 24 * 1024 * 1024 + 56;
/// one pdf, at most, as the person sees it in their files. cmx2 hands a pdf of up to 20 MB whole to a
/// model that reads documents, with its extracted text for the rest (`parts.ts`, `DOCUMENT_MAX_BYTES`);
/// 9 MiB is under that, so every pdf boxbox takes rides whole, and two fit the message's 18 MiB.
const MAX_PDF_FILE: usize = 9 * 1024 * 1024;
const _: () = assert!(
    MAX_PDF_FILE <= 20 * 1000 * 1000,
    "a pdf boxbox takes rides whole on cmx2"
);
/// one text or json file, at most. cmx2 puts its whole text into the message (`<file path=...>`), with
/// no cap of its own, so this is what keeps one file from filling the model's context: 512 KiB is about
/// 130,000 tokens, five times the most a person can type (`MAX_TEXT`).
const MAX_TEXT_FILE: usize = 512 * 1024;
/// the file kinds cmx2 reads from a `data:` url besides images (`parts.ts`): a pdf, and any text or json,
/// which it puts in the message whole. `text/*` is checked apart (`is_document_kind`).
const DOCUMENT_KINDS: [&str; 2] = ["application/pdf", "application/json"];
/// a file's name, at most, in characters: what a file system allows, and what cmx2 puts in the `<file path=...>` it writes.
const MAX_FILENAME: usize = 255;
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
/// cmx2 reads a pdf's text with `pdftotext` before it answers, and gives that 30 s; 5 s more is the margin.
const ACCEPT_PER_PDF: Duration = Duration::from_secs(35);
/// the slowest link a photo is allowed to cross to a host: 256 KiB a second, about 2 mbit. a host
/// beyond a vpn is not on a faster one than the phone's.
const ACCEPT_BYTES_PER_SECOND: usize = 256 * 1024;
/// cmx2's own effort names; any other variant goes by its name.
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
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

/// a file on a message that is not a photo: a document the host reads to the model.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    /// `application/pdf`, `application/json`, or any `text/*` (`text/plain`, `text/markdown`,
    /// `text/csv`).
    pub mime: String,
    /// the file's name as the person had it; the host labels the file with it.
    pub filename: String,
    /// `data:<mime>;base64,...`: a pdf of at most 9 mb, a text or json file of at most 512 kb; with the
    /// photos, at most 18 mb of files on one message.
    pub url: String,
}

/// text with photos and files, steered into the running turn.
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
    #[serde(default)]
    pub files: Vec<Document>,
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
    #[serde(default)]
    pub files: Vec<Document>,
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

/// text, photos and files as cmx2 parts, after the composer's own limits: the words, then the photos,
/// then the files, each a `file` part with its kind, its name and its `data:` url.
pub fn content(
    text: &str,
    photos: Vec<Photo>,
    files: Vec<Document>,
) -> Result<Vec<Value>, ApiError> {
    if text.len() > MAX_TEXT {
        return Err(ApiError::BadRequest(
            "write a message of at most 100,000 characters".into(),
        ));
    }
    if text.trim().is_empty() && photos.is_empty() && files.is_empty() {
        return Err(ApiError::BadRequest(
            "write something, or add a photo or a file".into(),
        ));
    }
    if photos.len() + files.len() > MAX_ATTACHMENTS {
        return Err(ApiError::BadRequest(format!(
            "send at most {MAX_ATTACHMENTS} photos and files with one message"
        )));
    }
    let urls = photos.iter().map(|photo| photo.url.as_str());
    let urls = urls.chain(files.iter().map(|file| file.url.as_str()));
    if urls.clone().map(str::len).sum::<usize>() > MAX_ATTACHMENTS_TOTAL {
        let bytes: usize = urls.map(file_bytes).sum();
        return Err(ApiError::BadRequest(format!(
            "the photos and files on one message add up to {} mb, over the {} mb that goes in one; send fewer or smaller ones",
            megabytes(bytes),
            MAX_HEIC_FILE * 2 / MIB
        )));
    }
    let mut parts = Vec::with_capacity(photos.len() + files.len() + 1);
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
        parts.push(file_part(photo.mime, photo.url, photo.filename));
    }
    for file in files {
        let name = document(&file)?;
        parts.push(file_part(file.mime, file.url, Some(name)));
    }
    Ok(parts)
}

/// a file that is not a photo, checked against what cmx2 reads and what boxbox lets one file be; the name it goes by.
fn document(file: &Document) -> Result<String, ApiError> {
    let name = file_name(&file.filename)?;
    if !is_document_kind(&file.mime) {
        return Err(ApiError::BadRequest(format!(
            "{name} is {}, which the agent cannot read; send a pdf, a text file or json",
            file.mime
        )));
    }
    if !file.url.starts_with(&format!("data:{};base64,", file.mime)) {
        return Err(ApiError::BadRequest(
            "send a file as a base64 data url of its own kind".into(),
        ));
    }
    let bytes = file_bytes(&file.url);
    let (most, which) = if file.mime == "application/pdf" {
        (MAX_PDF_FILE, "a pdf")
    } else {
        (MAX_TEXT_FILE, "a text file")
    };
    if bytes > most {
        return Err(ApiError::BadRequest(format!(
            "{name} is {}, over the {} {which} goes at; send a smaller one, or a part of it",
            size(bytes),
            size(most)
        )));
    }
    // cmx2 decodes a text file as utf-8 and puts it in the message: anything else would reach the model as replacement marks
    if file.mime != "application/pdf" {
        let data = &file.url[file.url.find(',').map_or(0, |at| at + 1)..];
        let text = Base64::decode_vec(data).map_err(|_| {
            ApiError::BadRequest(format!("{name} did not arrive as base64; add it again"))
        })?;
        if std::str::from_utf8(&text).is_err() {
            return Err(ApiError::BadRequest(format!(
                "{name} is not utf-8 text; save it as utf-8 and add it again"
            )));
        }
    }
    Ok(name)
}

/// a file's name as cmx2 labels it (`<file path="...">`, unescaped): only what follows its last slash or backslash, at most
/// `MAX_FILENAME` characters, and none of the characters that would break the label or hide what it says (a quote, an angle
/// bracket, a control or a format character such as a bidi override).
fn file_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();
    if name.is_empty() || name == "." || name == ".." || name.chars().count() > MAX_FILENAME {
        return Err(ApiError::BadRequest(format!(
            "name a file in 1 to {MAX_FILENAME} characters"
        )));
    }
    if let Some(bad) = name.chars().find(|&c| unsafe_in_name(c)) {
        return Err(ApiError::BadRequest(format!(
            "a file's name cannot hold {}; rename it and add it again",
            if bad.is_control() || is_format(bad) {
                "a control or direction mark".to_owned()
            } else {
                format!("\"{bad}\"")
            }
        )));
    }
    Ok(name.to_owned())
}

fn unsafe_in_name(c: char) -> bool {
    matches!(c, '"' | '<' | '>') || c.is_control() || is_format(c)
}

/// unicode's format characters (general category Cf) that can sit in a name unseen: the soft hyphen, the bidi marks,
/// embeddings, overrides and isolates, the zero-width ones and the byte order mark.
fn is_format(c: char) -> bool {
    matches!(
        c,
        '\u{ad}'
            | '\u{600}'..='\u{605}'
            | '\u{61c}'
            | '\u{6dd}'
            | '\u{70f}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{e0001}'
            | '\u{e0020}'..='\u{e007f}'
    )
}

/// a kind cmx2 reads from a file part's bytes: a pdf, json, or any `text/` with a plain subtype.
fn is_document_kind(mime: &str) -> bool {
    DOCUMENT_KINDS.contains(&mime)
        || mime.strip_prefix("text/").is_some_and(|sub| {
            !sub.is_empty()
                && sub
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+-.".contains(&b))
        })
}

/// a `file` part. the url moves in: a copy of a 12 MiB string is 12 MiB held for as long as the daemon
/// takes to answer.
fn file_part(mime: String, url: String, filename: Option<String>) -> Value {
    let mut part = serde_json::Map::new();
    part.insert("type".into(), Value::String("file".into()));
    part.insert("mime".into(), Value::String(mime));
    part.insert("url".into(), Value::String(url));
    if let Some(name) = filename {
        part.insert("filename".into(), Value::String(name));
    }
    Value::Object(part)
}

const MIB: usize = 1024 * 1024;

/// a size as the person reads it: in kb under a megabyte, else in mb.
fn size(bytes: usize) -> String {
    if bytes < MIB {
        format!("{} kb", bytes.div_ceil(1024))
    } else {
        format!("{} mb", megabytes(bytes))
    }
}

/// a size in mb as the person reads it: one decimal, none when it is whole.
fn megabytes(bytes: usize) -> String {
    let tenths = (bytes * 10).div_ceil(MIB);
    if tenths.is_multiple_of(10) {
        format!("{}", tenths / 10)
    } else {
        format!("{}.{}", tenths / 10, tenths % 10)
    }
}

/// how long the daemon gets to take a message: a base, then for each photo and file the time to cross a
/// slow link, for a heic or heif the time to be converted, and for a pdf the time to read its text. a
/// text-only message keeps the base. the device's post is given this, the time to upload to boxbox, and
/// a margin (`postBudgetMs`), so the answer of the host, not the device's own timeout, is what a slow
/// host produces.
pub fn accept_timeout(photos: &[Photo], files: &[Document]) -> Duration {
    let crossing = |url: &str| Duration::from_secs((url.len() / ACCEPT_BYTES_PER_SECOND) as u64);
    let mut limit = ACCEPT_BASE;
    for photo in photos {
        limit += crossing(&photo.url);
        if CONVERTED_KINDS.contains(&photo.mime.as_str()) {
            limit += ACCEPT_PER_CONVERTED;
        }
    }
    for file in files {
        limit += crossing(&file.url);
        if file.mime == "application/pdf" {
            limit += ACCEPT_PER_PDF;
        }
    }
    limit
}

/// the bytes a base64 `data:` url carries, as the person sees them in the file it came from: three for
/// every four characters, less the padding that ends it.
fn file_bytes(url: &str) -> usize {
    let data = &url[url.find(',').map_or(0, |at| at + 1)..];
    let padding = data.bytes().rev().take(2).filter(|&b| b == b'=').count();
    (data.len() * 3).div_ceil(4).saturating_sub(padding)
}

/// a message's json body, read straight into one buffer of the announced size and parsed from it. axum's `Json`
/// collects the frames and then joins them into a second buffer, which for a message with photos is the whole
/// body twice over before a byte is parsed (`AGENTS.md`, memory and latency); a body past what the routes take is refused as it passes
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
/// bytes are not copied again on the way (`AGENTS.md`, memory and latency).
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
    let limit = accept_timeout(&body.photos, &body.files);
    let parts = content(
        &body.text,
        std::mem::take(&mut body.photos),
        std::mem::take(&mut body.files),
    )?;
    let id = segment(&session)?;
    let source = agents::cmx2(&state, &host, Some(Capability::Steer))?;
    let key = session_key(&host, &session);
    state
        .fleet
        .arm(key.clone(), client_id.clone(), device.clone())
        .await
        .map_err(|_| ApiError::Stopping)?;
    let done = source
        .steer(id, message_body(parts, &client_id), limit)
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
    let id = segment(&session)?;
    let sent = json!({ "command": command, "clientID": client_id });
    let source = agents::cmx2(&state, &host, Some(Capability::Shell))?;
    source.shell(id, &sent).await.map(Json)
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
    let id = segment(&session)?;
    let mut sent = json!({ "command": name, "clientID": client_id });
    if let Some(arguments) = body.arguments.filter(|a| !a.trim().is_empty()) {
        sent["arguments"] = Value::String(arguments);
    }
    let source = agents::cmx2(&state, &host, Some(Capability::Commands))?;
    let key = session_key(&host, &session);
    state
        .fleet
        .arm(key.clone(), client_id, device.clone())
        .await
        .map_err(|_| ApiError::Stopping)?;
    let started = source.command(id, &sent).await?;
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
    let source = agents::cmx2(&state, &host, Some(Capability::Commands))?;
    source.commands(&scope.directory).await.map(Json)
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
    let source = agents::cmx2(&state, &host, Some(Capability::Places))?;
    source.projects().await.map(Json)
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
    let source = agents::cmx2(&state, &host, Some(Capability::Places))?;
    source
        .folders(&query, browse.prefix.as_deref().unwrap_or(""))
        .await
        .map(Json)
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
    let limit = accept_timeout(&body.photos, &body.files);
    let parts = content(
        &body.text,
        std::mem::take(&mut body.photos),
        std::mem::take(&mut body.files),
    )?;
    if !body.directory.starts_with('/') {
        return Err(ApiError::BadRequest(
            "name the repo by its absolute directory on the host".into(),
        ));
    }
    let source = agents::cmx2(&state, &host, Some(Capability::Threads))?;
    agents::check(source.as_ref(), &host, Capability::Places)?;
    if body.place == Place::Fresh {
        agents::check(source.as_ref(), &host, Capability::Worktree)?;
    }
    let directory = match body.place {
        Place::Checkout => body.directory.clone(),
        Place::Fresh => source.fresh_worktree(&body.directory).await?,
    };
    let mut session = json!({ "directory": directory });
    if let Some(model) = &body.model {
        session["model"] = Value::String(model.clone());
    }
    if let Some(effort) = body.effort.as_deref().filter(|e| EFFORTS.contains(e)) {
        session["effort"] = Value::String(effort.to_owned());
    }
    let id = source.new_session(&session, &directory).await?;
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
    source.prompt(segment(&id)?, prompt, limit).await?;
    info!(%host, session = %id, place = ?body.place, "a new thread was started");
    Ok((StatusCode::CREATED, Json(born)).into_response())
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
        let parts = content(
            "see the gap right?",
            vec![photo("image/jpeg", 2000)],
            vec![],
        )
        .unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["mime"], "image/jpeg");
    }

    #[test]
    fn a_photo_is_a_part_with_its_name_and_its_bytes_moved_in() {
        let mut named = photo("image/png", 500);
        named.filename = Some("gap.png".into());
        let url = named.url.clone();
        let parts = content("", vec![named], vec![]).unwrap();
        assert_eq!(parts[0]["filename"], "gap.png");
        assert_eq!(parts[0]["url"], url.as_str());
        assert_eq!(parts[0]["type"], "file");
    }

    #[test]
    fn a_photo_alone_is_a_message_and_nothing_is_not() {
        assert_eq!(
            content("  ", vec![photo("image/png", 100)], vec![])
                .unwrap()
                .len(),
            1
        );
        assert!(content("  ", vec![], vec![]).is_err());
    }

    #[test]
    fn a_heic_or_heif_original_goes_to_the_host_as_a_file_part() {
        for kind in ["image/heic", "image/heif"] {
            let parts = content("what is this?", vec![photo(kind, 3 * MIB)], vec![]).unwrap();
            assert_eq!(parts[1]["type"], "file");
            assert_eq!(parts[1]["mime"], kind);
        }
        assert!(content("x", vec![photo("image/heic", MAX_HEIC)], vec![]).is_ok());
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
        let Err(ApiError::BadRequest(said)) =
            content("x", vec![photo("image/heic", MAX_HEIC + 4)], vec![])
        else {
            panic!("a heic over the limit was taken");
        };
        // the size reads as the file the person has, and is never the limit's own number
        assert!(said.contains("is 9.1 mb, over the 9 mb"), "{said}");
        assert!(said.contains("export it as a jpeg"), "{said}");
        let Err(ApiError::BadRequest(heif)) =
            content("x", vec![photo("image/heif", MAX_HEIC + 1)], vec![])
        else {
            panic!("a heif over the limit was taken");
        };
        assert!(heif.starts_with("a heif photo is 9.1 mb"), "{heif}");
    }

    #[test]
    fn the_larger_limit_is_for_heic_and_heif_alone() {
        assert!(content("x", vec![photo("image/jpeg", MAX_PHOTO + 1)], vec![]).is_err());
        assert!(content("x", vec![photo("image/png", MAX_PHOTO + 1)], vec![]).is_err());
        assert!(content("x", vec![photo("image/webp", MAX_HEIC)], vec![]).is_err());
    }

    #[test]
    fn a_message_holds_two_heics_at_the_limit_and_not_a_third() {
        let two = vec![photo("image/heic", MAX_HEIC), photo("image/heif", MAX_HEIC)];
        assert!(content("x", two, vec![]).is_ok());
        let three = vec![
            photo("image/heic", MAX_HEIC),
            photo("image/heic", MAX_HEIC),
            photo("image/jpeg", 100),
        ];
        let Err(ApiError::BadRequest(said)) = content("x", three, vec![]) else {
            panic!("photos past the message's total were taken");
        };
        assert!(said.contains("add up to 18.1 mb"), "{said}");
        assert!(said.contains("over the 18 mb"), "{said}");
        let four: Vec<Photo> = (0..4).map(|_| photo("image/jpeg", MAX_PHOTO)).collect();
        assert!(content("x", four, vec![]).is_ok());
    }

    #[test]
    fn a_message_at_the_total_fits_the_body_the_routes_take() {
        let body = super::super::PROMPT_BODY;
        // json of a message at the text limit, every character a six-byte escape, and the photos at the total
        assert!(MAX_ATTACHMENTS_TOTAL + MAX_TEXT * 6 + 4096 <= body);
    }

    #[test]
    fn a_host_gets_longer_to_take_photos_than_words() {
        assert_eq!(accept_timeout(&[], &[]), ACCEPT_BASE);
        let jpeg = accept_timeout(&[photo("image/jpeg", MAX_PHOTO)], &[]);
        assert!(jpeg > ACCEPT_BASE && jpeg < ACCEPT_BASE + Duration::from_secs(10));
        let heic = accept_timeout(&[photo("image/heic", MAX_HEIC)], &[]);
        // 12 MiB over 256 KiB a second is 48 s, then the 75 s a conversion is given (cmx2's 60 s and a margin)
        assert_eq!(heic, ACCEPT_BASE + Duration::from_secs(48 + 75));
        let two = accept_timeout(
            &[photo("image/heic", MAX_HEIC), photo("image/heif", MAX_HEIC)],
            &[],
        );
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
        let parts = content("x", vec![photo("image/png", 100)], vec![]).unwrap();
        let body = message_body(parts, "c1");
        assert_eq!(body["clientID"], "c1");
        assert_eq!(body["parts"][1]["mime"], "image/png");
    }

    #[test]
    fn photos_the_composer_did_not_clamp_are_refused() {
        assert!(content("x", vec![photo("image/tiff", 100)], vec![]).is_err());
        assert!(content("x", vec![photo("image/jpeg", MAX_PHOTO + 1)], vec![]).is_err());
        let five: Vec<Photo> = (0..5).map(|_| photo("image/png", 100)).collect();
        assert!(content("x", five, vec![]).is_err());
        let lying = Photo {
            mime: "image/png".into(),
            filename: None,
            url: "data:image/jpeg;base64,AAAA".into(),
        };
        assert!(content("x", vec![lying], vec![]).is_err());
    }

    fn file(mime: &str, name: &str, bytes: usize) -> Document {
        let head = format!("data:{mime};base64,");
        Document {
            mime: mime.into(),
            filename: name.into(),
            // base64 of `bytes`: four characters for every three, the last group padded
            url: format!(
                "{head}{}{}",
                "A".repeat(bytes / 3 * 4),
                ["", "AA==", "AAA="][bytes % 3]
            ),
        }
    }

    #[test]
    fn a_pdf_text_or_json_file_goes_as_a_named_file_part_after_the_photos() {
        let files = vec![
            file("application/pdf", "booking.pdf", 3000),
            file("text/markdown", "notes.md", 300),
            file("application/json", "plan.json", 30),
        ];
        let parts = content("read these", vec![photo("image/png", 100)], files).unwrap();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[1]["mime"], "image/png");
        assert_eq!(parts[2]["type"], "file");
        assert_eq!(parts[2]["mime"], "application/pdf");
        assert_eq!(parts[2]["filename"], "booking.pdf");
        assert_eq!(parts[3]["filename"], "notes.md");
        assert_eq!(parts[4]["mime"], "application/json");
        for kind in ["text/plain", "text/csv", "text/x-python", "text/vnd.a+b"] {
            assert!(
                content("", vec![], vec![file(kind, "a", 10)]).is_ok(),
                "{kind}"
            );
        }
    }

    #[test]
    fn a_file_the_host_cannot_read_is_refused_by_its_name_and_kind() {
        for kind in [
            "application/zip",
            "image/png",
            "text/",
            "text/Plain",
            "text/html; charset=utf-8",
        ] {
            let Err(ApiError::BadRequest(said)) =
                content("x", vec![], vec![file(kind, "a.zip", 10)])
            else {
                panic!("a {kind} file was taken");
            };
            assert!(
                said.starts_with(&format!("a.zip is {kind}, which")),
                "{said}"
            );
        }
        let lying = Document {
            url: "data:text/plain;base64,AAAA".into(),
            ..file("application/pdf", "a.pdf", 3)
        };
        assert!(content("x", vec![], vec![lying]).is_err());
        for name in ["", "  ", "a\nb.md", &"a".repeat(MAX_FILENAME + 1)] {
            assert!(content("x", vec![], vec![file("text/plain", name, 3)]).is_err());
        }
    }

    #[test]
    fn a_file_goes_by_its_own_name_and_a_name_that_would_break_the_label_is_refused() {
        let named = |name: &str| content("", vec![], vec![file("text/plain", name, 3)]);
        // a path is cut to the name after its last slash or backslash
        for (sent, kept) in [
            ("../../etc/plan.md", "plan.md"),
            ("C:\\notes\\a.md", "a.md"),
            ("dir/b c.txt", "b c.txt"),
        ] {
            assert_eq!(named(sent).unwrap()[0]["filename"], kept, "{sent}");
        }
        // the limit is characters: a hundred cjk characters are three hundred bytes, and fit
        assert!(named(&"資".repeat(100)).is_ok());
        assert!(named(&"資".repeat(MAX_FILENAME + 1)).is_err());
        for name in [
            "a\"b.md",
            "<x>.md",
            "a>b",
            "evil\u{202e}dm.exe",
            "a\u{200b}b",
            "\u{feff}x",
            "dir/",
            "..",
            "a\u{2066}b",
        ] {
            let Err(ApiError::BadRequest(said)) = named(name) else {
                panic!("{name:?} was taken");
            };
            assert!(!said.contains('\u{202e}'), "{said}");
        }
    }

    #[test]
    fn a_text_file_must_be_utf8_and_a_pdf_need_not() {
        let latin1 = |mime: &str| Document {
            url: format!("data:{mime};base64,//4="),
            ..file(mime, "a", 2)
        };
        let Err(ApiError::BadRequest(said)) = content("", vec![], vec![latin1("text/plain")])
        else {
            panic!("a text file that is not utf-8 was taken");
        };
        assert_eq!(
            said,
            "a is not utf-8 text; save it as utf-8 and add it again"
        );
        assert!(content("", vec![], vec![latin1("application/json")]).is_err());
        assert!(content("", vec![], vec![latin1("application/pdf")]).is_ok());
        let text = Document {
            url: format!(
                "data:text/plain;base64,{}",
                Base64::encode_string("héllo, 資".as_bytes())
            ),
            ..file("text/plain", "a", 2)
        };
        assert!(content("", vec![], vec![text]).is_ok());
    }

    #[test]
    fn a_pdf_takes_up_to_9_mb_and_a_text_file_up_to_512_kb() {
        assert!(
            content(
                "",
                vec![],
                vec![file("application/pdf", "a.pdf", MAX_PDF_FILE)]
            )
            .is_ok()
        );
        let Err(ApiError::BadRequest(pdf)) = content(
            "",
            vec![],
            vec![file("application/pdf", "a.pdf", MAX_PDF_FILE + 1)],
        ) else {
            panic!("a pdf over its limit was taken");
        };
        assert!(
            pdf.contains("a.pdf is 9.1 mb, over the 9 mb a pdf goes at"),
            "{pdf}"
        );
        assert!(content("", vec![], vec![file("text/csv", "a.csv", MAX_TEXT_FILE)]).is_ok());
        let Err(ApiError::BadRequest(text)) = content(
            "",
            vec![],
            vec![file("text/csv", "a.csv", MAX_TEXT_FILE + 1)],
        ) else {
            panic!("a text file over its limit was taken");
        };
        assert!(
            text.contains("a.csv is 513 kb, over the 512 kb a text file goes at"),
            "{text}"
        );
    }

    #[test]
    fn photos_and_files_share_the_count_and_the_total() {
        let four: Vec<Document> = (0..4).map(|_| file("text/plain", "a", 10)).collect();
        assert!(content("x", vec![], four).is_ok());
        let three: Vec<Document> = (0..3).map(|_| file("text/plain", "a", 10)).collect();
        let Err(ApiError::BadRequest(said)) = content(
            "x",
            vec![photo("image/png", 100), photo("image/png", 100)],
            three,
        ) else {
            panic!("five on one message were taken");
        };
        assert!(said.contains("at most 4 photos and files"), "{said}");
        let pdfs = vec![
            file("application/pdf", "a.pdf", MAX_PDF_FILE),
            file("application/pdf", "b.pdf", MAX_PDF_FILE),
        ];
        assert!(content("x", vec![], pdfs).is_ok());
        let Err(ApiError::BadRequest(over)) = content(
            "x",
            vec![photo("image/heic", MAX_HEIC)],
            vec![
                file("application/pdf", "a.pdf", MAX_PDF_FILE),
                file("text/plain", "b", 10),
            ],
        ) else {
            panic!("files past the message's total were taken");
        };
        assert!(
            over.contains("photos and files on one message add up to"),
            "{over}"
        );
    }

    #[test]
    fn a_host_gets_time_to_read_a_pdf() {
        let text = accept_timeout(&[], &[file("text/plain", "a", 1000)]);
        assert_eq!(text, ACCEPT_BASE);
        let pdf = accept_timeout(&[], &[file("application/pdf", "a.pdf", MAX_PDF_FILE)]);
        // 12 MiB over 256 KiB a second is 48 s, then the 35 s cmx2's pdftotext is given and a margin
        assert_eq!(pdf, ACCEPT_BASE + Duration::from_secs(48 + 35));
    }

    #[test]
    fn a_file_is_sized_without_its_padding() {
        assert_eq!(file_bytes("data:text/plain;base64,AA=="), 1);
        assert_eq!(file_bytes("data:text/plain;base64,AAA="), 2);
        assert_eq!(size(512 * 1024), "512 kb");
        assert_eq!(size(MIB + 1), "1.1 mb");
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
