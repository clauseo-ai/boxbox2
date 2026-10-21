//! a page of a thread, cut from its whole read as it streams
//! (`docs/protocol.md`, section 11, pages): whole turns only, newest first
//! across pages and oldest first inside one, at most `K` turns and, past
//! the first, at most 1 MiB of json. it holds only the turns that can still
//! end up in the page, never the whole thread, each message once, and
//! one turn at most `TURN_BYTES`: a page whose turn is past it is refused
//! (the whole read serves that thread).

use std::collections::VecDeque;

use axum::body::Bytes;

use super::read::Out;
use crate::source::MessageWithParts;
use crate::wire::Role;

/// turns a page holds when the query names none.
pub const DEFAULT_TURNS: u32 = 8;
/// the most turns one page holds.
pub const MAX_TURNS: u32 = 64;
/// past the first turn, a page adds no older turn past this much json.
pub const PAGE_BYTES: usize = 1024 * 1024;
/// one turn's json a page holds, at most. a turn past it is dropped as it
/// grows (only counted), and a page that would hold it is refused.
pub const TURN_BYTES: usize = 64 * 1024 * 1024;

/// why a page could not be cut.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// the anchor's message is not in the thread.
    NoAnchor,
    /// the page would hold a turn past `TURN_BYTES`.
    TooLarge,
}

/// where a page sits in the thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Anchor {
    /// the newest turns.
    Newest,
    /// the turns older than the one this message is in.
    Before(String),
    /// the turn holding this message or part, and older ones.
    At(String),
}

/// one turn of the page being cut.
#[derive(Debug)]
struct TurnBuf {
    /// its first message's id: the `before` of the page after.
    first: String,
    /// its messages as the answer writes them.
    messages: Vec<Bytes>,
    bytes: usize,
    /// the index in the thread of its last message.
    last_index: u64,
    /// an assistant message without `completed`.
    unfinished: bool,
    /// past `TURN_BYTES`: its messages are dropped, its bytes still counted.
    over: bool,
}

/// what the pager came to.
#[derive(Debug)]
pub struct Page {
    pub messages: Vec<Bytes>,
    pub older: Option<String>,
    pub total: u64,
    /// the turns the app shows: one per user message, less a newest one with
    /// no part yet (`shownCount`); messages before the first user message
    /// ride in the oldest page and count as none, as the summary has them.
    pub turns: u64,
    /// the page holds the thread's newest turn.
    pub newest: bool,
    /// the page holds a message of the newest turn as `rv` counts it.
    pub in_rv_turn: bool,
    /// the page holds an assistant message without `completed`.
    pub unfinished: bool,
}

/// cuts a page from a thread's messages, oldest first.
#[derive(Debug)]
pub struct Pager {
    anchor: Anchor,
    limit: usize,
    /// `TURN_BYTES`, smaller in the tests.
    turn_cap: usize,
    window: VecDeque<TurnBuf>,
    /// the turns before the window's oldest, for `older`.
    dropped: bool,
    /// the page is decided: later turns only count.
    frozen: bool,
    /// the anchor was seen (in the current turn, for `At`).
    found: bool,
    total: u64,
    turns: u64,
    /// user messages.
    prompts: u64,
    /// 1 when the newest message is a user message with no part yet.
    hidden: u64,
    /// the index of the newest user message that is not queued.
    rv_start: u64,
}

impl Pager {
    #[must_use]
    pub fn new(anchor: Anchor, turns: u32) -> Self {
        Self {
            anchor,
            limit: turns.clamp(1, MAX_TURNS) as usize,
            turn_cap: TURN_BYTES,
            window: VecDeque::new(),
            dropped: false,
            frozen: false,
            found: false,
            total: 0,
            turns: 0,
            prompts: 0,
            hidden: 0,
            rv_start: 0,
        }
    }

