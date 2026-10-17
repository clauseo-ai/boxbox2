//! the fleet actor: the one owner of the fleet model, the journal and the
//! list of live client streams (architecture: tasks, and who owns what).
//!
//! watchers send it decoded daemon events and fresh host reads; it applies
//! them to the model, appends each resulting change to the journal once,
//! and hands the same bytes to every live stream. client streams ask it for
//! pages of the journal after their cursor; the page that reaches the head
//! registers the stream as live in the same step, so between replay and
//! live there is no gap and no duplicate (the way cmx2 switches a resumed
//! stream to live).
//!
//! a live stream's queue is bounded by bytes, not by count: a slow phone
//! can hold at most `OUTBOUND_CAP` here, then its stream is closed and it
//! resumes from its cursor (architecture: memory caps).
//!
//! needs and read state are the model's too (`needs.rs`, `read.rs`); the
//! actor carries their consequences out: notices to push, rows to
//! telemetry, and every raise, serve and mark to `boxbox.db` through one
//! writer task, so a restart forgets nothing.
//!
//! the actor's one clock flushes window tails that streamed text moved
//! while their session's last entry was too recent to send another
//! (`model::TAIL_EVERY_MS`); it sleeps only while one is held.
//!
//! the model asks for a window's tail to be read once per session
//! (`Effect::ReadTail`); the actor queues the request for the tail reader
//! (`upstream/tails.rs`), and the read comes back as an upstream message.

pub mod adopted;
pub mod change;
pub mod clears;
pub mod model;
pub mod needs;
pub mod read;
#[cfg(feature = "record")]
pub mod record;
#[cfg(test)]
mod replay;
#[cfg(any(test, feature = "record"))]
pub mod tape;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bytes::Bytes;
use serde_json::json;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::journal::{Cursor, Gap, Journal, sse_frame};
use crate::push::presence::Looking;
use crate::push::{Push, Thread};
use crate::source::cmx2::translate;
use crate::source::{SourceEvent, ThreadFacts};
use crate::store::Store;
use change::{Change, Control, JournalEntry, PROTOCOL, ResetReason};
use clears::Clears;
use model::{ClearRefused, Device, Effect, Model, ReadRefused, ReviewTarget, TailRequest};
use needs::{Moved, Need, Needs};
use read::{Mark, Reads};

/// events waiting for the actor. when it is full a watcher waits, which
/// stops it reading its socket; cmx2 then closes that stream at its own
/// 1 mb cap and the watcher resumes from its cursor. nothing is lost and
/// nothing here grows.
const UPSTREAM_CAPACITY: usize = 1024;
/// client stream requests waiting for the actor; a stream waits its turn.
const COMMAND_CAPACITY: usize = 256;
/// bytes a live stream may have queued before it is closed.
pub const OUTBOUND_CAP: usize = 512 * 1024;
/// bytes of journal handed to a replaying stream per request, so a replay
/// holds one page at a time, never the ring.
const PAGE_BYTES: usize = 256 * 1024;
/// writes waiting for the store. a raise, a serve or a mark each; past this
/// the disk is stalled, and the write is dropped with a warning (the model
/// holds the truth; the next write of the same row carries it).
const PERSIST_CAPACITY: usize = 1024;
/// served needs `GET /api/needs` lists.
pub const SERVED_LISTED: usize = 50;
/// tail reads waiting for the reader: more than the windows there can be
/// (`model::MAX_ORDER`). when it is full a request is not queued and the
/// session goes back to unread, so the next change to it asks again.
pub const TAIL_REQUESTS: usize = 512;

/// what the sources and their supervisor send.
#[derive(Debug)]
#[allow(
    clippy::large_enum_variant,
    reason = "nearly every message is a source event; boxing it would allocate per event to shrink the rare removal"
)]
pub enum Upstream {
    /// a connection left the config: its agents go.
    HostRemoved(String),
    /// one source event for one agent of a connection.
    Source {
        connection: Arc<str>,
        agent: Arc<str>,
        /// increases across the whole connection, or none.
        seq: Option<u64>,
        event: crate::source::SourceEvent,
        /// cmx2 only, while contract 1 lives: the whole event payload, byte
        /// for byte, for contract 1's journal.
        raw: Option<Box<RawValue>>,
    },
}

/// where a client stream starts.
#[derive(Debug)]
pub enum From {
    /// no cursor: a first connection.
    Start,
    /// a cursor that does not parse.
    Malformed,
    At(Cursor),
}

/// consecutive frames for a client stream, and the live feed once the
/// replay has reached the head.
#[derive(Debug)]
pub struct Page {
    pub frames: Vec<Bytes>,
    /// where the next request continues from.
    pub next: Cursor,
    pub live: Option<Live>,
}

