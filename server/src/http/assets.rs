//! the app: embedded in the binary for release, proxied to vite in dev.
//!
//! vite writes hashed files under `assets/`; they never change, so they are
//! cached forever. everything else is unhashed by design and revalidated on
//! every load: `index.html`, so a deploy is seen at the next launch; `sw.js`,
//! whose url is the service worker's identity and whose bytes change with
//! every build; the manifest and the home-screen icons, which an installed
//! app reads by fixed paths. the build precompresses text files (`.br`,
//! `.gz` beside each), and the server picks one by `Accept-Encoding`.
//! paths without an extension are the app's own routes and get the shell.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use reqwest::Url;
use rust_embed::Embed;

use super::AppState;
use super::error::ApiError;

#[derive(Embed)]
#[folder = "$BOXBOX_APP_DIST"]
struct App;

#[derive(Debug)]
pub enum Assets {
    Embedded,
    Vite {
        client: reqwest::Client,
        origin: Url,
    },
}

const SHELL: &str = "index.html";

/// the embedded app's build id: the start of its shell's hash, which
/// changes with every hashed asset it names. `None` when no app is
/// embedded (a dev build).
#[must_use]
pub fn build_id() -> Option<String> {
    let shell = App::get(SHELL)?;
    let hash = shell.metadata.sha256_hash();
    Some(
        hash.iter()
            .take(6)
            .fold(String::with_capacity(12), |mut id, b| {
                use std::fmt::Write;
                let _ = write!(id, "{b:02x}");
                id
            }),
    )
}
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const REVALIDATE: &str = "no-cache";

pub async fn serve(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if method != Method::GET && method != Method::HEAD {
        return Err(ApiError::NotFound);
    }
    if uri.path().starts_with("/api/") {
        return Err(ApiError::NotFound);
    }
    match &state.assets {
        Assets::Embedded => embedded(uri.path(), &headers),
        Assets::Vite { client, origin } => proxy(client, origin, &uri, &headers).await,
    }
}

fn embedded(path: &str, headers: &HeaderMap) -> Result<Response, ApiError> {
    let requested = path.trim_start_matches('/');
    let name = if requested.is_empty() {
        SHELL
    } else {
        requested
    };
    let (name, file) = match App::get(name) {
        Some(file) => (name, file),
        None if !has_extension(name) => (SHELL, App::get(SHELL).ok_or(ApiError::AppMissing)?),
        None if App::get(SHELL).is_none() => return Err(ApiError::AppMissing),
        None => return Err(ApiError::NotFound),
    };

    let hash = hex(&file.metadata.sha256_hash());
    let (encoding, body) = accepted_encodings(headers)
        .into_iter()
        .find_map(|(encoding, suffix)| {
            Some((Some(encoding), App::get(&format!("{name}.{suffix}"))?))
        })
        .map_or((None, file.data.clone()), |(encoding, compressed)| {
            (encoding, compressed.data)
        });
    let etag = format!(
        "\"{hash}{}\"",
        encoding.map_or(String::new(), |e| format!("-{e}"))
    );
    let cache = cache_policy(name);

    let mut response = if matches_etag(headers, &etag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Body::from(body).into_response()
    };
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        content_type(mime_of(name, file.metadata.mimetype())),
    );
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    out.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    out.insert(header::ETAG, header_value(&etag));
    if let Some(encoding) = encoding {
        out.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
    }
    Ok(response)
}

/// hashed files are immutable; every other file is read by a fixed path and
/// revalidated, so a new build is found the next time it is asked for.
fn cache_policy(name: &str) -> &'static str {
    if name.starts_with("assets/") {
        IMMUTABLE
    } else {
        REVALIDATE
    }
}

/// the type a file is served as. the web app manifest is named by the spec
/// rather than left to the guesser, since chromium reads the manifest by its
/// type before it decides the app can be installed.
fn mime_of<'a>(name: &str, guessed: &'a str) -> &'a str {
    if name.ends_with(".webmanifest") {
        "application/manifest+json"
    } else {
        guessed
    }
}

/// `br` before `gzip`, each only if the client takes it (a `q=0` refuses).
fn accepted_encodings(headers: &HeaderMap) -> Vec<(&'static str, &'static str)> {
    let offered = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let takes = |name: &str| {
        offered.split(',').any(|item| {
            let mut parts = item.split(';').map(str::trim);
            parts.next() == Some(name) && !parts.any(|p| p.replace(' ', "") == "q=0")
        })
    };
    [("br", "br"), ("gzip", "gz")]
        .into_iter()
        .filter(|(name, _)| takes(name))
        .collect()
}

