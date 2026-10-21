//! `GET /api/agents/{agent}/threads/{thread}/summary` (`docs/protocol.md`,
//! section 12): the thread's turn index, spawns, files and children, from
//! one streamed read, cached (`fleet/summary.rs`), etag on `v` and the
//! children's `v`.
//!
//! children are read at most `CHILD_READS` at a time, the first
//! `MAX_CHILDREN` of them, each within `CHILD_TIMEOUT` and all within
//! `CHILDREN_TIMEOUT`: a child past the count or the time, gone, failing or
//! slow is listed by its key alone, as the app shows a child it could not
//! read (no step count), and never fails the parent's summary. a child that
//! failed or ran late is not read again for `FAILED_FOR`.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::Found;
use super::find;
use super::read::{Versions, etag, names, stamp, versions};
use crate::fleet::summary::{At, Child, Computed, Failures, Fold, Spawn, Summary, Touched, Turn};
use crate::http::AppState;
use crate::http::error::{ApiError, ErrorBody};
use crate::source::{ThreadRef, VerbError};

/// children read for one summary, at most; the rest are listed by key.
pub const MAX_CHILDREN: usize = 64;
/// children read at once.
pub const CHILD_READS: usize = 4;
/// how long one child's read may take before it is listed by key.
pub const CHILD_TIMEOUT: Duration = Duration::from_secs(10);
/// how long one summary may spend on its children, all of them.
pub const CHILDREN_TIMEOUT: Duration = Duration::from_secs(15);

/// how a child came to be listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Seen {
    /// read, at this `v`.
    Read(Option<u64>),
    /// its read failed or ran late, now or within `FAILED_FOR`.
    Failed,
    /// past the count or the time: not asked.
    Unread,
}

/// a child as the summary lists it: its facts, or its key alone when it
/// could not be read.
#[derive(Serialize, Debug, PartialEq)]
struct ChildOut {
    key: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    facts: Option<Facts>,
    /// how it was listed, for the etag.
    #[serde(skip)]
    seen: Seen,
}

#[derive(Serialize, Debug, PartialEq)]
struct Facts {
    steps: u64,
    #[serde(serialize_with = "whole")]
    first: f64,
    #[serde(serialize_with = "whole")]
    end: f64,
}

/// a time in ms as an integer, as the fold writes it.
#[allow(clippy::trivially_copy_pass_by_ref, reason = "serde's signature")]
fn whole<S: serde::Serializer>(value: &f64, s: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "checked whole and in range"
        )]
        s.serialize_i64(*value as i64)
    } else {
        s.serialize_f64(*value)
    }
}

/// the summary as the route answers it.
#[derive(Serialize)]
struct Answer<'a> {
    key: &'a str,
    v: Option<u64>,
    rv: Option<u64>,
    total: u64,
    turns: &'a [Turn],
    spawns: &'a [Spawn],
    files: &'a [Touched],
    children: &'a [ChildOut],
}

