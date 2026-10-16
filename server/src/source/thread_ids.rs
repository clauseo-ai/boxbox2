//! the thread id map of one foreign agent (`docs/agents.md`, section 3 and
//! the buffers table): foreign session key to thread id and back, the most
//! recently used rows in memory and every row in `thread_ids`.
//!
//! nothing is loaded at start. forward, a miss recomputes the hash (it is
//! deterministic) and records the row, which is a no-op when it is known;
//! back, a miss reads the row by its key. so the memory is only a cache,
//! and losing it costs a hash or a read.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use sha2::{Digest, Sha256};
use tracing::warn;

use super::ids;
use crate::store::ids::Recorded;
use crate::store::{Store, StoreError};
use crate::wire::Source;

/// one foreign agent's thread id map: one connection, one agent.
#[derive(Debug)]
pub struct ThreadIds {
    store: Store,
    source: Source,
    connection: Arc<str>,
    /// the boxbox agent key, what `thread_ids.agent` holds.
    agent: Arc<str>,
    /// the runtime's own id for the agent, part of the hash.
    foreign_agent: Arc<str>,
    // a std mutex: every critical section is a few map operations and none
    // spans an await
    cache: Mutex<Lru>,
}

impl ThreadIds {
    /// rows held in memory (the buffers table: 10,000).
    pub const CAPACITY: usize = 10_000;

    #[must_use]
    pub fn new(
        store: Store,
        source: Source,
        connection: Arc<str>,
        agent: Arc<str>,
        foreign_agent: Arc<str>,
        capacity: usize,
    ) -> Self {
        Self {
            store,
            source,
            connection,
            agent,
            foreign_agent,
            cache: Mutex::new(Lru::new(capacity)),
        }
    }

    /// the thread id of the foreign session `foreign_key`, recorded on
    /// first sight. none when the id collides with another session's (the
    /// thread is not shown) or for a cmx2 agent, whose ids are its own.
    ///
    /// # Errors
    /// the store failed.
    pub async fn id_for(&self, foreign_key: &str) -> Result<Option<String>, StoreError> {
        if let Some(id) = self.lru().id_for(foreign_key) {
            return Ok(Some(id));
        }
        let Some(id) = ids::thread_id(
            self.source,
            &self.connection,
            &self.foreign_agent,
            foreign_key,
        ) else {
            return Ok(None);
        };
        match self
            .store
            .record_thread_id(&self.agent, &id, foreign_key)
            .await?
        {
            Recorded::New | Recorded::Known => {
                self.lru().insert(&id, foreign_key);
                Ok(Some(id))
            }
            Recorded::Collision => {
                // at 120 bits this is a bug report; the keys carry phone
                // numbers, so only their hashes reach the log
                let holder = self.store.foreign_key_of(&self.agent, &id).await?;
                warn!(
                    connection = %self.connection,
                    agent = %self.agent,
                    thread = %id,
                    key = %hashed(foreign_key),
                    holder = %holder.as_deref().map_or_else(|| "none".to_owned(), hashed),
                    "a thread id collides with another session's; the thread is not shown"
                );
                Ok(None)
            }
        }
    }

    /// the foreign session key of thread `id`, if it was ever recorded.
    ///
    /// # Errors
    /// the store failed.
    pub async fn foreign_key(&self, id: &str) -> Result<Option<String>, StoreError> {
        if let Some(key) = self.lru().foreign_key(id) {
            return Ok(Some(key));
        }
        let key = self.store.foreign_key_of(&self.agent, id).await?;
        if let Some(key) = &key {
            self.lru().insert(id, key);
        }
        Ok(key)
    }

    fn lru(&self) -> std::sync::MutexGuard<'_, Lru> {
        // a panic mid-update leaves at worst a stale cache entry, which the
        // store still backs; keep serving
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// a session key's hash for logs: 8 bytes of sha256, enough to tell two
/// keys apart in a bug report.
fn hashed(key: &str) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(key.as_bytes())[..8])
}

/// rows by id and by key, evicted least recently used first. one row
/// serves both directions, so both share the one bound.
#[derive(Debug)]
struct Lru {
    capacity: usize,
    /// id to (foreign key, last use).
    rows: HashMap<String, (String, u64)>,
    by_key: HashMap<String, String>,
    /// last use to id; the first entry is the next to go.
    recency: BTreeMap<u64, String>,
    tick: u64,
}

impl Lru {
    fn new(capacity: usize) -> Self {
        Self {
            // a zero bound would cache nothing and recompute every time;
            // one row keeps the type's invariants simple
            capacity: capacity.max(1),
            rows: HashMap::new(),
            by_key: HashMap::new(),
            recency: BTreeMap::new(),
            tick: 0,
        }
    }

    fn id_for(&mut self, foreign_key: &str) -> Option<String> {
        let id = self.by_key.get(foreign_key)?.clone();
        self.touch(&id);
        Some(id)
    }