fn matches_etag(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| value.split(',').any(|tag| tag.trim() == etag))
}

fn has_extension(name: &str) -> bool {
    name.rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'))
}

/// every text file vite writes is utf-8; saying so spares the browser a guess.
fn content_type(mime: &str) -> HeaderValue {
    let text = mime.starts_with("text/")
        || matches!(
            mime,
            "application/javascript"
                | "application/json"
                | "application/manifest+json"
                | "image/svg+xml"
        );
    if text {
        header_value(&format!("{mime}; charset=utf-8"))
    } else {
        header_value(mime)
    }
}

fn header_value(text: &str) -> HeaderValue {
    HeaderValue::from_str(text)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// dev only: forward the request to vite and stream its answer back. hot
/// reload's websocket goes to vite directly (see `app/vite.config.ts`).
async fn proxy(
    client: &reqwest::Client,
    origin: &Url,
    uri: &Uri,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let mut url = origin.clone();
    url.set_path(uri.path());
    url.set_query(uri.query());
    let mut request = client.get(url);
    for name in [
        header::ACCEPT,
        header::ACCEPT_ENCODING,
        header::IF_NONE_MATCH,
    ] {
        if let Some(value) = headers.get(&name) {
            request = request.header(name, value);
        }
    }
    let answer = request
        .send()
        .await
        .map_err(|e| ApiError::ViteDown(e.to_string()))?;
    let mut response = Response::builder().status(answer.status().as_u16());
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::ETAG,
        header::CONTENT_ENCODING,
    ] {
        if let Some(value) = answer.headers().get(name.as_str()) {
            response = response.header(name, value.as_bytes());
        }
    }
    response
        .body(Body::from_stream(answer.bytes_stream()))
        .map_err(|e| ApiError::ViteDown(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(name: header::HeaderName, value: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(name, HeaderValue::from_static(value));
        headers
    }

    #[test]
    fn prefers_brotli_and_honours_refusals() {
        let take = |v| accepted_encodings(&with(header::ACCEPT_ENCODING, v));
        assert_eq!(take("gzip, deflate, br"), [("br", "br"), ("gzip", "gz")]);
        assert_eq!(take("gzip"), [("gzip", "gz")]);
        assert_eq!(take("br;q=0, gzip;q=1"), [("gzip", "gz")]);
        assert!(take("identity").is_empty());
        assert!(accepted_encodings(&HeaderMap::new()).is_empty());
    }

    #[test]
    fn app_routes_get_the_shell_and_files_do_not() {
        assert!(!has_extension("t/desk:ses_1"));
        assert!(has_extension("assets/index-abc123.js"));
        assert!(has_extension("favicon.svg"));
    }

    #[test]
    fn text_is_declared_utf8_and_binaries_are_not() {
        assert_eq!(content_type("text/html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("text/javascript"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("font/woff2"), "font/woff2");
    }

    #[test]
    fn only_hashed_files_are_immutable() {
        assert_eq!(cache_policy("assets/index-abc123.js"), IMMUTABLE);
        assert_eq!(cache_policy("assets/boxbox-sans-abc.woff2"), IMMUTABLE);
        for unhashed in [
            "index.html",
            "sw.js",
            "manifest.webmanifest",
            "icon.svg",
            "icons/icon-192.png",
            "icons/apple-touch-icon.png",
        ] {
            assert_eq!(cache_policy(unhashed), REVALIDATE, "{unhashed}");
        }
    }

    #[test]
    fn the_manifest_is_served_as_a_manifest() {
        assert_eq!(
            mime_of("manifest.webmanifest", "application/octet-stream"),
            "application/manifest+json"
        );
        assert_eq!(
            content_type(mime_of("manifest.webmanifest", "")),
            "application/manifest+json; charset=utf-8"
        );
        assert_eq!(mime_of("icons/icon-192.png", "image/png"), "image/png");
        assert_eq!(
            content_type(mime_of("sw.js", "text/javascript")),
            "text/javascript; charset=utf-8"
        );
    }

    #[test]
    fn etags_match_in_a_list() {
        assert!(matches_etag(
            &with(header::IF_NONE_MATCH, "\"a\", \"b-br\""),
            "\"b-br\""
        ));
        assert!(!matches_etag(
            &with(header::IF_NONE_MATCH, "\"b\""),
            "\"b-br\""
        ));
    }
}