/// the thread's summary.
#[utoipa::path(
    get,
    path = "/api/agents/{agent}/threads/{thread}/summary",
    params(("agent" = String, Path), ("thread" = String, Path)),
    responses(
        (status = 200, description = "the summary, `cache-control: private, no-cache`, etag on `v` and the children's `v`, with `x-boxbox-seq`", body = Object),
        (status = 304, description = "the `if-none-match` etag is the summary's"),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such agent or thread", body = ErrorBody),
        (status = 502, description = "the agent did not answer", body = ErrorBody),
    ),
)]
pub async fn summary(
    State(state): State<Arc<AppState>>,
    Path((agent, thread)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let found = find(&state, &agent)?;
    let target = ThreadRef {
        agent: found.key().to_owned(),
        id: thread.clone(),
    };
    let key = target.key();
    let now = versions(&state, &key).await?;
    let own = fold_of(&state, &found, &target, &now).await?;
    let children = children_of(&state, &found, &own.value.spawns).await;
    let tag = tag_of(&now, own.at.v, &children);
    if let Some(tag) = tag.as_deref()
        && names(&headers, tag)
    {
        return Ok(unchanged(&now, tag));
    }
    let answer = Answer {
        key: &key,
        v: own.at.v,
        rv: own.at.rv,
        total: own.value.total,
        turns: &own.value.turns,
        spawns: &own.value.spawns,
        files: &own.value.files,
        children: &children,
    };
    let body = serde_json::to_vec(&answer).map_err(|e| unreadable(&found, &thread, &e))?;
    let mut response = (StatusCode::OK, body).into_response();
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    if let Some(Ok(value)) = tag.as_deref().map(HeaderValue::from_str) {
        out.insert(header::ETAG, value);
    }
    stamp(&mut response, &now, None);
    Ok(response)
}

/// the etag: the thread's `v` with a short hash of each child's key and the
/// `v` its facts came from, or that it failed or was not read. none when
/// the thread or a child read has no `v`: such a body vouches for nothing.
fn tag_of(now: &Versions, v: Option<u64>, children: &[ChildOut]) -> Option<String> {
    let v = v?;
    let mut hash = Sha256::new();
    hash.update(b"summary");
    for child in children {
        let seen = match child.seen {
            Seen::Read(v) => v?.to_string(),
            Seen::Failed => "failed".to_owned(),
            Seen::Unread => "unread".to_owned(),
        };
        hash.update(format!("|{}:{seen}", child.key).as_bytes());
    }
    let q = data_encoding::HEXLOWER.encode(&hash.finalize()[..4]);
    Some(etag(now, v, &q))
}

/// each spawned child once, in spawn order.
async fn children_of(state: &AppState, found: &Found, spawns: &[Spawn]) -> Vec<ChildOut> {
    let mut keys: Vec<ThreadRef> = Vec::new();
    for id in spawns.iter().filter_map(|s| s.child.as_deref()) {
        if keys.iter().all(|k| k.id != id) {
            keys.push(ThreadRef {
                agent: found.key().to_owned(),
                id: id.to_owned(),
            });
        }
    }
    let out = gather(keys, Limits::default(), &state.summaries.failed, |child| {
        child_of(state, found, child)
    })
    .await;
    // a read cut by a timeout leaves its slot empty.
    state.summaries.children.sweep();
    out
}

/// the time children may take.
#[derive(Debug, Clone, Copy)]
struct Limits {
    each: Duration,
    all: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            each: CHILD_TIMEOUT,
            all: CHILDREN_TIMEOUT,
        }
    }
}

/// the first `MAX_CHILDREN` read `CHILD_READS` at a time, each within
/// `limits.each` and all within `limits.all`; the rest, and any that failed
/// or ran late (now or lately), by key alone.
async fn gather<F, Fut>(
    keys: Vec<ThreadRef>,
    limits: Limits,
    failed: &Failures,
    read: F,
) -> Vec<ChildOut>
where
    F: Fn(ThreadRef) -> Fut,
    Fut: std::future::Future<Output = Result<(Child, Option<u64>), ApiError>>,
{
    let listed = |key: String, seen: Seen| ChildOut {
        key,
        facts: None,
        seen,
    };
    let deadline = tokio::time::Instant::now() + limits.all;
    let read_now = keys.len().min(MAX_CHILDREN);
    let rest: Vec<ChildOut> = keys[read_now..]
        .iter()
        .map(|t| listed(t.key(), Seen::Unread))
        .collect();
    let mut out: Vec<ChildOut> = futures_util::stream::iter(keys.into_iter().take(read_now))
        .map(|child| {
            let key = child.key();
            let started = tokio::time::Instant::now();
            let left = deadline.saturating_duration_since(started).min(limits.each);
            let skip = if left.is_zero() {
                Some(Seen::Unread)
            } else if failed.lately(&key) {
                Some(Seen::Failed)
            } else {
                None
            };
            let read = skip.is_none().then(|| read(child));
            async move {
                let Some(read) = read else {
                    return listed(key, skip.unwrap_or(Seen::Unread));
                };
                if let Ok(Ok((c, v))) = tokio::time::timeout(left, read).await {
                    ChildOut {
                        key,
                        facts: Some(Facts {
                            steps: c.steps,
                            first: c.first,
                            end: c.end,
                        }),
                        seen: Seen::Read(v),
                    }
                } else {
                    failed.note(&key);
                    listed(key, Seen::Failed)
                }
            }
        })
        .buffered(CHILD_READS)
        .collect()
        .await;
    out.extend(rest);
    out
}

/// one child's facts, kept or from one streamed read of it.
async fn child_of(
    state: &AppState,
    found: &Found,
    child: ThreadRef,
) -> Result<(Child, Option<u64>), ApiError> {
    let key = child.key();
    let at = at_of(&versions(state, &key).await?);
    let c = state
        .summaries
        .children
        .get(&key, &at, || async {
            let summary = fold(found, &child, "").await?;
            let facts = summary.as_child(&key);
            Ok::<_, ApiError>(Computed::new(at.clone(), facts, 64 + key.len()))
        })
        .await?;
    Ok((c.value.clone(), c.at.v))
}

