//! a thread's reads under `/api/agents` (`docs/protocol.md`, section 11):
//! the whole thread, or one message, translated message by message as the
//! source streams it, never parsed whole, with `x-boxbox-seq` (the journal
//! head when the read started) and `x-boxbox-upstream` (the source event
//! the read reflects).

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::IntoParams;

use super::page::{Anchor, DEFAULT_TURNS, MAX_TURNS, Pager, Refused};

use super::find;
use crate::http::AppState;
use crate::http::error::{ApiError, ErrorBody};
use crate::source::{MessageWithParts, Stamp, ThreadRef, VerbError};
use crate::wire::{Message, Part, Role};

pub use crate::fleet::Versions;

/// the journal head and the thread's versions, from the fleet.
///
/// # Errors
/// the fleet is stopping.
pub async fn versions(state: &AppState, key: &str) -> Result<Versions, ApiError> {
    state
        .fleet
        .versions(key.to_owned())
        .await
        .map_err(|_| ApiError::Stopping)
}

/// a page query (`docs/protocol.md`, section 11): with none of `turns`,
/// `before` and `at`, the read answers the whole thread until the app
/// pages (a2), when no query becomes the newest 8 turns.
#[derive(Debug, Default, Deserialize, IntoParams)]
pub struct PageQuery {
    /// at most this many whole turns, 1 to 64 (8 when absent).
    pub turns: Option<u32>,
    /// only turns older than the turn this message is in.
    pub before: Option<String>,
    /// the turn holding this message or part, and up to `turns - 1` older.
    pub at: Option<String>,
    /// on an older page: the rewrite version the client expects, with the
    /// epoch it was read in, `<epoch>.<rv>`: a url the browser keeps for
    /// ever must not meet the same `rv` from another epoch.
    pub rv: Option<String>,
}

impl PageQuery {
    /// the page asked for, none for the whole thread.
    ///
    /// # Errors
    /// `turns` out of range, or both `before` and `at`.
    pub fn anchor(&self) -> Result<Option<Anchor>, ApiError> {
        if let Some(n) = self.turns
            && !(1..=MAX_TURNS).contains(&n)
        {
            return Err(ApiError::BadRequest(format!(
                "turns is {n}; ask for 1 to {MAX_TURNS}"
            )));
        }
        match (&self.before, &self.at) {
            (Some(_), Some(_)) => Err(ApiError::BadRequest(
                "a page is before a message or at one, not both".to_owned(),
            )),
            (Some(id), None) => Ok(Some(Anchor::Before(id.clone()))),
            (None, Some(id)) => Ok(Some(Anchor::At(id.clone()))),
            (None, None) => Ok(self.turns.map(|_| Anchor::Newest)),
        }
    }

    /// the short hash of the query that shapes the page; `rv` only makes it
    /// cacheable, so it stays out.
    #[must_use]
    pub fn hash(&self) -> String {
        let text = format!(
            "turns={}&before={}&at={}",
            self.turns.unwrap_or(DEFAULT_TURNS),
            self.before.as_deref().unwrap_or(""),
            self.at.as_deref().unwrap_or("")
        );
        data_encoding::HEXLOWER.encode(&Sha256::digest(text.as_bytes())[..4])
    }
}

/// the etag of a read: `"<encoder>.<epoch>.<v or rv>.<q>"`.
#[must_use]
pub fn etag(versions: &Versions, n: u64, q: &str) -> String {
    let epoch = &versions.at.epoch;
    format!("\"{}.{epoch}.{n}.{q}\"", versions.encoder)
}

/// whether an `if-none-match` names `etag`, weak or strong.
#[must_use]
pub fn names(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|t| t.strip_prefix("W/").unwrap_or(t) == etag)
}