/// a stream's live feed: frames in journal order, the bytes queued in it
/// (the stream subtracts what it takes), and the token the actor fires
/// when the queue passed the cap and the stream must close.
#[derive(Debug)]
pub struct Live {
    pub frames: mpsc::UnboundedReceiver<Bytes>,
    pub queued: Arc<AtomicUsize>,
    pub closed: CancellationToken,
}

#[derive(Debug, thiserror::Error)]
#[error("the fleet actor has stopped")]
pub struct Stopped;

#[derive(Debug)]
enum Command {
    Read {
        from: From,
        /// the stream's first request, which begins with `hello`.
        first: bool,
        stream: u32,
        reply: oneshot::Sender<Page>,
    },
    Snapshot {
        reply: oneshot::Sender<Bytes>,
    },
    Needs {
        reply: oneshot::Sender<NeedsNow>,
    },
    Arm {
        key: String,
        client_id: String,
        device: Device,
    },
    Answering {
        host: String,
        ask: String,
        device: Device,
    },
    OwnAction {
        key: String,
    },
    MarkRead {
        key: String,
        device: Device,
        message: String,
        at: f64,
        reply: oneshot::Sender<Result<(), ReadRefused>>,
    },
    Clear {
        keys: Vec<String>,
        device: Device,
        reply: oneshot::Sender<Vec<(String, Result<(), ClearRefused>)>>,
    },
    ClearedAmong {
        rows: Vec<(String, f64)>,
        reply: oneshot::Sender<Vec<bool>>,
    },
    Adopt {
        host: String,
        thread: Box<ThreadFacts>,
        reply: oneshot::Sender<()>,
    },
    AdoptedKeys {
        reply: oneshot::Sender<Vec<String>>,
    },
    Places {
        host: String,
        reply: oneshot::Sender<HashSet<String>>,
    },
    Unadopt {
        key: String,
    },
    ReviewTarget {
        key: String,
        reply: oneshot::Sender<Option<ReviewTarget>>,
    },
    ReviewAnswered {
        key: String,
        device: Device,
    },
    ReviewGone {
        key: String,
    },
}

/// the needs as they stand at one point of the journal.
#[derive(Debug)]
pub struct NeedsNow {
    pub open: Vec<Need>,
    pub served: Vec<Need>,
    /// the journal position they reflect: a stream resumed from here
    /// carries every later move.
    pub at: Cursor,
}

/// what the actor needs from the rest of the server.
#[derive(Debug)]
pub struct Wiring {
    pub push: Push,
    pub telemetry: crate::telemetry::Sender,
    pub store: Store,
    /// who is looking, as push sees it.
    pub looking: watch::Receiver<Vec<Looking>>,
    /// the needs and marks the store kept.
    pub needs: Needs,
    pub reads: Reads,
    /// the threads cleared off home.
    pub clears: Clears,
    /// the threads opened from history that the store kept, as `(key,
    /// thread)`; none for a row that no longer decodes.
    pub adopted: Vec<(String, Option<ThreadFacts>)>,
    /// where window tails to read go (`upstream/tails.rs`).
    pub tails: mpsc::Sender<TailRequest>,
}

/// what `boxbox.db` kept for the fleet.
#[derive(Debug)]
pub struct Restored {
    pub needs: Needs,
    pub reads: Reads,
    pub clears: Clears,
    pub adopted: Vec<(String, Option<ThreadFacts>)>,
}

/// the ledger, the read marks, the clears and the adopted threads as `boxbox.db` kept them.
///
/// # Errors
/// the store failed.
pub async fn restore(store: &Store) -> Result<Restored, crate::store::StoreError> {
    let now = crate::now_ms();
    store
        .call(move |connection| {
            let (open, served) = needs::load(connection, now)?;
            let marks = read::load(connection)?;
            let (clears, dropped) = Clears::restore(clears::load(connection)?);
            // rows past the cap would otherwise stay in the table for good
            for key in dropped {
                clears::remove(connection, &key)?;
            }
            let adopted = adopted::load(connection)?
                .into_iter()
                .filter_map(|(key, info)| {
                    let info = RawValue::from_string(info).ok()?;
                    // every kept row is a cmx2 session's info, as contract 1 journals it
                    Some((key, translate::thread_from_json(info).ok()))
                })
                .collect();
            Ok(Restored {
                needs: Needs::restore(open, served),
                reads: Reads::restore(marks),
                clears,
                adopted,
            })
        })
        .await
}

/// the handle every other task holds.
#[derive(Clone, Debug)]
pub struct Fleet {
    upstream: mpsc::Sender<Upstream>,
    commands: mpsc::Sender<Command>,
}

