//! protocol 3's encoder (`docs/protocol.md`, sections 6 to 8): what the
//! fleet's model says changed, as the journal entries every stream gets.
//!
//! it keeps the bases the patches are made against (each thread's last
//! journaled state with its `whole` flag, and the order), the text deltas
//! waiting for their 100 ms batch, and what it needs to send each finished
//! text once: per streaming part the length and hash of the text its
//! deltas built (until the part's end), and per part and message a digest
//! of the last state it journaled. every map has a cap.
//!
//! the encoder never journals itself: each call answers the entries to
//! append, in order, and the caller appends them. any entry that is not a
//! text delta first takes every pending delta out (`flush`), so the
//! journal's order is the order things happened.

use std::collections::{HashMap, VecDeque};

use sha2::{Digest, Sha256};

use crate::wire::patch::{self, TextHash};
use crate::wire::{Btw, Change, Message, Part, Thread};

/// a text delta waits at most this long for the next one of its part.
pub const DELTA_EVERY_MS: i64 = 100;
/// pending delta text in all; past it every pending delta is journaled.
pub const PENDING_BYTES: usize = 1024 * 1024;
/// streaming parts whose built text is tracked; the oldest go first, and
/// their next update is sent whole.
pub const TRACKED_PARTS: usize = 4096;
/// parts and messages whose last journaled state is remembered, for the
/// rule that an unchanged re-send is not journaled.
pub const REMEMBERED: usize = 4096;
/// running btws whose answer length is tracked, so their deltas carry an
/// offset; the oldest go first, and their next deltas go without one.
pub const TRACKED_BTWS: usize = 1024;

/// what a pending delta streams into.
#[derive(Debug, PartialEq, Eq)]
enum Target {
    /// a part's text or reasoning.
    Part {
        message_id: String,
        part_id: String,
        field: String,
    },
    /// a btw's answer.
    Btw { btw_id: String },
}

/// one part's or btw's deltas, merged while they chain.
#[derive(Debug)]
struct Pending {
    key: String,
    target: Target,
    /// utf-16 units before `text`; none for a btw whose answer's length the
    /// encoder does not know.
    offset: Option<u64>,
    text: String,
    /// utf-16 units of `text`.
    units: u64,
    /// when its first delta arrived, ms.
    first: i64,
}

/// a map with an insertion-order cap: the oldest key goes first.
#[derive(Debug)]
struct Capped<V> {
    map: HashMap<String, V>,
    order: VecDeque<String>,
}

impl<V> Default for Capped<V> {
    fn default() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }
}

impl<V> Capped<V> {
    fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.map.get_mut(key)
    }

    fn insert(&mut self, key: &str, value: V, cap: usize) {
        if self.map.insert(key.to_owned(), value).is_none() {
            self.order.push_back(key.to_owned());
            while self.map.len() > cap {
                match self.order.pop_front() {
                    Some(old) => {
                        self.map.remove(&old);
                    }
                    None => break,
                }
            }
        }
    }

    fn remove(&mut self, key: &str) -> Option<V> {
        let value = self.map.remove(key)?;
        self.order.retain(|k| k != key);
        Some(value)
    }

    fn retain(&mut self, mut keep: impl FnMut(&str, &V) -> bool) {
        self.map.retain(|k, v| keep(k, v));
        let map = &self.map;
        self.order.retain(|k| map.contains_key(k));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.len()
    }
}

/// a thread's last journaled state.
#[derive(Debug)]
struct Base {
    thread: Thread,
    /// its next frame goes whole (a crash start, an encoder change).
    whole: bool,
}

/// the last journaled state of a part: a digest of its whole json, and the
/// message it belongs to.
#[derive(Debug)]
struct Remembered {
    digest: [u8; 32],
    message: String,
}

#[derive(Debug, Default)]
pub struct Encoder {
    threads: HashMap<String, Base>,
    order: Option<Vec<String>>,
    order_whole: bool,
    pending: Vec<Pending>,
    pending_bytes: usize,
    /// per streaming text or reasoning part, keyed `<thread>\n<part>`.
    texts: Capped<TextHash>,
    parts: Capped<Remembered>,
    messages: Capped<[u8; 32]>,
    /// per running btw, keyed `<thread>\n<btw>`: the utf-16 length of its
    /// answer as journaled and pending. cmx2's btw deltas carry no offset,
    /// so the encoder counts one.
    btws: Capped<u64>,
}

