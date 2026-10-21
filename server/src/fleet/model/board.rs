//! what the board's view takes from the model (`docs/board.md`, the view):
//! the home windows in the app's order, through the app's own membership
//! rule (`app/src/ui/home/membership.ts`, `windowKeys`), each reduced to
//! what a key lights. the projection (`fleet/board.rs`) keeps the ones that
//! need you, work or are bound, and owns the clock.

use std::collections::{HashMap, HashSet};

use boxbox_board_wire::{Ask as BoardAsk, AskKind as BoardAskKind, Need as BoardNeed, Thread};

use super::{Activity, Model, ReadRefused, WINDOW_RECENT_MS};
use crate::fleet::needs::{Need, NeedKind};
use crate::wire;

/// a single question's options the digit keys can answer, at most: one per
/// digit. a question with more is answered by voice or on the glass.
pub const MAX_OPTIONS: usize = 9;

/// one home window as the board sees it, with the stamp its need's age is
/// measured from.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// `waiting_ms` is left empty; the projection fills it from `raised`
    /// when it encodes, so time passing alone never changes a picture.
    pub thread: Thread,
    /// when the thread's leading need was raised, ms on the server's clock.
    pub raised: Option<i64>,
    /// a home window by the app's rule (else it rides only because it is bound).
    pub window: bool,
}

impl Model {
    /// every thread the board could show, in the window order: the home
    /// windows by the app's membership rule, and any `bound` thread the fleet
    /// holds that is not one. a quiet window is returned too, marked, so the
    /// caller decides what rides.
    #[must_use]
    pub fn board_rows(&self, bound: &HashSet<&str>) -> Vec<Row> {
        let asking: HashSet<&str> = self.asks.values().map(|p| p.neutral.key.as_str()).collect();
        let mut leads: HashMap<&str, &Need> = HashMap::new();
        for need in self.needs.open_iter() {
            match leads.get(need.key.as_str()) {
                // ties by id, so the lead is the same whatever the map's order
                Some(held) if (held.inbox_key(), &held.id) <= (need.inbox_key(), &need.id) => {}
                _ => {
                    leads.insert(need.key.as_str(), need);
                }
            }
        }
        #[allow(clippy::cast_precision_loss, reason = "ms stamps stay far below 2^52")]
        let now = self.now as f64;
        let mut rows = Vec::new();
        for key in &self.order {
            let Some(session) = self.sessions.get(key) else {
                continue;
            };
            let window =
                self.is_home_window(key, session.parent.is_some(), session.updated, now, &asking);
            let rides_bound = bound.contains(key.as_str()) && session.parent.is_none();
            if !(window || rides_bound) {
                continue;
            }
            let lead = leads.get(key.as_str()).copied();
            rows.push(Row {
                thread: Thread {
                    key: key.clone(),
                    title: Some(session.thread.title.clone()).filter(|t| !t.is_empty()),
                    need: lead.map(|n| board_need(n.kind)),
                    waiting_ms: None,
                    working: self.working(key),
                    fresh: false,
                    queued: session.thread.queued,
                    ask: lead.and_then(|n| self.board_ask(&session.host, n)),
                },
                raised: lead.map(|n| n.raised_at),
                window,
            });
        }
        rows
    }

    /// `windowKeys`, for one key of the order: not a subagent, not cleared
    /// off home, and active (a status, or an ask) or touched in the last 12 h.
    fn is_home_window(
        &self,
        key: &str,
        subagent: bool,
        updated: f64,
        now: f64,
        asking: &HashSet<&str>,
    ) -> bool {
        if subagent || self.cleared_mark(key).is_some() {
            return false;
        }
        // the thread's `activity` is not idle exactly while a status is held
        let active = self.statuses.contains_key(key) || asking.contains(key);
        active || now - updated < WINDOW_RECENT_MS
    }

    /// a turn is running: busy, or parked on agents still working (how the
    /// order ranks it, `Model::reorder`).
    fn working(&self, key: &str) -> bool {
        matches!(
            self.statuses.get(key).map(|s| s.activity),
            Some(Activity::Busy { .. } | Activity::Parked { agents: 1.., .. })
        )
    }

    /// the open ask a need is about, with a single question's option labels.
    fn board_ask(&self, host: &str, need: &Need) -> Option<BoardAsk> {
        let id = need.ask.as_deref()?;
        let pending = self.asks.get(&(host.to_owned(), id.to_owned()))?;
        Some(BoardAsk {
            id: id.to_owned(),
            kind: match pending.neutral.kind {
                wire::AskKind::Permission => BoardAskKind::Permission,
                wire::AskKind::Question => BoardAskKind::Question,
            },
            options: options_of(&pending.neutral),
        })
    }

    /// the agent's ask `id`, as its source told it, while it is open.
    #[must_use]
    pub fn neutral_ask(&self, agent: &str, id: &str) -> Option<wire::Ask> {
        self.asks
            .get(&(agent.to_owned(), id.to_owned()))
            .map(|p| (*p.neutral).clone())
    }

    /// the thread's newest message, its id and the daemon's `time.created`;
    /// none before it has one.
    ///
    /// # Errors
    /// the fleet does not hold the thread.
    pub fn newest_message(&self, key: &str) -> Result<Option<(String, f64)>, ReadRefused> {
        self.sessions
            .get(key)
            .map(|s| s.turn.newest.clone())
            .ok_or_else(|| ReadRefused::NoSuchSession(key.to_owned()))
    }
}

/// the labels a digit can pick: a single question with nine options or
/// fewer. empty for anything else, which the keys cannot answer whole.
#[must_use]
pub fn options_of(ask: &wire::Ask) -> Vec<String> {
    match ask.questions.as_deref() {
        Some([question]) if question.options.len() <= MAX_OPTIONS => {
            question.options.iter().map(|o| o.label.clone()).collect()
        }
        _ => Vec::new(),
    }
}

/// the board's five needs: `done` and `job` are both news.
#[must_use]
pub fn board_need(kind: NeedKind) -> BoardNeed {
    match kind {
        NeedKind::Permission => BoardNeed::Permission,
        NeedKind::Question => BoardNeed::Question,
        NeedKind::Fault => BoardNeed::Fault,
        NeedKind::Review => BoardNeed::Review,
        NeedKind::Done | NeedKind::Job => BoardNeed::News,
    }
}
