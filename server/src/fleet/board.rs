//! the board's projection (`docs/board.md`, the view), held by the fleet
//! actor only while a board stream listens. with no board there is no
//! projection: the actor's one check per change is `Option::is_some`.
//!
//! every change already passes the actor, so the projection only marks
//! itself: the changes that can move the picture (`host*`, `session*`,
//! `ask*`, `order`) mark it dirty, and a delta stamps its thread fresh and
//! feeds its machine's activity rate, never more. a dirty picture is built
//! at most every 250 ms. both edges of `fresh` are part of the picture's
//! shape, as v1 lit them: the first delta after a quiet spell marks it dirty
//! (so a working key brightens within the 250 ms coalesce), and the dimming
//! is one deadline at exactly the earliest fresh thread's last delta plus
//! 2 s, never a tick, so a thread that keeps streaming costs no build. when
//! only activity can have moved, a build waits a second, and that tick runs
//! only while some rate is still above zero. a build encodes once into
//! `Bytes` and publishes through a watch channel only when the picture
//! differs from the last one sent.
//!
//! the comparison leaves time out: a need's age is computed at encode time
//! (`waiting_ms`), so bytes compared with it would differ on every build
//! while any need is open. the picture compares each need's raised stamp
//! instead, and a view goes out when something other than the clock moved;
//! the daemon adds its own elapsed time to the last age it got.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use boxbox_board_wire::{Binding, Frame, MAX_MACHINES, MAX_THREADS, Machine, View};
use bytes::Bytes;
use tokio::sync::watch;
use tracing::error;

use super::model::Model;
use super::model::board::Row;
use crate::journal::sse_frame;
use crate::wire::Change;

/// a picture that changed shape waits at least this long after the last
/// build.
pub const STRUCTURE_EVERY: Duration = Duration::from_millis(250);
/// a picture where only `fresh` or activity moved waits this long.
pub const FRESH_EVERY: Duration = Duration::from_secs(1);
/// a thread that streamed text this recently is fresh.
pub const FRESH: Duration = Duration::from_secs(2);
/// v1's activity rate: +1 a delta, at most 60, times 0.7 a second, gone
/// under 0.05; the light is the rate rounded, 0 to 5.
const RATE_CAP: f64 = 60.0;
const RATE_DECAY: f64 = 0.7;
const RATE_FLOOR: f64 = 0.05;
const ACTIVITY_MAX: f64 = 5.0;
/// one `perf.board_view` row at most this often.
const SAMPLE_EVERY: Duration = Duration::from_secs(60);

/// one agent as the machine lights see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentLight {
    pub key: String,
    /// its `label.machine`.
    pub machine: String,
    /// connected (ready or syncing).
    pub up: bool,
}

/// the agents of every source, in the app's order (configured cmx2 hosts,
/// paired hosts, then the other sources). the board stream hands it over at
/// subscribe, since the sources start after the fleet does.
pub trait Roster: Send + Sync + fmt::Debug {
    fn agents(&self) -> Vec<AgentLight>;
}

/// what a board stream brings when it subscribes.
#[derive(Debug)]
pub struct Wanted {
    /// `[board] machines`, or none for the app's order.
    pub machines: Option<Vec<String>>,
    pub bindings: Vec<Binding>,
    pub roster: Arc<dyn Roster>,
}

/// what a build measured, for `perf.board_view`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Built {
    pub micros: u64,
    pub bytes: usize,
    pub threads: usize,
}

#[derive(Debug, PartialEq)]
struct Picture {
    view: View,
    /// each thread's need's raised stamp, in thread order.
    raised: Vec<Option<i64>>,
}

/// the time a build runs at: the monotonic clock schedules and ages the
/// projection's own stamps, the wall clock ages needs (raised on it).
#[derive(Clone, Copy, Debug)]
pub struct Clock {
    pub at: Instant,
    /// ms since the epoch.
    pub wall: i64,
}

impl Clock {
    #[must_use]
    pub fn now() -> Self {
        Self {
            at: Instant::now(),
            wall: crate::now_ms(),
        }
    }
}

/// what a focus or a compose names, for the board's routes to check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Holds {
    /// a thread the fleet holds.
    Thread(String),
    /// a machine light the view shows.
    Machine(String),
}

#[derive(Clone, Copy, Debug)]
struct Rate {
    value: f64,
    at: Instant,
}

impl Rate {
    /// the rate as of `now`.
    fn at(self, now: Instant) -> f64 {
        let seconds = now.saturating_duration_since(self.at).as_secs_f64();
        self.value * RATE_DECAY.powf(seconds)
    }
}

