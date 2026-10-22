//! what the journal knows per key, beside the patch bases the encoder holds
//! (`docs/protocol.md`, sections 9 to 11): the newest entry of every agent,
//! thread, open ask and the order, each thread's versions (`v`, `rv`,
//! `reset_seq`), and the tombstones of what was removed or settled.
//!
//! it is the in-memory half of `stream_keys` and `stream_gone` (section 10):
//! one struct, so the resume package can persist it as it stands. the
//! bodies a catch-up sends are the last journaled states: agents and asks
//! here, threads and the order in the encoder (its patch bases).
//!
//! every map has a cap: a thread's keys go with the thread (the model keeps
//! at most `model::MAX_SESSIONS`), an agent's and an ask's with theirs, the
//! tombstones at `GONE_ROWS` or `GONE_MS`, and the newest-turn ids at
//! `TURN_IDS` per thread and `ALL_TURN_IDS` over every thread.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::wire::{Agent, Ask, Change, Role};

/// tombstones kept, at most.
pub const GONE_ROWS: usize = 10_000;
/// how long a tombstone is kept, at most, ms.
pub const GONE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// message ids of a thread's newest turn tracked for `rv`; past it every
/// transcript entry of the thread counts as a rewrite.
pub const TURN_IDS: usize = 1000;
/// newest-turn message ids over every thread together: a thread whose set
/// would grow past it goes full, as past `TURN_IDS`.
pub const ALL_TURN_IDS: usize = 16_384;

/// one thread's place in the journal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadKeys {
    /// the newest `thread` or `thread.patch` entry.
    pub seq: u64,
    /// the newest transcript entry, or the head when first seen, or its
    /// last `thread.reset`.
    pub v: u64,
    /// the newest transcript entry that touched a message outside the
    /// newest turn (or the head when first seen, or its last reset).
    pub rv: u64,
    /// its last `thread.reset`, 0 if none.
    pub reset_seq: u64,
    turn: Turn,
}

/// the thread's newest turn, as `rv` counts it: it starts at the newest
/// user message that is not queued; a queued prompt joins it.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Turn {
    /// the message that starts it; none before the first one is seen.
    start: Option<String>,
    /// its creation time, so an older message is not taken for a new one.
    created: Option<u64>,
    ids: HashSet<String>,
    /// past `TURN_IDS`: every entry counts.
    full: bool,
}

/// a creation time as an ordered integer (ms are whole in practice).
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a clock in ms; negative or fractional times only lose their order among themselves"
)]
fn created(at: f64) -> u64 {
    at.max(0.0) as u64
}

impl ThreadKeys {
    fn first_seen(seq: u64) -> Self {
        Self {
            seq,
            v: seq,
            rv: seq,
            reset_seq: 0,
            turn: Turn::default(),
        }
    }

    /// a transcript entry at `seq` for `message`: `v` moves, and `rv` when
    /// the message is outside the newest turn.
    fn touched(&mut self, seq: u64, message: &str) {
        self.v = seq;
        if self.turn.full || !self.turn.ids.contains(message) {
            self.rv = seq;
        }
    }

    /// a btw entry: the whole read and the newest page carry the thread's
    /// btws, so `v` moves; no older page holds one, so `rv` stays.
    fn btw(&mut self, seq: u64) {
        self.v = seq;
    }

    /// a message entry. `room` says the fleet-wide set of newest-turn ids
    /// may grow; without it a set that would grow goes full instead.
    fn message(&mut self, seq: u64, id: &str, role: Role, queued: bool, at: f64, room: bool) {
        self.v = seq;
        let turn = &mut self.turn;
        let at = created(at);
        let newer = turn.created.is_some_and(|start| at >= start);
        if role == Role::User && !queued {
            if turn.start.as_deref() == Some(id) {
                if turn.full {
                    self.rv = seq;
                }
                return;
            }
            // a new prompt, or a queued one taken up: the newest turn starts at it
            if turn.start.is_none() || newer || turn.ids.contains(id) {
                // the new set of one only grows the fleet's when the old one was empty
                let grows = turn.ids.is_empty();
                *turn = if room || !grows {
                    Turn {
                        start: Some(id.to_owned()),
                        created: Some(at),
                        ids: HashSet::from([id.to_owned()]),
                        full: false,
                    }
                } else {
                    Turn {
                        start: Some(id.to_owned()),
                        created: Some(at),
                        ids: HashSet::new(),
                        full: true,
                    }
                };
                return;
            }
            self.rv = seq;
            return;
        }
        if turn.ids.contains(id) {
            if turn.full {
                self.rv = seq;
            }
            return;
        }
        if newer {
            if turn.ids.len() >= TURN_IDS || !room {
                turn.full = true;
                self.rv = seq;
            } else {
                turn.ids.insert(id.to_owned());
            }
            return;
        }
        self.rv = seq;
    }