/// a 304 for `etag`, with the read's own stamps.
fn unchanged(versions: &Versions, etag: &str, cache: &'static str) -> Response {
    let mut response = StatusCode::NOT_MODIFIED.into_response();
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(etag) {
        headers.insert(header::ETAG, value);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    stamp(&mut response, versions, None);
    response
}

const NO_CACHE: &str = "private, no-cache";
const IMMUTABLE: &str = "private, max-age=31536000, immutable";

/// a page of the thread: read whole as it streams, the page cut on the way.
///
/// a request naming the etag of `v` is answered 304 before the source is
/// asked: `v` unchanged means nothing in the thread changed. one naming the
/// etag of `rv` is not, since the same string can be the `v` etag of a page
/// holding the newest turn (`v` and `rv` share the form).
async fn paged(
    found: &super::Found,
    target: &ThreadRef,
    versions: &Versions,
    query: &PageQuery,
    anchor: Anchor,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let q = query.hash();
    if let Some(v) = versions.v {
        let tag = etag(versions, v, &q);
        if names(headers, &tag) {
            return Ok(unchanged(versions, &tag, NO_CACHE));
        }
    }
    // the newest page carries the btws: their list is read beside the
    // thread; a page anchored at a message learns it is the newest only at
    // its end, and reads them then
    let newest = anchor == Anchor::Newest;
    let (reading, mut btws) = if newest {
        let (reading, btws) = tokio::join!(found.source.read(target), btws_member(found, target));
        (reading, Some(btws))
    } else {
        (found.source.read(target).await, None)
    };
    let mut reading = reading.map_err(|e| found.refusal(Some(&target.id), e))?;
    let mut pager = Pager::new(anchor, query.turns.unwrap_or(DEFAULT_TURNS));
    while let Some(message) = reading.messages.next().await {
        let message = message.map_err(|e| found.refusal(Some(&target.id), e))?;
        pager.push(&message).map_err(|e| {
            found.refusal(
                Some(&target.id),
                VerbError::Unreachable {
                    reason: e.to_string(),
                },
            )
        })?;
    }
    let page = match pager.finish() {
        Ok(page) => page,
        Err(Refused::NoAnchor) => {
            let id = query
                .before
                .as_deref()
                .or(query.at.as_deref())
                .unwrap_or_default();
            return Err(ApiError::NoSuchMessage(id.to_owned()));
        }
        Err(Refused::TooLarge) => return Err(ApiError::PageTooLarge),
    };
    let (cache, tag) = cache_of(versions, query.rv.as_deref(), &page, &q);
    if page.newest && btws.is_none() {
        btws = Some(btws_member(found, target).await);
    }
    let btws = if page.newest {
        btws.unwrap_or_default()
    } else {
        Btws::default()
    };
    let (cache, tag) = whole_btws(cache, tag, &btws);
    let btws = btws.member;
    let older = serde_json::to_string(&page.older).unwrap_or_else(|_| "null".to_owned());
    let tail = Bytes::from(format!(
        "],\"older\":{older},\"total\":{},\"turns\":{}{btws}}}",
        page.total, page.turns
    ));
    // the page's messages go out as they are held, never copied into one
    // buffer.
    let commas = page
        .messages
        .into_iter()
        .enumerate()
        .flat_map(|(i, m)| [(i > 0).then(|| Bytes::from_static(b",")), Some(m)])
        .flatten();
    let parts = std::iter::once(Bytes::from_static(b"{\"messages\":["))
        .chain(commas)
        .chain(std::iter::once(tail))
        .map(Ok::<_, std::io::Error>);
    let mut response = Body::from_stream(futures_util::stream::iter(parts)).into_response();
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Some(Ok(value)) = tag.as_deref().map(HeaderValue::from_str) {
        out.insert(header::ETAG, value);
    }
    stamp(&mut response, versions, reading.upstream.as_ref());
    Ok(response)
}

/// the page's `cache-control` and etag (section 11, cache headers): the
/// newest page, or an older one holding the newest turn or an unfinished
/// answer, is `no-cache` on `v`; an older one asked with the current `rv`
/// is immutable on `rv`; any other older one is `no-cache` on `rv`. a
/// thread the server keeps no version for has no etag.
#[must_use]
pub fn cache_of(
    versions: &Versions,
    asked_rv: Option<&str>,
    page: &super::page::Page,
    q: &str,
) -> (&'static str, Option<String>) {
    if page.newest || page.in_rv_turn || page.unfinished {
        return (NO_CACHE, versions.v.map(|v| etag(versions, v, q)));
    }
    match versions.rv {
        Some(rv) if asked_rv == Some(rv_value(versions, rv).as_str()) => {
            (IMMUTABLE, Some(etag(versions, rv, q)))
        }
        Some(rv) => (NO_CACHE, Some(etag(versions, rv, q))),
        None => (NO_CACHE, None),
    }
}

/// the `rv` query value of an immutable page: `<epoch>.<rv>`.
#[must_use]
pub fn rv_value(versions: &Versions, rv: u64) -> String {
    let epoch = &versions.at.epoch;
    format!("{epoch}.{rv}")
}

/// a read's btws: the last member of its body, and whether it is whole.
#[derive(Debug, Default)]
struct Btws {
    /// `,"btws":[...]`, oldest first; empty when there are none to give.
    member: String,
    /// the list could not be read: the body lacks btws the thread has, so it
    /// goes without an etag, and a revalidation reads them again instead of
    /// a 304 keeping the read without them until the thread's version moves.
    failed: bool,
}

/// a read's cache headers once its btws are known: one whose btws could not
/// be read is `no-cache` with no etag, so the next look reads it again.
fn whole_btws(
    cache: &'static str,
    tag: Option<String>,
    btws: &Btws,
) -> (&'static str, Option<String>) {
    if btws.failed {
        (NO_CACHE, None)
    } else {
        (cache, tag)
    }
}

/// the thread's btws for a read; none for an agent without btw (or a
/// daemon that has said it has none), and none, marked failed, when the
/// list could not be read (logged): a thread read never fails for its btws,
/// and a client that gets none keeps the ones it holds.
async fn btws_member(found: &super::Found, target: &ThreadRef) -> Btws {
    if !found.facts.capabilities.btw {
        return Btws::default();
    }
    match found.source.btws(target).await {
        Ok(btws) => match serde_json::to_string(&btws) {
            Ok(list) => Btws {
                member: format!(",\"btws\":{list}"),
                failed: false,
            },
            Err(_) => Btws {
                member: String::new(),
                failed: true,
            },
        },
        Err(VerbError::Unsupported(_)) => Btws::default(),
        Err(error) => {
            tracing::warn!(
                agent = found.key(),
                thread = %target.id,
                %error,
                "a thread's btws could not be read; the read goes without them"
            );
            Btws {
                member: String::new(),
                failed: true,
            }
        }
    }
}

/// one message as a read answers it.
#[derive(Serialize)]
pub struct Out<'a> {
    pub info: &'a Message,
    pub parts: &'a [Part],
}

