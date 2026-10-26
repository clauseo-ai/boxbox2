//! the protocol 3 proofs over the recorded tape (`docs/protocol.md`, section
//! 16): a small protocol 3 client (the cursor rule, the overview by
//! `wire::patch`, the transcript by the upstream gate, the offset rule and
//! part replace, `textOf` kept or re-read, `catchup` frames that never move
//! the cursor, the no-gap read rule `S >= H`, `left`), driven through the
//! actor's streams and interest posts on a seeded schedule.
//!
//! a "read" of a thread at journal position S is the full replay of that
//! thread's transcript entries up to S through the same transcript rules
//! (`Reference`): what a source answered when the journal stood at S.

use std::collections::{BTreeMap, HashMap};

use bytes::Bytes;

use super::{Client, end, live, tape};
use crate::fleet::replay::Replay;
use crate::fleet::tape::Step;
use crate::fleet::{Confirm, Feed, From, Live};
use crate::journal::{Cursor, Journal};
use crate::wire::patch::TextHash;
use crate::wire::{Change, Control, Interest, InterestPost, JournalEntry, Message, Part, TextPart};

/// a seeded generator, so every run of a seed is the same run.
#[derive(Clone)]
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
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

fn text_of(part: &Part) -> Option<&Option<String>> {
    match part {
        Part::Text(p) => Some(&p.text),
        Part::Reasoning(p) => Some(&p.text),
        _ => None,
    }
}

fn text_mut(part: &mut Part) -> Option<&mut Option<String>> {
    match part {
        Part::Text(p) => Some(&mut p.text),
        Part::Reasoning(p) => Some(&mut p.text),
        _ => None,
    }
}

/// a settled part's length and hash, when it carries them instead of text.
fn settled(part: &Part) -> Option<&crate::wire::TextOf> {
    match part {
        Part::Text(p) if p.text.is_none() => p.text_of.as_ref(),
        Part::Reasoning(p) if p.text.is_none() => p.text_of.as_ref(),
        _ => None,
    }
}

/// the same part with `text` in place of its `textOf`.
fn with_text(part: &Part, text: Option<String>) -> Part {
    let mut part = part.clone();
    match &mut part {
        Part::Text(p) => {
            p.text = text;
            p.text_of = None;
        }
        Part::Reasoning(p) => {
            p.text = text;
            p.text_of = None;
        }
        _ => {}
    }
    part
}

/// one message as a client holds it: its info and its parts by id.
#[derive(Clone, Debug, PartialEq)]
struct Held {
    info: Option<Message>,
    parts: BTreeMap<String, Part>,
}

/// a thread's transcript as a client holds it.
#[derive(Clone, Debug, Default, PartialEq)]
struct Transcript {
    messages: BTreeMap<String, Held>,
    /// the upstream the read it came from reflects.
    hydrated: u64,
    last: u64,
}

/// what applying one transcript entry asks of the client beyond itself.
#[derive(Debug, PartialEq, Eq)]
enum Applied {
    Done,
    /// the message must be read again (a hole).
    Refetch(String),
    /// a settled part's hash missed: read the message again.
    HashMiss(String),
}

impl Transcript {
    fn gate(&mut self, upstream: Option<u64>) -> bool {
        let Some(upstream) = upstream else {
            return true;
        };
        if upstream <= self.hydrated || upstream <= self.last {
            return false;
        }
        self.last = upstream;
        true
    }

    /// one transcript entry by the client's rules.
    fn apply(&mut self, change: &Change) -> Applied {
        match change {
            Change::Message {
                upstream, message, ..
            } => {
                if self.gate(*upstream) {
                    self.messages
                        .entry(message.id.clone())
                        .or_insert_with(|| Held {
                            info: None,
                            parts: BTreeMap::new(),
                        })
                        .info = Some(message.clone());
                }
                Applied::Done
            }
            Change::Part { upstream, part, .. } => {
                if !self.gate(*upstream) {
                    return Applied::Done;
                }
                let Some(held) = self.messages.get_mut(part.message_id()) else {
                    return Applied::Refetch(part.message_id().to_owned());
                };
                if let Some(of) = settled(part) {
                    let kept = held
                        .parts
                        .get(part.id())
                        .and_then(text_of)
                        .and_then(Option::as_ref)
                        .filter(|t| TextHash::of(t).text_of() == *of)
                        .cloned();
                    let Some(text) = kept else {
                        return Applied::HashMiss(part.message_id().to_owned());
                    };
                    held.parts
                        .insert(part.id().to_owned(), with_text(part, Some(text)));
                    return Applied::Done;
                }
                held.parts.insert(part.id().to_owned(), part.clone());
                Applied::Done
            }
            Change::Delta {
                message_id,
                part_id,
                field,
                delta,
                offset,
                ..
            } => {
                let Some(held) = self.messages.get_mut(message_id) else {
                    return Applied::Refetch(message_id.clone());
                };
                let Some(part) = held.parts.get_mut(part_id) else {
                    if *offset == 0 && field == "text" {
                        held.parts.insert(
                            part_id.clone(),
                            Part::Text(TextPart {
                                id: part_id.clone(),
                                message_id: message_id.clone(),
                                at: None,
                                text: Some(delta.clone()),
                                text_of: None,
                                streaming: true,
                                time: None,
                                synthetic: false,
                                notice: false,
                                mail: None,
                            }),
                        );
                        return Applied::Done;
                    }
                    return Applied::Refetch(message_id.clone());
                };
                let Some(slot) = text_mut(part) else {
                    return Applied::Done;
                };
                let had = slot.clone().unwrap_or_default();
                let len = utf16_len(&had);
                let end = offset + utf16_len(delta);
                if *offset == len {
                    *slot = Some(had + delta);
                } else if end <= len {
                    // covered
                } else if *offset < len {
                    *slot = Some(had.clone() + after_units(delta, len - offset));
                } else {
                    return Applied::Refetch(message_id.clone());
                }
                Applied::Done
            }
            Change::MessageRemoved {
                upstream,
                message_id,
                ..
            } => {
                if self.gate(*upstream) {
                    self.messages.remove(message_id);
                }
                Applied::Done
            }
            _ => Applied::Done,
        }
    }

