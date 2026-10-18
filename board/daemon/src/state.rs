//! the board's state: the latest [`View`] and what the daemon derives from
//! it. the server computes needs, order and read state (decision 80); the
//! daemon keeps only what a picture alone cannot say: which needs are new
//! since the last view (the arrival pulse, the red flag), which review left
//! without the board marking it read (the victory lap), when a need turns hot,
//! and when the board was away long enough to earn the briefing.

use std::collections::{HashMap, HashSet};

use boxbox_board_wire::{Need, Thread, View};

/// a need waiting this long is hot (v1's chip threshold); a fault is born hot.
pub const HOT_AFTER_MS: u64 = 10 * 60_000;

/// what a new view set off, in thread keys; the controller places them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Derived {
    /// a thread's need changed to this one.
    Arrival { key: String, need: Need },
    /// a review need went away without the board marking it read.
    Victory,
}

#[derive(Debug, Default)]
pub struct Fleet {
    view: View,
    /// monotonic ms when the view landed: ages in it are as of then.
    view_at: u64,
    /// a view has landed since the last connect.
    seeded: bool,
    prev_needs: HashMap<String, Need>,
    /// threads the board marked read while they asked for review: their
    /// review leaving is the board's own doing, not a verdict.
    marked_read: HashSet<String>,
}

impl Fleet {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn view(&self) -> &View {
        &self.view
    }

    /// a view has landed since the stream connected.
    #[must_use]
    pub fn has_view(&self) -> bool {
        self.seeded
    }

    /// a new stream (a plug, a redial): the next view seeds silently, since
    /// what changed during the gap was not seen happening.
    pub fn reconnect(&mut self) {
        self.seeded = false;
    }

    /// unplugged: nothing of the old picture may draw on the next board.
    pub fn forget(&mut self) {
        *self = Self::default();
    }

    /// the board marked this thread read (`Act::Read`).
    pub fn marked_read(&mut self, key: &str) {
        self.marked_read.insert(key.to_owned());
    }

    /// takes a view; returns what it set off.
    pub fn apply(&mut self, view: View, now: u64) -> Vec<Derived> {
        let next: HashMap<String, Need> = view
            .threads
            .iter()
            .filter_map(|t| t.need.map(|n| (t.key.clone(), n)))
            .collect();
        let mut out = Vec::new();
        if self.seeded {
            for t in &view.threads {
                let Some(need) = t.need else { continue };
                if self.prev_needs.get(&t.key) != Some(&need) {
                    out.push(Derived::Arrival {
                        key: t.key.clone(),
                        need,
                    });
                }
            }
            for (key, need) in &self.prev_needs {
                if *need == Need::Review
                    && next.get(key) != Some(&Need::Review)
                    && !self.marked_read.contains(key)
                {
                    out.push(Derived::Victory);
                }
            }
        }
        self.marked_read
            .retain(|key| next.get(key) == Some(&Need::Review));
        self.prev_needs = next;
        self.view = view;
        self.view_at = now;
        self.seeded = true;
        out
    }

    #[must_use]
    pub fn thread(&self, key: &str) -> Option<&Thread> {
        self.view.threads.iter().find(|t| t.key == key)
    }

    /// how long a thread's need has waited at `now`: the view's age plus the
    /// time since it landed.
    #[must_use]
    pub fn waited(&self, thread: &Thread, now: u64) -> u64 {
        thread
            .waiting_ms
            .unwrap_or(0)
            .saturating_add(now.saturating_sub(self.view_at))
    }

    /// a fault, or a need waiting ten minutes or more.
    #[must_use]
    pub fn hot(&self, thread: &Thread, now: u64) -> bool {
        match thread.need {
            None => false,
            Some(Need::Fault) => true,
            Some(_) => self.waited(thread, now) >= HOT_AFTER_MS,
        }
    }

    /// the next time a need crosses into hot, so the main loop wakes once
    /// for it rather than checking on a clock.
    #[must_use]
    pub fn next_hot(&self, now: u64) -> Option<u64> {
        self.view
            .threads
            .iter()
            .filter(|t| t.need.is_some_and(|n| n != Need::Fault) && !self.hot(t, now))
            .map(|t| {
                self.view_at
                    .saturating_add(HOT_AFTER_MS.saturating_sub(t.waiting_ms.unwrap_or(0)))
            })
            .min()
    }