impl<'a> From<&'a MessageWithParts> for Out<'a> {
    fn from(m: &'a MessageWithParts) -> Self {
        Self {
            info: &m.info,
            parts: &m.parts,
        }
    }
}

/// counts turns as a thread's messages pass, oldest first: each user
/// message starts one, and messages before the first form turn 0.
#[derive(Debug, Default, Clone, Copy)]
pub struct Turns {
    pub messages: u64,
    pub turns: u64,
}

impl Turns {
    /// counts `role`; true when it starts a turn.
    pub fn count(&mut self, role: Role) -> bool {
        self.messages += 1;
        let starts = role == Role::User || self.turns == 0;
        if starts {
            self.turns += 1;
        }
        starts
    }
}

/// `x-boxbox-seq` and `x-boxbox-upstream` on a read's answer.
pub fn stamp(response: &mut Response, versions: &Versions, upstream: Option<&Stamp>) {
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&versions.at.to_string()) {
        headers.insert("x-boxbox-seq", value);
    }
    if let Some(Ok(value)) =
        upstream.map(|s| HeaderValue::from_str(&format!("{}:{}", s.epoch, s.seq)))
    {
        headers.insert("x-boxbox-upstream", value);
    }
}

fn thread_ref(found: &super::Found, thread: &str) -> ThreadRef {
    ThreadRef {
        agent: found.key().to_owned(),
        id: thread.to_owned(),
    }
}

