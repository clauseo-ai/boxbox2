//! history: every thread the daemons know, newest first, past home's 12
//! hours and including the ones cleared off home (`docs/home.md`,
//! history).
//!
//! the fleet holds only each host's newest 300 threads
//! (`upstream/reconcile.rs`), so history is read through the server, one
//! page at a time, and the fleet's snapshot does not grow. each page asks
//! every host for its threads older than the cursor and merges them.
//!
//! a search is over the title and the repo (the project's last path
//! segment). the daemon can match a title but not a repo, so a search reads
//! unfiltered pages and keeps what matches, at most `SCAN_PAGES` pages of
//! `PAGE` threads per host per request; when that ends before a host has,
//! the cursor continues from where it stopped, and an empty page with a
//! cursor means "keep looking".
//!
//! the cursor is the key of the last thread a page showed: its `time.updated`,
//! its machine and its id, `<updated>:<host>:<id>`. threads are ordered by
//! that key, newest first, so threads updated in the same millisecond keep a
//! place and a page edge between them loses none. cmx2's `before` is
//! exclusive and its listing orders by `updated desc, id desc`, so each
//! read asks for `before = updated + 1` and skips what the cursor already
//! passed. a run of threads sharing one millisecond that is longer than a
//! page cannot be passed that way (cmx2 has no keyset on `/session`; see
//! `cmx2-asks.md`): the rest of that millisecond is dropped, and only a bulk
//! import makes that happen.

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::{Query, State};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::value::RawValue;
use tracing::{info, warn};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::agents;
use super::error::{ApiError, ErrorBody};
use crate::fleet::model::session_key;
use crate::source::cmx2::Cmx2Source;
use crate::wire::Capability;

/// threads in a page unless the client asks for fewer.
const DEFAULT_LIMIT: usize = 30;
/// the most a page holds.
const MAX_LIMIT: usize = 100;
/// threads read from a host per call while searching.
const PAGE: usize = 100;
/// calls per host per request while searching: 400 threads a host.
const SCAN_PAGES: usize = 4;
/// the most threads cmx2 lists in one call (its `limit` maximum).
const MAX_DAEMON_PAGE: usize = 1000;
/// the longest search the server will match.
const MAX_QUERY: usize = 200;

#[derive(Debug, Deserialize, IntoParams)]
// query parameters, not path ones: without this the document puts them in the path and the typed client cannot call it
#[into_params(parameter_in = Query)]
pub struct HistoryQuery {
    /// matches a thread's title or its repo, any case.
    q: Option<String>,
    /// only this machine's threads.
    host: Option<String>,
    /// the cursor a page answered with (`next`): threads after it, newest first.
    before: Option<String>,
    /// threads in the page, 1 to 100; 30 when absent.
    limit: Option<usize>,
}

/// one thread of history. its status, asks and tail are the fleet's, for a
/// thread the fleet holds; the rest is the daemon's listing.
#[derive(Debug, Serialize, ToSchema)]
pub struct HistoryRow {
    /// `<host>:<sessionID>`.
    pub key: String,
    pub host: String,
    /// cmx2's `SessionInfo`, as the daemon wrote it.
    #[schema(value_type = Object)]
    pub info: Box<RawValue>,
    /// the thread is cleared off home now.
    pub cleared: bool,
}

/// a machine that did not answer, and why.
#[derive(Debug, Serialize, ToSchema)]
pub struct Unreached {
    pub host: String,
    pub reason: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HistoryPage {
    /// newest first.
    pub rows: Vec<HistoryRow>,
    /// where the next page starts (`before`); absent at the end. opaque: send
    /// it back as it came. a page can be empty with a cursor: a search that
    /// matched nothing yet.
    pub next: Option<String>,
    /// machines left out of this page.
    pub unreached: Vec<Unreached>,
}

/// what the daemon's listing says of a thread, read loosely.
#[derive(Deserialize)]
struct Facts {
    id: String,
    title: String,
    #[serde(rename = "projectID")]
    project_id: String,
    time: Times,
}

#[derive(Deserialize)]
struct Times {
    updated: f64,
}

/// where a thread stands in history's order: newest first, ties by machine
/// then id, both descending. a bigger key is newer.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    updated: u64,
    host: String,
    id: String,
}