    fn foreign_key(&mut self, id: &str) -> Option<String> {
        let key = self.rows.get(id)?.0.clone();
        self.touch(id);
        Some(key)
    }

    fn touch(&mut self, id: &str) {
        self.tick += 1;
        if let Some((_, used)) = self.rows.get_mut(id) {
            self.recency.remove(used);
            *used = self.tick;
            self.recency.insert(self.tick, id.to_owned());
        }
    }

    fn insert(&mut self, id: &str, foreign_key: &str) {
        // the store is unique both ways, so a row that disagrees with this
        // one is stale; drop it whichever side it shares
        if let Some((held, _)) = self.rows.get(id)
            && held != foreign_key
        {
            self.remove(id);
        }
        if let Some(other) = self.by_key.get(foreign_key)
            && other != id
        {
            let other = other.clone();
            self.remove(&other);
        }
        if self.rows.contains_key(id) {
            self.touch(id);
            return;
        }
        self.tick += 1;
        self.rows
            .insert(id.to_owned(), (foreign_key.to_owned(), self.tick));
        self.by_key.insert(foreign_key.to_owned(), id.to_owned());
        self.recency.insert(self.tick, id.to_owned());
        while self.rows.len() > self.capacity {
            let Some((_, oldest)) = self.recency.pop_first() else {
                break;
            };
            self.remove(&oldest);
        }
    }

    fn remove(&mut self, id: &str) {
        if let Some((key, used)) = self.rows.remove(id) {
            self.by_key.remove(&key);
            self.recency.remove(&used);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::scratch;

    fn map(store: &Store, capacity: usize) -> ThreadIds {
        ThreadIds::new(
            store.clone(),
            Source::Openclaw,
            "vm-a".into(),
            "vm-a-main".into(),
            "main".into(),
            capacity,
        )
    }

    fn cached(map: &ThreadIds) -> Vec<String> {
        let lru = map.lru();
        let mut keys: Vec<String> = lru.rows.values().map(|(k, _)| k.clone()).collect();
        keys.sort();
        keys
    }

    #[tokio::test]
    async fn the_least_recently_used_row_goes_first_and_comes_back_the_same() {
        let (store, thread, dir) = scratch();
        let ids = map(&store, 2);
        let a = ids.id_for("agent:main:a").await.unwrap().unwrap();
        assert_eq!(
            Some(a.clone()),
            ids::thread_id(Source::Openclaw, "vm-a", "main", "agent:main:a")
        );
        let b = ids.id_for("agent:main:b").await.unwrap().unwrap();
        // a back lookup counts as a use: b is now the oldest
        assert_eq!(
            ids.foreign_key(&a).await.unwrap().as_deref(),
            Some("agent:main:a")
        );
        ids.id_for("agent:main:c").await.unwrap().unwrap();
        assert_eq!(cached(&ids), ["agent:main:a", "agent:main:c"]);
        // a forward miss recomputes the same id
        assert_eq!(ids.id_for("agent:main:b").await.unwrap(), Some(b.clone()));
        assert_eq!(cached(&ids), ["agent:main:b", "agent:main:c"]);
        // a back miss reads the store
        assert_eq!(
            ids.foreign_key(&a).await.unwrap().as_deref(),
            Some("agent:main:a")
        );
        assert_eq!(cached(&ids), ["agent:main:a", "agent:main:b"]);
        assert_eq!(ids.foreign_key("oc_unknown").await.unwrap(), None);
        drop((ids, store));
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_restart_finds_the_rows_in_the_store() {
        let (store, thread, dir) = scratch();
        let id = map(&store, ThreadIds::CAPACITY)
            .id_for("agent:main:whatsapp:direct:+15550000000")
            .await
            .unwrap()
            .unwrap();
        let fresh = map(&store, ThreadIds::CAPACITY);
        assert!(cached(&fresh).is_empty(), "nothing loaded at start");
        assert_eq!(
            fresh.foreign_key(&id).await.unwrap().as_deref(),
            Some("agent:main:whatsapp:direct:+15550000000")
        );
        drop((fresh, store));
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_colliding_id_is_not_shown() {
        let (store, thread, dir) = scratch();
        let id = ids::thread_id(Source::Openclaw, "vm-a", "main", "agent:main:a").unwrap();
        assert_eq!(
            store
                .record_thread_id("vm-a-main", &id, "agent:main:squatter")
                .await
                .unwrap(),
            Recorded::New
        );
        let map = map(&store, 4);
        assert_eq!(map.id_for("agent:main:a").await.unwrap(), None);
        assert!(cached(&map).is_empty());
        // the holder is untouched
        assert_eq!(
            map.foreign_key(&id).await.unwrap().as_deref(),
            Some("agent:main:squatter")
        );
        drop((map, store));
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hashed_keys_are_not_the_keys() {
        let key = "agent:main:whatsapp:direct:+15550000000";
        let h = hashed(key);
        assert_eq!(h.len(), 16);
        assert!(!h.contains("1555"));
    }
}
