//! the thread summary (`docs/protocol.md`, section 12): everything the app
//! reads from a thread's whole history, folded from one streamed read
//! (`fold.rs`), cached per thread and computed at most once per 10 s.
//!
//! two pools keep what was computed, each least recently used out first:
//! threads' own folds (64 threads or 8 MiB of json) and children's facts
//! (1,024 children or 1 MiB), so a thread with many children never evicts
//! the folds of the threads asked for. each entry is tagged with the epoch,
//! `v` and `rv` it was computed at. one computation runs per key at a time
//! (single flight): a request that finds one running waits for it and takes
//! its answer. an entry is reused while its `v` is the thread's, and for
//! 10 s after it was computed while its epoch and `rv` still are: a
//! streaming thread (deltas move `v`, not `rv`) costs at most one whole
//! read every 10 s, while a revert, a removal or a reset (they move `rv` or
//! the epoch) is computed again at once.

mod fold;

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

pub use fold::{Child, Fold, Spawn, Summary, Touched, Turn};

/// threads whose own folds are kept.
pub const MAX_SUMMARIES: usize = 64;
/// the json the kept folds may take together.
pub const MAX_SUMMARY_BYTES: usize = 8 * 1024 * 1024;
/// children whose facts are kept.
pub const MAX_CHILDREN_KEPT: usize = 1024;
/// the json the kept children's facts may take together.
pub const MAX_CHILD_BYTES: usize = 1024 * 1024;
/// an entry is computed at most once in this long while `rv` holds.
pub const RECOMPUTE_EVERY: Duration = Duration::from_secs(10);

/// where a thread stood when a read of it started.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct At {
    pub epoch: String,
    pub v: Option<u64>,
    pub rv: Option<u64>,
}

/// one computed value, with where its thread stood.
#[derive(Debug)]
pub struct Computed<T> {
    pub at: At,
    pub value: T,
    /// its json size, what it counts against its pool's byte cap.
    pub bytes: usize,
    when: Instant,
}

impl<T> Computed<T> {
    #[must_use]
    pub fn new(at: At, value: T, bytes: usize) -> Self {
        Self {
            at,
            value,
            bytes,
            when: Instant::now(),
        }
    }

    /// whether a request that sees the thread at `now` may take this.
    fn serves(&self, now: &At, clock: Instant) -> bool {
        if self.at.epoch != now.epoch {
            return false;
        }
        (now.v.is_some() && now.v == self.at.v)
            || (now.rv == self.at.rv && clock.duration_since(self.when) < RECOMPUTE_EVERY)
    }
}

#[derive(Debug)]
struct Slot<T> {
    /// held while the key's value is computed.
    flight: Arc<tokio::sync::Mutex<()>>,
    kept: Option<Arc<Computed<T>>>,
    used: u64,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self {
            flight: Arc::default(),
            kept: None,
            used: 0,
        }
    }
}

#[derive(Debug)]
struct Kept<T> {
    slots: HashMap<String, Slot<T>>,
    bytes: usize,
    tick: u64,
    max: usize,
    max_bytes: usize,
}

impl<T> Kept<T> {
    /// drops slots that hold nothing and have no computation running, then
    /// the least recently used values past either cap.
    fn evict(&mut self) {
        self.slots
            .retain(|_, s| s.kept.is_some() || Arc::strong_count(&s.flight) > 1);
        loop {
            let held = self.slots.values().filter(|s| s.kept.is_some()).count();
            if held <= self.max && self.bytes <= self.max_bytes {
                return;
            }
            let oldest = self
                .slots
                .iter()
                .filter(|(_, s)| s.kept.is_some())
                .min_by_key(|(_, s)| s.used)
                .map(|(k, _)| k.clone());
            let Some(key) = oldest else { return };
            if let Some(slot) = self.slots.get_mut(&key)
                && let Some(gone) = slot.kept.take()
            {
                self.bytes -= gone.bytes;
            }
        }
    }
}

/// one pool of computed values; cloned handles share it.
#[derive(Debug)]
pub struct Pool<T> {
    kept: Arc<Mutex<Kept<T>>>,
}

impl<T> Clone for Pool<T> {
    fn clone(&self) -> Self {
        Self {
            kept: Arc::clone(&self.kept),
        }
    }
}

impl<T> Pool<T> {
    #[must_use]
    pub fn new(max: usize, max_bytes: usize) -> Self {
        Self {
            kept: Arc::new(Mutex::new(Kept {
                slots: HashMap::new(),
                bytes: 0,
                tick: 0,
                max,
                max_bytes,
            })),
        }
    }