impl Key {
    /// `<updated>:<host>:<id>`, which a machine's name and a session id never confuse.
    fn cursor(&self) -> String {
        format!("{}:{}:{}", self.updated, self.host, self.id)
    }

    fn parse(cursor: &str) -> Option<Key> {
        let mut parts = cursor.splitn(3, ':');
        let updated = parts.next()?.parse().ok()?;
        let host = parts.next()?.to_owned();
        let id = parts.next()?.to_owned();
        (!host.is_empty()).then_some(Key { updated, host, id })
    }
}

/// how far into one millisecond a host's read has gone.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Tie {
    /// every thread of that millisecond is still to read.
    All,
    /// those with an id below this one are.
    Below(String),
    /// none: the millisecond is done.
    Nothing,
}

/// where one host's read stands: the threads still to read are those older
/// than `updated`, and those of `updated` that `tie` allows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Edge {
    updated: u64,
    tie: Tie,
}

impl Edge {
    /// the edge a cursor sets for `host`.
    fn after(cursor: &Key, host: &str) -> Edge {
        let tie = match host.cmp(cursor.host.as_str()) {
            std::cmp::Ordering::Greater => Tie::Nothing,
            // an empty id is a millisecond that machine is done with (`advance`)
            std::cmp::Ordering::Equal if cursor.id.is_empty() => Tie::Nothing,
            std::cmp::Ordering::Equal => Tie::Below(cursor.id.clone()),
            std::cmp::Ordering::Less => Tie::All,
        };
        Edge {
            updated: cursor.updated,
            tie,
        }
    }

    fn allows(&self, updated: u64, id: &str) -> bool {
        updated < self.updated
            || (updated == self.updated
                && match &self.tie {
                    Tie::All => true,
                    Tie::Below(below) => id < below.as_str(),
                    Tie::Nothing => false,
                })
    }

    /// the daemon's exclusive `before` that still lists what the edge allows.
    fn before(&self) -> u64 {
        match self.tie {
            Tie::Nothing => self.updated,
            Tie::All | Tie::Below(_) => self.updated + 1,
        }
    }
}

/// the page size cmx2 is asked for again when a full page holds one millisecond only: the run it belongs to may go on
/// past it, and cmx2 lists a run only by the page that holds it. none once the page is at its largest, or when the
/// page shows more than one millisecond.
fn wider(size: usize, stamps: &[u64]) -> Option<usize> {
    let one_ms = stamps.len() > 1 && stamps.windows(2).all(|w| w[0] == w[1]);
    (one_ms && size < MAX_DAEMON_PAGE).then(|| (size * 4).min(MAX_DAEMON_PAGE))
}

/// where a host's read stands after a page whose oldest row was `id` at
/// `updated`, and the key the merge may rely on: a page that held something
/// past the edge walks on from its last row; one that held nothing (the
/// cursor was at the end of a run that fills a page) leaves that millisecond
/// done. a run longer than a page, entered in the middle, drops the rest of
/// its millisecond here, which cmx2's listing cannot avoid (`cmx2-asks.md`).
fn advance(passed: bool, host: &str, updated: u64, id: String) -> (Edge, Key) {
    let (tie, key_id) = if passed {
        (Tie::Below(id.clone()), id)
    } else {
        (Tie::Nothing, String::new())
    };
    let key = Key {
        updated,
        host: host.to_owned(),
        id: key_id,
    };
    (Edge { updated, tie }, key)
}

/// a thread read from a host, with what ordering and matching need.
#[derive(Debug)]
struct Found {
    host: String,
    id: String,
    updated: u64,
    info: Box<RawValue>,
}

impl Found {
    fn key(&self) -> Key {
        Key {
            updated: self.updated,
            host: self.host.clone(),
            id: self.id.clone(),
        }
    }
}

#[derive(Debug)]
struct Scan {
    host: String,
    found: Vec<Found>,
    /// the oldest key this host was read down to, when it has more behind
    /// it; absent when it was read to its end.
    reached: Option<Key>,
    failed: Option<String>,
}