    fn removed(&mut self, seq: u64, id: &str) {
        self.v = seq;
        if !self.turn.full && self.turn.ids.remove(id) {
            return;
        }
        self.rv = seq;
    }
}

/// an agent or an open ask as last journaled.
#[derive(Debug, Clone)]
pub struct Kept<T> {
    pub seq: u64,
    pub body: T,
    /// for an ask: the entry that first raised it.
    pub raised: u64,
}

/// what was removed or settled, kept so a catch-up can say so.
#[derive(Debug, Clone)]
struct Gone {
    seq: u64,
    at: i64,
    /// for a settled ask: the entry that raised it.
    raised: u64,
    change: Change,
}

/// `stream_gone.kind` by `gone_key`'s number.
const GONE_KINDS: [&str; 3] = ["agent", "thread", "ask"];

/// a tombstone as `stream_gone` keeps it.
#[derive(Debug, Clone)]
pub struct Grave {
    pub kind: &'static str,
    pub key: String,
    pub seq: u64,
    pub at: i64,
    pub raised: u64,
    /// the removal or settlement a catch-up sends, as json.
    pub body: String,
}

/// which key a tombstone is for.
fn gone_key(change: &Change) -> Option<(u8, String)> {
    match change {
        Change::AgentRemoved { agent } => Some((0, agent.clone())),
        Change::ThreadRemoved { key } => Some((1, key.clone())),
        Change::AskSettled(s) => Some((2, format!("{}\n{}", s.agent, s.id))),
        _ => None,
    }
}

#[derive(Debug, Default)]
pub struct StreamKeys {
    agents: HashMap<String, Kept<Agent>>,
    threads: HashMap<String, ThreadKeys>,
    asks: HashMap<(String, String), Kept<Ask>>,
    /// the newest `order` or `order.patch` entry, 0 before any.
    order: u64,
    gone: VecDeque<Gone>,
    /// newest-turn ids held over every thread, at most `ALL_TURN_IDS`.
    turn_ids: usize,
    /// the highest seq ever dropped from the tombstones: a cursor below it
    /// may have missed a removal nobody can tell it of any more.
    gone_floor: u64,
}

/// the overview a catch-up from a cursor sends, before the bodies the
/// encoder holds are filled in.
#[derive(Debug, Default)]
pub struct Since {
    /// each as `(seq, change)`: agents and asks whole, removals and
    /// settlements, and `thread.reset` frames.
    pub entries: Vec<(u64, Change)>,
    /// threads changed after the cursor, with the seq of their newest entry.
    pub threads: Vec<(u64, String)>,
    /// the order's newest seq, when it changed after the cursor.
    pub order: Option<u64>,
}

