//! the request scheduler (`docs/openclaw.md`, section 10): which queued
//! request may go on the wire next. pure state, no clock of its own and
//! no io, so every limit is unit-tested; the connection task owns one and
//! asks it after every arrival, completion and wake-up.
//!
//! the limits, per connection:
//!
//! | lane | in flight | spacing |
//! |---|---|---|
//! | every request | 4 | |
//! | preparation (`sessions.subscribe`, `sessions.list`, `models.list`, an approval-carrying `sessions.messages.subscribe`) | 1 | |
//! | roster pages (`sessions.list`) | | 250 ms |
//! | deltas (`chat.history` with a cursor) | 2 | 100 ms (10 a second) |
//! | tails (`chat.history` without one) | 1 | |
//! | `chat.message.get` | 1 | 1 s |
//! | subscribe and unsubscribe | | 500 ms (2 a second) |
//! | `chat.send`, per session | 1 | 1 s |
//!
//! the queue itself (8 waiting) is bounded before it gets here, by the
//! client's admission semaphore.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use super::wire::Allowed;

/// every request in flight at once.
pub const MAX_IN_FLIGHT: usize = 4;
/// requests waiting for a slot; past it a verb answers busy (section 10).
pub const MAX_QUEUED: usize = 8;

/// a limit a request is held to; a request may be in several.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Lane {
    Preparation,
    Roster,
    Delta,
    Tail,
    MessageGet,
    Subscription,
    /// one session's sends.
    Send(String),
}

impl Lane {
    fn max_in_flight(&self) -> usize {
        match self {
            Self::Preparation | Self::Tail | Self::MessageGet | Self::Send(_) => 1,
            Self::Delta => 2,
            Self::Roster | Self::Subscription => MAX_IN_FLIGHT,
        }
    }

    fn spacing(&self) -> Duration {
        match self {
            Self::Roster => Duration::from_millis(250),
            Self::Delta => Duration::from_millis(100),
            Self::Subscription => Duration::from_millis(500),
            Self::MessageGet | Self::Send(_) => Duration::from_secs(1),
            Self::Preparation | Self::Tail => Duration::ZERO,
        }
    }
}

/// the lanes `request` is held to.
#[must_use]
pub fn lanes(request: &Allowed) -> Vec<Lane> {
    match request {
        Allowed::SessionsList(_) => vec![Lane::Preparation, Lane::Roster],
        Allowed::SessionsSubscribe(_) | Allowed::ModelsList(_) => vec![Lane::Preparation],
        Allowed::SessionsMessagesSubscribe(p) if p.include_approvals.is_some() => {
            vec![Lane::Preparation, Lane::Subscription]
        }
        Allowed::SessionsMessagesSubscribe(_) | Allowed::SessionsMessagesUnsubscribe(_) => {
            vec![Lane::Subscription]
        }
        Allowed::ChatHistory(p) if p.cursor.is_some() => vec![Lane::Delta],
        Allowed::ChatHistory(_) => vec![Lane::Tail],
        Allowed::ChatMessageGet(_) => vec![Lane::MessageGet],
        Allowed::ChatSend(send) => vec![Lane::Send(send.session_key.clone())],
        _ => Vec::new(),
    }
}

#[derive(Debug, Default)]
struct LaneState {
    in_flight: usize,
    last_start: Option<Instant>,
}

/// the queue and what is in flight. `T` is whatever the connection keeps
/// with a waiting request (its reply channel).
#[derive(Debug)]
pub struct Scheduler<T> {
    queue: VecDeque<(Vec<Lane>, T)>,
    in_flight: usize,
    lanes: HashMap<Lane, LaneState>,
}

impl<T> Default for Scheduler<T> {
    fn default() -> Self {
        Self {
            queue: VecDeque::new(),
            in_flight: 0,
            lanes: HashMap::new(),
        }
    }
}

impl<T> Scheduler<T> {
    pub fn push(&mut self, lanes: Vec<Lane>, item: T) {
        self.queue.push_back((lanes, item));
    }