    /// the top call: the first thread with a need, in the app's order.
    #[must_use]
    pub fn top_call(&self) -> Option<&Thread> {
        self.view.threads.iter().find(|t| t.need.is_some())
    }
}

/// the briefing's clock: the board away (unplugged to plugged, or a stream
/// gap while plugged) longer than `away_ms`, in wall clock ms since a mac
/// asleep stops the monotonic one. a fresh process has no away to measure.
#[derive(Debug, Default)]
pub struct Away {
    since: Option<u64>,
}

impl Away {
    /// the board or its stream went away at `wall`; the first loss counts.
    pub fn left(&mut self, wall: u64) {
        self.since.get_or_insert(wall);
    }

    /// a view landed at `wall`: true when the absence earns the briefing.
    pub fn back(&mut self, wall: u64, away_ms: u64) -> bool {
        self.since
            .take()
            .is_some_and(|since| wall.saturating_sub(since) > away_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn thread(key: &str, need: Option<Need>) -> Thread {
        Thread {
            key: key.into(),
            title: None,
            need,
            waiting_ms: None,
            working: false,
            fresh: false,
            queued: 0,
            ask: None,
        }
    }

    fn view(threads: Vec<Thread>) -> View {
        View {
            machines: vec![],
            threads,
            bindings: vec![],
        }
    }

    #[test]
    fn the_first_view_after_a_connect_seeds_silently() {
        let mut f = Fleet::new();
        let first = f.apply(
            view(vec![
                thread("h:a", Some(Need::Permission)),
                thread("h:b", Some(Need::Fault)),
            ]),
            0,
        );
        assert!(first.is_empty());
        let next = f.apply(
            view(vec![
                thread("h:a", Some(Need::Permission)),
                thread("h:b", Some(Need::Fault)),
                thread("h:c", Some(Need::News)),
            ]),
            10,
        );
        assert_eq!(
            next,
            vec![Derived::Arrival {
                key: "h:c".into(),
                need: Need::News
            }]
        );
        f.reconnect();
        assert!(
            f.apply(view(vec![thread("h:d", Some(Need::Fault))]), 20)
                .is_empty()
        );
    }

    #[test]
    fn a_change_of_need_is_an_arrival_and_a_change_to_fault_is_one_too() {
        let mut f = Fleet::new();
        f.apply(view(vec![thread("h:a", Some(Need::News))]), 0);
        let out = f.apply(view(vec![thread("h:a", Some(Need::Fault))]), 1);
        assert_eq!(
            out,
            vec![Derived::Arrival {
                key: "h:a".into(),
                need: Need::Fault
            }]
        );
        assert!(
            f.apply(view(vec![thread("h:a", Some(Need::Fault))]), 2)
                .is_empty()
        );
    }

    #[test]
    fn a_review_leaving_is_a_victory_unless_the_board_marked_it_read() {
        let mut f = Fleet::new();
        f.apply(
            view(vec![
                thread("h:a", Some(Need::Review)),
                thread("h:b", Some(Need::Review)),
            ]),
            0,
        );
        f.marked_read("h:b");
        let out = f.apply(view(vec![thread("h:a", None)]), 1);
        assert_eq!(out, vec![Derived::Victory]);
        assert!(f.marked_read.is_empty());
    }

    #[test]
    fn hot_is_a_fault_or_ten_minutes_with_one_deadline_for_the_next_crossing() {
        let mut f = Fleet::new();
        let mut a = thread("h:a", Some(Need::Question));
        a.waiting_ms = Some(9 * 60_000);
        let mut b = thread("h:b", Some(Need::Review));
        b.waiting_ms = Some(60_000);
        f.apply(view(vec![a, b, thread("h:c", Some(Need::Fault))]), 1_000);
        let [a, b, c] = [&f.view.threads[0], &f.view.threads[1], &f.view.threads[2]];
        assert!(!f.hot(a, 1_000) && f.hot(c, 1_000));
        assert_eq!(f.next_hot(1_000), Some(61_000));
        assert!(f.hot(a, 61_000) && !f.hot(b, 61_000));
        assert_eq!(f.next_hot(61_000), Some(1_000 + 9 * 60_000));
    }

    #[test]
    fn the_briefing_wants_an_absence_longer_than_away_ms() {
        let mut away = Away::default();
        assert!(!away.back(10_000, 1_000), "a fresh process never briefs");
        away.left(10_000);
        away.left(10_500);
        assert!(away.back(11_200, 1_000));
        away.left(20_000);
        assert!(!away.back(20_900, 1_000));
    }
}
