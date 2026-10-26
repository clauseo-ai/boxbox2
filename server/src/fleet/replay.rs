//! the replay harness: a recorded tape (`tape.rs`) fed back through the
//! fleet actor, on the recorded clock, with no daemon and no network.
//!
//! **the one entry point for recorded upstream frames is
//! [`Replay::upstream`].** every cmx2 input on the tape (an event frame, a
//! host read, a tail read, a host status) becomes a `fleet::Upstream` there
//! and goes to `Actor::upstream`, the same call the watchers' messages reach
//! in a live server. after the seam (docs/agents.md, section 4) cmx2's
//! frames enter through the cmx2 source instead; the seam moves this one
//! function to feed the source, and nothing else here changes.
//!
//! commands, presence and the tail clock enter the way they do live:
//! `Actor::command`, `Actor::looking`, `Actor::flush_tails`. each step runs
//! with `crate::now_ms` pinned to the clock it was recorded at
//! (`crate::test_clock`), so tails that flush on time flush at the same
//! step. the tail reader is not running: a requested read is dropped here,
//! because its answer is on the tape as the `tailRead` step that followed.
//!
//! what a query answered is kept in `answers`, in tape order, so a test can
//! hold it against what the live server sent the bench.

use bytes::Bytes;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot};

use std::sync::Arc;

use super::model::TailRequest;
use super::tape::{self, Input, Step};
use super::{Actor, Command, From, Outside, TAIL_REQUESTS, Upstream};
use crate::journal::{Cursor, Journal};
use crate::push::presence::Looking;
use crate::push::{Asked, Captured, Push};
use crate::source::cmx2::{self, translate};
use crate::source::{SourceEvent, SourceSender, Stamp};
use crate::upstream::reconcile::{HostRead, Stamped};

/// the tail cadence the bench's tape was recorded at, before the home
/// overview's pace moved to `model::TAIL_EVERY_MS`. a replay at today's pace
/// flushes a held tail at the first recorded flush or change past it, so its
/// journal differs from the recording only in when session entries go out.
pub const RECORDED_TAIL_EVERY_MS: i64 = 200;

/// what one query answered.
#[derive(Debug)]
pub enum Answer {
    /// the first frames of a client stream the bench opened: `stream` is
    /// the id it logs under. (the bench's later page requests are gone with
    /// paging: a stream opens in one step.)
    Page { stream: u32, frames: Vec<Bytes> },
    /// `GET /api/fleet`'s body.
    Snapshot(Bytes),
    /// `GET /api/needs`'s body and its `x-boxbox-seq`.
    Needs { body: Vec<u8>, seq: String },
}

/// what the fleet asked push to do at one step, and that step's clock.
#[derive(Debug)]
pub struct Pushed {
    pub at: i64,
    pub asked: Asked,
}

#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("step {step}: {what}")]
    Step { step: usize, what: String },
}

/// the home prefs the recordings were made under: a job notice was a need
/// then, in the badge and the order.
fn recorded_home() -> crate::prefs::HomePrefs {
    crate::prefs::HomePrefs {
        jobs_as_needs: true,
        ..crate::prefs::HomePrefs::default()
    }
}

pub struct Replay {
    actor: Actor,
    tails: mpsc::Receiver<TailRequest>,
    push: Captured,
    pub answers: Vec<Answer>,
    pub pushed: Vec<Pushed>,
    steps: usize,
}

impl Replay {
    /// an actor as a fresh server from before repo colours started one (the
    /// recording predates them, so this one gives none) and before job notices
    /// stopped counting as needs (decision 95: the recorded order ranks them),
    /// with an empty store, a journal
    /// of `epoch` (the recorded one, so recorded cursors mean what they meant)
    /// and `build` for `hello`.
    pub fn new(epoch: &str, build: &str) -> Self {
        Self::with_journal(Journal::new(epoch.to_owned()), build)
    }