    /// what a page or a deep-equal compares: messages and parts.
    fn shown(&self) -> &BTreeMap<String, Held> {
        &self.messages
    }
}

/// every journal entry decoded once, and per thread its transcript replayed
/// up to a seq: the "read" of a thread at a journal position.
#[derive(Default)]
struct Reference {
    entries: Vec<JournalEntry>,
    /// the head after each step of the run.
    heads: Vec<u64>,
    /// per thread: the replay so far and the seq it reached.
    cache: HashMap<String, (u64, Transcript)>,
}

impl Reference {
    fn grow(&mut self, replay: &Replay) {
        let seen = self.entries.last().map_or(0, |e| e.seq);
        for frame in replay.journal_after(seen) {
            self.entries.push(super::entry(&frame));
        }
    }

    fn head(&self) -> u64 {
        self.entries.last().map_or(0, |e| e.seq)
    }

    /// the source's upstream at journal position `at`: the highest an entry
    /// up to it carries.
    fn upstream_at(&self, at: u64) -> u64 {
        self.entries
            .iter()
            .take_while(|e| e.seq <= at)
            .filter_map(|e| match &e.change {
                Change::Message { upstream, .. }
                | Change::Part { upstream, .. }
                | Change::MessageRemoved { upstream, .. } => *upstream,
                _ => None,
            })
            .max()
            .unwrap_or(0)
    }

    /// `key`'s transcript at journal position `at`: every transcript entry
    /// of it up to there through the transcript rules (a hole is what the
    /// source would not have either; a settled part keeps the text its
    /// deltas built, as a read carries whole text).
    fn read(&mut self, key: &str, at: u64) -> Transcript {
        let (from, mut held) = match self.cache.get(key) {
            Some((reached, held)) if *reached <= at => (*reached, held.clone()),
            _ => (0, Transcript::default()),
        };
        for entry in self.entries.iter().filter(|e| e.seq > from && e.seq <= at) {
            if entry.change.transcript_key() != Some(key) {
                continue;
            }
            let mut plain = strip_upstream(entry.change.clone());
            if let Change::Part { part, .. } = &mut plain
                && settled(part).is_some()
            {
                let built = held
                    .messages
                    .get(part.message_id())
                    .and_then(|m| m.parts.get(part.id()))
                    .and_then(text_of)
                    .cloned()
                    .flatten();
                *part = with_text(part, built);
            }
            let _ = held.apply(&plain);
        }
        self.cache.insert(key.to_owned(), (at, held.clone()));
        held
    }
}

/// the same change with no upstream, so the reference applies every one.
fn strip_upstream(mut change: Change) -> Change {
    match &mut change {
        Change::Message { upstream, .. }
        | Change::Part { upstream, .. }
        | Change::MessageRemoved { upstream, .. } => *upstream = None,
        _ => {}
    }
    change
}

/// where a thread the client holds stands.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Standing {
    /// in interest and trusted: entries apply.
    Current,
    /// in interest with a catch-up on its way (entering with `since`).
    Catching,
    /// in interest, read asked: entries wait in its buffer. `at` is the
    /// head it entered at (`H`); the read answers at a step at or after
    /// `due`.
    Reading { at: u64, due: usize },
    /// out of interest, its copy kept with the seq after which it lacks
    /// entries (none: stale, it is read when shown).
    Cold { left: Option<u64> },
}

/// what the client counted.
#[derive(Debug, Default, Clone)]
struct Counts {
    frames: usize,
    applied: usize,
    catchup: usize,
    refetches: usize,
    hash_misses: usize,
    read_late: usize,
    reads: usize,
    dropped: usize,
    checks: usize,
    /// streams the actor closed at the cap, resumed from the cursor.
    closed: usize,
}

/// a protocol 3 client.
#[derive(Clone)]
struct P3 {
    epoch: String,
    cursor: Option<u64>,
    overview: Client,
    transcripts: HashMap<String, Transcript>,
    standing: HashMap<String, Standing>,
    buffers: HashMap<String, Vec<JournalEntry>>,
    interest: Interest,
    stream: Option<u128>,
    ask: u64,
    head_at_hello: u64,
    /// keys a post took out of interest, whose `left` its confirm sets.
    pending_left: Vec<String>,
    counts: Counts,
    /// drop this share (1 in n) of deltas, to see a missed hash heal.
    drop_one_in: u64,
    rng: Rng,
}

fn keys_of(interest: &Interest) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for key in interest
        .thread
        .iter()
        .chain(&interest.under)
        .chain(&interest.holds)
    {
        if !keys.contains(key) {
            keys.push(key.clone());
        }
    }
    keys
}

/// the frame's id and json.
fn parse(frame: &Bytes) -> Result<(Option<u64>, serde_json::Value), String> {
    let text = std::str::from_utf8(frame).map_err(|e| e.to_string())?;
    let id = text
        .lines()
        .find_map(|l| l.strip_prefix("id: "))
        .and_then(Cursor::parse)
        .map(|c| c.seq);
    let json: String = text
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n");
    let value = serde_json::from_str(&json).map_err(|e| format!("does not parse: {e}"))?;
    Ok((id, value))
}

