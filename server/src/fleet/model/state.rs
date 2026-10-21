//! the model's own state per key, as `boxbox.db` keeps it in the `model`
//! column of `stream_keys` (`docs/protocol.md`, section 10): per thread its
//! facts, status, tail, turn, held tick and revision; per agent its place
//! among the agents, floors, epoch and the statuses of sessions the fleet
//! does not hold; per ask the ask and its arrival; and the order with the
//! arrival counter. a restart rebuilds the model from these rows, so the
//! sources resume from their cursors instead of being read again.
//!
//! what is not here is not needed across a restart, as before protocol 3:
//! sends waiting for their message (`arms`), asks being answered, a
//! person's last stop, who is looking, and a tail read in flight (asked
//! again on the thread's next change). needs, read marks, clears, adopted
//! infos and colours have their own tables.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{
    Activity, Arm, Device, Floors, Hydration, Model, Pending, Said, Session, Status, Tail,
    TailItem, Turn, activity,
};
use crate::source::ThreadFacts;
use crate::wire;

#[derive(Debug, Serialize, Deserialize)]
struct StatusState {
    activity: wire::Activity,
    queued: u32,
}

impl StatusState {
    fn of(status: &Status) -> Self {
        Self {
            activity: status.neutral.clone(),
            queued: status.queued,
        }
    }

    fn status(self) -> Option<Status> {
        let meaning: Activity = activity(&self.activity)?;
        Some(Status {
            neutral: self.activity,
            activity: meaning,
            queued: self.queued,
        })
    }
}

/// every state here reads a row a later build wrote, or an older build's
/// row in a later build: a field added later takes a default, so a row
/// without it still decodes (container `#[serde(default)]` where every
/// field has one, else on the field).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct ThreadState {
    host: String,
    id: String,
    thread: ThreadFacts,
    updated: f64,
    parent: Option<String>,
    directory: String,
    repo: String,
    places: [String; 2],
    items: Vec<TailItem>,
    said: Vec<Said>,
    /// when its entry last went out, ms.
    sent: i64,
    /// the tail holds the daemon's read at this upstream seq; none: it is
    /// read when the thread next changes.
    floor: Option<u64>,
    turn: Turn,
    srev: Option<u64>,
    status: Option<StatusState>,
    /// streamed text its journaled entry lacks: the clock sends it.
    held: bool,
    /// held because a person opened it from history.
    adopted: bool,
    /// the quiet re-read asked for its newest messages with this listing
    /// revision, and the answer had not come (asked again at start).
    newest: Option<u64>,
    /// a session info's revision past the journal's, given during a compact
    /// replay and not yet judged (judged at the next replay's end).
    unseen: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AgentState {
    /// its place among the agents, first seen first.
    #[serde(default)]
    at: usize,
    agent: wire::Agent,
    /// sessions, statuses, permissions, questions.
    #[serde(default)]
    floors: Option<[u64; 4]>,
    #[serde(default)]
    epoch: Option<String>,
    #[serde(default)]
    applied: Option<u64>,
    /// statuses of the agent's sessions the fleet does not hold.
    #[serde(default)]
    statuses: Vec<(String, StatusState)>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AskState {
    ask: wire::Ask,
    #[serde(default)]
    serial: u64,
}

/// the order, and what the model holds for the fleet as a whole: the
/// arrival counter, sends waiting for their message, asks being answered
/// and each thread's last stop by a person (each capped where it lives).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct OrderState {
    order: Vec<String>,
    serial: u64,
    #[serde(default)]
    arms: Vec<(String, Arm)>,
    #[serde(default)]
    answering: Vec<((String, String), (Device, i64))>,
    #[serde(default)]
    own: Vec<(String, i64)>,
}

/// the persisted model rows a restart hands back, each as its json.
#[derive(Debug, Default)]
pub struct Rows {
    /// `(key, model, srev)`.
    pub threads: Vec<(String, String, Option<u64>)>,
    /// `(agent, model)`.
    pub agents: Vec<(String, String)>,
    /// `(agent, model)`: the agent the ask waits on.
    pub asks: Vec<(String, String)>,
    pub order: Option<String>,
}

/// the rows that will not decode, found before anything is built from
/// them: the hosts whose kept cursors must go, so their sources read them
/// again and bring the lost threads back (`docs/protocol.md`, section 10);
/// the threads the model will not hold; and whether every host must be read
/// again (the order's row).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Broken {
    pub hosts: std::collections::BTreeSet<String>,
    pub threads: Vec<String>,
    pub every_host: bool,
}

impl Broken {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.hosts.is_empty() && !self.every_host
    }
}

