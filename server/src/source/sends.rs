//! sends that must never run twice (`docs/agents.md`, section 7, sends).
//!
//! every prompt, steer, queued prompt and new thread on contract 2 goes
//! through this ledger, keyed by agent and client id, before it reaches a
//! source. the first request with a client id calls the source; one that
//! arrives while it runs waits for its answer and shares it; one that
//! arrives after an answer that may have reached the agent is answered
//! from the ledger and never calls the source again. only an answer that
//! proves nothing reached the agent (a refusal, a 422, a busy source, a
//! daemon that could not be reached and dedupes retries itself) forgets
//! the client id, so the outbox's retry is safe.
//!
//! a source whose acknowledgement was lost answers `checking`, keeps
//! reading the agent's receipts, and settles the send with `resolve`. a
//! send still unsettled 30 minutes after its answer, or pushed out by the
//! cap, ends `uncertain`: a client shows it as not confirmed, and a retry
//! with the same client id is refused (409 `not-confirmed`), because the
//! old one may have landed. sending again is the person's call, with a new
//! client id.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, watch};
use tracing::{info, warn};

use super::{SendOutcome, SourceEvent, VerbError};
use crate::fleet::Upstream;
use crate::wire::{Accepted, AcceptedState, Born, SendStateKind};

/// sends kept per connection (`agents.md`, buffers and caps).
pub const KEPT: usize = 256;
/// how long a send may stay unsettled before it ends uncertain.
pub const RECONCILE: Duration = Duration::from_secs(30 * 60);
/// client ids pushed out by the cap, kept so a retry of one is refused
/// rather than sent again (about 100 bytes each).
pub const TOMBSTONES: usize = 4096;
/// how long a route waits for a source's answer before it answers
/// `checking` (never for cmx2, whose repeat key makes a retry safe).
pub const ANSWER_WITHIN: Duration = Duration::from_secs(10);

/// what a source answered a send with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Accepted(Accepted),
    Born(Born),
}

/// what the ledger knows of a send that already had its answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Known {
    /// the source's answer; an `Accepted` with `checking` is still being
    /// reconciled.
    Answered(Answer),
    /// no receipt proves it landed or did not: never sent again.
    Uncertain,
    /// the agent cancelled it, or refused it after the client was told
    /// `checking`.
    Cancelled,
}

impl Known {
    /// the answer a retry with the same client id gets.
    ///
    /// # Errors
    /// `NotConfirmed` for a send that ended uncertain or cancelled.
    pub fn answer(&self) -> Result<Answer, VerbError> {
        match self {
            Self::Answered(answer) => Ok(answer.clone()),
            Self::Uncertain | Self::Cancelled => Err(VerbError::NotConfirmed),
        }
    }

    fn checking(&self) -> bool {
        matches!(
            self,
            Self::Answered(Answer::Accepted(Accepted {
                state: AcceptedState::Checking,
                ..
            }))
        )
    }
}

/// what `claim` found.
#[derive(Debug)]
pub enum Claim {
    /// no send with this client id: call the source, then `settle`.
    Go(Ticket),
    /// one is running: wait for its answer.
    Waiting(Waiter),
    /// it had its answer already.
    Known(Known),
}

type Key = (Arc<str>, String);

#[derive(Debug)]
struct Entry {
    connection: Arc<str>,
    thread: String,
    state: State,
    /// when the answer came (or the call started, while in flight).
    since: Instant,
    /// the route answered `checking` before the source answered.
    told_checking: bool,
}

#[derive(Debug)]
enum State {
    InFlight(watch::Receiver<Option<Known>>),
    Known(Known),
}

#[derive(Debug, Default)]
struct Ledger {
    entries: HashMap<Key, Entry>,
    /// oldest first; a key leaves when its entry does.
    order: VecDeque<Key>,
    /// keys the cap pushed out, oldest first: a retry of one is refused.
    tombstones: VecDeque<Key>,
}

impl Ledger {
    fn remove(&mut self, key: &Key) -> Option<Entry> {
        let entry = self.entries.remove(key)?;
        self.order.retain(|k| k != key);
        Some(entry)
    }
}

