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

/// what one query answered.
#[derive(Debug)]
pub enum Answer {
    /// a page of a client stream: `stream` is the id the stream logs under.
    Page {
        stream: u32,
        first: bool,
        frames: Vec<Bytes>,
    },
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

pub struct Replay {
    actor: Actor,
    tails: mpsc::Receiver<TailRequest>,
    push: Captured,
    pub answers: Vec<Answer>,
    pub pushed: Vec<Pushed>,
    steps: usize,
}

impl Replay {
    /// an actor as a fresh server starts one, with an empty store, a journal
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
        let actor = Actor {
            model: super::Model::new(),
            journal,
            live: Vec::new(),
            build: build.to_owned(),
            tails: tails_tx,
            outside: Outside {
                push,
                telemetry: crate::telemetry::Sender::detached(),
                persist: mpsc::channel(1).0,
            },
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

    /// runs one recorded step on its recorded clock.
    ///
    /// # Errors
    /// the step's recorded wire does not decode the way it did live.
    pub fn step(&mut self, step: Step) -> Result<(), ReplayError> {
        let index = self.steps;
        self.steps += 1;
        crate::test_clock::set(Some(step.at));
        let fail = |what: String| ReplayError::Step { step: index, what };
        match step.input {
            Input::FlushTails => self.actor.flush_tails(),
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
                    None,
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
                sender.envelope(
                    &agent,
                    None,
                    SourceEvent::Snapshot(Box::new(snapshot)),
                    None,
                )
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
                let read = translate::tail(thread.to_owned(), stamp, body.get().as_bytes())
                    .map_err(|e| format!("tail body of {key}: {e}"))?;
                let (sender, agent) = source(host);
                sender.envelope(&agent, None, SourceEvent::TailRead(Box::new(read)), None)
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
                    None,
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
                let Some((event, raw)) = cmx2::from_frame(&host, decoded) else {
                    return Ok(());
                };
                let (sender, agent) = source(&host);
                sender.envelope(&agent, seq, event, Some(raw))
            }
            Input::FlushTails | Input::Looking(_) | Input::Command(_) => {
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
                let (reply, mut answer) = oneshot::channel();
                self.actor.command(Command::Read {
                    from,
                    first,
                    stream,
                    reply,
                });
                let page = answer.try_recv().map_err(|e| e.to_string())?;
                self.answers.push(Answer::Page {
                    stream,
                    first,
                    frames: page.frames,
                });
            }
            tape::Command::Snapshot => {
                let (reply, mut answer) = oneshot::channel();
                self.actor.command(Command::Snapshot { reply });
                let body = answer.try_recv().map_err(|e| e.to_string())?;
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

    /// a query asked after the tape ran out, on the clock of `at`: a stream
    /// opening from `from`, answered with its first page.
    pub fn open(&mut self, from: From, at: i64) -> Vec<Bytes> {
        crate::test_clock::set(Some(at));
        let (reply, mut answer) = oneshot::channel();
        self.actor.command(Command::Read {
            from,
            first: true,
            stream: 0,
            reply,
        });
        crate::test_clock::set(None);
        answer.try_recv().map(|p| p.frames).unwrap_or_default()
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

    pub fn head(&self) -> u64 {
        self.actor.journal.head()
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
