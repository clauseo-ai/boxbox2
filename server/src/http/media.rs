//! the media routes (`agents.md`, media): `POST /api/media` streams one
//! file of any kind into the store, and `GET`/`HEAD /api/media/{id}` serve
//! it back with ranges and immutable caching. the store, its caps and its
//! eviction are `media/`; this file is the http face and the one place a
//! media error becomes a status.
//!
//! every answer, refusals included, carries `nosniff` and the sandboxing
//! policy the repo icon route uses (`repo_icon::isolated`, layered where
//! the routes are registered), since an svg is a document.

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::AppState;
use super::error::{ErrorBody, ErrorDetail};
use crate::media::range::{self, Answer};
use crate::media::{
    BUSY_RETRY_S, Declared, Lookup, MEDIA_BODY, Media, MediaError, MediaObject, WAVEFORM_BYTES,
    clean_filename, is_id, normalize_mime,
};

/// the bytes each read of a served file takes; the body streams in these.
const READ_CHUNK: usize = 64 * 1024;
/// `cache-control` on a served file: the bytes behind an id never change.
const IMMUTABLE: &str = "private, max-age=31536000, immutable";

/// a refusal from these routes, in the shape every route's errors take.
#[derive(Debug)]
pub enum Refusal {
    BadRequest(String),
    NoSuchMedia,
    Evicted,
    Store(MediaError),
    Media(MediaError),
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad-request", message),
            Self::NoSuchMedia => (
                StatusCode::NOT_FOUND,
                "no-such-media",
                "boxbox holds no file with that id".to_owned(),
            ),
            Self::Evicted => (
                StatusCode::GONE,
                "media-evicted",
                "this file is no longer on the server: the media store made room for newer ones"
                    .to_owned(),
            ),
            Self::Store(e) => (StatusCode::SERVICE_UNAVAILABLE, "store-down", e.to_string()),
            Self::Media(e) => {
                let (status, code) = match &e {
                    MediaError::Busy => (StatusCode::SERVICE_UNAVAILABLE, "media-busy"),
                    MediaError::TooLarge { .. } => {
                        (StatusCode::PAYLOAD_TOO_LARGE, "media-too-large")
                    }
                    MediaError::Empty => (StatusCode::BAD_REQUEST, "bad-request"),
                    MediaError::Kind { .. } => (StatusCode::UNSUPPORTED_MEDIA_TYPE, "media-kind"),
                    MediaError::Full => (StatusCode::INSUFFICIENT_STORAGE, "media-full"),
                    MediaError::Source(_) => (StatusCode::BAD_REQUEST, "media-incomplete"),
                    MediaError::Disk(_) | MediaError::Store(_) | MediaError::Stopped => {
                        (StatusCode::SERVICE_UNAVAILABLE, "media-down")
                    }
                    MediaError::Stopping => (StatusCode::SERVICE_UNAVAILABLE, "stopping"),
                    // the sidecar's refusals; the upload never raises them
                    MediaError::Sidecar(_) | MediaError::NotAudio => {
                        (StatusCode::BAD_REQUEST, "bad-request")
                    }
                    MediaError::NoSuchMedia => (StatusCode::NOT_FOUND, "no-such-media"),
                };
                let busy = matches!(e, MediaError::Busy);
                let mut response = body(status, code, e.to_string());
                if busy {
                    response
                        .headers_mut()
                        .insert(header::RETRY_AFTER, HeaderValue::from(BUSY_RETRY_S));
                }
                return response;
            }
        };
        body(status, code, message)
    }
}

fn body(status: StatusCode, code: &'static str, message: String) -> Response {
    (
        status,
        Json(ErrorBody {
            error: ErrorDetail {
                code,
                message,
                settled: None,
            },
        }),
    )
        .into_response()
}

/// stores one file: the raw bytes of an image, audio, video or document.
#[utoipa::path(
    post,
    path = "/api/media",
    request_body(content = Vec<u8>, content_type = "*/*", description = "the file's raw bytes, at most 64 MiB. `content-type` is its type (`application/octet-stream` when absent); `x-boxbox-filename` its name, percent-encoded; for a voice note, `x-boxbox-duration-ms` and `x-boxbox-waveform` (base64 of at most 64 bytes)"),
    responses(
        (status = 201, description = "stored, or already held (the same answer for the same bytes)", body = MediaObject),
        (status = 400, description = "a header boxbox cannot read, an empty body, or a body that stopped arriving", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 413, description = "past 64 MiB, refused as the announced length or the bytes pass it", body = ErrorBody),
        (status = 415, description = "a declared image, audio or video type the bytes contradict, in words", body = ErrorBody),
        (status = 503, description = "`media-busy`: four uploads are running (with `retry-after`); or the store is not answering", body = ErrorBody),
        (status = 507, description = "`media-full`: nothing old enough to evict makes room; raise `[media] max_bytes`", body = ErrorBody),
    ),
)]
pub async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: Body,
) -> Response {
    take(&state.media, &headers, request).await
}