impl Fleet {
    #[must_use]
    pub fn upstream(&self) -> mpsc::Sender<Upstream> {
        self.upstream.clone()
    }

    /// a handle whose actor is gone: every command fails with `Stopped`. for
    /// tests of what holds a fleet handle and judges something else.
    #[cfg(test)]
    #[must_use]
    pub fn detached() -> Self {
        let (upstream, _) = mpsc::channel(1);
        let (commands, _) = mpsc::channel(1);
        Self { upstream, commands }
    }

    /// a handle whose actor takes every command and does nothing with it:
    /// a command without a reply succeeds, one with a reply fails with
    /// `Stopped`. for tests of routes that tell the fleet before they act.
    #[cfg(test)]
    #[must_use]
    pub fn listening() -> Self {
        let (upstream, mut events) = mpsc::channel(64);
        let (commands, mut taken) = mpsc::channel::<Command>(64);
        tokio::spawn(async move { while taken.recv().await.is_some() {} });
        tokio::spawn(async move { while events.recv().await.is_some() {} });
        Self { upstream, commands }
    }

    /// the next frames for client stream `stream`.
    ///
    /// # Errors
    /// the actor has stopped (the server is shutting down).
    pub async fn read(&self, from: From, first: bool, stream: u32) -> Result<Page, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Read {
                from,
                first,
                stream,
                reply,
            })
            .await
            .map_err(|_| Stopped)?;
        answer.await.map_err(|_| Stopped)
    }

    /// the whole fleet model as json.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn snapshot(&self) -> Result<Bytes, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Snapshot { reply })
            .await
            .map_err(|_| Stopped)?;
        answer.await.map_err(|_| Stopped)
    }

    /// the open needs, the ones served lately, and the journal position
    /// they reflect.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn needs(&self) -> Result<NeedsNow, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Needs { reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// a send from `device` is on its way to `key` with `client_id`: the
    /// turn it starts is armed for "done".
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn arm(&self, key: String, client_id: String, device: Device) -> Result<(), Stopped> {
        self.command(Command::Arm {
            key,
            client_id,
            device,
        })
        .await
    }

    /// `device` is answering `ask` on `host`.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn answering(
        &self,
        host: String,
        ask: String,
        device: Device,
    ) -> Result<(), Stopped> {
        self.command(Command::Answering { host, ask, device }).await
    }

    /// a person is stopping `key`'s turn.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn own_action(&self, key: String) -> Result<(), Stopped> {
        self.command(Command::OwnAction { key }).await
    }

    /// `device` has seen `key` through `message`, created at `at` on the
    /// daemon's clock.
    ///
    /// # Errors
    /// the actor has stopped (outer), or the session is unknown (inner).
    pub async fn mark_read(
        &self,
        key: String,
        device: Device,
        message: String,
        at: f64,
    ) -> Result<Result<(), ReadRefused>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::MarkRead {
            key,
            device,
            message,
            at,
            reply,
        })
        .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// clears each of `keys` off home on `device`'s behalf and says how
    /// each went (`model::Model::clear`).
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn clear(
        &self,
        keys: Vec<String>,
        device: Device,
    ) -> Result<Vec<(String, Result<(), ClearRefused>)>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Clear {
            keys,
            device,
            reply,
        })
        .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// which of these threads, each with the `time.updated` the daemon
    /// listed for it, are cleared off home now.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn cleared_among(&self, rows: Vec<(String, f64)>) -> Result<Vec<bool>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::ClearedAmong { rows, reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// a thread read from its daemon joins the fleet, if it is not in it.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn adopt(&self, host: String, thread: ThreadFacts) -> Result<(), Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Adopt {
            host,
            thread: Box::new(thread),
            reply,
        })
        .await?;
        answer.await.map_err(|_| Stopped)
    }

    /// the threads opened from history that are adopted, held or waiting for their host's first read.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn adopted_keys(&self) -> Result<Vec<String>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::AdoptedKeys { reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// the project roots and session directories the fleet holds for `host`.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn places(&self, host: String) -> Result<HashSet<String>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::Places { host, reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// a thread the daemon no longer has live (archived, or gone) is not adopted any more.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn unadopt(&self, key: String) -> Result<(), Stopped> {
        self.command(Command::Unadopt { key }).await
    }

    /// where `key` works and the checkout its open review need names; `None` when the
    /// fleet does not hold the session.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn review_target(&self, key: String) -> Result<Option<ReviewTarget>, Stopped> {
        let (reply, answer) = oneshot::channel();
        self.command(Command::ReviewTarget { key, reply }).await?;
        answer.await.map_err(|_| Stopped)
    }

    /// `device`'s reply to `key` went through boxbox and was taken: the review the agent asked
    /// for there is answered by it.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn review_answered(&self, key: String, device: Device) -> Result<(), Stopped> {
        self.command(Command::ReviewAnswered { key, device }).await
    }

    /// the daemon says the checkout `key` reviews is gone: its review need is served.
    ///
    /// # Errors
    /// the actor has stopped.
    pub async fn review_gone(&self, key: String) -> Result<(), Stopped> {
        self.command(Command::ReviewGone { key }).await
    }

    async fn command(&self, command: Command) -> Result<(), Stopped> {
        self.commands.send(command).await.map_err(|_| Stopped)
    }
}

