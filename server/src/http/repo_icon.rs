//! `GET /api/hosts/{host}/repo-icon`: a repo's favicon, so the app can wear
//! it beside the repo's name. the contract the app relies on is small: 200
//! is an image, anything else means "no icon, show the fallback". the
//! lookup, its caches and what each ending is worth are `icons/mod.rs`.
//!
//! the root is the project root, never a worktree's directory: every
//! worktree of a repo shares one icon, and a root is what a host proves.
//! svgs can carry script; the app loads them through `<img>` only, and
//! `isolated` (a layer on this route alone, outside its sign-in check) puts
//! on every answer the headers that make a browser that opens one on its
//! own refuse to run it.

use std::sync::Arc;

use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use utoipa::IntoParams;

use super::error::{ApiError, ErrorBody};
use super::session::find_host;
use super::{AppState, RequestId};
use crate::icons::{
    Answer, BARREN_TTL, Class, HIT_TTL, Icon, REFUSED_MAX_AGE, UNPROVEN_MAX_AGE, UNSUPPORTED_TTL,
};

#[derive(Debug, Deserialize, IntoParams)]
// query parameters, not path ones: without this the document puts them in the path and the typed client cannot call it
#[into_params(parameter_in = Query)]
pub struct IconQuery {
    /// the repo's project root on the host, absolute. a worktree's directory finds no icon: ask for the root.
    root: String,
}

/// a repo's favicon from its host, or 404 when there is none to show.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/repo-icon",
    params(
        ("host" = String, Path, description = "the host's name in boxbox.toml"),
        IconQuery,
    ),
    responses(
        (status = 200, description = "the image, with its content type found from its bytes; `cache-control: private, max-age=21600` and an `etag`", content_type = "image/*", body = Vec<u8>),
        (status = 304, description = "the `if-none-match` etag is current"),
        (status = 400, description = "root is not an absolute path, or is `/`", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no icon to show, with no body (an unknown host answers the usual json error instead). `x-repo-icon` says why (none, unproven, unsupported, refused, retry) and `cache-control` how long to believe it: 30 minutes when the repo was searched, 60 seconds for a root the host has not shown to be real, 5 minutes when the host cannot read files yet, an hour for the host user's home or a directory above it (never listed), `no-store` when the search could not finish"),
    ),
)]
pub async fn repo_icon(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
    Query(query): Query<IconQuery>,
    request: Option<Extension<RequestId>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let root = project_root(&query.root)?;
    let host = find_host(&state, &host)?;
    let request = request.map(|Extension(RequestId(id))| id);
    let answer = state.icons.lookup(host, root, request).await;
    Ok(respond(&answer, headers.get(header::IF_NONE_MATCH)))
}

/// the root as a lookup keys it: absolute, no trailing slash, nothing a
/// header or a path could not carry. `/` is no project: a lookup of it would
/// be a walk of the whole disk.
fn project_root(raw: &str) -> Result<String, ApiError> {
    let fits = raw.starts_with('/')
        && !raw.trim_end_matches('/').is_empty()
        && raw.len() <= 4096
        && !raw.contains(['\0', '\n', '\r'])
        && raw.split('/').all(|part| part != "..");
    if !fits {
        return Err(ApiError::BadRequest(
            "root is the project's absolute path on the host".into(),
        ));
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

/// what an svg opened on its own, not through `<img>`, may do: nothing runs,
/// nothing loads, and the document is sandboxed.
pub const POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/// on every answer this route gives, errors and the sign-in refusal included:
/// a browser must not sniff a body into something else, and an svg opened on
/// its own is held to `POLICY`.
pub async fn isolated(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(POLICY),
    );
    response
}

fn respond(answer: &Answer, if_none_match: Option<&HeaderValue>) -> Response {
    let mut response = match (&answer.icon, answer.class) {
        (Some(icon), Class::Hit) => image(icon, if_none_match),
        _ => StatusCode::NOT_FOUND.into_response(),
    };
    let headers = response.headers_mut();
    let (cache, why) = match answer.class {
        Class::Hit => (format!("private, max-age={}", HIT_TTL.as_secs()), "hit"),
        Class::Barren => (format!("private, max-age={}", BARREN_TTL.as_secs()), "none"),
        Class::Unproven => (
            format!("private, max-age={}", UNPROVEN_MAX_AGE.as_secs()),
            "unproven",
        ),
        Class::Unsupported => (
            format!("private, max-age={}", UNSUPPORTED_TTL.as_secs()),
            "unsupported",
        ),
        Class::Refused => (
            format!("private, max-age={}", REFUSED_MAX_AGE.as_secs()),
            "refused",
        ),
        Class::Transient => ("no-store".to_owned(), "retry"),
    };
    // plain ascii built here, so the conversions cannot fail
    if let Ok(value) = HeaderValue::from_str(&cache) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert("x-repo-icon", HeaderValue::from_static(why));
    response
}

fn image(icon: &Icon, if_none_match: Option<&HeaderValue>) -> Response {
    let etag = HeaderValue::from_str(&icon.etag).ok();
    let mut response = if if_none_match.is_some_and(|sent| current(sent, &icon.etag)) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        // `Bytes` clones by reference: the cache's copy is what is sent
        let mut full = Response::new(axum::body::Body::from(icon.bytes.clone()));
        full.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(icon.content_type),
        );
        full
    };
    if let Some(etag) = etag {
        response.headers_mut().insert(header::ETAG, etag);
    }
    response
}