#[derive(Debug)]
pub struct Projection {
    view: watch::Sender<Bytes>,
    roster: Arc<dyn Roster>,
    machines: Option<Vec<String>>,
    bindings: Vec<Binding>,
    /// a change that can move the picture's shape came since the last build.
    structure: bool,
    /// a delta came since the last build.
    soft: bool,
    /// when the last build ran, ms.
    built: Instant,
    last: Picture,
    /// when each thread last streamed text, ms; pruned at each build.
    fresh: HashMap<String, Instant>,
    /// each machine's activity rate; dropped under the floor at each build.
    rates: HashMap<String, Rate>,
    /// each agent's machine, as the roster said at the last build.
    machine_of: HashMap<String, String>,
    sampled: Option<Instant>,
    /// builds run and views sent, for the tests and the log.
    pub builds: u64,
    pub sent: u64,
}

impl Projection {
    /// a projection with its first view built: the receiver holds it.
    #[must_use]
    pub fn start(wanted: Wanted, model: &Model, now: Clock) -> (Self, watch::Receiver<Bytes>) {
        let (view, receiver) = watch::channel(Bytes::new());
        let mut projection = Self {
            view,
            roster: wanted.roster,
            machines: wanted.machines,
            bindings: wanted.bindings,
            structure: true,
            soft: false,
            built: now.at,
            last: Picture {
                view: View::default(),
                raised: Vec::new(),
            },
            fresh: HashMap::new(),
            rates: HashMap::new(),
            machine_of: HashMap::new(),
            sampled: None,
            builds: 0,
            sent: 0,
        };
        projection.build(model, now, true);
        (projection, receiver)
    }

    /// another board stream wants the same view: the current one is in it.
    #[must_use]
    pub fn subscribe(&mut self, wanted: Wanted) -> watch::Receiver<Bytes> {
        self.roster = wanted.roster;
        self.machines = wanted.machines;
        self.bindings = wanted.bindings;
        self.structure = true;
        self.view.subscribe()
    }