    /// `key`'s value for a request that sees its thread at `now`: the kept
    /// one when it serves, else the one `compute` gives, which is kept. a
    /// failed computation keeps nothing and leaves no slot behind.
    ///
    /// # Errors
    /// what `compute` returns.
    pub async fn get<F, Fut, E>(
        &self,
        key: &str,
        now: &At,
        compute: F,
    ) -> Result<Arc<Computed<T>>, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Computed<T>, E>>,
    {
        let flight = {
            let mut kept = self.lock();
            kept.tick += 1;
            let tick = kept.tick;
            let slot = kept.slots.entry(key.to_owned()).or_default();
            slot.used = tick;
            if let Some(found) = slot.kept.as_ref().filter(|c| c.serves(now, Instant::now())) {
                return Ok(Arc::clone(found));
            }
            Arc::clone(&slot.flight)
        };
        let running = flight.lock().await;
        // another request may have computed it while this one waited.
        let kept = self.lock().slots.get(key).and_then(|s| s.kept.clone());
        if let Some(found) = kept.filter(|c| c.serves(now, Instant::now())) {
            return Ok(found);
        }
        let computed = match compute().await {
            Ok(computed) => Arc::new(computed),
            Err(e) => {
                drop(running);
                drop(flight);
                self.lock().evict();
                return Err(e);
            }
        };
        let mut kept = self.lock();
        kept.tick += 1;
        let tick = kept.tick;
        let slot = kept.slots.entry(key.to_owned()).or_default();
        slot.used = tick;
        let before = slot
            .kept
            .replace(Arc::clone(&computed))
            .map_or(0, |c| c.bytes);
        kept.bytes = kept.bytes - before + computed.bytes;
        kept.evict();
        Ok(computed)
    }

    /// drops the slots a cancelled computation left empty.
    pub fn sweep(&self) {
        self.lock().evict();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Kept<T>> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// the values kept, their bytes, and the slots.
    #[cfg(test)]
    #[must_use]
    pub fn held(&self) -> (usize, usize, usize) {
        let kept = self.lock();
        (
            kept.slots.values().filter(|s| s.kept.is_some()).count(),
            kept.bytes,
            kept.slots.len(),
        )
    }
}

/// children whose read failed or ran late lately, so a request does not
/// read them again for `FAILED_FOR`.
#[derive(Debug, Clone, Default)]
pub struct Failures {
    recent: Arc<Mutex<HashMap<String, tokio::time::Instant>>>,
}

/// how long a failed child is listed by key without a read.
pub const FAILED_FOR: Duration = Duration::from_secs(30);
/// failed children remembered, at most; past it the oldest go.
pub const MAX_FAILED: usize = 1024;

impl Failures {
    /// whether `key` failed within `FAILED_FOR`.
    #[must_use]
    pub fn lately(&self, key: &str) -> bool {
        let now = tokio::time::Instant::now();
        let mut recent = self.lock();
        recent.retain(|_, at| now.duration_since(*at) < FAILED_FOR);
        recent.contains_key(key)
    }

