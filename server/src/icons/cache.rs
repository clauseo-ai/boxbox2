//! what the icon lookups remember, bounded by entry count and by bytes.
//!
//! the rule when an insert would pass either bound: entries past their
//! time go first, then the least recently used, until both bounds hold.
//! only an icon's bytes count toward the byte bound (a verdict that there
//! is none is a few bytes and the entry bound covers it). the owner is the
//! icons task; nothing here is shared.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use super::Icon;

/// what is asked about: a project root on a host.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    pub host: String,
    pub root: String,
}

/// what a lookup concluded and kept.
#[derive(Debug, Clone)]
pub enum Verdict {
    /// the repo's icon.
    Icon(Arc<Icon>),
    /// searched, and the repo has none.
    Barren,
    /// the search could not finish; asked again after a short wait, so a
    /// page of repos does not repeat the calls (never a verdict on the repo).
    Retry,
}

#[derive(Debug)]
struct Entry {
    verdict: Verdict,
    until: Instant,
    used: u64,
    size: usize,
}

#[derive(Debug)]
pub struct Cache {
    entries: HashMap<Key, Entry>,
    bytes: usize,
    clock: u64,
    max_entries: usize,
    max_bytes: usize,
}

impl Cache {
    #[must_use]
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            clock: 0,
            max_entries,
            max_bytes,
        }
    }

    /// the verdict for `key` while it is fresh; an expired one is dropped.
    pub fn get(&mut self, key: &Key, now: Instant) -> Option<Verdict> {
        let entry = self.entries.get_mut(key)?;
        if entry.until <= now {
            self.remove(key);
            return None;
        }
        self.clock += 1;
        entry.used = self.clock;
        Some(entry.verdict.clone())
    }

    /// keeps `verdict` for `ttl`, making room by the rule above.
    pub fn insert(&mut self, key: Key, verdict: Verdict, ttl: Duration, now: Instant) {
        self.remove(&key);
        let size = match &verdict {
            Verdict::Icon(icon) => icon.bytes.len(),
            Verdict::Barren | Verdict::Retry => 0,
        };
        if size > self.max_bytes {
            return;
        }
        self.expire(now);
        while self.entries.len() + 1 > self.max_entries || self.bytes + size > self.max_bytes {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.remove(&oldest);
        }
        self.clock += 1;
        self.bytes += size;
        self.entries.insert(
            key,
            Entry {
                verdict,
                until: now + ttl,
                used: self.clock,
                size,
            },
        );
    }

    fn expire(&mut self, now: Instant) {
        let gone: Vec<Key> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.until <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in gone {
            self.remove(&key);
        }
    }

    fn remove(&mut self, key: &Key) {
        if let Some(entry) = self.entries.remove(key) {
            self.bytes -= entry.size;
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    fn bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;

    fn key(root: &str) -> Key {
        Key {
            host: "desk".into(),
            root: root.into(),
        }
    }

    fn icon(len: usize) -> Verdict {
        Verdict::Icon(Arc::new(Icon {
            bytes: Bytes::from(vec![0; len]),
            content_type: "image/png",
            etag: "\"e\"".into(),
        }))
    }

    const HOUR: Duration = Duration::from_secs(3600);

    fn present(cache: &mut Cache, root: &str, now: Instant) -> bool {
        cache.get(&key(root), now).is_some()
    }

    #[test]
    fn a_verdict_is_served_until_its_time_runs_out() {
        let now = Instant::now();
        let mut cache = Cache::new(8, 1024);
        cache.insert(key("/a"), Verdict::Barren, HOUR, now);
        assert!(present(
            &mut cache,
            "/a",
            now + HOUR - Duration::from_secs(1)
        ));
        assert!(!present(&mut cache, "/a", now + HOUR));
        assert_eq!(
            cache.len(),
            0,
            "an expired entry is dropped when it is read"
        );
    }

    #[test]
    fn past_the_entry_bound_the_least_recently_used_goes() {
        let now = Instant::now();
        let mut cache = Cache::new(3, 1024);
        for root in ["/a", "/b", "/c"] {
            cache.insert(key(root), Verdict::Barren, HOUR, now);
        }
        // reading /a makes /b the least recently used
        assert!(present(&mut cache, "/a", now));
        cache.insert(key("/d"), Verdict::Barren, HOUR, now);
        assert!(present(&mut cache, "/a", now));
        assert!(!present(&mut cache, "/b", now));
        assert!(present(&mut cache, "/c", now));
        assert!(present(&mut cache, "/d", now));
        assert_eq!(cache.len(), 3);
    }

    #[test]
    fn past_the_byte_bound_icons_go_least_recently_used_first_until_it_holds() {
        let now = Instant::now();
        let mut cache = Cache::new(100, 1000);
        cache.insert(key("/a"), icon(400), HOUR, now);
        cache.insert(key("/b"), icon(400), HOUR, now);
        assert!(present(&mut cache, "/a", now));
        // 400 more does not fit beside both: /b, the least recently used, goes
        cache.insert(key("/c"), icon(400), HOUR, now);
        assert!(present(&mut cache, "/a", now));
        assert!(!present(&mut cache, "/b", now));
        assert!(present(&mut cache, "/c", now));
        assert_eq!(cache.bytes(), 800);
        // one that needs the whole room takes all of it
        cache.insert(key("/d"), icon(1000), HOUR, now);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.bytes(), 1000);
    }

    #[test]
    fn expired_entries_make_room_before_a_live_one_is_evicted() {
        let now = Instant::now();
        let mut cache = Cache::new(2, 1024);
        cache.insert(key("/short"), Verdict::Barren, Duration::from_secs(10), now);
        cache.insert(key("/long"), Verdict::Barren, HOUR, now);
        // /long was used last, /short is older and expired: it goes, /long stays
        assert!(present(&mut cache, "/long", now));
        let later = now + Duration::from_secs(60);
        cache.insert(key("/new"), Verdict::Barren, HOUR, later);
        assert!(present(&mut cache, "/long", later));
        assert!(present(&mut cache, "/new", later));
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn inserting_a_key_again_replaces_it_and_its_bytes() {
        let now = Instant::now();
        let mut cache = Cache::new(8, 1000);
        cache.insert(key("/a"), icon(600), HOUR, now);
        cache.insert(key("/a"), icon(100), HOUR, now);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.bytes(), 100);
        cache.insert(key("/a"), Verdict::Barren, HOUR, now);
        assert_eq!(cache.bytes(), 0);
    }

    #[test]
    fn an_icon_larger_than_the_whole_byte_bound_is_not_kept() {
        let now = Instant::now();
        let mut cache = Cache::new(8, 100);
        cache.insert(key("/small"), Verdict::Barren, HOUR, now);
        cache.insert(key("/big"), icon(101), HOUR, now);
        assert!(!present(&mut cache, "/big", now));
        assert!(
            present(&mut cache, "/small", now),
            "nothing was evicted for it"
        );
    }

    #[test]
    fn the_same_root_on_two_hosts_is_two_entries() {
        let now = Instant::now();
        let mut cache = Cache::new(8, 100);
        cache.insert(key("/a"), Verdict::Barren, HOUR, now);
        let other = Key {
            host: "laptop".into(),
            root: "/a".into(),
        };
        assert!(cache.get(&other, now).is_none());
    }
}