impl StreamKeys {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// one entry the journal took, at `seq`, on the clock `now` (ms).
    pub fn saw(&mut self, seq: u64, change: &Change, now: i64) {
        match change {
            Change::Agent { agent } => {
                self.forget_gone(change);
                self.agents.insert(
                    agent.key.clone(),
                    Kept {
                        seq,
                        body: agent.clone(),
                        raised: seq,
                    },
                );
            }
            Change::AgentRemoved { agent } => {
                self.agents.remove(agent);
                self.bury(seq, now, 0, change.clone());
            }
            Change::Thread { thread } => {
                self.forget_gone(change);
                self.threads
                    .entry(thread.key.clone())
                    .and_modify(|t| t.seq = seq)
                    .or_insert_with(|| ThreadKeys::first_seen(seq));
            }
            Change::ThreadPatch(patch) => {
                if let Some(t) = self.threads.get_mut(&patch.key) {
                    t.seq = seq;
                }
            }
            Change::ThreadRemoved { key } => {
                if let Some(t) = self.threads.remove(key) {
                    self.turn_ids -= t.turn.ids.len();
                }
                self.bury(seq, now, 0, change.clone());
            }
            Change::ThreadReset { key } => {
                if let Some(t) = self.threads.get_mut(key) {
                    t.reset_seq = seq;
                    t.v = seq;
                    // the journal can no longer say which pages held still
                    t.rv = seq;
                    self.turn_ids -= t.turn.ids.len();
                    t.turn = Turn::default();
                }
            }
            Change::Ask { ask } => {
                let id = (ask.agent.clone(), ask.id.clone());
                let raised = self.asks.get(&id).map_or(seq, |k| k.raised);
                self.asks.insert(
                    id,
                    Kept {
                        seq,
                        body: ask.clone(),
                        raised,
                    },
                );
            }
            Change::AskSettled(settled) => {
                let raised = self
                    .asks
                    .remove(&(settled.agent.clone(), settled.id.clone()))
                    .map_or(0, |k| k.raised);
                self.bury(seq, now, raised, change.clone());
            }
            Change::Order { .. } | Change::OrderPatch { .. } => self.order = seq,
            Change::Message { key, message, .. } => self.in_turn(key, |t, room| {
                t.message(
                    seq,
                    &message.id,
                    message.role,
                    message.queued,
                    message.created,
                    room,
                );
            }),
            Change::Part { key, part, .. } => {
                if let Some(t) = self.threads.get_mut(key) {
                    t.touched(seq, part.message_id());
                }
            }
            Change::Delta {
                key, message_id, ..
            }
            | Change::Reactions {
                key, message_id, ..
            } => {
                if let Some(t) = self.threads.get_mut(key) {
                    t.touched(seq, message_id);
                }
            }
            Change::MessageRemoved {
                key, message_id, ..
            } => {
                self.in_turn(key, |t, _| t.removed(seq, message_id));
            }
            Change::Btw { key, .. } | Change::BtwDelta { key, .. } => {
                if let Some(t) = self.threads.get_mut(key) {
                    t.btw(seq);
                }
            }
        }
    }

    /// a change to a thread's newest-turn ids, kept in the fleet-wide count;
    /// `room` says the count is under `ALL_TURN_IDS`.
    fn in_turn(&mut self, key: &str, change: impl FnOnce(&mut ThreadKeys, bool)) {
        let room = self.turn_ids < ALL_TURN_IDS;
        if let Some(t) = self.threads.get_mut(key) {
            let held = t.turn.ids.len();
            change(t, room);
            self.turn_ids = self.turn_ids - held + t.turn.ids.len();
        }
    }

    fn forget_gone(&mut self, change: &Change) {
        let key = match change {
            Change::Agent { agent } => (0, agent.key.clone()),
            Change::Thread { thread } => (1, thread.key.clone()),
            _ => return,
        };
        self.gone
            .retain(|g| gone_key(&g.change).as_ref() != Some(&key));
    }

    fn bury(&mut self, seq: u64, now: i64, mut raised: u64, change: Change) {
        let key = gone_key(&change);
        // a newer tombstone of the same key says all the older one did, but
        // for an ask raised and settled twice it keeps the first raise: a
        // cursor between that raise and the first settlement holds the ask
        // open and must still be told it settled
        if let Some(older) = self.gone.iter().find(|g| gone_key(&g.change) == key)
            && older.raised != 0
            && raised != 0
        {
            raised = raised.min(older.raised);
        }
        self.gone.retain(|g| gone_key(&g.change) != key);
        self.gone.push_back(Gone {
            seq,
            at: now,
            raised,
            change,
        });
        while let Some(oldest) = self.gone.front() {
            if self.gone.len() <= GONE_ROWS && oldest.at >= now - GONE_MS {
                break;
            }
            self.gone_floor = self.gone_floor.max(oldest.seq);
            self.gone.pop_front();
        }
    }