fn digest(value: &impl serde::Serialize) -> Option<[u8; 32]> {
    let json = serde_json::to_vec(value).ok()?;
    Some(Sha256::digest(&json).into())
}

fn part_key(key: &str, part: &str) -> String {
    format!("{key}\n{part}")
}

fn utf16_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

/// the part of `text` after its first `units` utf-16 units.
fn after_units(text: &str, units: u64) -> &str {
    let mut seen = 0u64;
    for (at, c) in text.char_indices() {
        if seen >= units {
            return &text[at..];
        }
        seen += c.len_utf16() as u64;
    }
    ""
}

impl Encoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// every key's next frame goes whole: a crash start, or a build whose
    /// encoding changed (`docs/protocol.md`, section 10).
    pub fn all_whole(&mut self) {
        for base in self.threads.values_mut() {
            base.whole = true;
        }
        self.order_whole = true;
    }

    /// a thread's last journaled state: what a catch-up or a reset sends
    /// whole, so the patches after it apply.
    #[must_use]
    pub fn base(&self, key: &str) -> Option<&Thread> {
        self.threads.get(key).map(|b| &b.thread)
    }

    /// whether the thread's next frame goes whole; none for a thread
    /// without a base.
    #[must_use]
    pub fn whole(&self, key: &str) -> Option<bool> {
        self.threads.get(key).map(|b| b.whole)
    }

    /// whether the order's next frame goes whole.
    #[must_use]
    pub fn order_whole(&self) -> bool {
        self.order_whole
    }

    /// a thread's base as `boxbox.db` kept it, with its `whole` flag.
    pub fn restore_thread(&mut self, thread: Thread, whole: bool) {
        self.threads
            .insert(thread.key.clone(), Base { thread, whole });
    }

    /// the order's base as `boxbox.db` kept it.
    pub fn restore_order(&mut self, keys: Vec<String>, whole: bool) {
        self.order = Some(keys);
        self.order_whole = whole;
    }

    /// the window order as last journaled.
    #[must_use]
    pub fn order_base(&self) -> Option<&[String]> {
        self.order.as_deref()
    }

    /// a thread's new state: whole on first sight or when flagged, a patch
    /// otherwise, nothing when nothing changed. pending deltas go first.
    pub fn thread(&mut self, thread: Thread) -> Vec<Change> {
        let change = match self.threads.get_mut(&thread.key) {
            Some(base) if !base.whole => {
                let Some(patch) = patch::thread(&base.thread, &thread) else {
                    return Vec::new();
                };
                base.thread = thread;
                Change::ThreadPatch(patch)
            }
            _ => {
                self.threads.insert(
                    thread.key.clone(),
                    Base {
                        thread: thread.clone(),
                        whole: false,
                    },
                );
                Change::Thread { thread }
            }
        };
        self.then(change)
    }

    /// a thread left the fleet: its base goes, so its next sight is whole.
    pub fn thread_removed(&mut self, key: &str) -> Vec<Change> {
        self.threads.remove(key);
        self.forget_thread(key);
        self.then(Change::ThreadRemoved {
            key: key.to_owned(),
        })
    }

    /// the thread's journal cannot be trusted whole: clients read it again,
    /// so what was journaled of its parts and messages is forgotten.
    pub fn thread_reset(&mut self, key: &str) -> Vec<Change> {
        self.forget_thread(key);
        self.then(Change::ThreadReset {
            key: key.to_owned(),
        })
    }

    fn forget_thread(&mut self, key: &str) {
        let prefix = format!("{key}\n");
        self.texts.retain(|k, _| !k.starts_with(&prefix));
        self.parts.retain(|k, _| !k.starts_with(&prefix));
        self.messages.retain(|k, _| !k.starts_with(&prefix));
        self.btws.retain(|k, _| !k.starts_with(&prefix));
        self.pending.retain(|p| p.key != key);
        self.pending_bytes = self.pending.iter().map(|p| p.text.len()).sum();
    }

    /// the window order: a patch when it is smaller than the list.
    pub fn order(&mut self, keys: Vec<String>) -> Vec<Change> {
        let change = match &self.order {
            Some(prev) if *prev == keys && !self.order_whole => return Vec::new(),
            Some(prev) if !self.order_whole => match patch::order(prev, &keys) {
                Some(ops) => Change::OrderPatch { ops },
                None => Change::Order { keys: keys.clone() },
            },
            _ => Change::Order { keys: keys.clone() },
        };
        self.order = Some(keys);
        self.order_whole = false;
        self.then(change)
    }

    /// any other entry: pending deltas first, then it.
    pub fn other(&mut self, change: Change) -> Vec<Change> {
        self.then(change)
    }

    fn then(&mut self, change: Change) -> Vec<Change> {
        let mut out = self.flush();
        out.push(change);
        out
    }

    /// a message: not journaled when it equals the last one journaled for it.
    pub fn message(&mut self, key: &str, upstream: Option<u64>, message: Message) -> Vec<Change> {
        let id = part_key(key, &message.id);
        let digest = digest(&message);
        if let Some(d) = digest {
            if self.messages.get(&id) == Some(&d) {
                return Vec::new();
            }
            self.messages.insert(&id, d, REMEMBERED);
        }
        self.then(Change::Message {
            key: key.to_owned(),
            upstream,
            message,
        })
    }

    /// a message left its thread: what was journaled of it is forgotten.
    pub fn message_removed(
        &mut self,
        key: &str,
        upstream: Option<u64>,
        message_id: String,
    ) -> Vec<Change> {
        self.messages.remove(&part_key(key, &message_id));
        let prefix = format!("{key}\n");
        let gone: Vec<String> = self
            .parts
            .map
            .iter()
            .filter(|(k, r)| k.starts_with(&prefix) && r.message == message_id)
            .map(|(k, _)| k.clone())
            .collect();
        for k in gone {
            self.parts.remove(&k);
            self.texts.remove(&k);
        }
        self.pending.retain(|p| {
            !(p.key == key
                && matches!(&p.target, Target::Part { message_id: m, .. } if *m == message_id))
        });
        self.pending_bytes = self.pending.iter().map(|p| p.text.len()).sum();
        self.then(Change::MessageRemoved {
            key: key.to_owned(),
            upstream,
            message_id,
        })
    }

    /// a part, created or replaced whole: not journaled when it equals the
    /// last state journaled for it; without its text when the deltas built
    /// exactly that text (`docs/protocol.md`, section 8).
    pub fn part(&mut self, key: &str, upstream: Option<u64>, mut part: Part) -> Vec<Change> {
        let id = part_key(key, part.id());
        let whole = digest(&part);
        if let Some(d) = whole
            && self.parts.get(&id).is_some_and(|r| r.digest == d)
        {
            return Vec::new();
        }
        // pending deltas first: they build the text this part is held to
        let mut out = self.flush();
        let text = match &mut part {
            Part::Text(p) => Some((
                &mut p.text,
                &mut p.text_of,
                p.time.as_ref().is_some_and(|t| t.end.is_some()),
            )),
            Part::Reasoning(p) => Some((
                &mut p.text,
                &mut p.text_of,
                p.time.as_ref().is_some_and(|t| t.end.is_some()),
            )),
            _ => None,
        };
        if let Some((text, text_of, ended)) = text
            && let Some(full) = text.as_deref()
        {
            let built = TextHash::of(full);
            if self.texts.get(&id) == Some(&built) && !full.is_empty() {
                *text_of = Some(built.text_of());
                *text = None;
            }
            if ended {
                // its end: no delta builds on it any more, and the step-end
                // re-send is caught by the part's digest below
                self.texts.remove(&id);
            } else {
                // the text from here on builds from this whole one
                self.texts.insert(&id, built, TRACKED_PARTS);
            }
        }
        if let Some(d) = whole {
            self.parts.insert(
                &id,
                Remembered {
                    digest: d,
                    message: part.message_id().to_owned(),
                },
                REMEMBERED,
            );
        }
        out.push(Change::Part {
            key: key.to_owned(),
            upstream,
            part,
        });
        out
    }

    /// a streamed text delta: merged with its part's pending one while it
    /// chains; one that does not chain sends the pending one first.
    #[allow(clippy::too_many_arguments)]
    pub fn delta(
        &mut self,
        now: i64,
        key: &str,
        message_id: &str,
        part_id: &str,
        field: &str,
        delta: &str,
        offset: u64,
    ) -> Vec<Change> {
        let mut out = Vec::new();
        if let Some(at) = self.pending.iter().position(|p| {
            p.key == key && matches!(&p.target, Target::Part { part_id: id, .. } if id == part_id)
        }) {
            let p = &mut self.pending[at];
            let chains = matches!(&p.target, Target::Part { field: f, .. } if f == field)
                && p.offset.map(|o| o + p.units) == Some(offset);
            if chains {
                p.text.push_str(delta);
                p.units += utf16_len(delta);
                self.pending_bytes += delta.len();
                if self.pending_bytes > PENDING_BYTES {
                    out.extend(self.flush());
                }
                return out;
            }
            let p = self.pending.remove(at);
            self.pending_bytes -= p.text.len();
            out.push(self.journal_delta(p));
        }
        self.pending.push(Pending {
            key: key.to_owned(),
            target: Target::Part {
                message_id: message_id.to_owned(),
                part_id: part_id.to_owned(),
                field: field.to_owned(),
            },
            offset: Some(offset),
            text: delta.to_owned(),
            units: utf16_len(delta),
            first: now,
        });
        self.pending_bytes += delta.len();
        if self.pending_bytes > PENDING_BYTES {
            out.extend(self.flush());
        }
        out
    }

    /// a btw, created or replaced whole: pending deltas first, then it. a
    /// running one's answer is what its next deltas build on; a settled one
    /// takes no more, so its length is no longer tracked.
    pub fn btw(&mut self, key: &str, upstream: Option<u64>, btw: Btw) -> Vec<Change> {
        let out = self.flush();
        let id = part_key(key, &btw.id);
        if btw.status.settled() {
            self.btws.remove(&id);
        } else if let Some(units) = self.btws.get_mut(&id) {
            *units = utf16_len(&btw.answer);
        } else {
            self.btws.insert(&id, utf16_len(&btw.answer), TRACKED_BTWS);
        }
        let mut out = out;
        out.push(Change::Btw {
            key: key.to_owned(),
            upstream,
            btw,
        });
        out
    }

    /// streamed text for a btw's answer: merged with its pending one, at
    /// the offset the encoder counted; none for a btw it does not track (one
    /// first seen by its deltas, or one past the cap), which the client
    /// answers by reading the btws again.
    pub fn btw_delta(&mut self, now: i64, key: &str, btw_id: &str, delta: &str) -> Vec<Change> {
        let mut out = Vec::new();
        let units = utf16_len(delta);
        let id = part_key(key, btw_id);
        let offset = self.btws.get_mut(&id).map(|known| {
            let before = *known;
            *known += units;
            before
        });
        let pending = self.pending.iter_mut().find(|p| {
            p.key == key && matches!(&p.target, Target::Btw { btw_id: b } if b == btw_id)
        });
        // a btw's deltas come in order and never overlap, so each chains
        // onto the pending one, known offset or not
        if let Some(p) = pending {
            p.text.push_str(delta);
            p.units += units;
        } else {
            self.pending.push(Pending {
                key: key.to_owned(),
                target: Target::Btw {
                    btw_id: btw_id.to_owned(),
                },
                offset,
                text: delta.to_owned(),
                units,
                first: now,
            });
        }
        self.pending_bytes += delta.len();
        if self.pending_bytes > PENDING_BYTES {
            out.extend(self.flush());
        }
        out
    }

    /// when the oldest pending delta is due, ms.
    #[must_use]
    pub fn due(&self) -> Option<i64> {
        self.pending.iter().map(|p| p.first + DELTA_EVERY_MS).min()
    }

    /// the pending deltas whose 100 ms have passed, in arrival order.
    pub fn flush_due(&mut self, now: i64) -> Vec<Change> {
        let mut out = Vec::new();
        let mut kept = Vec::new();
        for p in std::mem::take(&mut self.pending) {
            if p.first + DELTA_EVERY_MS <= now {
                out.push(self.journal_delta(p));
            } else {
                kept.push(p);
            }
        }
        self.pending = kept;
        self.pending_bytes = self.pending.iter().map(|p| p.text.len()).sum();
        out
    }

    /// every pending delta, in the order their first deltas arrived.
    pub fn flush(&mut self) -> Vec<Change> {
        self.pending_bytes = 0;
        std::mem::take(&mut self.pending)
            .into_iter()
            .map(|p| self.journal_delta(p))
            .collect()
    }

    /// a merged delta on its way into the journal: the built text grows.
    fn journal_delta(&mut self, p: Pending) -> Change {
        let (message_id, part_id, field) = match p.target {
            Target::Part {
                message_id,
                part_id,
                field,
            } => (message_id, part_id, field),
            Target::Btw { btw_id } => {
                return Change::BtwDelta {
                    key: p.key,
                    btw_id,
                    delta: p.text,
                    offset: p.offset,
                };
            }
        };
        // a part's pending delta always carries its offset
        let offset = p.offset.unwrap_or_default();
        let id = part_key(&p.key, &part_id);
        match self.texts.get_mut(&id) {
            Some(built) if offset <= built.length && offset + p.units > built.length => {
                built.push(after_units(&p.text, built.length - offset));
            }
            // a re-send of what it already holds
            Some(built) if offset + p.units <= built.length => {}
            // a gap: the built text is no longer the client's
            Some(_) => {
                self.texts.remove(&id);
            }
            None if offset == 0 => {
                self.texts.insert(&id, TextHash::of(&p.text), TRACKED_PARTS);
            }
            None => {}
        }
        Change::Delta {
            key: p.key,
            message_id,
            part_id,
            field,
            delta: p.text,
            offset,
        }
    }

    /// what the caps hold, for the tests.
    #[cfg(test)]
    #[must_use]
    pub fn tracked(&self) -> (usize, usize, usize) {
        (self.texts.len(), self.parts.len(), self.messages.len())
    }
}