/// the upload, given the store: what the route and its tests share.
pub async fn take(media: &Media, headers: &HeaderMap, request: Body) -> Response {
    let declared = match declared(headers) {
        Ok(declared) => declared,
        Err(refusal) => return refusal.into_response(),
    };
    let stream = request
        .into_data_stream()
        .map(|chunk| chunk.map_err(|e| e.to_string()));
    match media.upload(stream, declared).await {
        Ok(stored) => (StatusCode::CREATED, Json(stored.object)).into_response(),
        Err(e) => Refusal::Media(e).into_response(),
    }
}

/// what the headers declare about the file.
fn declared(headers: &HeaderMap) -> Result<Declared, Refusal> {
    let text = |name: &str| -> Result<Option<&str>, Refusal> {
        headers
            .get(name)
            .map(|v| {
                v.to_str()
                    .map_err(|_| Refusal::BadRequest(format!("{name} is not plain text")))
            })
            .transpose()
    };
    let mime = match text(header::CONTENT_TYPE.as_str())? {
        None => "application/octet-stream".to_owned(),
        Some(raw) => normalize_mime(raw).ok_or_else(|| {
            Refusal::BadRequest(format!("content-type \"{raw}\" is not a media type"))
        })?,
    };
    let filename = match text("x-boxbox-filename")? {
        None => None,
        Some(raw) => {
            let decoded = percent_decode(raw).ok_or_else(|| {
                Refusal::BadRequest("x-boxbox-filename is not percent-encoded utf-8".into())
            })?;
            clean_filename(&decoded)
        }
    };
    let duration_ms = text("x-boxbox-duration-ms")?
        .map(|raw| {
            raw.trim().parse::<u64>().map_err(|_| {
                Refusal::BadRequest("x-boxbox-duration-ms is a whole number of milliseconds".into())
            })
        })
        .transpose()?;
    let waveform = text("x-boxbox-waveform")?
        .map(|raw| {
            data_encoding::BASE64
                .decode(raw.trim().as_bytes())
                .ok()
                .filter(|w| w.len() <= WAVEFORM_BYTES)
                .ok_or_else(|| {
                    Refusal::BadRequest(format!(
                        "x-boxbox-waveform is base64 of at most {WAVEFORM_BYTES} bytes"
                    ))
                })
        })
        .transpose()?;
    let length = text(header::CONTENT_LENGTH.as_str())?.and_then(|v| v.parse::<u64>().ok());
    if let Some(length) = length
        && length > MEDIA_BODY
    {
        return Err(Refusal::Media(MediaError::TooLarge {
            limit: MEDIA_BODY,
            got: Some(length),
        }));
    }
    Ok(Declared {
        mime,
        filename,
        duration_ms,
        waveform,
        width: None,
        height: None,
        length,
    })
}

/// `%xx` escapes to bytes, then utf-8. `None` for a broken escape or bytes
/// that are not utf-8.
fn percent_decode(raw: &str) -> Option<String> {
    let mut out = Vec::with_capacity(raw.len());
    let mut bytes = raw.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let high = char::from(bytes.next()?).to_digit(16)?;
            let low = char::from(bytes.next()?).to_digit(16)?;
            out.push(u8::try_from(high * 16 + low).ok()?);
        } else {
            out.push(b);
        }
    }
    String::from_utf8(out).ok()
}

/// a stored file, whole or one range of it.
#[utoipa::path(
    get,
    path = "/api/media/{id}",
    params(("id" = String, Path, description = "the media id: the sha256 of the bytes, 64 lowercase hex")),
    responses(
        (status = 200, description = "the whole file (also for several ranges), with `accept-ranges: bytes`, `cache-control: private, max-age=31536000, immutable`, `etag: \"<id>\"`, the stored `content-type` for image, audio, video and pdf (`application/octet-stream` for every other kind) and a `content-disposition` (inline for image, audio, video and pdf; attachment otherwise)", content_type = "*/*", body = Vec<u8>),
        (status = 206, description = "one `range: bytes=a-b`, with `content-range`", content_type = "*/*", body = Vec<u8>),
        (status = 304, description = "the `if-none-match` etag is current"),
        (status = 400, description = "id is not 64 lowercase hex", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "`no-such-media`: boxbox never held it", body = ErrorBody),
        (status = 410, description = "`media-evicted`: the store made room for newer files", body = ErrorBody),
        (status = 416, description = "the range starts past the end, with `content-range: bytes */<size>`"),
    ),
)]
pub async fn serve(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    give(&state.media, &id, &method, &headers).await
}