/// the whole thread, `{messages, older, total, turns}`, oldest first,
/// streamed: the body is written message by message as the source reads.
#[utoipa::path(
    get,
    path = "/api/agents/{agent}/threads/{thread}/messages",
    params(("agent" = String, Path), ("thread" = String, Path)),
    responses(
        (status = 200, description = "the thread's messages, translated, with `x-boxbox-seq` and `x-boxbox-upstream`; `cache-control: private, no-cache` and an etag on the thread's version", body = Object),
        (status = 304, description = "`if-none-match` names the thread's version: nothing moved, the source was not asked"),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such agent or thread", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn messages(
    State(state): State<Arc<AppState>>,
    Path((agent, thread)): Path<(String, String)>,
    Query(query): Query<PageQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let found = find(&state, &agent)?;
    let target = thread_ref(&found, &thread);
    let versions = versions(&state, &target.key()).await?;
    if let Some(anchor) = query.anchor()? {
        return paged(&found, &target, &versions, &query, anchor, &headers).await;
    }
    let tag = whole_tag(&versions);
    if let Some(unchanged) = whole_unchanged(&versions, tag.as_deref(), &headers) {
        return Ok(unchanged);
    }
    let (reading, btws) = tokio::join!(found.source.read(&target), btws_member(&found, &target));
    let reading = reading.map_err(|e| found.refusal(Some(&thread), e))?;
    let upstream = reading.upstream.clone();
    let (_, tag) = whole_btws(NO_CACHE, tag, &btws);
    let body = whole(reading.messages, btws.member);
    let mut response = Body::from_stream(body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(NO_CACHE));
    if let Some(Ok(value)) = tag.as_deref().map(HeaderValue::from_str) {
        headers.insert(header::ETAG, value);
    }
    stamp(&mut response, &versions, upstream.as_ref());
    Ok(response)
}

/// the whole read's etag, on `v` like the newest page's (section 11); none
/// for a thread the journal holds no version for. its query part is
/// `whole`, never the normalised hash: no query normalises to 8 turns,
/// which until the app pages is another body under the same url shape.
fn whole_tag(versions: &Versions) -> Option<String> {
    versions.v.map(|v| etag(versions, v, WHOLE))
}

/// the query part of the whole read's etag.
const WHOLE: &str = "whole";

/// the 304 a whole read answers when the client holds what `v` names,
/// without asking the source.
fn whole_unchanged(
    versions: &Versions,
    tag: Option<&str>,
    headers: &HeaderMap,
) -> Option<Response> {
    let tag = tag?;
    names(headers, tag).then(|| unchanged(versions, tag, NO_CACHE))
}

/// the page shape around a whole read, written as the messages come: a
/// failure part way ends the body with an error, so a client never takes a
/// cut thread for a whole one.
fn whole(
    messages: futures_util::stream::BoxStream<'static, Result<MessageWithParts, VerbError>>,
    btws: String,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    let state = (messages, Turns::default(), false, false);
    futures_util::stream::unfold(state, move |(mut messages, mut turns, opened, ended)| {
        let btws = btws.clone();
        async move {
            if ended {
                return None;
            }
            if !opened {
                return Some((
                    Ok(Bytes::from_static(b"{\"messages\":[")),
                    (messages, turns, true, false),
                ));
            }
            match messages.next().await {
                Some(Ok(message)) => {
                    let first = turns.messages == 0;
                    turns.count(message.info.role);
                    let mut bytes = if first { Vec::new() } else { vec![b','] };
                    match serde_json::to_writer(&mut bytes, &Out::from(&message)) {
                        Ok(()) => Some((Ok(Bytes::from(bytes)), (messages, turns, true, false))),
                        Err(e) => {
                            Some((Err(std::io::Error::other(e)), (messages, turns, true, true)))
                        }
                    }
                }
                Some(Err(e)) => Some((
                    Err(std::io::Error::other(e.to_string())),
                    (messages, turns, true, true),
                )),
                None => Some((
                    Ok(Bytes::from(format!(
                        "],\"older\":null,\"total\":{},\"turns\":{}{btws}}}",
                        turns.messages, turns.turns
                    ))),
                    (messages, turns, true, true),
                )),
            }
        }
    })
    // fused: a body layer (gzip) polls again after the end, which an
    // unfold alone answers with a panic.
    .fuse()
}