/// starts the actor with a fresh journal; it stops when `shutdown` fires.
#[must_use]
pub fn spawn(
    build: String,
    wiring: Wiring,
    shutdown: CancellationToken,
) -> (Fleet, JoinHandle<()>) {
    let (upstream_tx, upstream) = mpsc::channel(UPSTREAM_CAPACITY);
    let (commands_tx, commands) = mpsc::channel(COMMAND_CAPACITY);
    let epoch = format!("{:012x}", rand::random::<u64>() & 0xffff_ffff_ffff);
    let (persist, persisted) = mpsc::channel(PERSIST_CAPACITY);
    tokio::spawn(persister(wiring.store, persisted));
    info!(
        epoch,
        open_needs = wiring.needs.open_count(),
        clears = wiring.clears.len(),
        "journal started"
    );
    let actor = Actor {
        model: Model::restored(wiring.needs, wiring.reads, wiring.clears, wiring.adopted),
        journal: Journal::new(epoch),
        live: Vec::new(),
        build,
        tails: wiring.tails,
        outside: Outside {
            push: wiring.push,
            telemetry: wiring.telemetry,
            persist,
        },
    };
    let task = tokio::spawn(actor.run(upstream, commands, wiring.looking, shutdown));
    (
        Fleet {
            upstream: upstream_tx,
            commands: commands_tx,
        },
        task,
    )
}

#[derive(Debug)]
struct Subscriber {
    stream: u32,
    frames: mpsc::UnboundedSender<Bytes>,
    queued: Arc<AtomicUsize>,
    closed: CancellationToken,
}

#[derive(Debug)]
struct Actor {
    model: Model,
    journal: Journal,
    live: Vec<Subscriber>,
    build: String,
    tails: mpsc::Sender<TailRequest>,
    outside: Outside,
}

/// where the model's effects go.
#[derive(Debug)]
struct Outside {
    push: Push,
    telemetry: crate::telemetry::Sender,
    persist: mpsc::Sender<Persist>,
}

/// one write for `boxbox.db`.
#[derive(Debug)]
enum Persist {
    Need(Need),
    Read { key: String, mark: Mark },
    Forget(String),
    Clear { key: String, clear: clears::Clear },
    Unclear(String),
    Adopt { key: String, info: String, at: i64 },
    Unadopt(String),
}

/// the fleet's writer: raises, serves and marks go to the store in order,
/// one at a time, off the actor.
async fn persister(store: Store, mut writes: mpsc::Receiver<Persist>) {
    while let Some(write) = writes.recv().await {
        let what = match &write {
            Persist::Need(need) => format!("need {}", need.id),
            Persist::Read { key, .. } => format!("read mark on {key}"),
            Persist::Forget(key) => format!("read marks of {key}"),
            Persist::Clear { key, .. } => format!("clear mark on {key}"),
            Persist::Unclear(key) => format!("clear mark of {key}"),
            Persist::Adopt { key, .. } | Persist::Unadopt(key) => format!("adopted thread {key}"),
        };
        let written = store
            .call(move |connection| match write {
                Persist::Need(need) => needs::save(connection, &need),
                Persist::Read { key, mark } => read::save(connection, &key, &mark),
                Persist::Forget(key) => read::remove(connection, &key),
                Persist::Clear { key, clear } => clears::save(connection, &key, clear),
                Persist::Unclear(key) => clears::remove(connection, &key),
                Persist::Adopt { key, info, at } => adopted::save(connection, &key, &info, at),
                Persist::Unadopt(key) => adopted::remove(connection, &key),
            })
            .await;
        if let Err(error) = written {
            warn!(%error, what, "the fleet could not write to the store; it holds the truth in memory until the next write");
        }
    }
}