/// one event the ledger owes the fleet: a send's state on its thread.
#[derive(Debug)]
struct Owed {
    connection: Arc<str>,
    agent: Arc<str>,
    thread: String,
    client_id: String,
    state: SendStateKind,
}

/// the ledger. cheap to clone; every clone shares it.
#[derive(Debug, Clone)]
pub struct Sends {
    ledger: Arc<Mutex<Ledger>>,
    fleet: mpsc::Sender<Upstream>,
    reconcile: Duration,
    answer_within: Duration,
}

impl Sends {
    #[must_use]
    pub fn new(fleet: mpsc::Sender<Upstream>) -> Self {
        Self::with_reconcile(fleet, RECONCILE)
    }

    /// the same, with sends ending uncertain after `reconcile` (the tests
    /// make it short).
    #[must_use]
    pub fn with_reconcile(fleet: mpsc::Sender<Upstream>, reconcile: Duration) -> Self {
        Self::with_timing(fleet, reconcile, ANSWER_WITHIN)
    }

    /// the same, with a route answering `checking` after `answer_within`.
    #[must_use]
    pub fn with_timing(
        fleet: mpsc::Sender<Upstream>,
        reconcile: Duration,
        answer_within: Duration,
    ) -> Self {
        Self {
            ledger: Arc::new(Mutex::new(Ledger::default())),
            fleet,
            reconcile,
            answer_within,
        }
    }