/// one message of the thread, `{info, parts}`, as the agent has it now.
#[utoipa::path(
    get,
    path = "/api/agents/{agent}/threads/{thread}/messages/{message}",
    params(("agent" = String, Path), ("thread" = String, Path), ("message" = String, Path)),
    responses(
        (status = 200, description = "the message, translated, with `x-boxbox-seq` and `x-boxbox-upstream`; `cache-control: no-store`", body = Object),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such agent, thread or message", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn message(
    State(state): State<Arc<AppState>>,
    Path((agent, thread, message)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let found = find(&state, &agent)?;
    let target = thread_ref(&found, &thread);
    let versions = versions(&state, &target.key()).await?;
    let one = found
        .source
        .message(&target, &message)
        .await
        .map_err(|e| found.refusal(Some(&thread), e))?;
    let bytes = serde_json::to_vec(&Out::from(&one.data)).map_err(|e| {
        found.refusal(
            Some(&thread),
            VerbError::Unreachable {
                reason: e.to_string(),
            },
        )
    })?;
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    stamp(&mut response, &versions, one.upstream.as_ref());
    Ok(response)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::source::cmx2::verbs::read::element;

    /// a fixture thread's messages, translated, oldest first.
    pub(crate) fn fixture(name: &str) -> Vec<MessageWithParts> {
        let path = format!(
            "{}/../app/src/ui/thread/fixtures/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let whole: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        whole["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| element(&serde_json::to_vec(m).unwrap()).unwrap())
            .collect()
    }

    async fn body_of(messages: Vec<MessageWithParts>) -> Vec<u8> {
        let stream = futures_util::stream::iter(messages.into_iter().map(Ok)).boxed();
        let mut out = Vec::new();
        let mut body = std::pin::pin!(whole(stream, String::new()));
        while let Some(chunk) = body.next().await {
            out.extend_from_slice(&chunk.unwrap());
        }
        out
    }

    #[tokio::test]
    async fn a_whole_read_is_the_page_shape_with_every_message_once() {
        for name in ["cmx-deploy", "northstar-heavy"] {
            let messages = fixture(name);
            let body: serde_json::Value =
                serde_json::from_slice(&body_of(messages.clone()).await).unwrap();
            let got = body["messages"].as_array().unwrap();
            assert_eq!(got.len(), messages.len(), "{name}");
            for (g, m) in got.iter().zip(&messages) {
                assert_eq!(g, &serde_json::to_value(Out::from(m)).unwrap());
            }
            let users = messages
                .iter()
                .filter(|m| m.info.role == Role::User)
                .count() as u64;
            let lead = u64::from(messages.first().is_some_and(|m| m.info.role != Role::User));
            assert_eq!(body["turns"], users + lead, "{name}");
            assert_eq!(body["total"], messages.len() as u64);
            assert!(body["older"].is_null());
        }
    }

    #[tokio::test]
    async fn a_whole_read_ends_with_the_thread_s_btws_when_it_has_them() {
        let btws = r#","btws":[{"id":"btw_1"}]"#.to_owned();
        let stream = futures_util::stream::iter(fixture("cmx-deploy").into_iter().map(Ok)).boxed();
        let mut body = std::pin::pin!(whole(stream, btws));
        let mut out = Vec::new();
        while let Some(chunk) = body.next().await {
            out.extend_from_slice(&chunk.unwrap());
        }
        let read: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(read["btws"], serde_json::json!([{"id": "btw_1"}]));
        assert!(read["messages"].as_array().is_some_and(|m| !m.is_empty()));
        // without them the member is absent, not empty
        let empty: serde_json::Value = serde_json::from_slice(&body_of(Vec::new()).await).unwrap();
        assert!(empty.get("btws").is_none());
    }

    #[test]
    fn a_read_whose_btws_failed_goes_without_an_etag_so_it_is_read_again() {
        let tag = Some("\"1.x.5.whole\"".to_owned());
        let failed = Btws {
            member: String::new(),
            failed: true,
        };
        assert_eq!(
            whole_btws(IMMUTABLE, tag.clone(), &failed),
            (NO_CACHE, None)
        );
        let whole = Btws {
            member: ",\"btws\":[]".into(),
            failed: false,
        };
        assert_eq!(
            whole_btws(IMMUTABLE, tag.clone(), &whole),
            (IMMUTABLE, tag.clone())
        );
        // no btw at all is whole too: nothing is missing
        assert_eq!(
            whole_btws(NO_CACHE, tag.clone(), &Btws::default()),
            (NO_CACHE, tag)
        );
    }

    #[tokio::test]
    async fn a_whole_read_polled_past_its_end_stays_ended() {
        let mut body = std::pin::pin!(whole(
            futures_util::stream::iter(Vec::new()).boxed(),
            String::new()
        ));
        while body.next().await.is_some() {}
        assert!(body.next().await.is_none());
        assert!(body.next().await.is_none());
    }

    #[tokio::test]
    async fn an_empty_thread_reads_as_an_empty_page() {
        let body: serde_json::Value = serde_json::from_slice(&body_of(Vec::new()).await).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"messages": [], "older": null, "total": 0, "turns": 0})
        );
    }

    #[tokio::test]
    async fn a_read_that_fails_part_way_ends_the_body_with_an_error() {
        let mut items: Vec<Result<MessageWithParts, VerbError>> =
            fixture("cmx-deploy").into_iter().take(3).map(Ok).collect();
        items.push(Err(VerbError::Unreachable {
            reason: "cut".into(),
        }));
        let mut body = std::pin::pin!(whole(
            futures_util::stream::iter(items).boxed(),
            String::new()
        ));
        let mut failed = false;
        while let Some(chunk) = body.next().await {
            failed |= chunk.is_err();
        }
        assert!(failed);
    }
    fn at(v: Option<u64>, rv: Option<u64>) -> Versions {
        Versions {
            at: crate::journal::Cursor::parse("0a1b2c3d4e5f:90").unwrap(),
            v,
            rv,
            encoder: 1,
        }
    }

    fn page(newest: bool, in_rv_turn: bool, unfinished: bool) -> crate::http::agents::page::Page {
        crate::http::agents::page::Page {
            messages: Vec::new(),
            older: None,
            total: 0,
            turns: 0,
            newest,
            in_rv_turn,
            unfinished,
        }
    }

    #[test]
    fn a_whole_read_carries_the_etag_on_v_and_answers_304_when_it_is_named() {
        let held = at(Some(156), Some(40));
        let tag = whole_tag(&held).unwrap();
        assert_eq!(tag, "\"1.0a1b2c3d4e5f.156.whole\"");
        // the client names it: 304 with the etag, no-cache and x-boxbox-seq
        let mut asked = HeaderMap::new();
        asked.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_str(&format!("W/{tag}")).unwrap(),
        );
        let answer = whole_unchanged(&held, Some(&tag), &asked).unwrap();
        assert_eq!(answer.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(answer.headers()[header::ETAG], tag.as_str());
        assert_eq!(answer.headers()[header::CACHE_CONTROL], NO_CACHE);
        assert!(answer.headers().contains_key("x-boxbox-seq"));
        // a transcript entry moved v: the old tag no longer names it
        let moved = at(Some(157), Some(40));
        let fresh = whole_tag(&moved).unwrap();
        assert_ne!(fresh, tag);
        assert!(whole_unchanged(&moved, Some(&fresh), &asked).is_none());
        // no if-none-match, or no version held: the source is read
        assert!(whole_unchanged(&held, Some(&tag), &HeaderMap::new()).is_none());
        assert_eq!(whole_tag(&at(None, None)), None);
        // the whole read and the newest page of 8 turns never share a tag
        let eight = PageQuery {
            turns: Some(8),
            ..PageQuery::default()
        };
        assert_ne!(Some(etag(&held, 156, &eight.hash())), Some(tag));
    }

    #[test]
    fn the_cache_headers_follow_section_eleven() {
        let now = at(Some(120), Some(90));
        let q = "abcd0123";
        let settled_tag = Some(r#""1.0a1b2c3d4e5f.120.abcd0123""#.to_owned());
        let rewrite_tag = Some(r#""1.0a1b2c3d4e5f.90.abcd0123""#.to_owned());
        // the newest page, an older one in the newest turn, or a half answer: no-cache on v.
        for p in [
            page(true, true, false),
            page(false, true, false),
            page(false, false, true),
        ] {
            assert_eq!(
                cache_of(&now, Some("0a1b2c3d4e5f.90"), &p, q),
                (NO_CACHE, settled_tag.clone())
            );
        }
        // a settled older page at the current rv: immutable on rv.
        assert_eq!(
            cache_of(&now, Some("0a1b2c3d4e5f.90"), &page(false, false, false), q),
            (IMMUTABLE, rewrite_tag.clone())
        );
        // without rv, or with a stale one: no-cache on rv.
        assert_eq!(
            cache_of(&now, None, &page(false, false, false), q),
            (NO_CACHE, rewrite_tag.clone())
        );
        assert_eq!(
            cache_of(&now, Some("0a1b2c3d4e5f.80"), &page(false, false, false), q),
            (NO_CACHE, rewrite_tag)
        );
        // a thread the server keeps no version for: no etag.
        assert_eq!(
            cache_of(
                &at(None, None),
                Some("0a1b2c3d4e5f.90"),
                &page(false, false, false),
                q
            ),
            (NO_CACHE, None)
        );
        assert_eq!(
            cache_of(&at(None, None), None, &page(true, true, false), q),
            (NO_CACHE, None)
        );
    }

    #[test]
    fn an_if_none_match_names_an_etag_weak_or_strong_among_others() {
        let tag = r#""1.e.5.q""#;
        let mut headers = HeaderMap::new();
        assert!(!names(&headers, tag));
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static(r#""x", W/"1.e.5.q""#),
        );
        assert!(names(&headers, tag));
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static(r#""1.e.6.q""#),
        );
        assert!(!names(&headers, tag));
    }

    #[test]
    fn a_page_query_is_checked_and_hashed_without_rv() {
        let q = |turns, before: Option<&str>, at: Option<&str>, rv| PageQuery {
            turns,
            before: before.map(str::to_owned),
            at: at.map(str::to_owned),
            rv,
        };
        assert!(
            q(None, None, None, Some("e.3".to_owned()))
                .anchor()
                .unwrap()
                .is_none()
        );
        assert_eq!(
            q(Some(4), None, None, None).anchor().unwrap(),
            Some(Anchor::Newest)
        );
        assert_eq!(
            q(None, Some("m"), None, None).anchor().unwrap(),
            Some(Anchor::Before("m".into()))
        );
        assert_eq!(
            q(None, None, Some("p"), None).anchor().unwrap(),
            Some(Anchor::At("p".into()))
        );
        assert!(q(Some(0), None, None, None).anchor().is_err());
        assert!(q(Some(65), None, None, None).anchor().is_err());
        assert!(q(None, Some("m"), Some("p"), None).anchor().is_err());
        assert_eq!(
            q(None, Some("m"), None, Some("e.1".to_owned())).hash(),
            q(Some(8), Some("m"), None, Some("e.2".to_owned())).hash()
        );
        assert_ne!(
            q(None, Some("m"), None, None).hash(),
            q(None, None, Some("m"), None).hash()
        );
        assert_eq!(q(None, None, None, None).hash().len(), 8);
    }
}