impl Actor {
    async fn run(
        mut self,
        mut upstream: mpsc::Receiver<Upstream>,
        mut commands: mpsc::Receiver<Command>,
        mut looking: watch::Receiver<Vec<Looking>>,
        shutdown: CancellationToken,
    ) {
        let mut watching = true;
        loop {
            let due = self.model.tail_due();
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                // a client waiting on its page is served before the next event
                Some(command) = commands.recv() => self.command(command),
                // ahead of the events, so a stream of them cannot starve a held tail
                () = tokio::time::sleep(until(due)), if due.is_some() => self.flush_tails(),
                changed = looking.changed(), if watching => match changed {
                    Ok(()) => {
                        let devices = looking.borrow_and_update().clone();
                        self.looking(devices);
                    }
                    // push has stopped: the server is going down
                    Err(_) => watching = false,
                },
                Some(message) = upstream.recv() => self.upstream(message),
                else => break,
            }
        }
        info!(
            head = self.journal.head(),
            entries = self.journal.len(),
            bytes = self.journal.bytes(),
            sessions = self.model.session_count(),
            "fleet actor stopped"
        );
    }

    fn command(&mut self, command: Command) {
        let now = crate::now_ms();
        #[cfg(feature = "record")]
        record::command(now, &command);
        self.model.at(now);
        match command {
            Command::Needs { reply } => {
                let _ = reply.send(NeedsNow {
                    open: self.model.needs_open(),
                    served: self.model.needs_served(SERVED_LISTED),
                    at: self.cursor(self.journal.head()),
                });
            }
            Command::Arm {
                key,
                client_id,
                device,
            } => self.model.arm(&key, &client_id, device),
            Command::Answering { host, ask, device } => self.model.answering(&host, &ask, device),
            Command::OwnAction { key } => self.model.own_action(&key),
            Command::MarkRead {
                key,
                device,
                message,
                at,
                reply,
            } => {
                let answer = self.model.read(&key, &device, &message, at).map(|changes| {
                    self.publish_all(&changes);
                });
                let _ = reply.send(answer);
            }
            Command::Clear {
                keys,
                device,
                reply,
            } => {
                let (changes, answers) = self.model.clear(&keys, &device);
                self.publish_all(&changes);
                let _ = reply.send(answers);
            }
            Command::ClearedAmong { rows, reply } => {
                let _ = reply.send(self.model.cleared_among(&rows));
            }
            Command::Adopt {
                host,
                thread,
                reply,
            } => {
                let changes = self.model.adopt_thread(&host, *thread);
                self.publish_all(&changes);
                let _ = reply.send(());
            }
            Command::AdoptedKeys { reply } => {
                let _ = reply.send(self.model.adopted_keys());
            }
            Command::ReviewAnswered { key, device } => {
                let changes = self.model.review_answered(&key, &device);
                self.publish_all(&changes);
            }
            Command::ReviewGone { key } => {
                let changes = self.model.review_gone(&key);
                self.publish_all(&changes);
            }
            Command::ReviewTarget { key, reply } => {
                let _ = reply.send(self.model.review_target(&key));
            }
            Command::Places { host, reply } => {
                let _ = reply.send(self.model.places(&host));
            }
            Command::Unadopt { key } => {
                let changes = self.model.unadopt(&key);
                self.publish_all(&changes);
            }
            Command::Read {
                from,
                first,
                stream,
                reply,
            } => {
                // a stream that went away while it waited needs nothing
                let _ = reply.send(self.read(from, first, stream));
            }
            Command::Snapshot { reply } => match serde_json::to_vec(&self.model.snapshot()) {
                Ok(json) => {
                    let _ = reply.send(Bytes::from(json));
                }
                Err(e) => error!(error = %e, "the fleet snapshot did not serialize"),
            },
        }
    }

    fn upstream(&mut self, message: Upstream) {
        let now = crate::now_ms();
        #[cfg(feature = "record")]
        record::upstream(now, &message);
        self.model.at(now);
        let changes = match message {
            Upstream::HostRemoved(host) => self.model.host_removed(&host),
            Upstream::Source {
                connection,
                agent,
                seq,
                event,
                raw,
            } => match event {
                SourceEvent::Connection(status) => self.model.connection(status),
                SourceEvent::Snapshot(read) => {
                    let (epoch, sessions) = (read.epoch.clone(), read.threads.len());
                    let changes = self.model.agent_read(&agent, *read);
                    info!(
                        host = %agent,
                        epoch = epoch.as_deref().unwrap_or("-"),
                        sessions,
                        "fleet replaced the host from its reads"
                    );
                    changes
                }
                SourceEvent::TailRead(read) => self.model.tail(&agent, *read),
                SourceEvent::TailUnread { thread, reason } => {
                    let key = model::session_key(&agent, &thread);
                    warn!(
                        session = key,
                        reason,
                        "a window's tail could not be read; it shows what streams, and is read again when its host is"
                    );
                    self.model.tail_failed(&key);
                    return;
                }
                event => {
                    let kind = event.kind();
                    match self.model.source(&agent, seq, event, raw.as_deref()) {
                        Ok(changes) => changes,
                        Err(e) => {
                            warn!(connection = %connection, host = %agent, kind, error = %e, "an event's payload lacks what it was translated from; skipped");
                            return;
                        }
                    }
                }
            },
        };
        self.publish_all(&changes);
    }

    fn looking(&mut self, devices: Vec<Looking>) {
        let now = crate::now_ms();
        #[cfg(feature = "record")]
        record::looking(now, &devices);
        self.model.at(now);
        let moved = self.model.looking(devices);
        self.publish_all(&moved);
    }

    fn flush_tails(&mut self) {
        let now = crate::now_ms();
        #[cfg(feature = "record")]
        record::flush_tails(now);
        self.model.at(now);
        let changes = self.model.flush_tails();
        self.publish_all(&changes);
    }

    /// journals the changes, then carries the model's effects out.
    fn publish_all(&mut self, changes: &[Change]) {
        for change in changes {
            self.publish(change);
        }
        for effect in self.model.drain() {
            match effect {
                Effect::ReadTail(request) => self.ask_tail(request),
                effect => self.outside.effect(effect),
            }
        }
    }

    /// queues a window's tail read; one that cannot wait leaves the session
    /// to be asked again on its next change.
    fn ask_tail(&mut self, request: TailRequest) {
        match self.tails.try_send(request) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(request)) => {
                warn!(
                    session = request.key,
                    cap = TAIL_REQUESTS,
                    "the tail reader is behind; this window's tail is asked again on its next change"
                );
                self.model.tail_not_asked(&request.key);
            }
            // the reader has stopped: the server is going down
            Err(mpsc::error::TrySendError::Closed(request)) => {
                self.model.tail_not_asked(&request.key);
            }
        }
    }

    fn publish(&mut self, change: &Change) {
        let frame =
            self.journal.append(
                |seq| match serde_json::to_vec(&JournalEntry { seq, change }) {
                    Ok(json) => Some(json),
                    Err(e) => {
                        error!(error = %e, "a change did not serialize; it is not journaled");
                        None
                    }
                },
            );
        let Some(frame) = frame else { return };
        self.live.retain(|s| {
            let queued = s.queued.load(Ordering::Acquire);
            if queued + frame.len() > OUTBOUND_CAP {
                warn!(stream = %format_args!("{:08x}", s.stream), queued_bytes = queued, frame_bytes = frame.len(), cap_bytes = OUTBOUND_CAP, "the client fell 512 KB behind; closing its stream");
                s.closed.cancel();
                return false;
            }
            s.queued.fetch_add(frame.len(), Ordering::AcqRel);
            // a failed send means the stream is gone: it leaves the list
            s.frames.send(frame.clone()).is_ok()
        });
    }

    fn read(&mut self, from: From, first: bool, stream: u32) -> Page {
        let mut frames = Vec::new();
        if first {
            frames.extend(self.hello());
        }
        let after = match from {
            From::Start => return self.reset(frames, ResetReason::None, stream),
            From::Malformed => return self.reset(frames, ResetReason::Invalid, stream),
            From::At(cursor) if cursor.epoch != self.journal.epoch() => {
                return self.reset(frames, ResetReason::Epoch, stream);
            }
            From::At(cursor) => cursor.seq,
        };
        match self.journal.page(after, PAGE_BYTES) {
            Err(Gap::Ahead) => self.reset(frames, ResetReason::Invalid, stream),
            Err(Gap::Evicted) => self.reset(frames, ResetReason::Expired, stream),
            Ok(page) => {
                frames.extend(page.frames);
                let live = (page.last == self.journal.head()).then(|| self.subscribe(stream));
                Page {
                    frames,
                    next: self.cursor(page.last),
                    live,
                }
            }
        }
    }

    fn reset(&mut self, mut frames: Vec<Bytes>, reason: ResetReason, stream: u32) -> Page {
        let head = self.journal.head();
        let control = Control::Reset {
            seq: head,
            epoch: self.journal.epoch().to_owned(),
            reason,
            fleet: self.model.snapshot(),
        };
        match serde_json::to_vec(&control) {
            Ok(json) => {
                let frame = sse_frame(Some(&self.cursor(head).to_string()), &json);
                info!(stream = %format_args!("{stream:08x}"), reason = reason.as_str(), head, bytes = frame.len(), "stream starts from a snapshot");
                frames.push(frame);
            }
            Err(e) => error!(error = %e, "the reset snapshot did not serialize"),
        }
        Page {
            frames,
            next: self.cursor(head),
            live: Some(self.subscribe(stream)),
        }
    }

    fn hello(&self) -> Option<Bytes> {
        let hello = Control::Hello {
            epoch: self.journal.epoch().to_owned(),
            head: self.journal.head(),
            build: self.build.clone(),
            protocol: PROTOCOL,
        };
        match serde_json::to_vec(&hello) {
            Ok(json) => Some(sse_frame(None, &json)),
            Err(e) => {
                error!(error = %e, "hello did not serialize");
                None
            }
        }
    }

    fn subscribe(&mut self, stream: u32) -> Live {
        let (tx, frames) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let closed = CancellationToken::new();
        self.live.push(Subscriber {
            stream,
            frames: tx,
            queued: Arc::clone(&queued),
            closed: closed.clone(),
        });
        Live {
            frames,
            queued,
            closed,
        }
    }

    fn cursor(&self, seq: u64) -> Cursor {
        Cursor {
            epoch: self.journal.epoch().to_owned(),
            seq,
        }
    }
}