fn at_of(now: &Versions) -> At {
    At {
        epoch: now.at.epoch.clone(),
        v: now.v,
        rv: now.rv,
    }
}

fn unchanged(now: &Versions, tag: &str) -> Response {
    let mut response = StatusCode::NOT_MODIFIED.into_response();
    let out = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(tag) {
        out.insert(header::ETAG, value);
    }
    out.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    stamp(&mut response, now, None);
    response
}

fn unreadable(found: &Found, thread: &str, e: &serde_json::Error) -> ApiError {
    found.refusal(
        Some(thread),
        VerbError::Unreachable {
            reason: e.to_string(),
        },
    )
}

/// one streamed read of the thread, folded.
async fn fold(found: &Found, target: &ThreadRef, directory: &str) -> Result<Summary, ApiError> {
    let refuse = |e| found.refusal(Some(&target.id), e);
    let mut reading = found.source.read(target).await.map_err(refuse)?;
    let mut fold = Fold::new(directory);
    while let Some(message) = reading.messages.next().await {
        fold.push(&message.map_err(refuse)?);
    }
    Ok(fold.finish())
}

/// the thread's own fold: kept, or from one streamed read.
async fn fold_of(
    state: &AppState,
    found: &Found,
    target: &ThreadRef,
    now: &Versions,
) -> Result<Arc<Computed<Summary>>, ApiError> {
    let at = at_of(now);
    state
        .summaries
        .threads
        .get(&target.key(), &at, || async {
            // the directory file paths are shortened against; a source that
            // cannot say gives none, and paths stay as the agent wrote them.
            let directory = match found.source.thread(target).await {
                Ok(facts) => facts.place.map(|p| p.directory).unwrap_or_default(),
                Err(VerbError::NotBuilt(_) | VerbError::Unsupported(_)) => String::new(),
                Err(e) => return Err(found.refusal(Some(&target.id), e)),
            };
            let summary = fold(found, target, &directory).await?;
            let bytes = serde_json::to_vec(&(&summary.turns, &summary.spawns, &summary.files))
                .map_err(|e| unreadable(found, &target.id, &e))?
                .len();
            Ok(Computed::new(at.clone(), summary, bytes))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering::SeqCst;

    fn now(v: Option<u64>) -> Versions {
        Versions {
            at: crate::journal::Cursor::parse("e:1").unwrap(),
            v,
            rv: v,
            encoder: 1,
        }
    }

    fn child(key: &str, seen: Seen) -> ChildOut {
        ChildOut {
            key: key.into(),
            facts: matches!(seen, Seen::Read(_)).then_some(Facts {
                steps: 3,
                first: 1.0,
                end: 2.0,
            }),
            seen,
        }
    }

    #[allow(clippy::unnecessary_wraps, reason = "the shape a child read answers")]
    fn facts(t: &ThreadRef, steps: u64) -> Result<(Child, Option<u64>), ApiError> {
        Ok((
            Child {
                key: t.key(),
                steps,
                first: 1.0,
                end: 2.0,
            },
            Some(9),
        ))
    }

    fn tag(children: &[ChildOut]) -> Option<String> {
        tag_of(&now(Some(5)), Some(5), children)
    }

    #[test]
    fn the_etag_moves_with_any_child() {
        let a = tag(&[child("h:c1", Seen::Read(Some(7)))]).unwrap();
        assert_ne!(a, tag(&[child("h:c1", Seen::Read(Some(8)))]).unwrap());
        assert_eq!(a, tag(&[child("h:c1", Seen::Read(Some(7)))]).unwrap());
        assert_ne!(a, tag(&[]).unwrap());
        assert_ne!(a, tag(&[child("h:c1", Seen::Failed)]).unwrap());
    }

    #[test]
    fn a_failed_or_unread_child_keeps_the_etag_and_marks_it() {
        let failed = tag(&[child("h:c1", Seen::Failed)]).unwrap();
        let unread = tag(&[child("h:c1", Seen::Unread)]).unwrap();
        assert_ne!(failed, unread);
        assert_eq!(failed, tag(&[child("h:c1", Seen::Failed)]).unwrap());
    }

    #[test]
    fn a_summary_that_vouches_for_nothing_has_no_etag() {
        assert!(tag_of(&now(None), None, &[]).is_none());
        assert!(tag(&[child("h:c1", Seen::Read(None))]).is_none());
    }

    fn keys(n: usize) -> Vec<ThreadRef> {
        (0..n)
            .map(|i| ThreadRef {
                agent: "h".into(),
                id: format!("c{i}"),
            })
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn a_failing_or_slow_child_is_its_key_alone_remembered_and_the_rest_read() {
        let failed = Failures::default();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let read = |t: ThreadRef| {
            let reads = Arc::clone(&reads);
            async move {
                reads.fetch_add(1, SeqCst);
                match t.id.as_str() {
                    "c0" => Err(ApiError::Gone),
                    "c1" => {
                        tokio::time::sleep(CHILD_TIMEOUT * 2).await;
                        facts(&t, 1)
                    }
                    _ => facts(&t, 4),
                }
            }
        };
        let out = gather(keys(3), Limits::default(), &failed, read).await;
        assert_eq!(
            out.iter().map(|c| c.seen).collect::<Vec<_>>(),
            [Seen::Failed, Seen::Failed, Seen::Read(Some(9))]
        );
        assert!(out[0].facts.is_none() && out[1].facts.is_none());
        assert_eq!(out[2].facts.as_ref().map(|f| f.steps), Some(4));
        assert_eq!(reads.load(SeqCst), 3);
        // within FAILED_FOR, the two are listed without a read.
        let again = gather(keys(3), Limits::default(), &failed, read).await;
        assert_eq!(reads.load(SeqCst), 4);
        assert_eq!(again[0].seen, Seen::Failed);
        tokio::time::advance(crate::fleet::summary::FAILED_FOR).await;
        gather(keys(3), Limits::default(), &failed, read).await;
        assert_eq!(reads.load(SeqCst), 7);
    }

    #[tokio::test(start_paused = true)]
    async fn children_share_one_overall_deadline() {
        let failed = Failures::default();
        let started = tokio::time::Instant::now();
        // every child takes 9 s, under its own 10 s: 4 at once, so the
        // first four end at 9 s, the next four are cut at 15 s, the rest
        // are not asked.
        let out = gather(keys(12), Limits::default(), &failed, |t| async move {
            tokio::time::sleep(Duration::from_secs(9)).await;
            facts(&t, 2)
        })
        .await;
        assert!(started.elapsed() <= CHILDREN_TIMEOUT + Duration::from_millis(1));
        let seen: Vec<Seen> = out.iter().map(|c| c.seen).collect();
        assert!(
            seen[..4].iter().all(|s| *s == Seen::Read(Some(9))),
            "{seen:?}"
        );
        assert!(seen[4..8].iter().all(|s| *s == Seen::Failed), "{seen:?}");
        assert!(seen[8..].iter().all(|s| *s == Seen::Unread), "{seen:?}");
    }

    #[tokio::test]
    async fn children_past_the_count_are_not_read_and_at_most_a_few_read_at_once() {
        let failed = Failures::default();
        let running = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let most = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let out = gather(keys(MAX_CHILDREN + 5), Limits::default(), &failed, |t| {
            let (running, most, reads) =
                (Arc::clone(&running), Arc::clone(&most), Arc::clone(&reads));
            async move {
                reads.fetch_add(1, SeqCst);
                let n = running.fetch_add(1, SeqCst) + 1;
                most.fetch_max(n, SeqCst);
                tokio::time::sleep(Duration::from_millis(2)).await;
                running.fetch_sub(1, SeqCst);
                facts(&t, 1)
            }
        })
        .await;
        assert_eq!(out.len(), MAX_CHILDREN + 5);
        assert_eq!(reads.load(SeqCst), MAX_CHILDREN);
        assert!(most.load(SeqCst) <= CHILD_READS);
        assert!(out[MAX_CHILDREN..].iter().all(|c| c.seen == Seen::Unread));
    }

    #[test]
    fn a_child_not_read_is_its_key_alone() {
        let out = serde_json::to_value(child("h:c1", Seen::Failed)).unwrap();
        assert_eq!(out, serde_json::json!({"key": "h:c1"}));
        let out = serde_json::to_value(child("h:c1", Seen::Read(Some(1)))).unwrap();
        assert_eq!(
            out,
            serde_json::json!({"key": "h:c1", "steps": 3, "first": 1, "end": 2})
        );
    }
}