    /// takes the next message.
    ///
    /// # Errors
    /// it could not be written as json.
    pub fn push(&mut self, message: &MessageWithParts) -> Result<(), serde_json::Error> {
        let index = self.total;
        self.total += 1;
        let user = message.info.role == Role::User;
        self.prompts += u64::from(user);
        self.hidden = u64::from(user && message.parts.is_empty());
        if user && !message.info.queued {
            self.rv_start = index;
        }
        let starts = user || self.turns == 0;
        if starts {
            self.turns += 1;
        }
        if self.frozen {
            return Ok(());
        }
        match &self.anchor {
            // the turn holding the `at` message ended: the page is decided.
            Anchor::At(_) if starts && self.found => {
                self.frozen = true;
                return Ok(());
            }
            Anchor::Before(id) if *id == message.info.id => {
                self.found = true;
                self.frozen = true;
                if !starts {
                    // a message inside a turn names that turn, which is not older.
                    self.window.pop_back();
                }
                self.trim(false);
                return Ok(());
            }
            Anchor::At(id) => {
                if *id == message.info.id || message.parts.iter().any(|p| p.id() == id) {
                    self.found = true;
                }
            }
            _ => {}
        }
        let bytes = Bytes::from(serde_json::to_vec(&Out::from(message))?);
        if starts {
            self.window.push_back(TurnBuf {
                first: message.info.id.clone(),
                messages: Vec::new(),
                bytes: 0,
                last_index: index,
                unfinished: false,
                over: false,
            });
        }
        if let Some(turn) = self.window.back_mut() {
            turn.bytes += bytes.len();
            if turn.bytes > self.turn_cap {
                turn.over = true;
                turn.messages = Vec::new();
            } else {
                turn.messages.push(bytes);
            }
            turn.last_index = index;
            turn.unfinished |=
                message.info.role == Role::Assistant && message.info.completed.is_none();
        }
        // a `before` page never holds the open turn until a later one starts:
        // it may be the turn the anchor names.
        self.trim(matches!(self.anchor, Anchor::Before(_)));
        Ok(())
    }

    /// drops the oldest turns past the count, and past the byte cap while
    /// more than one turn is held; `open_aside` leaves the newest turn out
    /// of both.
    fn trim(&mut self, open_aside: bool) {
        let aside = usize::from(open_aside && !self.window.is_empty());
        let mut held = self.window.len() - aside;
        let mut bytes: usize = self.window.iter().take(held).map(|t| t.bytes).sum();
        while held > self.limit || (held > 1 && bytes > PAGE_BYTES) {
            let Some(gone) = self.window.pop_front() else {
                break;
            };
            bytes -= gone.bytes;
            held -= 1;
            self.dropped = true;
        }
    }