    /// the same with a journal of other caps, to see a resume that reaches
    /// past what the ring holds.
    pub fn with_journal(journal: Journal, build: &str) -> Self {
        let (tails_tx, tails) = mpsc::channel(TAIL_REQUESTS);
        let (push, captured) = Push::capturing(1 << 16);
        let mut model = super::Model::new();
        model.set_home(recorded_home());
        let actor = Actor {
            model,
            journal,
            encoder: super::Encoder::new(),
            keys: super::StreamKeys::new(),
            live: Vec::new(),
            board: None,
            build: build.to_owned(),
            tails: tails_tx,
            outside: Outside {
                push,
                telemetry: crate::telemetry::Sender::detached(),
                persist: mpsc::channel(1).0,
                ack: None,
            },
            persist: super::persist::Persist::detached(),
            cursors: std::collections::HashMap::new(),
            unasked: Vec::new(),
            away: Vec::new(),
            next_sweep: tokio::time::Instant::now(),
            sweep_every: std::time::Duration::from_secs(300),
        };
        Self {
            actor,
            tails,
            push: captured,
            answers: Vec::new(),
            pushed: Vec::new(),
            steps: 0,
        }
    }

    /// the same, flushing held tails at the cadence the tape was recorded
    /// at (`RECORDED_TAIL_EVERY_MS`), so what it journals can be held against
    /// what the live server sent.
    #[must_use]
    pub fn at_recorded_pace(mut self) -> Self {
        self.actor.model.set_tail_every(RECORDED_TAIL_EVERY_MS);
        self
    }

    /// the same, giving repos colours as a fresh server does now: what the
    /// recording would have journaled with them.
    pub fn colouring(epoch: &str, build: &str) -> Self {
        let mut replay = Self::new(epoch, build);
        replay.actor.model = super::Model::restored(
            super::Needs::default(),
            super::Reads::default(),
            super::Clears::default(),
            Vec::new(),
            super::Colours::assigning(),
        );
        replay.actor.model.set_home(recorded_home());
        replay
    }

    /// runs one recorded step on its recorded clock.
    ///
    /// # Errors
    /// the step's recorded wire does not decode the way it did live.
    pub fn step(&mut self, step: Step) -> Result<(), ReplayError> {
        let index = self.steps;
        self.steps += 1;
        // the actor's clock fires for text deltas due before this step, each at its time
        self.flush_deltas(step.at);
        crate::test_clock::set(Some(step.at));
        let fail = |what: String| ReplayError::Step { step: index, what };
        match step.input {
            Input::FlushTails => self.actor.flush_tails(),
            Input::Sweep => {
                self.actor.sweep(step.at);
            }
            Input::Looking(devices) => self.actor.looking(
                devices
                    .into_iter()
                    .map(|d| Looking {
                        device: d.device,
                        class: d.class,
                        thread: d.thread,
                        until: d.until,
                    })
                    .collect(),
            ),
            Input::Command(command) => self.command(command).map_err(fail)?,
            upstream => self.upstream(upstream).map_err(fail)?,
        }
        // the reader is not running; the read's answer is a later step
        while self.tails.try_recv().is_ok() {}
        for asked in self.push.take() {
            self.pushed.push(Pushed { at: step.at, asked });
        }
        crate::test_clock::set(None);
        Ok(())
    }