impl Rows {
    /// what of these rows will not decode.
    #[must_use]
    pub fn broken(&self) -> Broken {
        let mut broken = Broken::default();
        for (key, text, _) in &self.threads {
            if serde_json::from_str::<ThreadState>(text).is_err() {
                let host = key.split_once(':').map_or(key.as_str(), |(h, _)| h);
                broken.hosts.insert(host.to_owned());
                broken.threads.push(key.clone());
            }
        }
        for (agent, text) in &self.agents {
            if serde_json::from_str::<AgentState>(text).is_err() {
                broken.hosts.insert(agent.clone());
            }
        }
        for (agent, text) in &self.asks {
            if serde_json::from_str::<AskState>(text).is_err() {
                broken.hosts.insert(agent.clone());
            }
        }
        if let Some(text) = &self.order {
            broken.every_host = serde_json::from_str::<OrderState>(text).is_err();
        }
        broken
    }
}

fn json(value: &impl Serialize) -> Option<String> {
    match serde_json::to_string(value) {
        Ok(json) => Some(json),
        Err(error) => {
            tracing::error!(%error, "a model state did not serialize; its row is not written");
            None
        }
    }
}

impl Model {
    /// the thread's state as its row keeps it; none when the fleet does not
    /// hold it.
    #[must_use]
    pub fn thread_state(&self, key: &str) -> Option<String> {
        let s = self.sessions.get(key)?;
        json(&ThreadState {
            host: s.host.clone(),
            id: s.id.clone(),
            thread: s.thread.clone(),
            updated: s.updated,
            parent: s.parent.clone(),
            directory: s.directory.clone(),
            repo: s.repo.clone(),
            places: s.places.clone(),
            items: s.tail.items.clone(),
            said: s.tail.said.iter().cloned().collect(),
            sent: s.tail.sent,
            floor: match s.tail.hydration {
                Hydration::Read { floor } => Some(floor),
                _ => None,
            },
            turn: s.turn.clone(),
            srev: s.srev,
            status: self.statuses.get(key).map(StatusState::of),
            held: self.held.contains(key),
            adopted: self.adopted.iter().any(|k| k == key),
            newest: self.newest.get(key).copied(),
            unseen: self.unseen.get(key).copied(),
        })
    }

    /// an agent as the model holds it.
    #[must_use]
    pub fn snapshot_agent(&self, key: &str) -> Option<wire::Agent> {
        self.agents.iter().find(|a| a.key == key).cloned()
    }

    /// the thread's transcript revision (section 14a).
    #[must_use]
    pub fn srev(&self, key: &str) -> Option<u64> {
        self.sessions.get(key).and_then(|s| s.srev)
    }