impl Outside {
    fn effect(&self, effect: Effect) {
        match effect {
            Effect::Need(Moved::Raised(need)) => {
                info!(
                    id = need.id,
                    need = need.kind.as_str(),
                    session = need.key,
                    "need raised"
                );
                self.telemetry.record(&json!({
                    "kind": "need.raised",
                    "host": host_of(&need.key),
                    "session": need.key,
                    "props": { "need": need.kind.as_str(), "child": 0, "id": need.id },
                }));
                self.persist(Persist::Need(need));
            }
            Effect::Need(Moved::Served(need)) => {
                let (Some(by), Some(how), Some(at)) = (&need.served_by, need.how, need.served_at)
                else {
                    return;
                };
                let age = at - need.raised_at;
                info!(
                    id = need.id,
                    need = need.kind.as_str(),
                    session = need.key,
                    by = by.label(),
                    how = how.as_str(),
                    age_ms = age,
                    "need served"
                );
                if by.is_person() {
                    self.telemetry.record(&json!({
                        "kind": "need.served",
                        "host": host_of(&need.key),
                        "session": need.key,
                        "ms": age,
                        "props": { "need": need.kind.as_str(), "by": by.label(), "how": how.as_str(), "id": need.id },
                    }));
                    self.push
                        .served(need.id.clone(), by.label().to_owned(), how.as_str());
                } else {
                    let cleared = if how == needs::How::Expired {
                        "expired"
                    } else {
                        "agent"
                    };
                    self.telemetry.record(&json!({
                        "kind": "need.cleared",
                        "host": host_of(&need.key),
                        "session": need.key,
                        "props": { "need": need.kind.as_str(), "by": cleared, "ageMs": age },
                    }));
                }
                self.persist(Persist::Need(need));
            }
            Effect::Notice(notice) => self.push.notify(notice),
            Effect::Continued(key) => {
                if let Some(thread) = Thread::parse(&key) {
                    self.push.continued(thread);
                }
            }
            Effect::Read { key, mark, source } => {
                self.telemetry.record(&json!({
                    "kind": "read.mark",
                    "host": host_of(&key),
                    "session": key,
                    "props": { "scope": "one", "source": source, "device": mark.device },
                }));
                self.persist(Persist::Read { key, mark });
            }
            Effect::ReadForgotten(key) => self.persist(Persist::Forget(key)),
            Effect::Cleared { key, clear } => self.persist(Persist::Clear { key, clear }),
            Effect::Uncleared(key) => self.persist(Persist::Unclear(key)),
            Effect::Adopted { key, info } => self.persist(Persist::Adopt {
                key,
                info: info.get().to_owned(),
                at: crate::now_ms(),
            }),
            Effect::Unadopted(key) => self.persist(Persist::Unadopt(key)),
            // the actor carries these out itself (`Actor::ask_tail`)
            Effect::ReadTail(_) => {}
        }
    }