    /// no stream holds the view any more.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.view.is_closed()
    }

    /// a change of the model passed the actor, on its way to the encoder.
    pub fn saw(&mut self, change: &Change, now: Instant) {
        match change {
            Change::Agent { .. }
            | Change::AgentRemoved { .. }
            | Change::Thread { .. }
            | Change::ThreadPatch(_)
            | Change::ThreadRemoved { .. }
            | Change::Ask { .. }
            | Change::AskSettled(_)
            | Change::Order { .. }
            | Change::OrderPatch { .. } => self.structure = true,
            Change::Delta { key, .. } => self.streamed(key, now),
            Change::ThreadReset { .. }
            | Change::Message { .. }
            | Change::Part { .. }
            | Change::MessageRemoved { .. }
            | Change::Reactions { .. } => {}
        }
    }

    /// a connection's state moved: a machine light may have.
    pub fn connection_moved(&mut self) {
        self.structure = true;
    }

    /// the pairings changed.
    pub fn bindings(&mut self, bindings: Vec<Binding>) {
        self.bindings = bindings;
        self.structure = true;
    }

    /// a delta: allocates only for a thread or a machine not stamped yet.
    /// the first after a quiet spell is `fresh`'s rising edge: the picture's
    /// shape moved.
    fn streamed(&mut self, key: &str, now: Instant) {
        if let Some(at) = self.fresh.get_mut(key) {
            // a stamp past its 2 s that no build has pruned yet is quiet already
            if now.saturating_duration_since(*at) >= FRESH {
                self.structure = true;
            }
            *at = now;
        } else {
            self.fresh.insert(key.to_owned(), now);
            self.structure = true;
        }
        let agent = key.split_once(':').map_or(key, |(agent, _)| agent);
        let machine = self.machine_of.get(agent).map_or(agent, String::as_str);
        if let Some(rate) = self.rates.get_mut(machine) {
            *rate = Rate {
                value: (rate.at(now) + 1.0).min(RATE_CAP),
                at: now,
            };
        } else {
            self.rates.insert(
                machine.to_owned(),
                Rate {
                    value: 1.0,
                    at: now,
                },
            );
        }
        self.soft = true;
    }

    /// when the next build is due; none when nothing can change. the
    /// dimming of the earliest fresh thread is exact, not coalesced: it comes
    /// 2 s after a delta, never inside the 250 ms after a build it follows.
    #[must_use]
    pub fn due(&self) -> Option<Instant> {
        let paced = if self.structure {
            Some(self.built + STRUCTURE_EVERY)
        } else if self.soft || !self.rates.is_empty() {
            Some(self.built + FRESH_EVERY)
        } else {
            None
        };
        let dims = self.fresh.values().min().map(|at| *at + FRESH);
        match (paced, dims) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// builds when due; what it measured when a view went out.
    pub fn tick(&mut self, model: &Model, now: Clock) -> Option<Built> {
        match self.due() {
            Some(due) if due <= now.at => self.build(model, now, false),
            _ => None,
        }
    }

    /// whether a `perf.board_view` row is due, and if so takes the sample.
    pub fn sample(&mut self, now: Instant) -> bool {
        if self
            .sampled
            .is_some_and(|at| now.saturating_duration_since(at) < SAMPLE_EVERY)
        {
            false
        } else {
            self.sampled = Some(now);
            true
        }
    }

    /// whether the last view sent shows a light for `machine`.
    #[must_use]
    pub fn shows_machine(&self, machine: &str) -> bool {
        self.last.view.machines.iter().any(|m| m.name == machine)
    }

    fn build(&mut self, model: &Model, clock: Clock, first: bool) -> Option<Built> {
        let started = std::time::Instant::now();
        let now = clock.at;
        self.builds += 1;
        self.structure = false;
        self.soft = false;
        self.built = now;
        self.fresh
            .retain(|_, at| now.saturating_duration_since(*at) < FRESH);
        self.rates.retain(|_, rate| {
            *rate = Rate {
                value: rate.at(now),
                at: now,
            };
            rate.value >= RATE_FLOOR
        });
        let picture = self.picture(model);
        if !first && picture == self.last {
            return None;
        }
        let mut view = picture.view.clone();
        for (thread, raised) in view.threads.iter_mut().zip(&picture.raised) {
            thread.waiting_ms = raised.map(|at| u64::try_from(clock.wall - at).unwrap_or(0));
        }
        let threads = view.threads.len();
        let json = match serde_json::to_vec(&Frame::View(view)) {
            Ok(json) => json,
            Err(e) => {
                error!(error = %e, "the board's view did not serialize; it is not sent");
                return None;
            }
        };
        let frame = sse_frame(None, &json);
        let bytes = frame.len();
        self.view.send_replace(frame);
        self.last = picture;
        self.sent += 1;
        Some(Built {
            micros: u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX),
            bytes,
            threads,
        })
    }

    fn picture(&mut self, model: &Model) -> Picture {
        let agents = self.roster.agents();
        self.machine_of = agents
            .iter()
            .map(|a| (a.key.clone(), a.machine.clone()))
            .collect();
        let names: Vec<String> = if let Some(names) = &self.machines {
            names.iter().take(MAX_MACHINES).cloned().collect()
        } else {
            let mut names: Vec<String> = Vec::new();
            for agent in &agents {
                if names.len() == MAX_MACHINES {
                    break;
                }
                if !names.contains(&agent.machine) {
                    names.push(agent.machine.clone());
                }
            }
            names
        };
        let machines = names
            .into_iter()
            .map(|name| Machine {
                up: agents.iter().any(|a| a.machine == name && a.up),
                activity: self.rates.get(&name).map_or(0, |r| activity(r.value)),
                name,
            })
            .collect();

        let bound: HashSet<&str> = self.bindings.iter().map(|b| b.key.as_str()).collect();
        let rows = model.board_rows(&bound);
        let (threads, raised) = keep(rows, &bound)
            .into_iter()
            .map(|mut row| {
                row.thread.fresh = self.fresh.contains_key(&row.thread.key);
                (row.thread, row.raised)
            })
            .unzip();
        Picture {
            view: View {
                machines,
                threads,
                bindings: self.bindings.clone(),
            },
            raised,
        }
    }
}

/// what rides the view: the windows that need you or work, and every bound
/// thread, in order, at most `MAX_THREADS`. a bound thread is never the one
/// the cap drops.
fn keep(rows: Vec<Row>, bound: &HashSet<&str>) -> Vec<Row> {
    let wanted = |row: &Row| {
        bound.contains(row.thread.key.as_str())
            || (row.window && (row.thread.need.is_some() || row.thread.working))
    };
    let bound_riding = rows
        .iter()
        .filter(|r| bound.contains(r.thread.key.as_str()))
        .count()
        .min(MAX_THREADS);
    let mut room = MAX_THREADS - bound_riding;
    let mut kept = Vec::new();
    for row in rows {
        if !wanted(&row) {
            continue;
        }
        if bound.contains(row.thread.key.as_str()) {
            if kept.len() < MAX_THREADS {
                kept.push(row);
            }
        } else if room > 0 {
            room -= 1;
            kept.push(row);
        }
    }
    kept
}

/// a rate as the fleet bank's column: 0 to 5.
fn activity(rate: f64) -> u8 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "clamped to 0..=5 first"
    )]
    let light = rate.clamp(0.0, ACTIVITY_MAX).round() as u8;
    light
}

#[cfg(test)]
mod tests;