impl P3 {
    fn new(seed: u64) -> Self {
        Self {
            epoch: String::new(),
            cursor: None,
            overview: Client::default(),
            transcripts: HashMap::new(),
            standing: HashMap::new(),
            buffers: HashMap::new(),
            interest: Interest::default(),
            stream: None,
            ask: 0,
            head_at_hello: 0,
            pending_left: Vec::new(),
            counts: Counts::default(),
            drop_one_in: 0,
            rng: Rng(seed | 1),
        }
    }

    fn in_interest(&self, key: &str) -> bool {
        keys_of(&self.interest).iter().any(|k| k == key)
    }

    /// one frame off the stream. a frame that cannot apply is a protocol
    /// error: nothing of it is applied.
    #[allow(clippy::too_many_lines, reason = "one arm per control frame")]
    fn frame(
        &mut self,
        frame: &Bytes,
        reference: &mut Reference,
        step: usize,
    ) -> Result<(), String> {
        self.counts.frames += 1;
        let (id, value) = parse(frame)?;
        let kind = value["type"].as_str().unwrap_or_default().to_owned();
        let control = matches!(
            kind.as_str(),
            "hello" | "reset" | "caught" | "catchup" | "interest" | "thread.stale"
        );
        if !control {
            if matches!(kind.as_str(), "colours" | "colour" | "away" | "autoCleared") {
                return Ok(());
            }
            let entry: JournalEntry =
                serde_json::from_value(value).map_err(|e| format!("{kind}: {e}"))?;
            if self.cursor.is_some_and(|c| entry.seq <= c) {
                return Ok(());
            }
            return self.entry(entry, reference, step);
        }
        let control: Control =
            serde_json::from_value(value).map_err(|e| format!("{kind} does not parse: {e}"))?;
        match control {
            Control::Hello {
                protocol,
                epoch,
                head,
                stream,
                ..
            } => {
                if protocol != 3 {
                    return Err(format!("protocol {protocol}"));
                }
                self.epoch = epoch;
                self.head_at_hello = head;
                self.stream = u128::from_str_radix(&stream, 16).ok();
                // a key it shows without a `since` is read under the no-gap rule with H = head
                for key in keys_of(&self.interest) {
                    if self.standing.get(&key) != Some(&Standing::Catching) {
                        self.read(&key, head, step);
                    }
                }
            }
            Control::Reset { seq, fleet, .. } => {
                let mut overview = Client::default();
                for agent in fleet.agents {
                    overview.agents.insert(agent.key.clone(), agent);
                }
                for thread in fleet.threads {
                    overview.threads.insert(thread.key.clone(), thread);
                }
                for ask in fleet.asks {
                    overview
                        .asks
                        .insert((ask.agent.clone(), ask.id.clone()), ask);
                }
                overview.order = fleet.order;
                self.overview = overview;
                self.cursor = Some(seq);
                // every held thread goes cold and stale; the stage, its layers and holds are read
                for standing in self.standing.values_mut() {
                    *standing = Standing::Cold { left: None };
                }
                for key in keys_of(&self.interest) {
                    self.read(&key, seq, step);
                }
            }
            Control::Caught { seq } => {
                self.cursor = Some(seq);
                for key in keys_of(&self.interest) {
                    if self.standing.get(&key) == Some(&Standing::Catching) {
                        self.standing.insert(key, Standing::Current);
                    }
                }
            }
            Control::Catchup { entries } => {
                // checked whole first: every entry's thread is one catching up
                if let Some(bad) = entries.iter().find(|e| {
                    e.change
                        .transcript_key()
                        .is_none_or(|k| self.standing.get(k) != Some(&Standing::Catching))
                }) {
                    return Err(format!(
                        "a catchup entry for a thread not catching up: seq {}",
                        bad.seq
                    ));
                }
                for entry in entries {
                    self.counts.catchup += 1;
                    let key = entry.change.transcript_key().unwrap_or_default().to_owned();
                    self.transcript(&key, &entry.change, reference);
                }
            }
            Control::ThreadStale { key } => {
                let at = self.head_at_hello;
                self.read(&key, at, step);
            }
            Control::Interest {
                ask,
                seq,
                stale,
                reset,
                thread,
                under,
                holds,
            } => {
                self.cursor = Some(seq);
                if ask != self.ask {
                    // the confirm of an older ask: only the newest one is acted on
                    return Ok(());
                }
                let confirmed = Interest {
                    thread,
                    under,
                    holds,
                };
                for key in std::mem::take(&mut self.pending_left) {
                    self.standing
                        .insert(key, Standing::Cold { left: Some(seq) });
                }
                for key in &reset {
                    if let Some(t) = self.transcripts.get_mut(key) {
                        t.messages.clear();
                    }
                }
                for key in keys_of(&confirmed) {
                    let again = stale.contains(&key) || reset.contains(&key);
                    match self.standing.get(&key) {
                        Some(Standing::Catching) if !again => {
                            self.standing.insert(key, Standing::Current);
                        }
                        Some(Standing::Current | Standing::Reading { .. }) if !again => {}
                        _ => self.read(&key, seq, step),
                    }
                }
            }
        }
        if let Some(id) = id {
            self.cursor = Some(id);
        }
        Ok(())
    }

    fn entry(
        &mut self,
        entry: JournalEntry,
        reference: &mut Reference,
        step: usize,
    ) -> Result<(), String> {
        let seq = entry.seq;
        match entry.change.transcript_key().map(str::to_owned) {
            None => {
                // the whole frame checks before anything changes (patch applies return a new value)
                let mut next = self.overview.clone();
                let reset = match &entry.change {
                    Change::ThreadReset { key } => Some(key.clone()),
                    _ => None,
                };
                next.apply(entry.change)?;
                self.overview = next;
                if let Some(key) = reset {
                    if let Some(t) = self.transcripts.get_mut(&key) {
                        t.messages.clear();
                    }
                    if self.in_interest(&key) {
                        self.read(&key, seq, step);
                    } else if self.standing.contains_key(&key) {
                        self.standing.insert(key, Standing::Cold { left: None });
                    }
                }
            }
            Some(key) => match self.standing.get(&key).cloned() {
                Some(Standing::Current) => {
                    self.transcript(&key, &entry.change, reference);
                }
                Some(Standing::Reading { .. }) => {
                    self.buffers.entry(key).or_default().push(entry);
                }
                other => {
                    return Err(format!(
                        "seq {seq}: an entry for {key}, which is {other:?} here"
                    ));
                }
            },
        }
        self.cursor = Some(seq);
        self.counts.applied += 1;
        Ok(())
    }