    #[must_use]
    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    #[must_use]
    pub fn in_flight(&self) -> usize {
        self.in_flight
    }

    /// the oldest queued request every lane of which has room at `now`,
    /// marked started. call it until it answers `None`.
    pub fn next(&mut self, now: Instant) -> Option<(Vec<Lane>, T)> {
        // an idle send lane past its spacing holds nothing worth keeping,
        // so the map stays as small as the sessions sent to this second
        self.lanes.retain(|lane, state| {
            !matches!(lane, Lane::Send(_))
                || state.in_flight > 0
                || state
                    .last_start
                    .is_some_and(|last| now.duration_since(last) < lane.spacing())
        });
        if self.in_flight >= MAX_IN_FLIGHT {
            return None;
        }
        let index = self
            .queue
            .iter()
            .position(|(lanes, _)| lanes.iter().all(|lane| self.has_room(lane, now)))?;
        let (lanes, item) = self.queue.remove(index)?;
        self.in_flight += 1;
        for lane in &lanes {
            let state = self.lanes.entry(lane.clone()).or_default();
            state.in_flight += 1;
            state.last_start = Some(now);
        }
        Some((lanes, item))
    }

    /// a request that `next` started has its answer (or gave up).
    pub fn finished(&mut self, lanes: &[Lane]) {
        self.in_flight = self.in_flight.saturating_sub(1);
        for lane in lanes {
            if let Some(state) = self.lanes.get_mut(lane) {
                state.in_flight = state.in_flight.saturating_sub(1);
            }
        }
    }

    /// when a request held only by spacing becomes eligible, so the
    /// connection can sleep until then; `None` when nothing waits on time.
    #[must_use]
    pub fn wake_at(&self, now: Instant) -> Option<Instant> {
        if self.in_flight >= MAX_IN_FLIGHT {
            return None;
        }
        self.queue
            .iter()
            .filter(|(lanes, _)| {
                lanes.iter().all(|lane| {
                    self.lanes
                        .get(lane)
                        .is_none_or(|s| s.in_flight < lane.max_in_flight())
                })
            })
            .filter_map(|(lanes, _)| {
                lanes
                    .iter()
                    .filter_map(|lane| {
                        let last = self.lanes.get(lane)?.last_start?;
                        Some(last + lane.spacing())
                    })
                    .max()
            })
            .filter(|at| *at > now)
            .min()
    }