    /// **where recorded upstream frames enter the fleet pipeline**: through
    /// the cmx2 source, whose translation turns each into the `SourceEvent`
    /// its watcher, reconcile and tail reader send live.
    fn upstream(&mut self, input: Input) -> Result<(), String> {
        // the agent and its connection are the host, as for every cmx2 source
        let source = |host: &str| -> (SourceSender, Arc<str>) {
            let name: Arc<str> = Arc::from(host);
            (
                SourceSender::new(Arc::clone(&name), mpsc::channel(1).0),
                name,
            )
        };
        let message = match input {
            Input::Host(status) => {
                let (sender, agent) = source(&status.name);
                sender.envelope(
                    &agent,
                    None,
                    SourceEvent::Connection(translate::connection(*status)),
                )
            }
            Input::HostRemoved(host) => Upstream::HostRemoved(host),
            Input::HostRead(read) => {
                let read = *read;
                let (sender, agent) = source(&read.host);
                let snapshot = translate::snapshot(HostRead {
                    host: read.host,
                    epoch: read.epoch,
                    sessions: Stamped {
                        seq: read.sessions.seq,
                        data: read.sessions.data,
                    },
                    statuses: Stamped {
                        seq: read.statuses.seq,
                        data: read.statuses.data,
                    },
                    permissions: Stamped {
                        seq: read.permissions.seq,
                        data: read.permissions.data,
                    },
                    questions: Stamped {
                        seq: read.questions.seq,
                        data: read.questions.data,
                    },
                });
                sender.envelope(&agent, None, SourceEvent::Snapshot(Box::new(snapshot)))
            }
            Input::TailRead { key, cursor, body } => {
                let cursor =
                    Cursor::parse(&cursor).ok_or_else(|| format!("tail cursor {cursor}"))?;
                let (host, thread) = key
                    .split_once(':')
                    .ok_or_else(|| format!("tail key {key}"))?;
                let stamp = Stamp {
                    epoch: cursor.epoch,
                    seq: cursor.seq,
                };
                let read = translate::tail(thread.to_owned(), stamp, None, body.get().as_bytes())
                    .map_err(|e| format!("tail body of {key}: {e}"))?;
                let (sender, agent) = source(host);
                sender.envelope(&agent, None, SourceEvent::TailRead(Box::new(read)))
            }
            Input::TailUnread { key, reason } => {
                let (host, thread) = key
                    .split_once(':')
                    .ok_or_else(|| format!("tail key {key}"))?;
                let (sender, agent) = source(host);
                sender.envelope(
                    &agent,
                    None,
                    SourceEvent::TailUnread {
                        thread: thread.to_owned(),
                        reason,
                    },
                )
            }
            Input::Event {
                host,
                seq,
                directory,
                payload,
            } => {
                let frame = frame(directory.as_deref(), &payload)?;
                let decoded =
                    crate::cmx2::decode_frame(&frame).map_err(|e| format!("event frame: {e}"))?;
                let Some(event) = cmx2::from_frame(&host, &decoded) else {
                    return Ok(());
                };
                let (sender, agent) = source(&host);
                sender.envelope(&agent, seq, event)
            }
            Input::FlushTails | Input::Sweep | Input::Looking(_) | Input::Command(_) => {
                return Err("not an upstream input".into());
            }
        };
        self.actor.upstream(message);
        Ok(())
    }

    /// a stream's page, a snapshot or the needs: kept in `answers`.
    fn query(&mut self, query: tape::Command) -> Result<(), String> {
        match query {
            tape::Command::Read {
                from,
                first,
                stream,
            } => {
                let from = match from {
                    tape::From::Start => From::Start,
                    tape::From::Malformed => From::Malformed,
                    tape::From::At(text) => {
                        From::At(Cursor::parse(&text).ok_or_else(|| format!("cursor {text}"))?)
                    }
                };
                if !first {
                    return Ok(());
                }
                let opened = self.actor.open(&super::Opening {
                    from,
                    interest: crate::wire::Interest::default(),
                    since: std::collections::BTreeMap::new(),
                    owner: [0; 32],
                    log: stream,
                });
                self.answers.push(Answer::Page {
                    stream,
                    frames: opened.frames,
                });
            }
            tape::Command::Snapshot => {
                let (reply, mut answer) = oneshot::channel();
                self.actor.command(Command::Snapshot { reply });
                let (body, _) = answer.try_recv().map_err(|e| e.to_string())?;
                self.answers.push(Answer::Snapshot(body));
            }
            tape::Command::Needs => {
                let (reply, mut answer) = oneshot::channel();
                self.actor.command(Command::Needs { reply });
                let now = answer.try_recv().map_err(|e| e.to_string())?;
                // the route's own body type, serialized as axum's `Json` does
                let body = serde_json::to_vec(&crate::http::needs::NeedsList {
                    open: now.open,
                    served: now.served,
                })
                .map_err(|e| e.to_string())?;
                self.answers.push(Answer::Needs {
                    body,
                    seq: now.at.to_string(),
                });
            }
            _ => return Err("not a query".into()),
        }
        Ok(())
    }