    /// one transcript entry, healing a hole or a missed hash by a re-read of
    /// that message from the source now.
    fn transcript(&mut self, key: &str, change: &Change, reference: &mut Reference) {
        if self.drop_one_in > 0
            && matches!(change, Change::Delta { .. })
            && self.rng.below(self.drop_one_in) == 0
        {
            self.counts.dropped += 1;
            return;
        }
        let held = self.transcripts.entry(key.to_owned()).or_default();
        let message = match held.apply(change) {
            Applied::Done => return,
            Applied::Refetch(message) => message,
            Applied::HashMiss(message) => {
                self.counts.hash_misses += 1;
                message
            }
        };
        self.counts.refetches += 1;
        let now = reference.read(key, reference.head());
        let held = self.transcripts.entry(key.to_owned()).or_default();
        match now.messages.get(&message) {
            Some(m) => {
                held.messages.insert(message, m.clone());
            }
            None => {
                held.messages.remove(&message);
            }
        }
    }

    /// a read of `key` asked when it entered interest at `at`; it answers
    /// a step or a few later.
    fn read(&mut self, key: &str, at: u64, step: usize) {
        let due = step + usize::try_from(self.rng.below(3)).unwrap_or(0);
        self.standing
            .insert(key.to_owned(), Standing::Reading { at, due });
        self.buffers.insert(key.to_owned(), Vec::new());
    }

    /// reads that are due answer, at the journal's head now: accepted when
    /// `S >= H`, taken again when not (a read that started early).
    fn answer_reads(&mut self, reference: &mut Reference, step: usize) {
        let mut due: Vec<(String, u64)> = self
            .standing
            .iter()
            .filter_map(|(k, s)| match s {
                Standing::Reading { at, due } if *due <= step => Some((k.clone(), *at)),
                _ => None,
            })
            .collect();
        due.sort();
        for (key, at) in due {
            // now and then a read the network took before the post landed
            let s = if self.rng.below(4) == 0 && at > 0 {
                at - 1
            } else {
                reference.head()
            };
            if s < at {
                self.counts.read_late += 1;
                self.standing
                    .insert(key, Standing::Reading { at, due: step + 1 });
                continue;
            }
            self.counts.reads += 1;
            let mut read = reference.read(&key, s);
            read.hydrated = reference.upstream_at(s);
            read.last = read.hydrated;
            self.transcripts.insert(key.clone(), read);
            self.standing.insert(key.clone(), Standing::Current);
            for entry in self.buffers.remove(&key).unwrap_or_default() {
                self.transcript(&key, &entry.change, reference);
            }
        }
    }

    /// the interest post for `interest`, with `since` from what it holds
    /// (`with_since` false: as a client that lost its `left`).
    fn post(&mut self, interest: Interest, with_since: bool) -> InterestPost {
        self.ask += 1;
        let next = keys_of(&interest);
        let mut since = BTreeMap::new();
        let entering: Vec<String> = next
            .iter()
            .filter(|k| !self.in_interest(k))
            .cloned()
            .collect();
        for key in &entering {
            match self.standing.get(key) {
                Some(Standing::Cold { left: Some(left) }) if with_since => {
                    since.insert(key.clone(), *left);
                    self.standing.insert(key.clone(), Standing::Catching);
                }
                _ => {
                    // read once the confirm says where it entered
                    self.standing.remove(key);
                }
            }
        }
        // the keys that leave stay current until the confirm sets their `left`
        self.pending_left = keys_of(&self.interest)
            .into_iter()
            .filter(|k| !next.contains(k))
            .collect();
        self.interest = interest.clone();
        InterestPost {
            ask: self.ask,
            thread: interest.thread,
            under: interest.under,
            holds: interest.holds,
            since,
        }
    }

    /// opens a stream from where the client stands: its cursor (none at
    /// first), its interest, `since` for each interest key it holds with a
    /// `left`.
    fn connect(
        &mut self,
        replay: &mut Replay,
        reference: &mut Reference,
        at: i64,
        step: usize,
    ) -> Live {
        let mut since = BTreeMap::new();
        for key in keys_of(&self.interest) {
            match self.standing.get(&key) {
                Some(Standing::Cold { left: Some(left) }) => {
                    since.insert(key.clone(), *left);
                    self.standing.insert(key, Standing::Catching);
                }
                _ => {
                    self.standing.remove(&key);
                }
            }
        }
        let from = match self.cursor {
            None => From::Start,
            Some(seq) => From::At(Cursor {
                epoch: self.epoch.clone(),
                seq,
            }),
        };
        let opened = replay.open_with(from, self.interest.clone(), since, at);
        for frame in &opened.frames {
            self.frame(frame, reference, step)
                .unwrap_or_else(|e| panic!("step {step}, opening: {e}"));
        }
        opened.live
    }

    /// the stream drops: every key in interest keeps the cursor as its
    /// `left` (a key still being read or caught up has none: it is read).
    fn disconnect(&mut self) {
        let cursor = self.cursor;
        for key in keys_of(&self.interest) {
            let left = match self.standing.get(&key) {
                Some(Standing::Current) => cursor,
                _ => None,
            };
            self.standing.insert(key, Standing::Cold { left });
        }
        self.pending_left.clear();
        self.stream = None;
    }