    /// the agent's state as its row keeps it.
    #[must_use]
    pub fn agent_state(&self, key: &str) -> Option<String> {
        let at = self.agents.iter().position(|a| a.key == key)?;
        let prefix = format!("{key}:");
        let mut statuses: Vec<(String, StatusState)> = self
            .statuses
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix) && !self.sessions.contains_key(*k))
            .map(|(k, s)| (k.clone(), StatusState::of(s)))
            .collect();
        statuses.sort_by(|a, b| a.0.cmp(&b.0));
        json(&AgentState {
            at,
            agent: self.agents[at].clone(),
            floors: self
                .floors
                .get(key)
                .map(|f| [f.sessions, f.statuses, f.permissions, f.questions]),
            epoch: self.epochs.get(key).cloned(),
            applied: self.applied.get(key).copied(),
            statuses,
        })
    }

    /// an open ask's state as its row keeps it.
    #[must_use]
    pub fn ask_state(&self, agent: &str, id: &str) -> Option<String> {
        let pending = self.asks.get(&(agent.to_owned(), id.to_owned()))?;
        json(&AskState {
            ask: (*pending.neutral).clone(),
            serial: pending.serial,
        })
    }

    /// the order and the arrival counter, as their row keeps them.
    #[must_use]
    pub fn order_state(&self) -> Option<String> {
        let mut arms: Vec<(String, Arm)> = self
            .arms
            .iter()
            .map(|(id, a)| {
                (
                    id.clone(),
                    Arm {
                        key: a.key.clone(),
                        device: a.device.clone(),
                        at: a.at,
                    },
                )
            })
            .collect();
        arms.sort_by(|a, b| a.0.cmp(&b.0));
        let mut answering: Vec<_> = self
            .answering
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        answering.sort_by(|a, b| a.0.cmp(&b.0));
        let mut own: Vec<(String, i64)> = self.own.iter().map(|(k, v)| (k.clone(), *v)).collect();
        own.sort();
        json(&OrderState {
            order: self.order.clone(),
            serial: self.serial,
            arms,
            answering,
            own,
        })
    }

    /// what the model's own tables hold (needs, read marks, clears, colours,
    /// adopted infos), moved from another model: a replay's restart, where
    /// the store that keeps them across a real one is not running.
    #[cfg(test)]
    pub fn carry_tables(&mut self, from: &mut Model) {
        self.needs = std::mem::take(&mut from.needs);
        self.reads = std::mem::take(&mut from.reads);
        self.clears = std::mem::take(&mut from.clears);
        self.colours = std::mem::take(&mut from.colours);
        self.restored = std::mem::take(&mut from.restored);
    }

    /// whether a window's tail read is out: it is not kept across a
    /// restart, so a replay restarts only where none is.
    #[cfg(test)]
    #[must_use]
    pub fn tail_reads_out(&self) -> bool {
        self.sessions
            .values()
            .any(|s| matches!(s.tail.hydration, Hydration::Asked { .. }))
    }

    /// every key the model holds a row for: threads, agents and open asks
    /// (as `(agent, id)`).
    #[must_use]
    pub fn held_keys(&self) -> (Vec<String>, Vec<String>, Vec<(String, String)>) {
        (
            self.sessions.keys().cloned().collect(),
            self.agents.iter().map(|a| a.key.clone()).collect(),
            self.asks.keys().cloned().collect(),
        )
    }

    /// rebuilds the model from its rows. answers how many rows did not
    /// decode (each is logged); a thread that does not decode is not held:
    /// the start drops its host's cursor (`Rows::broken`), so the host is
    /// read again and the thread comes back, reset.
    #[allow(clippy::too_many_lines, reason = "one pass per kind of row")]
    pub fn resume(&mut self, rows: Rows) -> usize {
        let mut broken = 0;
        let mut adopted = Vec::new();
        for (key, text, srev) in rows.threads {
            let state: ThreadState = match serde_json::from_str(&text) {
                Ok(state) => state,
                Err(error) => {
                    tracing::error!(session = key, %error, "a kept thread state does not decode; it is not held");
                    broken += 1;
                    continue;
                }
            };
            if let Some(status) = state.status.and_then(StatusState::status) {
                self.statuses.insert(key.clone(), status);
            }
            if state.held {
                self.held.insert(key.clone());
            }
            if state.adopted {
                adopted.push(key.clone());
            }
            if let Some(rev) = state.newest {
                self.newest.insert(key.clone(), rev);
            }
            if let Some(rev) = state.unseen {
                self.unseen.insert(key.clone(), rev);
            }
            let session = Session {
                host: state.host,
                id: state.id,
                thread: state.thread,
                updated: state.updated,
                parent: state.parent,
                directory: state.directory,
                repo: state.repo,
                places: state.places,
                tail: Tail {
                    items: state.items,
                    said: state.said.into(),
                    sent: state.sent,
                    hydration: state
                        .floor
                        .map_or(Hydration::Unread, |floor| Hydration::Read { floor }),
                },
                turn: state.turn,
                // the column is the row's word on it
                srev: srev.or(state.srev),
            };
            self.sessions.insert(key, session);
        }
        let mut agents = Vec::new();
        for (_, text) in rows.agents {
            let state: AgentState = match serde_json::from_str(&text) {
                Ok(state) => state,
                Err(error) => {
                    tracing::error!(%error, "a kept agent state does not decode; it is read again");
                    broken += 1;
                    continue;
                }
            };
            let key = state.agent.key.clone();
            if let Some([sessions, statuses, permissions, questions]) = state.floors {
                self.floors.insert(
                    key.clone(),
                    Floors {
                        sessions,
                        statuses,
                        permissions,
                        questions,
                    },
                );
            }
            if let Some(epoch) = state.epoch {
                self.epochs.insert(key.clone(), epoch);
            }
            if let Some(applied) = state.applied {
                self.applied.insert(key.clone(), applied);
            }
            for (session, status) in state.statuses {
                if let Some(status) = status.status() {
                    self.statuses.insert(session, status);
                }
            }
            agents.push((state.at, state.agent));
        }
        agents.sort_by_key(|(at, _)| *at);
        self.agents = agents.into_iter().map(|(_, agent)| agent).collect();
        let mut serial = 0;
        for (_, text) in rows.asks {
            let state: AskState = match serde_json::from_str(&text) {
                Ok(state) => state,
                Err(error) => {
                    tracing::error!(%error, "a kept ask state does not decode; its host's next read raises it again");
                    broken += 1;
                    continue;
                }
            };
            serial = serial.max(state.serial);
            self.asks.insert(
                (state.ask.agent.clone(), state.ask.id.clone()),
                Pending {
                    neutral: Box::new(state.ask),
                    serial: state.serial,
                },
            );
        }
        if let Some(text) = rows.order {
            match serde_json::from_str::<OrderState>(&text) {
                Ok(state) => {
                    self.order = state.order;
                    serial = serial.max(state.serial);
                    self.arms = state.arms.into_iter().collect();
                    self.answering = state.answering.into_iter().collect();
                    self.own = state.own.into_iter().collect();
                }
                Err(error) => {
                    tracing::error!(%error, "the kept order does not decode; the next change orders again");
                    broken += 1;
                }
            }
        }
        self.serial = self.serial.max(serial);
        // the adopted threads come back in the order the store kept them, newest last
        let kept: HashMap<String, usize> = self
            .restored
            .iter()
            .enumerate()
            .map(|(at, (key, _))| (key.clone(), at))
            .collect();
        adopted.sort_by_key(|key| kept.get(key).copied().unwrap_or(usize::MAX));
        self.restored
            .retain(|(key, _)| !self.sessions.contains_key(key));
        self.adopted = adopted;
        broken
    }
}