    fn command(&mut self, command: tape::Command) -> Result<(), String> {
        let device = |d: tape::Device| super::Device {
            id: d.id,
            class: d.class,
        };
        match command {
            query @ (tape::Command::Read { .. }
            | tape::Command::Snapshot
            | tape::Command::Needs) => return self.query(query),
            tape::Command::Arm {
                key,
                client_id,
                device: d,
            } => self.actor.command(Command::Arm {
                key,
                client_id,
                device: device(d),
            }),
            tape::Command::Answering {
                host,
                ask,
                device: d,
            } => self.actor.command(Command::Answering {
                host,
                ask,
                device: device(d),
            }),
            tape::Command::OwnAction { key } => self.actor.command(Command::OwnAction { key }),
            tape::Command::MarkRead {
                key,
                device: d,
                message,
                at,
            } => self.actor.command(Command::MarkRead {
                key,
                device: device(d),
                message,
                at,
                reply: oneshot::channel().0,
            }),
            tape::Command::Clear { keys, device: d } => self.actor.command(Command::Clear {
                keys,
                device: device(d),
                reply: oneshot::channel().0,
            }),
            tape::Command::ClearedAmong { rows } => self.actor.command(Command::ClearedAmong {
                rows,
                reply: oneshot::channel().0,
            }),
            tape::Command::Adopt { host, info } => {
                // as the adopt route does: a read that is not a session joins nothing
                if let Ok(thread) = translate::thread_from_json(info) {
                    self.actor.command(Command::Adopt {
                        host,
                        thread: Box::new(thread),
                        reply: oneshot::channel().0,
                    });
                }
            }
            tape::Command::AdoptedKeys => self.actor.command(Command::AdoptedKeys {
                reply: oneshot::channel().0,
            }),
            tape::Command::Places { host } => self.actor.command(Command::Places {
                host,
                reply: oneshot::channel().0,
            }),
            tape::Command::Unadopt { key } => self.actor.command(Command::Unadopt { key }),
            tape::Command::Unclear { keys } => self.actor.command(Command::Unclear {
                keys,
                reply: oneshot::channel().0,
            }),
            tape::Command::AwaySeen => self.actor.command(Command::AwaySeen {
                reply: oneshot::channel().0,
            }),
            tape::Command::Home { home } => {
                let home =
                    serde_json::from_str(home.get()).map_err(|e| format!("home prefs: {e}"))?;
                self.actor.command(Command::Home {
                    home,
                    reply: oneshot::channel().0,
                });
            }
            tape::Command::ReviewTarget { key } => self.actor.command(Command::ReviewTarget {
                key,
                reply: oneshot::channel().0,
            }),
            tape::Command::ReviewAnswered { key, device: d } => {
                self.actor.command(Command::ReviewAnswered {
                    key,
                    device: device(d),
                });
            }
            tape::Command::ReviewGone { key } => self.actor.command(Command::ReviewGone { key }),
        }
        Ok(())
    }

    /// the text deltas whose 100 ms batch falls due by `at` go into the
    /// journal, each batch on its own clock, as the actor's timer sends them.
    pub fn flush_deltas(&mut self, at: i64) {
        while let Some(due) = self.actor.encoder.due() {
            if due > at {
                break;
            }
            crate::test_clock::set(Some(due));
            self.actor.flush_deltas();
        }
        crate::test_clock::set(None);
    }

    /// the whole fleet as the model holds it now.
    pub fn snapshot(&self) -> crate::wire::Fleet {
        self.actor.model.snapshot()
    }

    /// the threads whose streamed text waits for the 500 ms pace.
    pub fn held(&self) -> Vec<String> {
        self.actor.model.held().iter().cloned().collect()
    }

    /// a query asked after the tape ran out, on the clock of `at`: a stream
    /// opening from `from`, answered with its first page.
    pub fn open(&mut self, from: From, at: i64) -> Vec<Bytes> {
        self.open_with(
            from,
            crate::wire::Interest::default(),
            std::collections::BTreeMap::new(),
            at,
        )
        .frames
    }

    /// the same with an interest and its `since`, answered with the
    /// stream's first frames and its live feed.
    pub fn open_with(
        &mut self,
        from: From,
        interest: crate::wire::Interest,
        since: std::collections::BTreeMap<String, u64>,
        at: i64,
    ) -> super::Opened {
        crate::test_clock::set(Some(at));
        let opened = self.actor.open(&super::Opening {
            from,
            interest,
            since,
            owner: [0; 32],
            log: 0,
        });
        crate::test_clock::set(None);
        opened
    }

    /// an interest post for an open stream, as the route hands it to the actor.
    pub fn post(&mut self, stream: u128, post: &crate::wire::InterestPost) -> super::Confirm {
        self.actor.interest(stream, [0; 32], post)
    }

    /// tombstones below `seq` gone, as if 10,000 removals or a week had passed.
    pub fn raise_gone_floor(&mut self, seq: u64) {
        self.actor.keys.raise_floor(seq);
    }

    /// the journal's versions of a thread now.
    pub fn versions(&self, key: &str) -> Option<(u64, u64)> {
        self.actor.keys.thread(key).map(|t| (t.v, t.rv))
    }