    /// a cursor below this may have missed a removal: it is reset as expired.
    #[must_use]
    pub fn gone_floor(&self) -> u64 {
        self.gone_floor
    }

    #[must_use]
    pub fn thread(&self, key: &str) -> Option<&ThreadKeys> {
        self.threads.get(key)
    }

    /// what changed after `cursor` in the overview (`docs/protocol.md`,
    /// section 9): each agent and open ask changed after it whole, each
    /// thread changed after it (whose body the encoder holds), the removals
    /// and settlements after it (an ask raised and settled since is not
    /// told), a `thread.reset` for each thread reset after it, and the order
    /// when it moved.
    #[must_use]
    pub fn since(&self, cursor: u64) -> Since {
        let mut since = Since::default();
        for kept in self.agents.values().filter(|k| k.seq > cursor) {
            since.entries.push((
                kept.seq,
                Change::Agent {
                    agent: kept.body.clone(),
                },
            ));
        }
        for kept in self.asks.values().filter(|k| k.seq > cursor) {
            since.entries.push((
                kept.seq,
                Change::Ask {
                    ask: kept.body.clone(),
                },
            ));
        }
        for gone in self
            .gone
            .iter()
            .filter(|g| g.seq > cursor && !(g.raised > cursor && g.raised != 0))
        {
            since.entries.push((gone.seq, gone.change.clone()));
        }
        for (key, t) in &self.threads {
            if t.seq > cursor {
                since.threads.push((t.seq, key.clone()));
            }
            if t.reset_seq > cursor {
                since
                    .entries
                    .push((t.reset_seq, Change::ThreadReset { key: key.clone() }));
            }
        }
        since.order = (self.order > cursor).then_some(self.order);
        since
    }

    /// a thread's place, its newest-turn tracking as json beside it.
    #[must_use]
    pub fn thread_row(&self, key: &str) -> Option<(&ThreadKeys, Option<String>)> {
        let t = self.threads.get(key)?;
        Some((t, serde_json::to_string(&t.turn).ok()))
    }

    #[must_use]
    pub fn agent(&self, key: &str) -> Option<&Kept<Agent>> {
        self.agents.get(key)
    }

    #[must_use]
    pub fn ask(&self, agent: &str, id: &str) -> Option<&Kept<Ask>> {
        self.asks.get(&(agent.to_owned(), id.to_owned()))
    }

    /// the order's newest entry, 0 before any.
    #[must_use]
    pub fn order_seq(&self) -> u64 {
        self.order
    }

    /// every key held: threads, agents, open asks.
    #[must_use]
    pub fn held_keys(&self) -> (Vec<String>, Vec<String>, Vec<(String, String)>) {
        (
            self.threads.keys().cloned().collect(),
            self.agents.keys().cloned().collect(),
            self.asks.keys().cloned().collect(),
        )
    }

