//! telemetry, as v1 sent it: `POST /api/telemetry` batches with
//! `deviceClass: "board"`, flushed 5 s after the first event of a batch or at
//! 40 events. labels carry kinds, wires and thread keys, never words.

use std::hash::{BuildHasher, Hasher, RandomState};

use serde::Serialize;
use serde_json::{Map, Value};

pub const FLUSH_AFTER_MS: u64 = 5_000;
pub const FLUSH_AT: usize = 40;
/// a batch the server did not take goes back, capped: a dead server must
/// not grow the daemon.
pub const KEEP_CAP: usize = 400;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Event {
    pub id: String,
    /// wall clock, ms since the epoch.
    pub at: u64,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
    pub props: Map<String, Value>,
}

impl Event {
    #[must_use]
    pub fn new(kind: &'static str, at: u64, props: Map<String, Value>) -> Self {
        Self {
            id: nano(12),
            at,
            kind,
            session: None,
            ok: None,
            ms: None,
            props,
        }
    }

    #[must_use]
    pub fn ok(mut self, ok: bool) -> Self {
        self.ok = Some(u8::from(ok));
        self
    }

    #[must_use]
    pub fn ms(mut self, ms: u64) -> Self {
        self.ms = Some(ms);
        self
    }

    #[must_use]
    pub fn session(mut self, key: Option<String>) -> Self {
        self.session = key;
        self
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Batch<'a> {
    pub device: &'a str,
    pub device_class: &'static str,
    pub events: &'a [Event],
}

/// the queue between the controller and the poster.
#[derive(Debug, Default)]
pub struct Queue {
    events: Vec<Event>,
    /// monotonic ms when the oldest unsent event arrived.
    first_at: Option<u64>,
}

impl Queue {
    /// queues one event; true when the batch is full and should go now.
    pub fn push(&mut self, event: Event, now: u64) -> bool {
        if self.events.is_empty() {
            self.first_at = Some(now);
        }
        self.events.push(event);
        self.events.len() >= FLUSH_AT
    }

    /// when the batch is due, if any is waiting.
    #[must_use]
    pub fn deadline(&self) -> Option<u64> {
        self.first_at.map(|at| at + FLUSH_AFTER_MS)
    }

    /// the whole batch, emptying the queue.
    pub fn take(&mut self) -> Vec<Event> {
        self.first_at = None;
        std::mem::take(&mut self.events)
    }

    /// a batch the server refused comes back in front, capped.
    pub fn restore(&mut self, mut batch: Vec<Event>, now: u64) {
        batch.append(&mut self.events);
        let over = batch.len().saturating_sub(KEEP_CAP);
        batch.drain(..over);
        if !batch.is_empty() && self.first_at.is_none() {
            self.first_at = Some(now);
        }
        self.events = batch;
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

const ALPHABET: &[u8; 64] = b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/// a random id from nanoid's url alphabet, `[A-Za-z0-9_-]`. std's hasher keys are
/// random per process, enough for ids that only need to be unique.
#[must_use]
pub fn nano(len: usize) -> String {
    let state = RandomState::new();
    let mut out = String::with_capacity(len);
    let mut word = 0u64;
    for i in 0..len {
        if i % 10 == 0 {
            let mut h = state.build_hasher();
            h.write_usize(i);
            h.write_u128(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
            );
            word = h.finish();
        }
        let idx = usize::try_from(word & 63).unwrap_or(0);
        out.push(char::from(ALPHABET[idx]));
        word >>= 6;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev() -> Event {
        Event::new("board.key", 1, Map::new())
    }

    #[test]
    fn a_batch_is_due_five_seconds_after_its_first_event_or_at_forty() {
        let mut q = Queue::default();
        assert_eq!(q.deadline(), None);
        assert!(!q.push(ev(), 100));
        assert_eq!(q.deadline(), Some(5_100));
        for i in 1..39 {
            assert!(!q.push(ev(), 100 + i));
        }
        assert!(q.push(ev(), 200));
        assert_eq!(q.take().len(), 40);
        assert_eq!(q.deadline(), None);
    }

    #[test]
    fn a_refused_batch_comes_back_capped() {
        let mut q = Queue::default();
        q.restore((0..500).map(|_| ev()).collect(), 7);
        assert_eq!(q.len(), KEEP_CAP);
        assert_eq!(q.deadline(), Some(5_007));
    }

    #[test]
    fn ids_use_the_alphabet() {
        let id = nano(12);
        assert_eq!(id.len(), 12);
        assert!(id.bytes().all(|b| ALPHABET.contains(&b)));
        assert_ne!(nano(12), nano(12));
    }
}