/// order ops for the tests of other modules.
#[cfg(test)]
pub fn apply_order(base: &[String], ops: &[crate::wire::OrderOp]) -> Vec<String> {
    patch::apply_order(base, ops).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{PartAt, TextPart};

    fn text_part(id: &str, text: &str) -> Part {
        Part::Text(TextPart {
            id: id.into(),
            message_id: "msg_1".into(),
            at: Some(PartAt { step: 1, index: 0 }),
            text: Some(text.into()),
            text_of: None,
            streaming: false,
            time: None,
            synthetic: false,
            notice: false,
            mail: None,
        })
    }

    fn kinds(changes: &[Change]) -> Vec<&'static str> {
        changes.iter().map(Change::kind).collect()
    }

    #[test]
    fn deltas_that_chain_merge_into_one_and_go_when_due() {
        let mut e = Encoder::new();
        assert!(e.delta(0, "k", "m", "p", "text", "hel", 0).is_empty());
        assert!(e.delta(40, "k", "m", "p", "text", "lo", 3).is_empty());
        assert_eq!(e.due(), Some(100));
        assert!(e.flush_due(99).is_empty());
        let out = e.flush_due(100);
        let [Change::Delta { delta, offset, .. }] = out.as_slice() else {
            panic!("{out:?}")
        };
        assert_eq!((delta.as_str(), *offset), ("hello", 0));
        assert_eq!(e.due(), None);
    }

    #[test]
    fn a_delta_that_does_not_chain_sends_the_pending_one_first() {
        let mut e = Encoder::new();
        e.delta(0, "k", "m", "p", "text", "abc", 0);
        let out = e.delta(10, "k", "m", "p", "text", "zzz", 10);
        assert_eq!(kinds(&out), ["delta"]);
        assert_eq!(e.flush().len(), 1);
    }

    #[test]
    fn any_other_entry_takes_every_pending_delta_out_first_in_arrival_order() {
        let mut e = Encoder::new();
        e.delta(0, "a", "m", "p1", "text", "one", 0);
        e.delta(5, "b", "m", "p2", "text", "two", 0);
        let out = e.other(Change::ThreadReset { key: "c".into() });
        assert_eq!(kinds(&out), ["delta", "delta", "thread.reset"]);
        let Change::Delta { key, .. } = &out[0] else {
            panic!()
        };
        assert_eq!(key, "a");
    }

    #[test]
    fn a_finished_part_whose_text_the_deltas_built_goes_without_its_text_once() {
        let mut e = Encoder::new();
        let first = e.part("k", Some(1), text_part("p", ""));
        assert_eq!(kinds(&first), ["part"]);
        e.delta(0, "k", "msg_1", "p", "text", "hello ", 0);
        e.delta(10, "k", "msg_1", "p", "text", "world", 6);
        let end = e.part("k", Some(2), text_part("p", "hello world"));
        assert_eq!(kinds(&end), ["delta", "part"]);
        let Change::Part {
            part: Part::Text(p),
            ..
        } = &end[1]
        else {
            panic!()
        };
        assert_eq!(p.text, None);
        let of = p.text_of.clone().unwrap();
        assert_eq!(of.length, 11);
        assert_eq!(of, TextHash::of("hello world").text_of());
        // the step-end re-send is not journaled at all
        assert!(
            e.part("k", Some(3), text_part("p", "hello world"))
                .is_empty()
        );
        // a different text goes whole
        let other = e.part("k", Some(4), text_part("p", "hello there"));
        let Change::Part {
            part: Part::Text(p),
            ..
        } = &other[0]
        else {
            panic!()
        };
        assert_eq!(p.text.as_deref(), Some("hello there"));
    }

    #[test]
    fn a_part_whose_deltas_had_a_gap_goes_whole() {
        let mut e = Encoder::new();
        e.delta(0, "k", "msg_1", "p", "text", "hello ", 0);
        e.flush();
        e.delta(200, "k", "msg_1", "p", "text", "x", 9);
        e.flush();
        let end = e.part("k", None, text_part("p", "hello abcx"));
        let Change::Part {
            part: Part::Text(p),
            ..
        } = &end[0]
        else {
            panic!()
        };
        assert!(p.text.is_some());
    }

    #[test]
    fn an_unchanged_message_is_not_journaled_again() {
        let mut e = Encoder::new();
        let m: Message = serde_json::from_value(
            serde_json::json!({"id": "msg_1", "role": "assistant", "created": 1.0}),
        )
        .unwrap();
        assert_eq!(e.message("k", Some(1), m.clone()).len(), 1);
        assert!(e.message("k", Some(9), m.clone()).is_empty());
        e.message_removed("k", Some(10), "msg_1".into());
        assert_eq!(e.message("k", Some(11), m).len(), 1);
    }

    #[test]
    fn the_order_goes_as_a_patch_unless_whole_is_smaller_or_flagged() {
        let mut e = Encoder::new();
        let keys: Vec<String> = (0..20).map(|i| format!("vm-a:ses_{i}")).collect();
        assert_eq!(kinds(&e.order(keys.clone())), ["order"]);
        assert!(e.order(keys.clone()).is_empty());
        let mut moved = keys.clone();
        moved.swap(0, 5);
        let out = e.order(moved.clone());
        let [Change::OrderPatch { ops }] = out.as_slice() else {
            panic!("{out:?}")
        };
        assert_eq!(apply_order(&keys, ops), moved);
        e.all_whole();
        assert_eq!(kinds(&e.order(moved)), ["order"]);
    }

    #[test]
    fn a_part_s_text_tracking_goes_at_its_end_and_its_step_end_re_send_is_still_not_journaled() {
        let ended = |text: &str| {
            let mut part = text_part("p", text);
            if let Part::Text(p) = &mut part {
                p.time = Some(crate::wire::PartTime {
                    start: Some(1.0),
                    end: Some(2.0),
                });
            }
            part
        };
        let mut e = Encoder::new();
        e.part("k", Some(1), text_part("p", ""));
        e.delta(0, "k", "msg_1", "p", "text", "hello world", 0);
        e.flush();
        assert_eq!(e.tracked().0, 1, "a streaming part is tracked");
        // the part's end goes without its text, and its tracking goes with it
        let end = e.part("k", Some(2), ended("hello world"));
        let Some(Change::Part {
            part: Part::Text(p),
            ..
        }) = end.last()
        else {
            panic!("{end:?}")
        };
        assert_eq!(p.text, None);
        assert_eq!(p.text_of, Some(TextHash::of("hello world").text_of()));
        assert_eq!(e.tracked().0, 0, "the ended part is still tracked");
        // the step end sends it again, the same: the digest drops it
        assert!(e.part("k", Some(3), ended("hello world")).is_empty());
    }

    fn btw(id: &str, answer: &str, status: crate::wire::BtwStatus) -> Btw {
        Btw {
            id: id.into(),
            question: "why".into(),
            answer: answer.into(),
            status,
            error: None,
            after_message_id: None,
            created: 1.0,
            completed: None,
            dismissed: None,
            promoted_message_id: None,
            model: None,
            tokens: None,
            cost: None,
        }
    }

    fn btw_delta(change: &Change) -> (&str, Option<u64>) {
        let Change::BtwDelta { delta, offset, .. } = change else {
            panic!("{change:?}")
        };
        (delta.as_str(), *offset)
    }

    #[test]
    fn btw_deltas_merge_into_one_batch_at_the_offset_the_encoder_counts() {
        use crate::wire::BtwStatus::Running;
        let mut e = Encoder::new();
        assert_eq!(
            kinds(&e.btw("k", Some(1), btw("b", "ab", Running))),
            ["btw"]
        );
        assert!(e.btw_delta(0, "k", "b", "c\u{1F600}").is_empty());
        assert!(e.btw_delta(40, "k", "b", "d").is_empty());
        assert_eq!(e.due(), Some(100));
        let out = e.flush_due(100);
        assert_eq!(out.len(), 1);
        assert_eq!(btw_delta(&out[0]), ("c\u{1F600}d", Some(2)));
        // the emoji is two utf-16 units: the next batch starts at 2 + 1 + 2 + 1
        e.btw_delta(200, "k", "b", "e");
        assert_eq!(btw_delta(&e.flush()[0]), ("e", Some(6)));
    }

    #[test]
    fn a_whole_btw_takes_its_pending_deltas_out_first_and_resets_the_count() {
        use crate::wire::BtwStatus::{Done, Running};
        let mut e = Encoder::new();
        e.btw("k", Some(1), btw("b", "", Running));
        e.btw_delta(0, "k", "b", "hello");
        let out = e.btw("k", Some(2), btw("b", "hello world", Running));
        assert_eq!(kinds(&out), ["btw.delta", "btw"]);
        assert_eq!(btw_delta(&out[0]), ("hello", Some(0)));
        e.btw_delta(10, "k", "b", "!");
        assert_eq!(btw_delta(&e.flush()[0]), ("!", Some(11)));
        // settled: no delta builds on it any more
        e.btw("k", Some(3), btw("b", "hello world!", Done));
        e.btw_delta(20, "k", "b", "late");
        assert_eq!(btw_delta(&e.flush()[0]), ("late", None));
    }

    #[test]
    fn a_btw_the_encoder_never_saw_whole_streams_without_an_offset() {
        let mut e = Encoder::new();
        e.btw_delta(0, "k", "unknown", "abc");
        e.btw_delta(5, "k", "unknown", "def");
        let out = e.flush();
        assert_eq!(out.len(), 1);
        assert_eq!(btw_delta(&out[0]), ("abcdef", None));
    }

    #[test]
    fn btw_and_part_deltas_batch_apart_and_go_in_arrival_order() {
        use crate::wire::BtwStatus::Running;
        let mut e = Encoder::new();
        e.btw("k", None, btw("b", "", Running));
        e.delta(0, "k", "m", "p", "text", "one", 0);
        e.btw_delta(1, "k", "b", "two");
        e.delta(2, "k", "m", "p", "text", "three", 3);
        let out = e.other(Change::ThreadReset { key: "x".into() });
        assert_eq!(kinds(&out), ["delta", "btw.delta", "thread.reset"]);
        let Change::Delta { delta, .. } = &out[0] else {
            panic!()
        };
        assert_eq!(delta, "onethree");
        // a reset forgets the thread's counts
        e.btw("k", None, btw("b", "zz", Running));
        e.thread_reset("k");
        e.btw_delta(10, "k", "b", "q");
        assert_eq!(btw_delta(&e.flush()[0]), ("q", None));
    }

    #[test]
    fn the_btw_counts_keep_their_cap() {
        use crate::wire::BtwStatus::Running;
        let mut e = Encoder::new();
        for i in 0..(TRACKED_BTWS + 10) {
            e.btw("k", None, btw(&format!("b{i}"), "", Running));
        }
        assert_eq!(e.btws.len(), TRACKED_BTWS);
        // the oldest went first: its deltas lose their offset
        e.btw_delta(0, "k", "b0", "x");
        e.btw_delta(0, "k", &format!("b{}", TRACKED_BTWS + 9), "y");
        let out = e.flush();
        assert_eq!(btw_delta(&out[0]).1, None);
        assert_eq!(btw_delta(&out[1]).1, Some(0));
    }

    #[test]
    fn the_tracking_maps_keep_their_caps() {
        let mut e = Encoder::new();
        for i in 0..(REMEMBERED + 10) {
            e.part("k", None, text_part(&format!("p{i}"), "x"));
        }
        let (texts, parts, _) = e.tracked();
        assert!(texts <= TRACKED_PARTS && parts <= REMEMBERED);
    }
}