    /// how long a route waits for a source that does not dedupe retries
    /// before it answers `checking`.
    #[must_use]
    pub fn answer_within(&self) -> Duration {
        self.answer_within
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Ledger> {
        // a panic while holding the lock leaves whole entries behind: every
        // change below is one insert or one remove
        self.ledger.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// takes the client id for one send to `thread` of `agent`, or says what
    /// already happened to it.
    pub async fn claim(
        &self,
        connection: &Arc<str>,
        agent: &Arc<str>,
        thread: &str,
        client_id: &str,
    ) -> Claim {
        let (claim, owed) = {
            let mut ledger = self.lock();
            let owed = self.sweep(&mut ledger, connection);
            let key: Key = (Arc::clone(agent), client_id.to_owned());
            let claim = if ledger.tombstones.contains(&key) {
                Claim::Known(Known::Uncertain)
            } else {
                match ledger.entries.get(&key).map(|e| &e.state) {
                    Some(State::Known(known)) => Claim::Known(known.clone()),
                    Some(State::InFlight(answer)) => Claim::Waiting(Waiter {
                        answer: answer.clone(),
                    }),
                    None => {
                        let (sender, receiver) = watch::channel(None);
                        ledger.entries.insert(
                            key.clone(),
                            Entry {
                                connection: Arc::clone(connection),
                                thread: thread.to_owned(),
                                state: State::InFlight(receiver),
                                since: Instant::now(),
                                told_checking: false,
                            },
                        );
                        ledger.order.push_back(key.clone());
                        Claim::Go(Ticket {
                            sends: self.clone(),
                            key: Some(key),
                            answer: sender,
                        })
                    }
                }
            };
            (claim, owed)
        };
        self.owe(owed).await;
        claim
    }

    /// the route answered `checking` because the source had not answered
    /// within `ANSWER_WITHIN`: the thread shows the send as checking until
    /// the source answers. answers false when the send already had its
    /// answer (the route then gives that one instead).
    pub async fn told_checking(&self, agent: &Arc<str>, client_id: &str) -> bool {
        let owed = {
            let mut ledger = self.lock();
            let key: Key = (Arc::clone(agent), client_id.to_owned());
            match ledger.entries.get_mut(&key) {
                Some(entry) if matches!(entry.state, State::InFlight(_)) => {
                    if entry.told_checking {
                        return true;
                    }
                    entry.told_checking = true;
                    entry.since = Instant::now();
                    vec![Owed {
                        connection: Arc::clone(&entry.connection),
                        agent: Arc::clone(agent),
                        thread: entry.thread.clone(),
                        client_id: client_id.to_owned(),
                        state: SendStateKind::Checking,
                    }]
                }
                _ => return false,
            }
        };
        self.owe(owed).await;
        true
    }

    /// a source settles a send it answered `checking` for: landed (its user
    /// message arrived), cancelled, or uncertain. the source sends the
    /// thread's `Send` event itself; this only moves what a retry gets.
    pub fn resolve(&self, agent: &Arc<str>, client_id: &str, outcome: SendOutcome) {
        let mut ledger = self.lock();
        let key: Key = (Arc::clone(agent), client_id.to_owned());
        // a send still running settles through its ticket; only one that had
        // its answer (`checking`) is the source's to resolve
        let Some(entry) = ledger
            .entries
            .get_mut(&key)
            .filter(|e| matches!(e.state, State::Known(_)))
        else {
            return;
        };
        entry.state = State::Known(match outcome {
            SendOutcome::Landed => Known::Answered(Answer::Accepted(Accepted {
                state: AcceptedState::Accepted,
                message: None,
            })),
            SendOutcome::Pending(SendStateKind::Uncertain) => Known::Uncertain,
            SendOutcome::Pending(SendStateKind::Cancelled) => Known::Cancelled,
            // still checking: nothing moves
            SendOutcome::Pending(SendStateKind::Checking) => return,
        });
        entry.since = Instant::now();
    }

    /// how many sends the ledger holds for `connection` (for tests and the
    /// agents screen).
    #[must_use]
    pub fn held(&self, connection: &str) -> usize {
        self.lock()
            .entries
            .values()
            .filter(|e| &*e.connection == connection)
            .count()
    }

    /// ends sends unsettled past `reconcile` as uncertain, and makes room
    /// for one more of `connection` under the cap: its oldest send that is
    /// not running goes, ending uncertain if it was still checking.
    fn sweep(&self, ledger: &mut Ledger, connection: &Arc<str>) -> Vec<Owed> {
        let mut owed = Vec::new();
        let now = Instant::now();
        for (key, entry) in &mut ledger.entries {
            let stale = now.duration_since(entry.since) >= self.reconcile;
            let checking = match &entry.state {
                State::Known(known) => known.checking(),
                // a call that never answered after the client was told checking
                State::InFlight(_) => entry.told_checking,
            };
            if checking && stale {
                entry.state = State::Known(Known::Uncertain);
                owed.push(Owed {
                    connection: Arc::clone(&entry.connection),
                    agent: Arc::clone(&key.0),
                    thread: entry.thread.clone(),
                    client_id: key.1.clone(),
                    state: SendStateKind::Uncertain,
                });
            }
        }
        let held = ledger
            .entries
            .values()
            .filter(|e| e.connection == *connection)
            .count();
        if held >= KEPT {
            let oldest = ledger.order.iter().find(|key| {
                ledger.entries.get(*key).is_some_and(|e| {
                    e.connection == *connection && matches!(e.state, State::Known(_))
                })
            });
            if let Some(key) = oldest.cloned()
                && let Some(entry) = ledger.remove(&key)
            {
                if ledger.tombstones.len() >= TOMBSTONES {
                    ledger.tombstones.pop_front();
                }
                ledger.tombstones.push_back(key.clone());
                let State::Known(known) = &entry.state else {
                    return owed;
                };
                if !known.checking() {
                    return owed;
                }
                warn!(connection = %connection, agent = %key.0, "a send still being checked was pushed out of the ledger; it ends uncertain");
                owed.push(Owed {
                    connection: entry.connection,
                    agent: key.0,
                    thread: entry.thread,
                    client_id: key.1,
                    state: SendStateKind::Uncertain,
                });
            }
        }
        owed
    }

    async fn owe(&self, owed: Vec<Owed>) {
        // a new thread's send has no thread until it is born: nothing to show it on
        for owed in owed.into_iter().filter(|o| !o.thread.is_empty()) {
            let event = Upstream::Source {
                connection: owed.connection,
                agent: owed.agent,
                seq: None,
                event: SourceEvent::Send {
                    thread: owed.thread,
                    client_id: owed.client_id,
                    state: SendOutcome::Pending(owed.state),
                },
                raw: None,
            };
            // a stopped fleet is a server going down; the send's state goes with it
            let _ = self.fleet.send(event).await;
        }
    }
}

/// the right to call the source for one send. dropped without `settle`
/// (the call failed before reaching the agent, or panicked), it forgets the
/// client id so a retry may call again.
#[derive(Debug)]
pub struct Ticket {
    sends: Sends,
    key: Option<Key>,
    answer: watch::Sender<Option<Known>>,
}

impl Ticket {
    /// records the source's answer. an answer that may have reached the
    /// agent is kept, so no retry calls again; a failure that proves
    /// nothing reached it forgets the client id, unless the client was
    /// already told `checking`, in which case the send ends cancelled (a
    /// refusal) or uncertain (no answer).
    pub async fn settle(mut self, answered: &Result<Answer, VerbError>) {
        let Some(key) = self.key.take() else { return };
        let (known, owed) = {
            let mut ledger = self.sends.lock();
            let Some(entry) = ledger.entries.get_mut(&key) else {
                return;
            };
            let known = match answered {
                Ok(answer) => Some(Known::Answered(answer.clone())),
                Err(VerbError::Unreachable { .. }) if entry.told_checking => Some(Known::Uncertain),
                Err(_) if entry.told_checking => Some(Known::Cancelled),
                Err(_) => None,
            };
            if let Some(known) = &known {
                {
                    entry.state = State::Known(known.clone());
                    entry.since = Instant::now();
                    let owed = (entry.told_checking
                        && matches!(known, Known::Uncertain | Known::Cancelled))
                    .then(|| Owed {
                        connection: Arc::clone(&entry.connection),
                        agent: Arc::clone(&key.0),
                        thread: entry.thread.clone(),
                        client_id: key.1.clone(),
                        state: if matches!(known, Known::Uncertain) {
                            SendStateKind::Uncertain
                        } else {
                            SendStateKind::Cancelled
                        },
                    });
                    (Some(known.clone()), owed)
                }
            } else {
                ledger.remove(&key);
                (None, None)
            }
        };
        if let Some(Known::Uncertain | Known::Cancelled) = &known {
            info!(agent = %key.0, "a send the client was told is checking ended without proof it landed");
        }
        // waiters see the answer; a forgotten send wakes them to claim again
        let _ = self.answer.send(known);
        self.sends.owe(owed.into_iter().collect()).await;
    }
}

impl Ticket {
    /// the call failed in a way that proves nothing either way (it
    /// panicked inside the server): the send ends uncertain, never sent again.
    pub async fn uncertain(mut self) {
        let Some(key) = self.key.take() else { return };
        let owed = {
            let mut ledger = self.sends.lock();
            let Some(entry) = ledger.entries.get_mut(&key) else {
                return;
            };
            entry.state = State::Known(Known::Uncertain);
            entry.since = Instant::now();
            Owed {
                connection: Arc::clone(&entry.connection),
                agent: Arc::clone(&key.0),
                thread: entry.thread.clone(),
                client_id: key.1.clone(),
                state: SendStateKind::Uncertain,
            }
        };
        let _ = self.answer.send(Some(Known::Uncertain));
        self.sends.owe(vec![owed]).await;
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.sends.lock().remove(&key);
            let _ = self.answer.send(None);
        }
    }
}

/// a send that is running under the same client id.
#[derive(Debug)]
pub struct Waiter {
    answer: watch::Receiver<Option<Known>>,
}

impl Waiter {
    /// its answer; none when it was forgotten (nothing reached the agent),
    /// so the caller claims again.
    pub async fn wait(mut self) -> Option<Known> {
        loop {
            if let Some(known) = self.answer.borrow_and_update().clone() {
                return Some(known);
            }
            if self.answer.changed().await.is_err() {
                return self.answer.borrow().clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepted() -> Answer {
        Answer::Accepted(Accepted {
            state: AcceptedState::Accepted,
            message: Some("msg_1".into()),
        })
    }

    fn checking() -> Answer {
        Answer::Accepted(Accepted {
            state: AcceptedState::Checking,
            message: None,
        })
    }

    fn names() -> (Arc<str>, Arc<str>) {
        (Arc::from("vm-b"), Arc::from("assistant"))
    }

    async fn go(sends: &Sends, id: &str) -> Ticket {
        let (connection, agent) = names();
        match sends.claim(&connection, &agent, "oc_t", id).await {
            Claim::Go(ticket) => ticket,
            other => panic!("expected to go, got {other:?}"),
        }
    }

    async fn known(sends: &Sends, id: &str) -> Known {
        let (connection, agent) = names();
        match sends.claim(&connection, &agent, "oc_t", id).await {
            Claim::Known(known) => known,
            other => panic!("expected known, got {other:?}"),
        }
    }

    fn send_events(events: &mut mpsc::Receiver<Upstream>) -> Vec<(String, SendOutcome)> {
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let Upstream::Source {
                event:
                    SourceEvent::Send {
                        client_id, state, ..
                    },
                ..
            } = event
            {
                seen.push((client_id, state));
            }
        }
        seen
    }

    #[tokio::test]
    async fn an_accepted_send_is_answered_from_the_ledger_and_never_called_twice() {
        let sends = Sends::new(mpsc::channel(8).0);
        go(&sends, "c1").await.settle(&Ok(accepted())).await;
        assert_eq!(known(&sends, "c1").await, Known::Answered(accepted()));
    }

    #[tokio::test]
    async fn a_refusal_forgets_the_client_id_so_the_retry_calls_again() {
        let sends = Sends::new(mpsc::channel(8).0);
        go(&sends, "c1").await.settle(&Err(VerbError::Busy)).await;
        go(&sends, "c1").await;
        // and a ticket dropped mid call forgets it too
        let (connection, agent) = names();
        assert!(matches!(
            sends.claim(&connection, &agent, "oc_t", "c1").await,
            Claim::Go(_)
        ));
    }

    #[tokio::test]
    async fn a_retry_while_the_first_runs_shares_its_answer() {
        let sends = Sends::new(mpsc::channel(8).0);
        let first = go(&sends, "c1").await;
        let (connection, agent) = names();
        let Claim::Waiting(waiter) = sends.claim(&connection, &agent, "oc_t", "c1").await else {
            panic!("the second should wait");
        };
        let waiting = tokio::spawn(waiter.wait());
        first.settle(&Ok(accepted())).await;
        assert_eq!(waiting.await.unwrap(), Some(Known::Answered(accepted())));
    }

    #[tokio::test]
    async fn a_checking_send_unsettled_past_its_window_ends_uncertain_and_is_refused() {
        let (fleet, mut events) = mpsc::channel(8);
        let sends = Sends::with_reconcile(fleet, Duration::from_millis(20));
        go(&sends, "c1").await.settle(&Ok(checking())).await;
        assert_eq!(known(&sends, "c1").await, Known::Answered(checking()));
        tokio::time::sleep(Duration::from_millis(30)).await;
        let after = known(&sends, "c1").await;
        assert_eq!(after, Known::Uncertain);
        assert!(matches!(after.answer(), Err(VerbError::NotConfirmed)));
        assert_eq!(
            send_events(&mut events),
            vec![(
                "c1".to_owned(),
                SendOutcome::Pending(SendStateKind::Uncertain)
            )]
        );
    }

    #[tokio::test]
    async fn a_source_resolves_a_checking_send_and_the_retry_hears_it() {
        let sends = Sends::new(mpsc::channel(8).0);
        let (_, agent) = names();
        go(&sends, "c1").await.settle(&Ok(checking())).await;
        sends.resolve(&agent, "c1", SendOutcome::Landed);
        assert!(known(&sends, "c1").await.answer().is_ok());
        go(&sends, "c2").await.settle(&Ok(checking())).await;
        sends.resolve(&agent, "c2", SendOutcome::Pending(SendStateKind::Cancelled));
        assert_eq!(known(&sends, "c2").await, Known::Cancelled);
    }

    #[tokio::test]
    async fn a_send_the_client_was_told_is_checking_never_forgets_on_failure() {
        let (fleet, mut events) = mpsc::channel(8);
        let sends = Sends::new(fleet);
        let (_, agent) = names();
        let ticket = go(&sends, "c1").await;
        sends.told_checking(&agent, "c1").await;
        ticket
            .settle(&Err(VerbError::Unreachable {
                reason: "socket closed".into(),
            }))
            .await;
        assert_eq!(known(&sends, "c1").await, Known::Uncertain);
        let ticket = go(&sends, "c2").await;
        sends.told_checking(&agent, "c2").await;
        ticket
            .settle(&Err(VerbError::Refused {
                status: 400,
                words: "no".into(),
            }))
            .await;
        assert_eq!(known(&sends, "c2").await, Known::Cancelled);
        let states: Vec<SendStateKind> = send_events(&mut events)
            .into_iter()
            .filter_map(|(_, s)| match s {
                SendOutcome::Pending(kind) => Some(kind),
                SendOutcome::Landed => None,
            })
            .collect();
        assert_eq!(
            states,
            vec![
                SendStateKind::Checking,
                SendStateKind::Uncertain,
                SendStateKind::Checking,
                SendStateKind::Cancelled
            ]
        );
    }

    #[tokio::test]
    async fn the_cap_pushes_out_the_oldest_settled_send_and_a_checking_one_ends_uncertain() {
        let (fleet, mut events) = mpsc::channel(8);
        let sends = Sends::new(fleet);
        go(&sends, "c0").await.settle(&Ok(checking())).await;
        for n in 1..KEPT {
            go(&sends, &format!("c{n}"))
                .await
                .settle(&Ok(accepted()))
                .await;
        }
        assert_eq!(sends.held("vm-b"), KEPT);
        go(&sends, "one-more").await.settle(&Ok(accepted())).await;
        assert_eq!(sends.held("vm-b"), KEPT);
        // a retry of the send pushed out is refused, never sent again
        assert_eq!(known(&sends, "c0").await, Known::Uncertain);
        assert_eq!(
            send_events(&mut events),
            vec![(
                "c0".to_owned(),
                SendOutcome::Pending(SendStateKind::Uncertain)
            )]
        );
    }

    #[tokio::test]
    async fn a_source_cannot_resolve_a_send_still_running() {
        let sends = Sends::new(mpsc::channel(8).0);
        let (connection, agent) = names();
        let ticket = go(&sends, "c1").await;
        sends.resolve(&agent, "c1", SendOutcome::Landed);
        assert!(matches!(
            sends.claim(&connection, &agent, "oc_t", "c1").await,
            Claim::Waiting(_)
        ));
        ticket.settle(&Ok(accepted())).await;
        assert_eq!(known(&sends, "c1").await, Known::Answered(accepted()));
    }

    #[tokio::test]
    async fn a_call_that_never_answers_after_checking_ends_uncertain_in_its_window() {
        let (fleet, mut events) = mpsc::channel(8);
        let sends = Sends::with_reconcile(fleet, Duration::from_millis(20));
        let (_, agent) = names();
        let _hung = go(&sends, "c1").await;
        assert!(sends.told_checking(&agent, "c1").await);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(known(&sends, "c1").await, Known::Uncertain);
        let states: Vec<SendOutcome> = send_events(&mut events)
            .into_iter()
            .map(|(_, s)| s)
            .collect();
        assert_eq!(
            states,
            vec![
                SendOutcome::Pending(SendStateKind::Checking),
                SendOutcome::Pending(SendStateKind::Uncertain)
            ]
        );
    }

    #[tokio::test]
    async fn a_send_that_panicked_ends_uncertain_and_its_waiters_hear_it() {
        let sends = Sends::new(mpsc::channel(8).0);
        let (connection, agent) = names();
        let ticket = go(&sends, "c1").await;
        let Claim::Waiting(waiter) = sends.claim(&connection, &agent, "oc_t", "c1").await else {
            panic!("the second should wait");
        };
        ticket.uncertain().await;
        assert_eq!(waiter.wait().await, Some(Known::Uncertain));
        assert_eq!(known(&sends, "c1").await, Known::Uncertain);
        // told checking after it already had its answer: the route gives that answer
        assert!(!sends.told_checking(&agent, "c1").await);
    }
}