    /// what the stream has for it now, a confirm block and all.
    fn drain(&mut self, live: &mut Live, reference: &mut Reference, step: usize) {
        while let Ok(feed) = live.frames.try_recv() {
            match feed {
                Feed::Frame(frame) => {
                    live.queued
                        .fetch_sub(frame.len(), std::sync::atomic::Ordering::AcqRel);
                    self.frame(&frame, reference, step)
                        .unwrap_or_else(|e| panic!("step {step}: {e}"));
                }
                Feed::Block { frames, drained } => {
                    for frame in &frames {
                        self.frame(frame, reference, step)
                            .unwrap_or_else(|e| panic!("step {step}, confirm: {e}"));
                    }
                    drained.cancel();
                }
            }
        }
    }

    /// every thread it trusts deep-equals a read at its cursor.
    fn check(&mut self, reference: &mut Reference, step: usize) {
        let Some(cursor) = self.cursor else { return };
        let mut trusted: Vec<String> = self
            .standing
            .iter()
            .filter(|(_, s)| **s == Standing::Current)
            .map(|(k, _)| k.clone())
            .collect();
        trusted.sort();
        for key in trusted {
            let read = reference.read(&key, cursor);
            let held = self.transcripts.get(&key).cloned().unwrap_or_default();
            assert!(
                held.shown() == read.shown(),
                "step {step}: {key} differs from a read at {cursor}: {}",
                apart(held.shown(), read.shown())
            );
            self.counts.checks += 1;
        }
    }
}

/// where two transcripts part, for a failure's message.
fn apart(a: &BTreeMap<String, Held>, b: &BTreeMap<String, Held>) -> String {
    for (id, m) in a {
        match b.get(id) {
            None => return format!("{id} only in the client"),
            Some(n) if n != m => return format!("{id}: client {m:?}\nread {n:?}"),
            _ => {}
        }
    }
    b.keys()
        .find(|id| !a.contains_key(*id))
        .map_or_else(String::new, |id| format!("{id} only in the read"))
}

/// the threads with the most transcript entries in the whole tape, busiest first.
fn busiest_threads(n: usize) -> Vec<String> {
    let recorded = live();
    let mut replay = Replay::new(&recorded.epoch, &recorded.build);
    let steps = tape();
    let at = end(&steps);
    for step in steps {
        replay.step(step).unwrap();
    }
    replay.flush_deltas(at + 1000);
    let mut counts: HashMap<String, usize> = HashMap::new();
    for frame in replay.journal() {
        if let Some(key) = super::entry(&frame).change.transcript_key() {
            *counts.entry(key.to_owned()).or_default() += 1;
        }
    }
    let mut counts: Vec<(String, usize)> = counts.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    counts.into_iter().take(n).map(|c| c.0).collect()
}

fn stage(thread: Option<&str>) -> Interest {
    Interest {
        thread: thread.map(Into::into),
        under: Vec::new(),
        holds: Vec::new(),
    }
}

/// what one scripted moment does.
#[derive(Clone, Debug)]
enum Act {
    /// post this interest, with `since` or as a client that lost it.
    Show(Interest, bool),
    /// hidden: the overview only; the next show brings back `since`.
    Hide,
    /// the stream drops and comes back from the cursor at once.
    Drop,
    /// the stream drops and stays away until `Back`.
    Away,
    Back,
}

/// one run of the tape with a client driven by `acts` at their steps.
#[allow(clippy::too_many_lines, reason = "one arm per scripted act")]
fn run(
    seed: u64,
    acts: &[(usize, Act)],
    journal: Option<Journal>,
    drop_one_in: u64,
) -> (P3, Replay, Reference) {
    let recorded = live();
    let steps = tape();
    let finish = end(&steps);
    // a small ring loses entries the reads are made of: those come from the
    // same tape through a whole ring, which journals the same bytes
    let mut whole = journal.is_some().then(|| {
        (
            Replay::new(&recorded.epoch, &recorded.build),
            tape().into_iter(),
        )
    });
    let mut replay = match journal {
        Some(journal) => Replay::with_journal(journal, &recorded.build),
        None => Replay::new(&recorded.epoch, &recorded.build),
    };
    let mut reference = Reference::default();
    let mut client = P3::new(seed);
    client.drop_one_in = drop_one_in;
    let mut live: Option<Live> = None;
    let mut away = false;
    let mut acts = acts.iter().peekable();
    let count = steps.len();
    for (n, step) in steps.into_iter().enumerate() {
        let at = step.at;
        replay.step(step).unwrap();
        match &mut whole {
            Some((whole, steps)) => {
                whole.step(steps.next().unwrap()).unwrap();
                reference.grow(whole);
            }
            None => reference.grow(&replay),
        }
        reference.heads.push(reference.head());
        if live.is_none() && !away {
            live = Some(client.connect(&mut replay, &mut reference, at, n));
        }
        while let Some((when, act)) = acts.peek() {
            if *when > n {
                break;
            }
            let act = act.clone();
            acts.next();
            // what was queued before the act reaches the client first
            if let Some(feed) = live.as_mut() {
                client.drain(feed, &mut reference, n);
            }
            match act {
                Act::Show(..) | Act::Hide => {
                    let (interest, with_since) = match act {
                        Act::Show(interest, with_since) => (interest, with_since),
                        _ => (Interest::default(), true),
                    };
                    if let Some(stream) = client.stream {
                        let post = client.post(interest, with_since);
                        match replay.post(stream, &post) {
                            Confirm::Applied => {}
                            // closed at the cap a moment ago: it reconnects with the interest in its query
                            Confirm::NoSuchStream => {
                                client.counts.closed += 1;
                                drop(live.take());
                                client.disconnect();
                                live = Some(client.connect(&mut replay, &mut reference, at, n));
                            }
                            other => panic!("step {n}: {other:?}"),
                        }
                    }
                }
                Act::Drop => {
                    drop(live.take());
                    client.disconnect();
                    live = Some(client.connect(&mut replay, &mut reference, at, n));
                }
                Act::Away => {
                    drop(live.take());
                    client.disconnect();
                    away = true;
                }
                Act::Back => {
                    away = false;
                    live = Some(client.connect(&mut replay, &mut reference, at, n));
                }
            }
        }
        if let Some(feed) = live.as_mut() {
            client.drain(feed, &mut reference, n);
            // a step that queued past the 512 KiB cap closed the stream: it resumes from its cursor
            if feed.closed.is_cancelled() {
                client.counts.closed += 1;
                client.disconnect();
                live = Some(client.connect(&mut replay, &mut reference, at, n));
            }
        }
        // away, the client hears nothing and reads nothing
        if !away {
            client.answer_reads(&mut reference, n);
            // a client that lost a delta is wrong until the loss shows; it is held to the end
            if drop_one_in == 0 {
                client.check(&mut reference, n);
            }
        }
    }
    // the clock runs on: held text and tails go out, the last reads land
    let last = || Step {
        at: finish + 1000,
        input: crate::fleet::tape::Input::FlushTails,
    };
    replay.flush_deltas(finish + 1000);
    replay.step(last()).unwrap();
    match &mut whole {
        Some((whole, _)) => {
            whole.flush_deltas(finish + 1000);
            whole.step(last()).unwrap();
            reference.grow(whole);
        }
        None => reference.grow(&replay),
    }
    if let Some(feed) = live.as_mut() {
        client.drain(feed, &mut reference, count);
    }
    for extra in 0..20 {
        client.answer_reads(&mut reference, count + extra);
    }
    client.check(&mut reference, count);
    (client, replay, reference)
}