/// a page of history: every machine's threads older than the cursor, newest
/// first, with the cleared ones marked.
#[utoipa::path(
    get,
    path = "/api/history",
    params(HistoryQuery),
    responses(
        (status = 200, description = "a page, and the cursor for the next", body = HistoryPage),
        (status = 400, description = "a search or limit out of range", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such machine", body = ErrorBody),
        (status = 503, description = "the server is stopping", body = ErrorBody),
    ),
)]
pub async fn page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryPage>, ApiError> {
    let started = Instant::now();
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::BadRequest(format!(
            "a page is 1 to {MAX_LIMIT} threads"
        )));
    }
    let needle = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty());
    if needle.is_some_and(|q| q.chars().count() > MAX_QUERY) {
        return Err(ApiError::BadRequest(format!(
            "a search is at most {MAX_QUERY} characters"
        )));
    }
    let needle = needle.map(str::to_lowercase);
    let cursor = match query.before.as_deref() {
        Some(raw) => Some(Key::parse(raw).ok_or_else(|| {
            ApiError::BadRequest("that is not a place in history; start again from the top".into())
        })?),
        None => None,
    };
    let hosts: Vec<Arc<Cmx2Source>> = match query.host.as_deref() {
        Some(host) => vec![agents::cmx2(&state, host, Some(Capability::History))?],
        None => state
            .upstreams
            .hosts
            .borrow()
            .iter()
            .filter(|h| {
                agents::check(h.source.as_ref(), &h.config.name, Capability::History).is_ok()
            })
            .map(|h| Arc::clone(&h.source))
            .collect(),
    };

    let scans = join_all(
        hosts
            .iter()
            .map(|source| scan(source, needle.as_deref(), cursor.as_ref(), limit)),
    )
    .await;
    let asked = scans.len();
    let (rows, next, unreached) = merge(scans, limit);

    let cleared = state
        .fleet
        .cleared_among(
            rows.iter()
                .map(|row| (session_key(&row.host, &row.id), updated_f64(row.updated)))
                .collect(),
        )
        .await
        .map_err(|_| ApiError::Stopping)?;
    let rows: Vec<HistoryRow> = rows
        .into_iter()
        .zip(cleared)
        .map(|(found, cleared)| HistoryRow {
            key: session_key(&found.host, &found.id),
            host: found.host,
            info: found.info,
            cleared,
        })
        .collect();

    let ms = started.elapsed().as_secs_f64() * 1000.0;
    info!(
        rows = rows.len(),
        hosts = asked,
        unreached = unreached.len(),
        searched = needle.is_some(),
        paged = cursor.is_some(),
        latency_ms = format_args!("{ms:.1}"),
        "history page"
    );
    state.telemetry.record(&json!({
        "kind": "history.page",
        "ms": ms,
        "ok": unreached.is_empty(),
        "props": {
            "rows": rows.len(),
            "hosts": asked,
            "unreached": unreached.len(),
            "chars": needle.as_deref().map_or(0, |q| q.chars().count()),
            "paged": u8::from(cursor.is_some()),
        },
    }));
    Ok(Json(HistoryPage {
        rows,
        next,
        unreached,
    }))
}

/// the merged page of every host's scan: the threads every host has been
/// read down to, newest first, at most `limit`, and where the next page
/// starts.
///
/// a host read only down to its key knows nothing older, so a thread older
/// than the newest such key could be missing others from the hosts that were
/// read less far, and the page stops at that key.
fn merge(scans: Vec<Scan>, limit: usize) -> (Vec<Found>, Option<String>, Vec<Unreached>) {
    let mut unreached = Vec::new();
    let mut found = Vec::new();
    let mut frontier: Option<Key> = None;
    for scan in scans {
        if let Some(reason) = scan.failed {
            unreached.push(Unreached {
                host: scan.host,
                reason,
            });
            continue;
        }
        frontier = frontier.max(scan.reached);
        found.extend(scan.found);
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.key()));
    if let Some(edge) = &frontier {
        found.retain(|f| f.key() >= *edge);
    }
    if found.len() > limit {
        found.truncate(limit);
        let next = found.last().map(|f| f.key().cursor());
        return (found, next, unreached);
    }
    (found, frontier.map(|key| key.cursor()), unreached)
}