    /// the page.
    ///
    /// # Errors
    /// the anchor's message is not in the thread, or the page would hold a
    /// turn past `TURN_BYTES`.
    pub fn finish(self) -> Result<Page, Refused> {
        let found = matches!(self.anchor, Anchor::Newest) || self.found;
        if !found {
            return Err(Refused::NoAnchor);
        }
        if self.window.iter().any(|t| t.over) {
            return Err(Refused::TooLarge);
        }
        // the page holds the newest turn when nothing froze it before the end.
        let newest = !self.frozen;
        let in_rv_turn = self
            .window
            .back()
            .is_some_and(|t| t.last_index >= self.rv_start);
        let unfinished = self.window.iter().any(|t| t.unfinished);
        let older = if self.dropped {
            self.window.front().map(|t| t.first.clone())
        } else {
            None
        };
        Ok(Page {
            messages: self.window.into_iter().flat_map(|t| t.messages).collect(),
            older,
            total: self.total,
            turns: self.prompts - self.hidden,
            newest,
            in_rv_turn,
            unfinished,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::agents::read::tests::fixture;

    /// each message's turn index, as the app splits turns.
    fn turn_of(messages: &[MessageWithParts]) -> Vec<usize> {
        let mut turn = 0;
        messages
            .iter()
            .enumerate()
            .map(|(i, m)| {
                if i > 0 && m.info.role == Role::User {
                    turn += 1;
                }
                turn
            })
            .collect()
    }

    fn cut_or_none(messages: &[MessageWithParts], anchor: Anchor, turns: u32) -> Option<Page> {
        let mut pager = Pager::new(anchor, turns);
        for m in messages {
            pager.push(m).unwrap();
        }
        pager.finish().ok()
    }

    fn cut(messages: &[MessageWithParts], anchor: Anchor, turns: u32) -> (Page, Vec<String>) {
        let page = cut_or_none(messages, anchor, turns).unwrap();
        let ids = page
            .messages
            .iter()
            .map(|b| {
                let v: serde_json::Value = serde_json::from_slice(b).unwrap();
                v["info"]["id"].as_str().unwrap().to_owned()
            })
            .collect();
        (page, ids)
    }

    const FIXTURES: [&str; 3] = ["cmx-deploy", "northstar-heavy", "notes-asks"];

    fn thread(name: &str) -> Vec<MessageWithParts> {
        let mut messages = fixture(name);
        if name == "notes-asks" {
            // a turn 0: messages before the first prompt.
            let lead = messages
                .iter()
                .find(|m| m.info.role == Role::Assistant)
                .cloned();
            if let Some(mut lead) = lead {
                lead.info.id = "msg_lead".into();
                lead.parts.clear();
                messages.insert(0, lead);
            }
        }
        messages
    }

    #[test]
    fn walking_back_from_the_newest_page_holds_every_message_once_and_never_splits_a_turn() {
        for name in FIXTURES {
            let messages = thread(name);
            let turns = turn_of(&messages);
            let index: std::collections::HashMap<&str, usize> = messages
                .iter()
                .enumerate()
                .map(|(i, m)| (m.info.id.as_str(), i))
                .collect();
            for k in [1, 2, 3, 8, 64] {
                let mut seen: Vec<String> = Vec::new();
                let mut anchor = Anchor::Newest;
                let mut pages = 0;
                loop {
                    let (page, ids) = cut(&messages, anchor, k);
                    pages += 1;
                    assert_eq!(page.newest, pages == 1, "{name} k {k}");
                    assert_eq!(page.total, messages.len() as u64);
                    let prompts = messages
                        .iter()
                        .filter(|m| m.info.role == Role::User)
                        .count();
                    assert_eq!(page.turns, prompts as u64, "{name}: the app's turns");
                    assert!(!ids.is_empty(), "{name} k {k}: an empty page");
                    let first = index[ids[0].as_str()];
                    let last = index[ids[ids.len() - 1].as_str()];
                    // whole turns: the page starts a turn and ends where the next starts.
                    assert!(
                        first == 0 || turns[first - 1] != turns[first],
                        "{name} k {k}"
                    );
                    assert!(
                        last + 1 == messages.len() || turns[last + 1] != turns[last],
                        "{name} k {k}"
                    );
                    assert!(
                        turns[last] - turns[first] < k as usize,
                        "{name} k {k}: too many turns"
                    );
                    let bytes: usize = page.messages.iter().map(Bytes::len).sum();
                    assert!(
                        turns[last] == turns[first] || bytes <= PAGE_BYTES,
                        "{name} k {k}: past the cap"
                    );
                    for (i, id) in ids.iter().enumerate() {
                        assert_eq!(
                            index[id.as_str()],
                            first + i,
                            "{name} k {k}: a gap inside a page"
                        );
                    }
                    let mut next = ids.clone();
                    next.extend(seen);
                    seen = next;
                    match page.older {
                        Some(older) => {
                            assert_eq!(older, ids[0]);
                            anchor = Anchor::Before(older);
                        }
                        None => break,
                    }
                }
                let all: Vec<String> = messages.iter().map(|m| m.info.id.clone()).collect();
                assert_eq!(seen, all, "{name} k {k}: every message once, in order");
            }
        }
    }

    #[test]
    fn a_page_at_a_message_or_part_ends_with_the_turn_holding_it() {
        for name in FIXTURES {
            let messages = thread(name);
            let turns = turn_of(&messages);
            let last_turn = turns.last().copied().unwrap_or(0);
            for (i, m) in messages.iter().enumerate() {
                let mut ids = vec![m.info.id.clone()];
                ids.extend(m.parts.iter().take(2).map(|p| p.id().to_owned()));
                for id in ids {
                    let (page, got) = cut(&messages, Anchor::At(id.clone()), 3);
                    assert!(got.contains(&m.info.id), "{name} {id}");
                    let end = turns.iter().rposition(|&t| t == turns[i]).unwrap();
                    assert_eq!(got.last(), Some(&messages[end].info.id), "{name} {id}");
                    assert_eq!(page.newest, turns[i] == last_turn, "{name} {id}");
                }
            }
        }
    }

    #[test]
    fn before_a_message_inside_a_turn_leaves_that_turn_out() {
        let messages = thread("cmx-deploy");
        let turns = turn_of(&messages);
        let inside = (1..messages.len())
            .rev()
            .find(|&i| turns[i] == turns[i - 1] && turns[i] > 0)
            .unwrap();
        let start = (0..=inside)
            .rev()
            .find(|&i| i == 0 || turns[i - 1] != turns[i])
            .unwrap();
        let (_, a) = cut(
            &messages,
            Anchor::Before(messages[inside].info.id.clone()),
            8,
        );
        let (_, b) = cut(
            &messages,
            Anchor::Before(messages[start].info.id.clone()),
            8,
        );
        assert_eq!(a, b);
        assert!(
            a.iter()
                .all(|id| messages.iter().position(|m| &m.info.id == id).unwrap() < start)
        );
    }

    #[test]
    fn an_unknown_anchor_is_not_found() {
        let messages = thread("cmx-deploy");
        assert!(cut_or_none(&messages, Anchor::Before("msg_none".into()), 8).is_none());
        assert!(cut_or_none(&messages, Anchor::At("msg_none".into()), 8).is_none());
        assert!(cut_or_none(&[], Anchor::Newest, 8).is_some());
    }

    #[test]
    fn the_flags_say_what_the_cache_headers_need() {
        let mut messages = thread("cmx-deploy");
        let turns = turn_of(&messages);
        let last_start = messages
            .iter()
            .rposition(|m| m.info.role == Role::User)
            .unwrap();
        // older pages of a settled thread: not newest, no rv turn, nothing unfinished.
        let (page, _) = cut(
            &messages,
            Anchor::Before(messages[last_start].info.id.clone()),
            1,
        );
        assert!(!page.newest && !page.in_rv_turn && !page.unfinished);
        // a queued prompt behind the answer joins the newest turn as rv counts it:
        // the page before it holds the rv turn.
        messages[last_start].info.queued = true;
        let prev_start = messages[..last_start]
            .iter()
            .rposition(|m| m.info.role == Role::User)
            .unwrap();
        let (page, _) = cut(
            &messages,
            Anchor::Before(messages[last_start].info.id.clone()),
            1,
        );
        assert!(page.in_rv_turn, "{prev_start}");
        messages[last_start].info.queued = false;
        // an answer without completed in an older turn.
        let older = (0..last_start)
            .find(|&i| {
                messages[i].info.role == Role::Assistant && turns[i] == turns[last_start - 1]
            })
            .unwrap();
        messages[older].info.completed = None;
        let (page, _) = cut(
            &messages,
            Anchor::Before(messages[last_start].info.id.clone()),
            1,
        );
        assert!(page.unfinished);
    }

    #[test]
    fn a_turn_past_the_cap_is_held_by_no_page() {
        let messages = thread("northstar-heavy");
        let turns = turn_of(&messages);
        let last = turns.last().copied().unwrap();
        let size = |t: usize| -> usize {
            (0..messages.len())
                .filter(|&i| turns[i] == t)
                .map(|i| serde_json::to_vec(&Out::from(&messages[i])).unwrap().len())
                .sum()
        };
        let (big, biggest) = (0..=last)
            .map(|t| (t, size(t)))
            .max_by_key(|&(_, s)| s)
            .unwrap();
        assert!((0..=last).filter(|&t| size(t) == biggest).count() == 1);
        let start = turns.iter().position(|&t| t == big).unwrap();
        let cut_with = |cap: usize, anchor: Anchor| {
            let mut pager = Pager::new(anchor, 64);
            pager.turn_cap = cap;
            for m in &messages {
                pager.push(m).unwrap();
            }
            pager.finish().map(|p| p.messages.len())
        };
        // a page holding the big turn is refused once the cap is below it.
        let at = Anchor::At(messages[start].info.id.clone());
        assert_eq!(
            cut_with(biggest - 1, at.clone()).unwrap_err(),
            Refused::TooLarge
        );
        assert!(cut_with(biggest, at).is_ok());
        // a page before it never holds it, and is cut as before.
        if start > 0 {
            let before = Anchor::Before(messages[start].info.id.clone());
            assert_eq!(
                cut_with(biggest - 1, before.clone()),
                cut_with(biggest, before)
            );
        }
    }

    #[test]
    fn page_turns_count_as_the_summary_does() {
        for name in FIXTURES {
            let messages = thread(name);
            let mut fold = crate::fleet::summary::Fold::new("");
            for m in &messages {
                fold.push(m);
            }
            let summary = fold.finish().turns.len() as u64;
            assert_eq!(cut(&messages, Anchor::Newest, 8).0.turns, summary, "{name}");
        }
        let mut messages = thread("notes-asks");
        let prompts = messages
            .iter()
            .filter(|m| m.info.role == Role::User)
            .count() as u64;
        // a turn 0 (thread() adds one) counts as none.
        assert_eq!(cut(&messages, Anchor::Newest, 8).0.turns, prompts);
        // a newest prompt with no part yet is not shown, so not counted.
        let mut bare = messages
            .iter()
            .find(|m| m.info.role == Role::User)
            .cloned()
            .unwrap();
        bare.info.id = "msg_bare".into();
        bare.parts.clear();
        messages.push(bare);
        assert_eq!(cut(&messages, Anchor::Newest, 8).0.turns, prompts);
    }
}