/// the overview a client that applied every journal entry in order holds.
fn full_overview(reference: &Reference) -> Client {
    let mut client = Client::default();
    for entry in &reference.entries {
        client.apply(entry.change.clone()).unwrap();
    }
    client
}

fn same_overview(a: &Client, b: &Client) -> bool {
    a.agents == b.agents && a.threads == b.threads && a.asks == b.asks && a.order == b.order
}

/// seeded switches home, A, B, home, A, with and without `since`, hidden
/// spells (the overview only, then back with `since`) and dropped streams:
/// whenever a thread is on stage and its read or catch-up has landed, its
/// messages deep-equal a read at the client's cursor; nothing doubles or
/// goes missing, and the overview ends as a client that applied every
/// entry holds it.
#[test]
fn protocol3_view_switches_keep_every_thread_on_stage_equal_to_a_read_at_the_cursor() {
    let threads = busiest_threads(2);
    let (a, b) = (threads[0].clone(), threads[1].clone());
    let count = tape().len() as u64;
    let mut totals = Counts::default();
    let seeds = [1u64, 2, 3, 4, 5, 6];
    for seed in seeds {
        let mut rng = Rng(seed * 7919);
        let mut at: Vec<usize> = (0..40)
            .map(|_| usize::try_from(rng.below(count)).unwrap())
            .collect();
        at.sort_unstable();
        let cycle = [
            None,
            Some(a.as_str()),
            Some(b.as_str()),
            None,
            Some(a.as_str()),
        ];
        let mut acts = Vec::new();
        let mut shows = 0;
        for when in at {
            let act = match rng.below(7) {
                0 => Act::Hide,
                1 => Act::Drop,
                _ => {
                    let thread = cycle[shows % cycle.len()];
                    shows += 1;
                    // a layer under the stage now and then: A stays current under B
                    let mut interest = stage(thread);
                    if thread == Some(b.as_str()) && rng.below(2) == 0 {
                        interest.under.push(a.clone());
                    }
                    Act::Show(interest, seed % 2 == 1 || rng.below(3) > 0)
                }
            };
            acts.push((when, act));
        }
        let (client, _, reference) = run(seed, &acts, None, 0);
        assert!(
            same_overview(&client.overview, &full_overview(&reference)),
            "seed {seed}: the overview ended elsewhere"
        );
        let c = &client.counts;
        totals.checks += c.checks;
        totals.frames += c.frames;
        totals.catchup += c.catchup;
        totals.reads += c.reads;
        totals.read_late += c.read_late;
        totals.refetches += c.refetches;
        totals.hash_misses += c.hash_misses;
        totals.closed += c.closed;
    }
    println!(
        "view switches, {} seeds: {} frames, {} checks of a trusted thread against a read at the cursor, all equal; {} catch-up entries applied, {} reads ({} taken again as late), {} message re-reads, {} hash misses, {} streams closed at the cap and resumed, 0 protocol errors",
        seeds.len(),
        totals.frames,
        totals.checks,
        totals.catchup,
        totals.reads,
        totals.read_late,
        totals.refetches,
        totals.hash_misses,
        totals.closed
    );
    assert!(totals.checks > 1000 && totals.catchup > 0 && totals.read_late > 0);
}