/// reads one host's threads after the cursor, keeping what matches.
async fn scan(
    source: &Cmx2Source,
    needle: Option<&str>,
    cursor: Option<&Key>,
    limit: usize,
) -> Scan {
    let (pages, mut size) = if needle.is_some() {
        (SCAN_PAGES, PAGE)
    } else {
        (1, limit)
    };
    let host = source.host();
    let mut out = Scan {
        host: host.name.clone(),
        found: Vec::new(),
        reached: None,
        failed: None,
    };
    let mut edge = cursor.map(|cursor| Edge::after(cursor, &host.name));
    let mut spent = 0;
    while spent < pages {
        let before = edge.as_ref().map(Edge::before);
        let (list, more) = match source.history_page(size, before).await {
            Ok(page) => page,
            Err(reason) => {
                warn!(host = %host.name, reason, "history could not read a host");
                out.found.clear();
                out.reached = None;
                out.failed = Some(reason);
                return out;
            }
        };
        let rows: Vec<(Facts, Box<RawValue>)> = list
            .into_iter()
            .filter_map(|info| {
                serde_json::from_str::<Facts>(info.get())
                    .ok()
                    .map(|f| (f, info))
            })
            .collect();
        // a page that is all one millisecond may be the middle of a longer run, which cmx2 can only list by a bigger page
        let stamps: Vec<u64> = rows
            .iter()
            .map(|(f, _)| updated_u64(f.time.updated))
            .collect();
        if more && let Some(wider) = wider(size, &stamps) {
            size = wider;
            continue;
        }
        spent += 1;
        let mut oldest: Option<(u64, String)> = None;
        let mut passed = false;
        for (facts, info) in rows {
            let updated = updated_u64(facts.time.updated);
            oldest = Some((updated, facts.id.clone()));
            if edge
                .as_ref()
                .is_some_and(|edge| !edge.allows(updated, &facts.id))
            {
                continue;
            }
            passed = true;
            if needle.is_some_and(|needle| !matches(&facts, needle)) {
                continue;
            }
            out.found.push(Found {
                host: host.name.clone(),
                id: facts.id,
                updated,
                info,
            });
        }
        if !more {
            out.reached = None;
            return out;
        }
        let Some((updated, id)) = oldest else {
            out.reached = None;
            return out;
        };
        let (next, reached) = advance(passed, &host.name, updated, id);
        out.reached = Some(reached);
        edge = Some(next);
        if out.found.len() >= limit {
            break;
        }
    }
    out
}

/// the title or the repo contains what was typed; `needle` is lowercase already.
fn matches(facts: &Facts, needle: &str) -> bool {
    facts.title.to_lowercase().contains(needle)
        || repo_of(&facts.project_id).to_lowercase().contains(needle)
}

/// the project's last path segment: what the app calls the repo.
fn repo_of(project: &str) -> &str {
    crate::source::cmx2::translate::repo_name(project)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a ms stamp is a positive integer far below 2^53"
)]
fn updated_u64(at: f64) -> u64 {
    at.max(0.0) as u64
}