/// the serve, given the store: what the route and its tests share.
pub async fn give(media: &Media, id: &str, method: &Method, headers: &HeaderMap) -> Response {
    let started = Instant::now();
    let (response, bytes, first) = match answer(media, id, method, headers).await {
        Ok(served) => served,
        Err(refusal) => (refusal.into_response(), 0, true),
    };
    // one row per play or open, not per scrub: a range from the start, a
    // whole file or a refusal
    if first {
        let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        media.record_serve(ms, response.status().as_u16(), bytes);
    }
    response
}

async fn answer(
    media: &Media,
    id: &str,
    method: &Method,
    headers: &HeaderMap,
) -> Result<(Response, u64, bool), Refusal> {
    if !is_id(id) {
        return Err(Refusal::BadRequest(
            "a media id is 64 lowercase hex characters".into(),
        ));
    }
    let object = match media.lookup(id).await.map_err(Refusal::Store)? {
        Lookup::Ready(object) => object,
        Lookup::Evicted => return Err(Refusal::Evicted),
        Lookup::Unknown => return Err(Refusal::NoSuchMedia),
    };
    let etag = format!("\"{id}\"");
    let mut base = HeaderMap::new();
    base.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    base.insert(header::CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE));
    if let Ok(value) = HeaderValue::from_str(&etag) {
        base.insert(header::ETAG, value);
    }
    if matches(headers.get(header::IF_NONE_MATCH), &etag) {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        response.headers_mut().extend(base);
        return Ok((response, 0, false));
    }
    let size = object.size;
    let wanted = range::answer(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        size,
    );
    if wanted == Answer::Unsatisfiable {
        let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        response.headers_mut().extend(base);
        if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
            response.headers_mut().insert(header::CONTENT_RANGE, value);
        }
        return Ok((response, 0, false));
    }
    let (status, start, length) = match wanted {
        Answer::Part { start, end } => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        Answer::Whole | Answer::Unsatisfiable => (StatusCode::OK, 0, size),
    };
    let first = start == 0;
    let Some(path) = media.path_of(id) else {
        return Err(Refusal::BadRequest(
            "a media id is 64 lowercase hex characters".into(),
        ));
    };
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        // evicted between the lookup and the open
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Refusal::Evicted),
        Err(e) => return Err(Refusal::Media(MediaError::Disk(e))),
    };
    let mut response = if *method == Method::HEAD {
        Response::new(Body::empty())
    } else {
        if start > 0 {
            file.seek(std::io::SeekFrom::Start(start))
                .await
                .map_err(|e| Refusal::Media(MediaError::Disk(e)))?;
        }
        Response::new(Body::from_stream(stream(file, length)))
    };
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.extend(base);
    // an attachment kind goes out as bytes, never under its stored type: a
    // stored text/javascript must not be a same-origin script the day the app
    // allows `script-src 'self'`. the stored type stays in the json
    let served_type = if is_inline(&object.mime) {
        object.mime.as_str()
    } else {
        "application/octet-stream"
    };
    if let Ok(value) = HeaderValue::from_str(served_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    if status == StatusCode::PARTIAL_CONTENT
        && let Ok(value) =
            HeaderValue::from_str(&format!("bytes {start}-{}/{size}", start + length - 1))
    {
        headers.insert(header::CONTENT_RANGE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&disposition(&object)) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    Ok((response, length, first))
}

/// whether an `if-none-match` names this etag (or is `*`).
fn matches(header: Option<&HeaderValue>, etag: &str) -> bool {
    header.and_then(|v| v.to_str().ok()).is_some_and(|v| {
        v.split(',')
            .map(|t| t.trim().trim_start_matches("W/"))
            .any(|t| t == etag || t == "*")
    })
}

/// inline for what a browser shows in place, attachment for the rest, with
/// the filename (an ascii fallback and the utf-8 original).
fn disposition(object: &MediaObject) -> String {
    let kind = if is_inline(&object.mime) {
        "inline"
    } else {
        "attachment"
    };
    let Some(name) = &object.filename else {
        return kind.to_owned();
    };
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            encoded.push(char::from(b));
        } else {
            let _ = write!(encoded, "%{b:02X}");
        }
    }
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// what a browser shows in place: image, audio, video and pdf.
fn is_inline(mime: &str) -> bool {
    mime.starts_with("image/")
        || mime.starts_with("audio/")
        || mime.starts_with("video/")
        || mime == "application/pdf"
}

/// `length` bytes of `file` from where it stands, `READ_CHUNK` at a time.
fn stream(
    file: tokio::fs::File,
    length: u64,
) -> impl futures_util::Stream<Item = std::io::Result<Bytes>> + Send {
    futures_util::stream::try_unfold((file.take(length), length), |(mut file, left)| async move {
        if left == 0 {
            return Ok(None);
        }
        let mut buffer = vec![0; READ_CHUNK];
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "the file is shorter than its row says",
            ));
        }
        buffer.truncate(read);
        Ok(Some((Bytes::from(buffer), (file, left - read as u64))))
    })
}

#[cfg(test)]
mod tests;