/// from random cursors, a stream that was away catches up and then goes
/// live, and ends where a client that never dropped ends, through the same
/// interest: from the ring, and from a ring too small to hold it (the
/// thread comes back stale and is read).
#[test]
fn protocol3_a_catch_up_from_any_cursor_then_live_ends_as_a_full_replay_through_the_same_interest()
{
    let threads = busiest_threads(1);
    let thread = threads[0].clone();
    let count = tape().len();
    let mut rng = Rng(424_242);
    let mut runs = 0;
    let mut caught = 0;
    for small in [false, true] {
        let journal = || small.then(|| Journal::with_caps(live().epoch, usize::MAX, 300));
        let show = (0, Act::Show(stage(Some(&thread)), true));
        let (steady, steady_replay, steady_reference) =
            run(9, std::slice::from_ref(&show), journal(), 0);
        // the thread's versions: v its newest transcript entry, rv at or below it
        let newest = steady_reference
            .entries
            .iter()
            .filter(|e| e.change.transcript_key() == Some(thread.as_str()))
            .map(|e| e.seq)
            .max();
        let (v, rv) = steady_replay.versions(&thread).unwrap();
        assert_eq!(Some(v), newest);
        assert!(rv <= v);
        // the steps at which the thread's transcript moved: a cursor among them misses some
        let seqs: std::collections::HashSet<u64> = steady_reference
            .entries
            .iter()
            .filter(|e| e.change.transcript_key() == Some(thread.as_str()))
            .map(|e| e.seq)
            .collect();
        let moving: Vec<usize> = (1..count)
            .filter(|&n| {
                (steady_reference.heads[n - 1] + 1..=steady_reference.heads[n])
                    .any(|seq| seqs.contains(&seq))
            })
            .collect();
        for _ in 0..4 {
            let away = moving[usize::try_from(rng.below(moving.len() as u64)).unwrap()]
                .saturating_sub(1)
                .max(1);
            let back = (away + 2 + usize::try_from(rng.below(40)).unwrap()).min(count - 1);
            let (dropped, dropped_replay, dropped_reference) = run(
                9,
                &[show.clone(), (away, Act::Away), (back, Act::Back)],
                journal(),
                0,
            );
            assert_eq!(steady_replay.head(), dropped_replay.head());
            assert!(
                same_overview(&steady.overview, &dropped.overview),
                "overview after a drop at {away}"
            );
            assert!(
                steady.transcripts.get(&thread).map(Transcript::shown)
                    == dropped.transcripts.get(&thread).map(Transcript::shown),
                "{thread} after a drop at step {away}, back at {back}"
            );
            assert!(same_overview(
                &dropped.overview,
                &full_overview(&dropped_reference)
            ));
            caught += dropped.counts.catchup;
            runs += 1;
        }
    }
    println!(
        "{runs} catch-ups from random cursors (half through a 300-entry ring) end equal to a stream that never dropped; {caught} catch-up entries applied"
    );
}

/// a client that loses a delta now and then: the hole or the missed hash
/// sends it to read that message again, and its text ends as the source's.
#[test]
fn protocol3_a_lost_delta_is_healed_by_a_re_read_and_the_text_ends_as_the_source_s() {
    let threads = busiest_threads(1);
    let thread = threads[0].clone();
    let (client, _, mut reference) =
        run(77, &[(0, Act::Show(stage(Some(&thread)), true))], None, 6);
    let c = &client.counts;
    let held = client.transcripts.get(&thread).cloned().unwrap_or_default();
    let source = reference.read(&thread, reference.head());
    assert!(
        held.shown() == source.shown(),
        "{}",
        apart(held.shown(), source.shown())
    );
    println!(
        "{} deltas lost: {} hash misses and {} re-reads in all; the final text equals the source's",
        c.dropped, c.hash_misses, c.refetches
    );
    assert!(c.dropped > 0 && c.hash_misses > 0);
}

/// what the recorded session costs each view on the wire, per minute of
/// tape: a home stream, a stream with the busiest thread open, and a hidden
/// one (the overview only), each from the first step, raw and through one
/// gzip context sync-flushed per batch (`compress::Framed`), a batch being
/// what one step handed the stream. today's: the contract 1 journal the
/// live server sent every device, `goldens/contract1/live.json.gz`, which
/// carries no step clock, so its gzip is flushed per frame (the method of
/// `docs/protocol.md` section 17). a measurement: it prints, and holds only
/// that interest cuts what a stream with nothing open gets.
#[test]
fn protocol3_bytes_per_minute_of_tape_by_view() {
    let recorded = live();
    let steps = tape();
    let (start, finish) = (steps.first().unwrap().at, steps.last().unwrap().at);
    #[allow(clippy::cast_precision_loss)]
    let minutes = (finish - start) as f64 / 60_000.0;
    let thread = busiest_threads(1).remove(0);
    let mut replay = Replay::new(&recorded.epoch, &recorded.build);
    let views = [
        ("home", stage(None)),
        ("thread", stage(Some(&thread))),
        ("hidden", stage(None)),
    ];
    let mut streams: Vec<(&str, Live, crate::http::compress::Framed, usize, usize)> = Vec::new();
    for (n, step) in steps.into_iter().enumerate() {
        let at = step.at;
        replay.step(step).unwrap();
        if n == 0 {
            for (name, interest) in &views {
                let opened = replay.open_with(From::Start, interest.clone(), BTreeMap::new(), at);
                streams.push((
                    name,
                    opened.live,
                    crate::http::compress::Framed::new(),
                    0,
                    0,
                ));
            }
            continue;
        }
        for (_, live, gzip, raw, zipped) in &mut streams {
            let mut batch = Vec::new();
            while let Ok(feed) = live.frames.try_recv() {
                if let Feed::Frame(frame) = feed {
                    live.queued
                        .fetch_sub(frame.len(), std::sync::atomic::Ordering::AcqRel);
                    batch.extend_from_slice(&frame);
                }
            }
            if !batch.is_empty() {
                *raw += batch.len();
                *zipped += gzip.batch(&batch).unwrap().len();
            }
        }
    }
    let today = recorded_journal();
    let mut gzip = crate::http::compress::Framed::new();
    let (mut today_raw, mut today_zipped) = (0usize, 0usize);
    for frame in today.split_inclusive(
        "

",
    ) {
        today_raw += frame.len();
        today_zipped += gzip.batch(frame.as_bytes()).unwrap().len();
    }
    #[allow(clippy::cast_precision_loss)]
    let per = |bytes: usize| bytes as f64 / minutes / 1000.0;
    println!("{minutes:.2} min of tape; KB per minute, raw and gzip:");
    println!(
        "  today (contract 1, every device): {:.0} raw, {:.0} gzip flushed per frame",
        per(today_raw),
        per(today_zipped)
    );
    for (name, _, _, raw, zipped) in &streams {
        println!(
            "  protocol 3 {name}: {:.0} raw, {:.0} gzip flushed per batch",
            per(*raw),
            per(*zipped)
        );
    }
    let home = streams[0].3;
    let open = streams[1].3;
    assert!(
        home < open && home * 4 < today_raw,
        "home {home}, open {open}, today {today_raw}"
    );
}