#[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
fn updated_f64(at: u64) -> f64 {
    at as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(host: &str, id: &str, updated: u64) -> Found {
        Found {
            host: host.into(),
            id: id.into(),
            updated,
            info: RawValue::from_string("{}".into()).unwrap(),
        }
    }

    fn key(host: &str, id: &str, updated: u64) -> Key {
        Key {
            updated,
            host: host.into(),
            id: id.into(),
        }
    }

    fn scan_of(host: &str, rows: &[(&str, u64)], reached: Option<(&str, u64)>) -> Scan {
        Scan {
            host: host.into(),
            found: rows.iter().map(|(id, at)| found(host, id, *at)).collect(),
            reached: reached.map(|(id, at)| key(host, id, at)),
            failed: None,
        }
    }

    fn ids(rows: &[Found]) -> Vec<String> {
        rows.iter()
            .map(|f| format!("{}:{}", f.host, f.id))
            .collect()
    }

    #[test]
    fn hosts_that_are_read_to_their_end_merge_newest_first() {
        let (rows, next, unreached) = merge(
            vec![
                scan_of("a", &[("1", 50), ("2", 10)], None),
                scan_of("b", &[("3", 30)], None),
            ],
            10,
        );
        assert_eq!(ids(&rows), ["a:1", "b:3", "a:2"]);
        assert_eq!((next, unreached.len()), (None, 0));
    }

    #[test]
    fn a_page_over_the_limit_is_cut_and_continues_from_its_last_thread() {
        let (rows, next, _) = merge(
            vec![scan_of(
                "a",
                &[("3", 50), ("2", 40), ("1", 30)],
                Some(("1", 30)),
            )],
            2,
        );
        assert_eq!(ids(&rows), ["a:3", "a:2"]);
        assert_eq!(next.as_deref(), Some("40:a:2"));
    }

    #[test]
    fn a_page_stops_where_the_least_read_host_stops() {
        // b was read only down to 80: its threads between 80 and 20 are unknown, so a's older ones wait
        let (rows, next, _) = merge(
            vec![
                scan_of("a", &[("1", 90), ("2", 60), ("3", 20)], Some(("3", 20))),
                scan_of("b", &[("4", 85), ("5", 80)], Some(("5", 80))),
            ],
            10,
        );
        assert_eq!(ids(&rows), ["a:1", "b:4", "b:5"]);
        assert_eq!(next.as_deref(), Some("80:b:5"));
    }

    #[test]
    fn a_search_that_matched_nothing_yet_still_says_where_to_look_next() {
        let (rows, next, _) = merge(vec![scan_of("a", &[], Some(("9", 500)))], 10);
        assert!(rows.is_empty());
        assert_eq!(next.as_deref(), Some("500:a:9"));
    }

    #[test]
    fn a_host_that_did_not_answer_is_named_and_the_rest_still_page() {
        let mut down = scan_of("b", &[("9", 99)], Some(("9", 1)));
        down.failed = Some("cannot connect".into());
        let (rows, next, unreached) = merge(vec![scan_of("a", &[("1", 5)], None), down], 10);
        assert_eq!(ids(&rows), ["a:1"]);
        assert_eq!(next, None, "a dead host does not hold the cursor back");
        assert_eq!(unreached[0].host, "b");
    }

    #[test]
    fn threads_updated_in_one_millisecond_are_ordered_by_machine_then_id_both_descending() {
        let (rows, _, _) = merge(
            vec![
                scan_of("a", &[("2", 7), ("1", 7)], None),
                scan_of("b", &[("3", 7)], None),
            ],
            10,
        );
        assert_eq!(ids(&rows), ["b:3", "a:2", "a:1"]);
    }

    #[test]
    fn a_cursor_round_trips_and_a_stranger_is_refused() {
        let at = key("desk", "ses_1", 1_700_000_000_123);
        assert_eq!(Key::parse(&at.cursor()), Some(at));
        for bad in [
            "",
            "12",
            "12:desk",
            "x:desk:ses_1",
            "12::ses_1",
            "-4:desk:ses_1",
        ] {
            assert_eq!(Key::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn after_a_cursor_only_what_sorts_below_it_is_read() {
        // the page ended on desk:ses_5 at 100: its same-millisecond neighbours with a lower id and a lower machine are next
        let cursor = key("desk", "ses_5", 100);
        let own = Edge::after(&cursor, "desk");
        assert!(own.allows(100, "ses_4"));
        assert!(
            !own.allows(100, "ses_5"),
            "the last thread shown is not shown again"
        );
        assert!(!own.allows(100, "ses_6"));
        assert!(own.allows(99, "ses_9"));
        let before = Edge::after(&cursor, "attic");
        assert!(
            before.allows(100, "ses_9"),
            "a machine sorting below has all of that millisecond left"
        );
        let beyond = Edge::after(&cursor, "zoo");
        assert!(
            !beyond.allows(100, "ses_0"),
            "a machine sorting above was shown before the cursor"
        );
        assert!(beyond.allows(99, "ses_0"));
    }

    #[test]
    fn the_daemons_before_is_exclusive_so_it_is_asked_one_past_unless_the_millisecond_is_done() {
        let cursor = key("desk", "ses_5", 100);
        assert_eq!(Edge::after(&cursor, "desk").before(), 101);
        assert_eq!(Edge::after(&cursor, "attic").before(), 101);
        assert_eq!(Edge::after(&cursor, "zoo").before(), 100);
    }

    #[test]
    fn same_millisecond_threads_across_every_page_size_are_each_seen_once() {
        // a daemon of one host holding 33 threads in 5 milliseconds, listed as cmx2 lists them
        let mut all: Vec<(u64, String)> = (0..33_u32)
            .map(|n| (1000 + u64::from(n % 5), format!("ses_{n:02}")))
            .collect();
        all.sort_by(|a, b| b.cmp(a));
        // the longest run is 7: a page shorter than a run cannot walk it (cmx2 has no keyset), so those sizes are left out
        for size in [7usize, 8, 10, 40] {
            let mut seen: Vec<(u64, String)> = Vec::new();
            let mut cursor: Option<Key> = None;
            loop {
                let edge = cursor.as_ref().map(|c| Edge::after(c, "desk"));
                let before = edge.as_ref().map_or(u64::MAX, Edge::before);
                // the daemon: updated < before, updated desc, id desc, limit
                let page: Vec<&(u64, String)> =
                    all.iter().filter(|(u, _)| *u < before).take(size).collect();
                let rows: Vec<&&(u64, String)> = page
                    .iter()
                    .filter(|(u, id)| edge.as_ref().is_none_or(|e| e.allows(*u, id)))
                    .collect();
                seen.extend(rows.iter().map(|r| (***r).clone()));
                let Some(last) = page.last().filter(|_| page.len() == size) else {
                    break;
                };
                cursor = Some(advance(!rows.is_empty(), "desk", last.0, last.1.clone()).1);
            }
            assert_eq!(seen, all, "page size {size}");
        }
    }

    #[test]
    fn a_full_page_of_one_millisecond_is_asked_again_wider_until_cmx2_cannot_list_more() {
        assert_eq!(wider(30, &[5; 30]), Some(120));
        assert_eq!(wider(600, &[5; 600]), Some(1000));
        assert_eq!(wider(1000, &[5; 1000]), None);
        assert_eq!(
            wider(30, &[5, 5, 4]),
            None,
            "two milliseconds: the page walks"
        );
        assert_eq!(wider(1, &[5]), None);
    }

    #[test]
    fn a_run_of_one_millisecond_longer_than_a_page_is_walked_by_widening() {
        // 33 threads at one millisecond, and 7 newer, paged by 30 as the app does
        let mut all: Vec<(u64, String)> = (0..33).map(|n| (1000, format!("ses_{n:02}"))).collect();
        all.extend((0..7).map(|n| (2000 + n, format!("ses_new{n}"))));
        all.sort_by(|a, b| b.cmp(a));
        let mut seen: Vec<(u64, String)> = Vec::new();
        let mut cursor: Option<Key> = None;
        loop {
            let edge = cursor.as_ref().map(|c| Edge::after(c, "desk"));
            let before = edge.as_ref().map_or(u64::MAX, Edge::before);
            let mut size = 30;
            let page: Vec<&(u64, String)> = loop {
                let page: Vec<&(u64, String)> =
                    all.iter().filter(|(u, _)| *u < before).take(size).collect();
                let stamps: Vec<u64> = page.iter().map(|(u, _)| *u).collect();
                match wider(size, &stamps).filter(|_| page.len() == size) {
                    Some(bigger) => size = bigger,
                    None => break page,
                }
            };
            let rows: Vec<&&(u64, String)> = page
                .iter()
                .filter(|(u, id)| edge.as_ref().is_none_or(|e| e.allows(*u, id)))
                .collect();
            seen.extend(rows.iter().map(|r| (***r).clone()));
            let Some(last) = page.last().filter(|_| page.len() == size) else {
                break;
            };
            cursor = Some(advance(!rows.is_empty(), "desk", last.0, last.1.clone()).1);
        }
        assert_eq!(seen, all);
    }

    #[test]
    fn a_search_matches_title_or_repo_in_any_case() {
        let facts = Facts {
            id: "ses_1".into(),
            title: "Fix the Rate Limiter".into(),
            project_id: "/work/Ledger/".into(),
            time: Times { updated: 1.0 },
        };
        assert!(matches(&facts, "limiter"));
        assert!(matches(&facts, "ledger"));
        assert!(
            !matches(&facts, "work"),
            "the path above the repo is not the repo"
        );
    }
}