    /// every frame the journal holds, oldest first.
    pub fn journal(&self) -> Vec<Bytes> {
        let floor = self.actor.journal.floor();
        self.actor
            .journal
            .page(floor.saturating_sub(1), usize::MAX)
            .map(|p| p.frames)
            .unwrap_or_default()
    }

    /// the frames the journal holds after `seq`, oldest first.
    pub fn journal_after(&self, seq: u64) -> Vec<Bytes> {
        self.actor
            .journal
            .page(seq, usize::MAX)
            .map(|p| p.frames)
            .unwrap_or_default()
    }

    pub fn head(&self) -> u64 {
        self.actor.journal.head()
    }

    /// a window's tail read is out (a replay restarts only where none is:
    /// its answer is a later step, which a restarted model does not wait for).
    pub fn tail_reads_out(&self) -> bool {
        self.actor.model.tail_reads_out()
    }

    /// what the actor's clock does at a clean stop: every pending delta
    /// into the journal.
    pub fn stop(&mut self, at: i64) {
        crate::test_clock::set(Some(at));
        let pending = self.actor.encoder.flush();
        self.actor.journal_all(pending);
        crate::test_clock::set(None);
    }

    /// one batch of the actor's dirty rows, committed to `connection` and
    /// answered `ok`, as the writer does every second (`persist.rs`).
    /// answers how many rows it wrote.
    pub fn persist(&mut self, connection: &mut rusqlite::Connection, clean: bool) -> usize {
        let batch = self.actor.take_batch(clean);
        let (id, rows) = (batch.id, batch.writes.len());
        super::persist::write(connection, &batch).expect("the batch commits");
        let ok = self.actor.persist.acknowledged(
            &super::persist::Ack { id, result: Ok(()) },
            std::time::Instant::now(),
        );
        assert!(ok, "the batch was in flight");
        rows
    }

    /// the actor started again from what `connection` holds, as a server
    /// restart does (`persist::start`): its streams are gone, and the tables
    /// the store keeps beside the stream (needs, marks, clears, colours)
    /// are carried over as the store would keep them.
    pub fn restart(&mut self, connection: &rusqlite::Connection) -> super::persist::Resumed {
        let stored = super::persist::load(connection).expect("the stream tables read");
        let mut resumed = super::persist::start(stored);
        let mut model = super::Model::new();
        model.carry_tables(&mut self.actor.model);
        let broken = model.resume(std::mem::take(&mut resumed.model));
        assert_eq!(broken, 0, "every kept model row decodes");
        self.actor.model = model;
        self.actor.journal = Journal::resumed(resumed.epoch.clone(), resumed.head);
        self.actor.encoder = std::mem::take(&mut resumed.encoder);
        self.actor.keys = std::mem::take(&mut resumed.keys);
        self.actor.persist = super::persist::Persist::new(resumed.reserved, resumed.graves, None);
        self.actor.cursors = std::mem::take(&mut resumed.cursors);
        self.actor.live.clear();
        self.actor.board = None;
        if resumed.rewrite {
            self.actor.mark_all();
        }
        self.actor.started(resumed.how, &resumed.broken.threads);
        // the reader is not running; a newest read asked again has no answer on the tape
        while self.tails.try_recv().is_ok() {}
        resumed
    }

    /// the tail clock fires once at `at`.
    pub fn flush_tails(&mut self, at: i64) {
        crate::test_clock::set(Some(at));
        self.actor.flush_tails();
        crate::test_clock::set(None);
    }

    /// one recorded upstream input fed again, as a source re-delivers what
    /// follows a cursor after a crash.
    ///
    /// # Errors
    /// the input is not an upstream one, or does not decode.
    pub fn redeliver(&mut self, step: &Step) -> Result<(), String> {
        let input: Input =
            serde_json::from_value(serde_json::to_value(&step.input).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        crate::test_clock::set(Some(step.at));
        let result = self.upstream(input);
        crate::test_clock::set(None);
        result
    }

    pub fn floor(&self) -> u64 {
        self.actor.journal.floor()
    }
}

/// the frame data cmx2 sent: its envelope around the raw payload.
fn frame(directory: Option<&str>, payload: &RawValue) -> Result<String, String> {
    let directory = serde_json::to_string(&directory).map_err(|e| e.to_string())?;
    Ok(format!(
        "{{\"directory\":{directory},\"payload\":{}}}",
        payload.get()
    ))
}

#[cfg(test)]
mod tests;