    /// everything still queued, for a connection that is going away.
    pub fn drain(&mut self) -> impl Iterator<Item = T> + '_ {
        self.queue.drain(..).map(|(_, item)| item)
    }

    /// forgets in-flight counts and spacing: a new socket starts clean.
    pub fn reset(&mut self) {
        self.in_flight = 0;
        self.lanes.clear();
    }

    fn has_room(&self, lane: &Lane, now: Instant) -> bool {
        self.lanes.get(lane).is_none_or(|state| {
            state.in_flight < lane.max_in_flight()
                && state
                    .last_start
                    .is_none_or(|last| now.duration_since(last) >= lane.spacing())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    fn drain_ready<T>(scheduler: &mut Scheduler<T>, now: Instant) -> Vec<T> {
        std::iter::from_fn(|| scheduler.next(now).map(|(_, item)| item)).collect()
    }

    #[test]
    fn at_most_four_requests_are_in_flight() {
        let mut scheduler = Scheduler::default();
        let now = Instant::now();
        for n in 0..6 {
            scheduler.push(Vec::new(), n);
        }
        assert_eq!(drain_ready(&mut scheduler, now), [0, 1, 2, 3]);
        assert_eq!(scheduler.queued(), 2);
        scheduler.finished(&[]);
        assert_eq!(drain_ready(&mut scheduler, now), [4]);
    }

    #[test]
    fn preparation_requests_go_one_at_a_time_and_others_pass_them() {
        let mut scheduler = Scheduler::default();
        let now = Instant::now();
        scheduler.push(vec![Lane::Preparation], "subscribe");
        scheduler.push(vec![Lane::Preparation], "models");
        scheduler.push(Vec::new(), "agents");
        assert_eq!(drain_ready(&mut scheduler, now), ["subscribe", "agents"]);
        scheduler.finished(&[Lane::Preparation]);
        assert_eq!(drain_ready(&mut scheduler, now), ["models"]);
    }

    #[test]
    fn roster_pages_are_at_least_250_ms_apart() {
        let mut scheduler = Scheduler::default();
        let start = Instant::now();
        let page = || vec![Lane::Preparation, Lane::Roster];
        scheduler.push(page(), 1);
        scheduler.push(page(), 2);
        assert_eq!(drain_ready(&mut scheduler, start), [1]);
        scheduler.finished(&page());
        assert_eq!(
            drain_ready(&mut scheduler, at(start, 100)),
            Vec::<i32>::new()
        );
        assert_eq!(scheduler.wake_at(at(start, 100)), Some(at(start, 250)));
        assert_eq!(drain_ready(&mut scheduler, at(start, 250)), [2]);
    }

    #[test]
    fn deltas_are_two_in_flight_and_ten_a_second() {
        let mut scheduler = Scheduler::default();
        let start = Instant::now();
        for n in 0..3 {
            scheduler.push(vec![Lane::Delta], n);
        }
        assert_eq!(drain_ready(&mut scheduler, start), [0]);
        assert_eq!(
            drain_ready(&mut scheduler, at(start, 50)),
            Vec::<i32>::new()
        );
        assert_eq!(drain_ready(&mut scheduler, at(start, 100)), [1]);
        assert_eq!(
            drain_ready(&mut scheduler, at(start, 500)),
            Vec::<i32>::new(),
            "two are in flight"
        );
        assert_eq!(
            scheduler.wake_at(at(start, 500)),
            None,
            "nothing waits on time, only on an answer"
        );
        scheduler.finished(&[Lane::Delta]);
        assert_eq!(drain_ready(&mut scheduler, at(start, 500)), [2]);
    }

    #[test]
    fn one_send_per_session_and_one_a_second_while_other_sessions_go() {
        let mut scheduler = Scheduler::default();
        let start = Instant::now();
        let a = || vec![Lane::Send("a".into())];
        scheduler.push(a(), "a1");
        scheduler.push(a(), "a2");
        scheduler.push(vec![Lane::Send("b".into())], "b1");
        assert_eq!(drain_ready(&mut scheduler, start), ["a1", "b1"]);
        scheduler.finished(&a());
        assert_eq!(
            drain_ready(&mut scheduler, at(start, 400)),
            Vec::<&str>::new()
        );
        assert_eq!(drain_ready(&mut scheduler, at(start, 1000)), ["a2"]);
    }

    #[test]
    fn tails_and_message_gets_go_one_at_a_time() {
        let mut scheduler = Scheduler::default();
        let start = Instant::now();
        scheduler.push(vec![Lane::Tail], 1);
        scheduler.push(vec![Lane::Tail], 2);
        scheduler.push(vec![Lane::MessageGet], 3);
        scheduler.push(vec![Lane::MessageGet], 4);
        assert_eq!(drain_ready(&mut scheduler, start), [1, 3]);
        scheduler.finished(&[Lane::Tail]);
        scheduler.finished(&[Lane::MessageGet]);
        assert_eq!(drain_ready(&mut scheduler, at(start, 10)), [2]);
        assert_eq!(scheduler.wake_at(at(start, 10)), Some(at(start, 1000)));
    }

    #[test]
    fn a_new_socket_starts_with_nothing_in_flight() {
        let mut scheduler = Scheduler::default();
        let now = Instant::now();
        for n in 0..5 {
            scheduler.push(vec![Lane::Tail], n);
        }
        assert_eq!(drain_ready(&mut scheduler, now), [0]);
        assert_eq!(scheduler.drain().collect::<Vec<_>>(), [1, 2, 3, 4]);
        scheduler.reset();
        assert_eq!(scheduler.in_flight(), 0);
        scheduler.push(vec![Lane::Tail], 9);
        assert_eq!(drain_ready(&mut scheduler, now), [9]);
    }
}