    fn persist(&self, write: Persist) {
        if let Err(error) = self.persist.try_send(write) {
            warn!(%error, "the store is not keeping up with the fleet; a write was dropped");
        }
    }
}

/// how long until `due`, ms since the epoch; nothing when it has passed.
fn until(due: Option<i64>) -> Duration {
    let wait = due.map_or(0, |due| due - crate::now_ms());
    Duration::from_millis(u64::try_from(wait).unwrap_or(0))
}

fn host_of(key: &str) -> &str {
    key.split_once(':').map_or(key, |(host, _)| host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream::{Connection, FrameCounts, HostStatus};

    fn actor() -> Actor {
        Actor {
            model: Model::new(),
            journal: Journal::new("ep".into()),
            live: Vec::new(),
            build: "test".into(),
            tails: mpsc::channel(1).0,
            outside: Outside {
                push: Push::detached(),
                telemetry: crate::telemetry::Sender::detached(),
                persist: mpsc::channel(1).0,
            },
        }
    }

    /// the host's status, as the cmx2 source sends it.
    fn host(connects: u64) -> Upstream {
        let name: Arc<str> = Arc::from("desk");
        let status = HostStatus {
            name: "desk".into(),
            url: "http://127.0.0.1:4840/".into(),
            origin: crate::config::Origin::Config,
            memory: None,
            system: None,
            reports_system: None,
            connection: Connection::Connected,
            since: 0,
            health: None,
            last_error: None,
            connects,
            frames: FrameCounts::default(),
            cursor: None,
        };
        Upstream::Source {
            connection: Arc::clone(&name),
            agent: name,
            seq: None,
            event: SourceEvent::Connection(translate::connection(status)),
            raw: None,
        }
    }

    fn text(frame: &Bytes) -> &str {
        std::str::from_utf8(frame).unwrap()
    }

    #[test]
    fn a_first_connection_gets_hello_then_a_snapshot_and_goes_live() {
        let mut actor = actor();
        actor.upstream(host(1));
        let page = actor.read(From::Start, true, 1);
        assert_eq!(page.frames.len(), 2);
        assert!(
            text(&page.frames[0])
                .starts_with("data: {\"type\":\"hello\",\"epoch\":\"ep\",\"head\":1")
        );
        assert!(text(&page.frames[1]).starts_with(
            "id: ep:1\ndata: {\"type\":\"reset\",\"seq\":1,\"epoch\":\"ep\",\"reason\":\"none\""
        ));
        let mut live = page.live.unwrap();
        actor.upstream(host(2));
        let next = live.frames.try_recv().unwrap();
        assert!(text(&next).starts_with("id: ep:2\ndata: {\"seq\":2,\"type\":\"host\""));
        assert_eq!(live.queued.load(Ordering::Acquire), next.len());
    }

    #[test]
    fn a_resume_replays_after_the_cursor_and_then_goes_live_with_no_gap() {
        let mut actor = actor();
        for n in 1..=3 {
            actor.upstream(host(n));
        }
        let page = actor.read(
            From::At(Cursor {
                epoch: "ep".into(),
                seq: 1,
            }),
            true,
            1,
        );
        let ids: Vec<&str> = page
            .frames
            .iter()
            .skip(1)
            .map(|f| text(f).lines().next().unwrap())
            .collect();
        assert_eq!(ids, ["id: ep:2", "id: ep:3"]);
        assert!(
            page.live.is_some(),
            "the page that reaches the head goes live"
        );
    }

    #[test]
    fn a_long_replay_comes_in_pages_and_only_the_last_goes_live() {
        let mut actor = actor();
        for n in 0..3000 {
            actor.upstream(host(n));
        }
        let mut next = From::At(Cursor {
            epoch: "ep".into(),
            seq: 0,
        });
        let mut first = true;
        let mut received = 0;
        let mut pages = 0;
        loop {
            let page = actor.read(next, first, 1);
            received += page.frames.len() - usize::from(first);
            first = false;
            pages += 1;
            if page.live.is_some() {
                break;
            }
            next = From::At(page.next);
        }
        assert_eq!(received, 3000);
        assert!(pages > 1);
    }

    #[test]
    fn a_cursor_from_another_epoch_or_past_the_head_starts_from_a_snapshot() {
        let mut actor = actor();
        actor.upstream(host(1));
        for (from, reason) in [
            (
                From::At(Cursor {
                    epoch: "old".into(),
                    seq: 1,
                }),
                "epoch",
            ),
            (
                From::At(Cursor {
                    epoch: "ep".into(),
                    seq: 9,
                }),
                "invalid",
            ),
            (From::Malformed, "invalid"),
        ] {
            let page = actor.read(from, false, 1);
            assert!(
                text(&page.frames[0]).contains(&format!("\"reason\":\"{reason}\"")),
                "{reason}"
            );
        }
    }

    #[test]
    fn a_stream_that_falls_past_the_cap_is_closed_and_dropped() {
        let mut actor = actor();
        let live = actor.read(From::Start, false, 7).live.unwrap();
        // nobody takes from the queue: it fills until the cap closes it
        for n in 0..10_000 {
            actor.upstream(host(n));
            if live.closed.is_cancelled() {
                break;
            }
        }
        assert!(live.closed.is_cancelled());
        assert!(live.queued.load(Ordering::Acquire) <= OUTBOUND_CAP);
        assert!(actor.live.is_empty());
    }

    #[test]
    fn a_stream_that_went_away_leaves_the_list_on_the_next_frame() {
        let mut actor = actor();
        drop(actor.read(From::Start, false, 1).live);
        actor.upstream(host(1));
        assert!(actor.live.is_empty());
    }
}