    /// the tombstones newer than `seq`, as `stream_gone` keeps them.
    pub fn graves_after(&self, seq: u64) -> impl Iterator<Item = Grave> + '_ {
        self.gone
            .iter()
            .filter(move |g| g.seq > seq)
            .filter_map(|g| {
                let (kind, key) = gone_key(&g.change)?;
                let body = serde_json::to_string(&g.change).ok()?;
                Some(Grave {
                    kind: GONE_KINDS[usize::from(kind)],
                    key,
                    seq: g.seq,
                    at: g.at,
                    raised: g.raised,
                    body,
                })
            })
    }

    /// a thread as its row kept it.
    pub fn restore_thread(
        &mut self,
        key: String,
        seq: u64,
        versions: [u64; 3],
        turn: Option<&str>,
    ) {
        let [v, rv, reset_seq] = versions;
        let turn: Turn = turn
            .and_then(|t| serde_json::from_str(t).ok())
            .unwrap_or_default();
        // the restored ids join the fleet-wide count, which a later removal
        // or reset takes them out of
        let held = turn.ids.len();
        let replaced = self.threads.insert(
            key,
            ThreadKeys {
                seq,
                v,
                rv,
                reset_seq,
                turn,
            },
        );
        self.turn_ids = self.turn_ids - replaced.map_or(0, |t| t.turn.ids.len()) + held;
    }

    pub fn restore_agent(&mut self, kept: Kept<Agent>) {
        self.agents.insert(kept.body.key.clone(), kept);
    }

    pub fn restore_ask(&mut self, kept: Kept<Ask>) {
        self.asks
            .insert((kept.body.agent.clone(), kept.body.id.clone()), kept);
    }

    pub fn restore_order(&mut self, seq: u64) {
        self.order = seq;
    }

    /// the tombstones as `stream_gone` kept them, oldest first, and the floor.
    pub fn restore_graves(&mut self, graves: Vec<(u64, i64, u64, Change)>, floor: u64) {
        self.gone = graves
            .into_iter()
            .map(|(seq, at, raised, change)| Gone {
                seq,
                at,
                raised,
                change,
            })
            .collect();
        self.gone_floor = floor;
    }

    /// after a crash every thread's versions move to `seq` (the reserved
    /// mark), so each revalidation misses once and no stale copy can win a
    /// 304 (`docs/protocol.md`, section 10).
    pub fn versions_to(&mut self, seq: u64) {
        for t in self.threads.values_mut() {
            t.v = seq;
            t.rv = seq;
        }
    }

    /// a floor as if older tombstones had gone, for the tests.
    #[cfg(test)]
    pub fn raise_floor(&mut self, seq: u64) {
        self.gone_floor = self.gone_floor.max(seq);
    }

    /// newest-turn ids held over every thread, for the tests.
    #[cfg(test)]
    #[must_use]
    pub fn turn_ids(&self) -> usize {
        self.turn_ids
    }

    /// how many tombstones are held, for the tests.
    #[cfg(test)]
    #[must_use]
    pub fn graves(&self) -> usize {
        self.gone.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Message;

    fn message(id: &str, role: &str, created: f64, queued: bool) -> Change {
        let message: Message = serde_json::from_value(serde_json::json!({
            "id": id, "role": role, "created": created, "queued": queued,
        }))
        .unwrap();
        Change::Message {
            key: "a:1".into(),
            upstream: None,
            message,
        }
    }

    fn thread() -> Change {
        let thread = serde_json::from_value(serde_json::json!({
            "key": "a:1", "agent": "a", "id": "1", "title": "t", "created": 1.0, "updated": 1.0,
            "activity": {"state": "idle"}, "queued": 0, "browseOnly": false, "agents": 0,
            "processes": 0, "tail": [], "needs": [], "read": null,
        }));
        match thread {
            Ok(thread) => Change::Thread { thread },
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn rv_moves_only_for_messages_outside_the_newest_turn() {
        let mut keys = StreamKeys::new();
        keys.saw(1, &thread(), 0);
        assert_eq!(keys.thread("a:1").map(|t| (t.v, t.rv)), Some((1, 1)));
        keys.saw(2, &message("u1", "user", 10.0, false), 0);
        keys.saw(3, &message("a1", "assistant", 11.0, false), 0);
        // a queued prompt behind the streaming answer joins the turn
        keys.saw(4, &message("u2", "user", 12.0, true), 0);
        keys.saw(
            5,
            &Change::Delta {
                key: "a:1".into(),
                message_id: "a1".into(),
                part_id: "p".into(),
                field: "text".into(),
                delta: "x".into(),
                offset: 0,
            },
            0,
        );
        let t = keys.thread("a:1").unwrap();
        assert_eq!((t.v, t.rv), (5, 1), "the newest turn's entries keep rv");
        // an edit of a message older than the turn moves it
        keys.saw(6, &message("old", "assistant", 1.0, false), 0);
        assert_eq!(keys.thread("a:1").unwrap().rv, 6);
        // the queued prompt taken up starts the next turn; the answer before it is now older
        keys.saw(7, &message("u2", "user", 12.0, false), 0);
        keys.saw(
            8,
            &Change::Reactions {
                key: "a:1".into(),
                message_id: "a1".into(),
                reactions: Vec::new(),
            },
            0,
        );
        assert_eq!(keys.thread("a:1").unwrap().rv, 8);
        keys.saw(9, &Change::ThreadReset { key: "a:1".into() }, 0);
        let t = keys.thread("a:1").unwrap();
        assert_eq!((t.v, t.rv, t.reset_seq), (9, 9, 9));
    }

    #[test]
    fn a_catch_up_tells_what_moved_after_the_cursor_and_never_an_ask_born_and_settled_since() {
        let mut keys = StreamKeys::new();
        keys.saw(1, &thread(), 0);
        keys.saw(2, &Change::Order { keys: Vec::new() }, 0);
        let ask: Ask = serde_json::from_value(serde_json::json!({
            "key": "a:1", "agent": "a", "id": "q1", "thread": "a:1", "kind": "permission",
            "title": "t", "options": [], "created": 1.0,
        }))
        .unwrap_or_else(|e| panic!("{e}"));
        keys.saw(3, &Change::Ask { ask }, 0);
        let settled: crate::wire::AskSettled = serde_json::from_value(serde_json::json!({
            "agent": "a", "id": "q1", "outcome": "unknown", "at": 1.0,
        }))
        .unwrap_or_else(|e| panic!("{e}"));
        keys.saw(4, &Change::AskSettled(settled), 0);
        keys.saw(5, &Change::ThreadRemoved { key: "a:1".into() }, 0);
        let from_two = keys.since(2);
        let kinds: Vec<&str> = from_two.entries.iter().map(|e| e.1.kind()).collect();
        assert_eq!(kinds, ["thread.removed"], "{kinds:?}");
        let from_zero = keys.since(0);
        assert_eq!(from_zero.order, Some(2));
        assert!(from_zero.threads.is_empty());
        let from_three = keys.since(3);
        let mut kinds: Vec<&str> = from_three.entries.iter().map(|e| e.1.kind()).collect();
        kinds.sort_unstable();
        assert_eq!(kinds, ["ask.settled", "thread.removed"]);
    }

    #[test]
    fn an_ask_raised_and_settled_twice_is_still_told_settled_to_a_cursor_inside_the_first_raise() {
        let ask: Ask = serde_json::from_value(serde_json::json!({
            "key": "a:1", "agent": "a", "id": "q1", "thread": "a:1", "kind": "permission",
            "title": "t", "options": [], "created": 1.0,
        }))
        .unwrap_or_else(|e| panic!("{e}"));
        let settled: crate::wire::AskSettled = serde_json::from_value(serde_json::json!({
            "agent": "a", "id": "q1", "outcome": "unknown", "at": 1.0,
        }))
        .unwrap_or_else(|e| panic!("{e}"));
        let mut keys = StreamKeys::new();
        keys.saw(1, &Change::Ask { ask: ask.clone() }, 0);
        keys.saw(2, &Change::AskSettled(settled.clone()), 0);
        keys.saw(3, &Change::Ask { ask }, 0);
        keys.saw(4, &Change::AskSettled(settled), 0);
        assert_eq!(keys.graves(), 1, "one tombstone per key");
        // the client at 1 holds q1 open: it is told q1 settled
        let kinds: Vec<(u64, &str)> = keys
            .since(1)
            .entries
            .iter()
            .map(|e| (e.0, e.1.kind()))
            .collect();
        assert_eq!(kinds, [(4, "ask.settled")]);
        // one before the first raise never held it
        assert!(keys.since(0).entries.is_empty());
    }

    #[test]
    fn a_restored_thread_s_turn_ids_join_the_count_so_its_removal_after_a_restart_is_whole() {
        let mut kept = StreamKeys::new();
        kept.saw(1, &thread(), 0);
        kept.saw(2, &message("u", "user", 10.0, false), 0);
        kept.saw(3, &message("m1", "assistant", 11.0, false), 0);
        let (row, turn) = kept.thread_row("a:1").unwrap();
        let (seq, versions) = (row.seq, [row.v, row.rv, row.reset_seq]);
        assert_eq!(kept.turn_ids(), 2);
        // a restart: the row comes back, and the source then says the thread is gone
        let mut keys = StreamKeys::new();
        keys.restore_thread("a:1".into(), seq, versions, turn.as_deref());
        assert_eq!(keys.turn_ids(), 2);
        keys.restore_thread("a:1".into(), seq, versions, turn.as_deref());
        assert_eq!(
            keys.turn_ids(),
            2,
            "restoring the same row twice counts it once"
        );
        keys.saw(4, &Change::ThreadRemoved { key: "a:1".into() }, 0);
        assert_eq!(keys.turn_ids(), 0);
    }

    #[test]
    fn the_newest_turn_ids_stop_at_their_fleet_wide_cap_and_the_thread_past_it_counts_every_entry()
    {
        fn thread_at(key: &str) -> Change {
            let Change::Thread { mut thread } = thread() else {
                unreachable!()
            };
            thread.key = key.into();
            Change::Thread { thread }
        }
        fn message_in(key: &str, id: &str, role: &str, created: f64) -> Change {
            let Change::Message { message, .. } = message(id, role, created, false) else {
                unreachable!()
            };
            Change::Message {
                key: key.into(),
                upstream: None,
                message,
            }
        }
        let mut keys = StreamKeys::new();
        let mut seq = 0;
        let mut next = || {
            seq += 1;
            seq
        };
        // 16 threads with a turn of 1,000 messages each: 16,000 ids
        for n in 0..16 {
            let key = format!("a:{n}");
            keys.saw(next(), &thread_at(&key), 0);
            keys.saw(next(), &message_in(&key, "u", "user", 10.0), 0);
            for m in 1..TURN_IDS {
                keys.saw(
                    next(),
                    &message_in(&key, &format!("m{m}"), "assistant", 11.0),
                    0,
                );
            }
        }
        assert_eq!(keys.turn_ids(), 16 * TURN_IDS);
        // the 17th fills what is left; its turn's entries keep rv
        keys.saw(next(), &thread_at("b:1"), 0);
        let first = keys.thread("b:1").map(|t| t.rv);
        keys.saw(next(), &message_in("b:1", "u", "user", 10.0), 0);
        for m in 1..(ALL_TURN_IDS - 16 * TURN_IDS) {
            keys.saw(
                next(),
                &message_in("b:1", &format!("m{m}"), "assistant", 11.0),
                0,
            );
        }
        assert_eq!(keys.turn_ids(), ALL_TURN_IDS);
        assert_eq!(keys.thread("b:1").map(|t| t.rv), first);
        // one more message would pass the cap: the thread goes full and counts it
        let over = next();
        keys.saw(over, &message_in("b:1", "late", "assistant", 11.0), 0);
        assert_eq!(keys.turn_ids(), ALL_TURN_IDS);
        assert_eq!(keys.thread("b:1").map(|t| t.rv), Some(over));
        // a removed thread frees its ids, and the next turn is tracked again
        keys.saw(next(), &Change::ThreadRemoved { key: "a:0".into() }, 0);
        assert_eq!(keys.turn_ids(), ALL_TURN_IDS - TURN_IDS);
        keys.saw(next(), &message_in("b:1", "u2", "user", 20.0), 0);
        let rv = keys.thread("b:1").map(|t| t.rv);
        keys.saw(next(), &message_in("b:1", "a2", "assistant", 21.0), 0);
        assert_eq!(keys.thread("b:1").map(|t| t.rv), rv);
        assert_eq!(keys.turn_ids(), 15 * TURN_IDS + 2);
    }

    #[test]
    fn the_tombstones_keep_their_cap_and_the_floor_rises() {
        let mut keys = StreamKeys::new();
        for n in 0..(GONE_ROWS as u64 + 5) {
            keys.saw(
                n + 1,
                &Change::ThreadRemoved {
                    key: format!("a:{n}"),
                },
                0,
            );
        }
        assert_eq!(keys.graves(), GONE_ROWS);
        assert_eq!(keys.gone_floor(), 5);
        // a week later the old ones go too
        keys.saw(
            100_000,
            &Change::ThreadRemoved { key: "b:1".into() },
            GONE_MS + 1,
        );
        assert_eq!(keys.graves(), 1);
        assert_eq!(keys.gone_floor(), GONE_ROWS as u64 + 5);
    }
}