/// the contract 1 journal the live server sent.
fn recorded_journal() -> String {
    #[derive(serde::Deserialize)]
    struct Recorded {
        journal: String,
    }
    let text = super::input("live.json.gz");
    let recorded: Recorded = serde_json::from_str(&text).unwrap();
    recorded.journal
}

/// what keeping a message's first entry beside its last costs a catch-up:
/// the busiest thread caught up from every 25th seq of the tape.
#[test]
fn protocol3_the_catch_up_s_first_message_entries_cost_little() {
    let recorded = live();
    let thread = busiest_threads(1).remove(0);
    let mut replay = Replay::new(&recorded.epoch, &recorded.build);
    let steps = tape();
    let at = end(&steps);
    for step in steps {
        replay.step(step).unwrap();
    }
    replay.flush_deltas(at + 1000);
    let entries: Vec<JournalEntry> = replay
        .journal()
        .iter()
        .map(super::entry)
        .filter(|e| e.change.transcript_key() == Some(thread.as_str()))
        .collect();
    let head = replay.head();
    let (mut total, mut extra, mut catchups) = (0usize, 0usize, 0usize);
    for since in (0..head).step_by(25) {
        let after: Vec<JournalEntry> = entries.iter().filter(|e| e.seq > since).cloned().collect();
        if after.is_empty() {
            continue;
        }
        let compacted = crate::fleet::catchup::compact(after);
        catchups += 1;
        let mut last: HashMap<&str, u64> = HashMap::new();
        for e in &compacted {
            if let Change::Message { message, .. } = &e.change {
                last.insert(&message.id, e.seq);
            }
        }
        for e in &compacted {
            let bytes = serde_json::to_vec(e).unwrap().len();
            total += bytes;
            if let Change::Message { message, .. } = &e.change
                && last.get(message.id.as_str()) != Some(&e.seq)
            {
                extra += bytes;
            }
        }
    }
    #[allow(clippy::cast_precision_loss)]
    let share = extra as f64 * 100.0 / total.max(1) as f64;
    println!(
        "{catchups} catch-ups of {thread}: {total} bytes of entries, {extra} of them first message entries ({share:.1}%)"
    );
    assert!(extra * 5 < total);
}

/// every malformed frame is caught before anything of it applies.
#[test]
fn protocol3_the_client_detects_each_frame_that_cannot_apply() {
    let mut reference = Reference::default();
    let mut client = P3::new(1);
    let frame = |json: &serde_json::Value, id: Option<u64>| {
        crate::journal::sse_frame(
            id.map(|s| format!("ep:{s}")).as_deref(),
            json.to_string().as_bytes(),
        )
    };
    let thread = serde_json::json!({
        "key": "a:1", "agent": "a", "id": "1", "title": "t", "created": 1.0, "updated": 1.0,
        "activity": {"state": "idle"}, "queued": 0, "browseOnly": false, "agents": 0,
        "processes": 0, "tail": [], "needs": [], "read": null,
    });
    for (seq, json) in [
        (
            1,
            serde_json::json!({"seq": 1, "type": "thread", "thread": thread}),
        ),
        (
            2,
            serde_json::json!({"seq": 2, "type": "order", "keys": ["a:1"]}),
        ),
    ] {
        client
            .frame(&frame(&json, Some(seq)), &mut reference, 0)
            .unwrap();
    }
    let item = serde_json::json!({"partID": "p", "messageID": "m", "kind": "text", "role": "assistant", "text": "x"});
    let long: Vec<serde_json::Value> = (0..13).map(|i| serde_json::json!([i, item])).collect();
    let bad = [
        (
            "a patch for a thread it does not hold",
            serde_json::json!({"seq": 3, "type": "thread.patch", "key": "a:2", "set": {"title": "x"}}),
        ),
        (
            "a tail put past the tail's length",
            serde_json::json!({"seq": 3, "type": "thread.patch", "key": "a:1", "tail": {"drop": 0, "put": [[1, item]]}}),
        ),
        (
            "a tail longer than 12",
            serde_json::json!({"seq": 3, "type": "thread.patch", "key": "a:1", "tail": {"drop": 0, "put": long}}),
        ),
        (
            "an order op out of range",
            serde_json::json!({"seq": 3, "type": "order.patch", "ops": [["-", 4, 1]]}),
        ),
        (
            "a catchup frame that does not parse",
            serde_json::json!({"type": "catchup", "entries": [{"seq": "x"}]}),
        ),
        (
            "an interest frame that does not parse",
            serde_json::json!({"type": "interest", "ask": "one"}),
        ),
    ];
    for (what, json) in bad {
        let before = (
            client.cursor,
            client.overview.threads.clone(),
            client.overview.order.clone(),
        );
        let id = json.get("seq").and_then(serde_json::Value::as_u64);
        assert!(
            client.frame(&frame(&json, id), &mut reference, 0).is_err(),
            "{what} was not caught"
        );
        assert!(
            before
                == (
                    client.cursor,
                    client.overview.threads.clone(),
                    client.overview.order.clone()
                ),
            "{what} changed something"
        );
    }
}