    /// `key` failed now.
    pub fn note(&self, key: &str) {
        let mut recent = self.lock();
        recent.insert(key.to_owned(), tokio::time::Instant::now());
        while recent.len() > MAX_FAILED {
            let oldest = recent
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(k, _)| k.clone());
            let Some(oldest) = oldest else { break };
            recent.remove(&oldest);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, tokio::time::Instant>> {
        self.recent.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// the kept summaries: threads' own folds and children's facts, apart, and
/// the children that failed lately.
#[derive(Debug, Clone)]
pub struct Summaries {
    pub threads: Pool<Summary>,
    pub children: Pool<Child>,
    pub failed: Failures,
}

impl Default for Summaries {
    fn default() -> Self {
        Self::new()
    }
}

impl Summaries {
    #[must_use]
    pub fn new() -> Self {
        Self {
            threads: Pool::new(MAX_SUMMARIES, MAX_SUMMARY_BYTES),
            children: Pool::new(MAX_CHILDREN_KEPT, MAX_CHILD_BYTES),
            failed: Failures::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn at(epoch: &str, v: Option<u64>, rv: Option<u64>) -> At {
        At {
            epoch: epoch.to_owned(),
            v,
            rv,
        }
    }

    async fn get(
        p: &Pool<u32>,
        key: &str,
        now: &At,
        runs: &AtomicUsize,
        bytes: usize,
    ) -> Arc<Computed<u32>> {
        p.get(key, now, || async {
            runs.fetch_add(1, Ordering::SeqCst);
            Ok::<_, ()>(Computed::new(now.clone(), 0, bytes))
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_moved_v_inside_the_window_takes_the_kept_value_with_its_own_v() {
        let p = Pool::new(8, 1024);
        let runs = AtomicUsize::new(0);
        assert_eq!(
            get(&p, "a", &at("e", Some(1), Some(1)), &runs, 1)
                .await
                .at
                .v,
            Some(1)
        );
        assert_eq!(
            get(&p, "a", &at("e", Some(2), Some(1)), &runs, 1)
                .await
                .at
                .v,
            Some(1)
        );
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_moved_rv_or_epoch_inside_the_window_computes_again() {
        let p = Pool::new(8, 1024);
        let runs = AtomicUsize::new(0);
        get(&p, "a", &at("e", Some(1), Some(1)), &runs, 1).await;
        // a revert or a removal moved rv.
        assert_eq!(
            get(&p, "a", &at("e", Some(2), Some(2)), &runs, 1)
                .await
                .at
                .rv,
            Some(2)
        );
        // a reset moved the epoch.
        assert_eq!(
            get(&p, "a", &at("f", Some(2), Some(2)), &runs, 1)
                .await
                .at
                .epoch,
            "f"
        );
        assert_eq!(runs.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_value_serves_its_own_v_for_ever_and_its_rv_for_ten_seconds() {
        let clock = Instant::now();
        let mut c = Computed::new(at("e", Some(5), Some(3)), 0u32, 1);
        assert!(c.serves(&at("e", Some(5), Some(3)), clock));
        assert!(c.serves(&at("e", Some(6), Some(3)), clock));
        assert!(!c.serves(&at("e", Some(6), Some(4)), clock));
        assert!(!c.serves(&at("f", Some(5), Some(3)), clock));
        c.when = clock.checked_sub(RECOMPUTE_EVERY).unwrap();
        assert!(c.serves(&at("e", Some(5), Some(3)), clock));
        assert!(!c.serves(&at("e", Some(6), Some(3)), clock));
        let mut unkept = Computed::new(at("e", None, None), 0u32, 1);
        assert!(unkept.serves(&at("e", None, None), clock));
        unkept.when = clock.checked_sub(RECOMPUTE_EVERY).unwrap();
        assert!(!unkept.serves(&at("e", None, None), clock));
    }

    #[tokio::test]
    async fn requests_for_one_key_share_one_computation() {
        let p: Pool<u32> = Pool::new(8, 1024);
        let runs = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let (p, runs) = (p.clone(), Arc::clone(&runs));
            tasks.push(tokio::spawn(async move {
                let now = at("e", Some(1), Some(1));
                p.get("a", &now.clone(), || async {
                    runs.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    Ok::<_, ()>(Computed::new(now, 0, 1))
                })
                .await
                .unwrap()
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_caps_drop_the_least_recently_used() {
        let p = Pool::new(MAX_SUMMARIES, MAX_SUMMARY_BYTES);
        let runs = AtomicUsize::new(0);
        let now = at("e", Some(1), Some(1));
        for i in 0..=MAX_SUMMARIES {
            get(&p, &format!("t{i}"), &now, &runs, 1).await;
        }
        assert_eq!(p.held().0, MAX_SUMMARIES);
        // t0 was the least recently used.
        get(&p, "t0", &now, &runs, 1).await;
        assert_eq!(runs.load(Ordering::SeqCst), MAX_SUMMARIES + 2);
        get(&p, "big", &now, &runs, MAX_SUMMARY_BYTES).await;
        let (held, bytes, _) = p.held();
        assert!(bytes <= MAX_SUMMARY_BYTES);
        assert_eq!(held, 1);
    }

    #[tokio::test]
    async fn children_never_evict_threads() {
        let s = Summaries::new();
        let runs = AtomicUsize::new(0);
        let now = at("e", Some(1), Some(1));
        s.threads
            .get("parent", &now, || async {
                Ok::<_, ()>(Computed::new(now.clone(), Fold::new("").finish(), 10))
            })
            .await
            .unwrap();
        for i in 0..=MAX_CHILDREN_KEPT {
            s.children
                .get(&format!("c{i}"), &now, || async {
                    runs.fetch_add(1, Ordering::SeqCst);
                    let child = Child {
                        key: format!("c{i}"),
                        steps: 0,
                        first: 0.0,
                        end: 0.0,
                    };
                    Ok::<_, ()>(Computed::new(now.clone(), child, 1))
                })
                .await
                .unwrap();
        }
        assert_eq!(s.threads.held().0, 1);
        assert_eq!(s.children.held().0, MAX_CHILDREN_KEPT);
    }

    #[tokio::test]
    async fn a_computation_cut_by_a_timeout_leaves_no_slot_once_swept() {
        let p: Pool<u32> = Pool::new(8, 1024);
        let cut = tokio::time::timeout(
            Duration::from_millis(5),
            p.get("a", &At::default(), || async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok::<_, ()>(Computed::new(At::default(), 0, 1))
            }),
        )
        .await;
        assert!(cut.is_err());
        assert_eq!(p.held().2, 1);
        p.sweep();
        assert_eq!(p.held(), (0, 0, 0));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_child_is_remembered_for_thirty_seconds() {
        let f = Failures::default();
        assert!(!f.lately("c"));
        f.note("c");
        assert!(f.lately("c"));
        tokio::time::advance(FAILED_FOR).await;
        assert!(!f.lately("c"));
        for i in 0..=MAX_FAILED {
            f.note(&format!("k{i}"));
            tokio::time::advance(Duration::from_millis(1)).await;
        }
        assert!(!f.lately("k0") && f.lately(&format!("k{MAX_FAILED}")));
    }

    #[tokio::test]
    async fn a_failed_computation_keeps_nothing_and_leaves_no_slot() {
        let p: Pool<u32> = Pool::new(8, 1024);
        let failed = p
            .get("a", &At::default(), || async {
                Err::<Computed<u32>, _>("no")
            })
            .await;
        assert!(failed.is_err());
        assert_eq!(p.held(), (0, 0, 0));
    }
}