/// whether `if-none-match` names the icon's etag (weak or strong), or `*`.
fn current(sent: &HeaderValue, etag: &str) -> bool {
    let Ok(sent) = sent.to_str() else {
        return false;
    };
    sent.split(',').map(str::trim).any(|candidate| {
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == etag
    })
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use bytes::Bytes;

    use super::*;

    fn icon() -> Arc<Icon> {
        Arc::new(Icon {
            bytes: Bytes::from_static(b"\x89PNG\r\n\x1a\nxx"),
            content_type: "image/png",
            etag: "\"abc\"".into(),
        })
    }

    fn answer(class: Class) -> Answer {
        Answer {
            class,
            icon: (class == Class::Hit).then(icon),
        }
    }

    fn header_of<'a>(response: &'a Response, name: &str) -> &'a str {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }

    #[tokio::test]
    async fn a_hit_is_the_image_with_its_sniffed_type_and_six_hours() {
        let response = respond(&answer(Class::Hit), None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(header_of(&response, "content-type"), "image/png");
        assert_eq!(
            header_of(&response, "cache-control"),
            "private, max-age=21600"
        );
        assert_eq!(header_of(&response, "etag"), "\"abc\"");
        assert_eq!(header_of(&response, "x-repo-icon"), "hit");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(body.starts_with(b"\x89PNG"));
    }

    #[tokio::test]
    async fn the_isolating_layer_forbids_sniffing_and_sandboxes_whatever_it_wraps() {
        let policy = POLICY;
        let mut answers = vec![
            respond(&answer(Class::Hit), None),
            respond(&answer(Class::Barren), None),
            ApiError::BadRequest("root is wrong".into()).into_response(),
            ApiError::UnknownHost("nope".into()).into_response(),
            ApiError::SignInFirst.into_response(),
        ];
        for response in answers.drain(..) {
            let response = isolated(response).await;
            assert_eq!(header_of(&response, "x-content-type-options"), "nosniff");
            assert_eq!(header_of(&response, "content-security-policy"), policy);
        }
    }

    #[test]
    fn each_class_of_no_icon_is_a_404_cached_for_what_it_is_worth() {
        let cases = [
            (Class::Barren, "private, max-age=1800", "none"),
            (Class::Unproven, "private, max-age=60", "unproven"),
            (Class::Unsupported, "private, max-age=300", "unsupported"),
            (Class::Refused, "private, max-age=3600", "refused"),
            (Class::Transient, "no-store", "retry"),
        ];
        for (class, cache, why) in cases {
            let response = respond(&answer(class), None);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{class:?}");
            assert_eq!(header_of(&response, "cache-control"), cache, "{class:?}");
            assert_eq!(header_of(&response, "x-repo-icon"), why, "{class:?}");
            assert!(response.headers().get("content-type").is_none());
        }
    }

    #[test]
    fn a_current_etag_is_a_304_with_no_body_and_the_same_headers() {
        let sent = HeaderValue::from_static("\"abc\"");
        let response = respond(&answer(Class::Hit), Some(&sent));
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(header_of(&response, "etag"), "\"abc\"");
        assert_eq!(
            header_of(&response, "cache-control"),
            "private, max-age=21600"
        );
        assert!(response.headers().get("content-type").is_none());
    }

    #[test]
    fn an_if_none_match_that_is_stale_gets_the_image() {
        let stale = HeaderValue::from_static("\"old\"");
        assert_eq!(
            respond(&answer(Class::Hit), Some(&stale)).status(),
            StatusCode::OK
        );
    }

    #[test]
    fn if_none_match_takes_weak_tags_lists_and_a_star() {
        let is = |sent: &'static str| current(&HeaderValue::from_static(sent), "\"abc\"");
        assert!(is("W/\"abc\""));
        assert!(is("\"x\", \"abc\""));
        assert!(is("*"));
        assert!(!is("\"abcd\""));
        assert!(!is(""));
    }

    #[test]
    fn a_root_is_absolute_and_loses_its_trailing_slash() {
        assert_eq!(project_root("/work/app/").unwrap(), "/work/app");
        assert_eq!(project_root("/work/app").unwrap(), "/work/app");
    }

    #[test]
    fn a_root_that_is_not_a_plain_absolute_path_is_refused() {
        for bad in [
            "",
            "/",
            "//",
            "work/app",
            "~/app",
            "/work/../etc",
            "/work/app\n/x",
            "/work/\0",
            &format!("/{}", "a".repeat(4096)),
        ] {
            assert!(project_root(bad).is_err(), "{bad:?}");
        }
    }
}
