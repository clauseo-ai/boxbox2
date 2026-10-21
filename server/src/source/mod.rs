//! the agent source seam (`docs/agents.md`, section 4): a trait out and a
//! `SourceEvent` union in.
//!
//! a source is one kind of agent runtime boxbox speaks (cmx2, openclaw,
//! hermes). each connection in `boxbox.toml` runs as one supervised source
//! task (`run`) that sends the fleet actor `SourceEvent`s through a bounded
//! channel, and answers the verbs the http layer calls on it. the reducer
//! matches `SourceEvent` with today's floors and staleness rules, keyed by
//! agent; no source keeps a transcript mirror (the agent is the system of
//! record).
//!
//! verbs go out through `AgentSource`, held as `Arc<dyn AgentSource>` per
//! connection in the registry; its methods return boxed futures so it stays
//! object safe. a verb gated by a capability answers
//! `VerbError::Unsupported` unless the source implements it, and the http
//! layer checks the capability before it calls (decision 29).

// the seam lands before every user of it (m9: the cmx2 source, the openclaw
// source); what no source uses yet is still the contract they build against.
#![allow(dead_code, unused_imports)]

pub mod agent_keys;
pub mod cmx2;
pub mod config;
pub mod identity;
pub mod ids;
pub mod sends;
#[cfg(test)]
pub mod testing;
pub mod thread_ids;

use std::sync::Arc;

use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::upstream::HostStatus;
use crate::wire::{
    Accepted, Activity, AgentConnection, AgentStatus, Ask, AskKind, AskSettled, Born, Capabilities,
    Capability, Changes, Context, Kind, Label, Mark, Message, Origin, Part, Place, Reaction,
    SendStateKind, Source, Vcs,
};
pub use config::{AgentOverride, ConnectionConfig, HermesConfig, OpenclawConfig, OpenclawMode};

/// what a source sends the fleet actor. every event names its agent (on
/// the envelope, `Upstream::Source`).
#[derive(Debug)]
pub enum SourceEvent {
    /// the connection's status changed; one per connection, for all its agents.
    Connection(ConnectionStatus),
    /// the connection's agents, whole: identity, kind, capabilities.
    Agents(Vec<AgentFacts>),
    /// one agent read afresh: replaces every thread and ask the fleet held
    /// for it; its floors bound what follows, and its `epoch` is the
    /// source's (a moved epoch re-reads every tail).
    Snapshot(Box<Snapshot>),
    /// a thread appeared or changed. `born`: it was just created, so the
    /// model marks its tail read and empty instead of asking for one.
    Thread {
        thread: Box<ThreadFacts>,
        born: bool,
    },
    ThreadRemoved {
        thread: String,
    },
    /// the source cannot prove every row reached the journal: `thread.reset`.
    ThreadReset {
        thread: String,
    },
    Activity {
        thread: String,
        activity: Activity,
    },
    /// a turn ended: busy becomes idle, parked stays parked; raises done.
    TurnEnded {
        thread: String,
    },
    /// what boxbox knows of a send it could not confirm (section 7).
    Send {
        thread: String,
        client_id: String,
        state: SendOutcome,
    },
    Message {
        thread: String,
        message: Box<Message>,
    },
    Part {
        thread: String,
        part: Box<Part>,
    },
    /// streamed text for a part; `offset` is utf-16 units before it.
    Delta {
        thread: String,
        message: String,
        part: String,
        field: String,
        delta: String,
        offset: u64,
    },
    MessageRemoved {
        thread: String,
        message: String,
    },
    Reactions {
        thread: String,
        message: String,
        reactions: Vec<Reaction>,
    },
    AskRaised {
        ask: Box<Ask>,
    },
    /// `kind` picks the floor (permissions or questions).
    AskSettled {
        ask: String,
        kind: AskKind,
        settled: Box<AskSettled>,
    },
    /// a turn ended in an error the person should hear of.
    Fault {
        thread: String,
        words: String,
    },
    /// review and job needs; cmx2 only today.
    Notice {
        thread: String,
        notice: Notice,
    },
    /// a worktree merged or discarded: settles review needs by worktree
    /// name and the directory the event was framed with, with no thread.
    /// cmx2 only. a merge framed with no directory settles nothing.
    ReviewSettled {
        worktree: String,
        directory: Option<String>,
    },
    /// a thread's newest messages, read for its window's tail.
    TailRead(Box<TailRead>),
    /// a thread's tail could not be read; why, in plain words.
    TailUnread {
        thread: String,
        reason: String,
    },
    /// the source dropped an event it could not read (over the frame cap,
    /// undecodable, or lacking what it decoded with): whatever it changed is
    /// unknown here. it changes nothing shown; a transcript read stamped
    /// before it can no longer be answered unchanged (`fleet/model/marks.rs`).
    Skipped,
}

impl SourceEvent {
    /// the event's name in logs.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Connection(_) => "connection",
            Self::Agents(_) => "agents",
            Self::Snapshot(_) => "snapshot",
            Self::Thread { born: true, .. } => "thread.born",
            Self::Thread { .. } => "thread",
            Self::ThreadRemoved { .. } => "thread.removed",
            Self::ThreadReset { .. } => "thread.reset",
            Self::Activity { .. } => "activity",
            Self::TurnEnded { .. } => "turn.ended",
            Self::Send { .. } => "send",
            Self::Message { .. } => "message",
            Self::Part { .. } => "part",
            Self::Delta { .. } => "delta",
            Self::MessageRemoved { .. } => "message.removed",
            Self::Reactions { .. } => "reactions",
            Self::AskRaised { .. } => "ask.raised",
            Self::AskSettled { .. } => "ask.settled",
            Self::Fault { .. } => "fault",
            Self::Notice { .. } => "notice",
            Self::ReviewSettled { .. } => "review.settled",
            Self::TailRead(_) => "tail.read",
            Self::TailUnread { .. } => "tail.unread",
            Self::Skipped => "skipped",
        }
    }
}

/// a connection's state, for every agent on it.
#[derive(Clone, Debug)]
pub struct ConnectionStatus {
    pub status: AgentStatus,
    pub connection: AgentConnection,
    /// cmx2 only, while contract 1 lives: the host as contract 1's `host`
    /// change carries it, byte for byte as today.
    pub host: Option<Box<HostStatus>>,
}

/// one agent of a connection: who it is and what it can do. the status and
/// connection facts come from `ConnectionStatus`.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentFacts {
    /// `[a-z0-9-]{1,32}`; a cmx2 agent's is its connection's name.
    pub key: String,
    /// the runtime's own id for the agent; none for cmx2.
    pub foreign_id: Option<String>,
    pub label: Label,
    pub kind: Kind,
    pub source: Source,
    pub mark: Mark,
    pub palette: Option<String>,
    pub capabilities: Capabilities,
}

/// a thread as its source knows it: everything on contract 2's `Thread`
/// that is not boxbox's own (activity, tail, needs, read and clears are).
#[derive(Clone, Debug)]
pub struct ThreadFacts {
    /// the thread id, unique within its agent: `[A-Za-z0-9_-]{1,128}`
    /// (cmx2 ids also allow `.`).
    pub id: String,
    pub title: String,
    /// ms on the agent's clock.
    pub created: f64,
    pub updated: f64,
    pub said: Option<f64>,
    pub generation: Option<String>,
    /// the parent thread's id.
    pub parent: Option<String>,
    pub place: Option<Place>,
    pub origin: Option<Origin>,
    pub queued: u32,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub context: Option<Context>,
    pub cost: Option<f64>,
    pub vcs: Option<Vcs>,
    pub changes: Option<Changes>,
    pub browse_only: bool,
    /// archived on the agent: it leaves the fleet.
    pub archived: bool,
    /// cmx2 only, while contract 1 lives: the session's info as the daemon
    /// wrote it, for contract 1's `session` change.
    pub raw: Option<Box<RawValue>>,
}

/// one agent read afresh.
#[derive(Debug)]
pub struct Snapshot {
    /// the source's own epoch: a read from another one lines up with
    /// nothing held. none for a source that has no such thing.
    pub epoch: Option<String>,
    /// the source seq each list reflects; 0 for a source whose events
    /// carry no connection-wide seq.
    pub floors: Floors,
    pub threads: Vec<ThreadFacts>,
    /// threads that are not plain idle.
    pub activities: Vec<ThreadActivity>,
    pub asks: Vec<RaisedAsk>,
}

/// a snapshot's floors, per domain: an event at or below one is already in
/// the read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Floors {
    pub threads: u64,
    pub activities: u64,
    pub permissions: u64,
    pub questions: u64,
}

/// a thread's activity in a snapshot.
#[derive(Debug)]
pub struct ThreadActivity {
    pub thread: String,
    pub activity: Activity,
    /// cmx2 only, while contract 1 lives: the status as the daemon wrote it.
    pub raw: Option<Box<RawValue>>,
}

/// an ask in a snapshot.
#[derive(Debug)]
pub struct RaisedAsk {
    pub ask: Ask,
    /// cmx2 only, while contract 1 lives: the request as the daemon wrote it.
    pub raw: Option<Box<RawValue>>,
}

/// what boxbox knows of a send it could not confirm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendOutcome {
    /// settled: the user message with its client id arrived.
    Landed,
    Pending(SendStateKind),
}

/// review and job notices (cmx2 only today).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    /// the agent asks for its checkout to be reviewed.
    Review {
        /// the worktree's name.
        checkout: String,
        /// the note, else the branch, else the checkout's name.
        words: String,
    },
    /// a background job exited, opened a port, or printed what it watched for.
    Job {
        process: String,
        /// `exit`, `port`, or what it watched for.
        reason: String,
        /// the job's title.
        title: String,
        detail: String,
    },
}

/// a thread's newest messages and where they stand in the source's events.
#[derive(Debug)]
pub struct TailRead {
    pub thread: String,
    /// the event the read includes up to; none when the source does not
    /// number its events (the read is then newer than anything before it).
    pub upstream: Option<Stamp>,
    pub messages: Vec<MessageWithParts>,
}

/// a point in a source's numbered events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub epoch: String,
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MessageWithParts {
    pub info: Message,
    pub parts: Vec<Part>,
}

/// a value with the point in the source's events it reflects.
#[derive(Clone, Debug, PartialEq)]
pub struct Stamped<T> {
    pub upstream: Option<Stamp>,
    pub data: T,
}

/// how a source's task ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exit {
    /// try again after the supervisor's jittered backoff.
    Retry { why: String },
    /// boxbox will not talk to it until the config changes.
    Refused { why: String },
    /// the shutdown token fired.
    Stopped,
}

/// where a source's events go: the fleet actor's bounded channel, stamped
/// with the connection. when it is full the source waits; domain events
/// are never dropped.
#[derive(Debug, Clone)]
pub struct SourceSender {
    connection: Arc<str>,
    fleet: mpsc::Sender<crate::fleet::Upstream>,
}

/// the fleet actor has stopped; the server is going down.
#[derive(Debug, thiserror::Error)]
#[error("the fleet actor has stopped")]
pub struct FleetGone;

impl SourceSender {
    #[must_use]
    pub fn new(connection: Arc<str>, fleet: mpsc::Sender<crate::fleet::Upstream>) -> Self {
        Self { connection, fleet }
    }

    #[must_use]
    pub fn connection(&self) -> &Arc<str> {
        &self.connection
    }

    /// the fleet's message for one event of `agent`, as `send` sends it.
    #[must_use]
    pub fn envelope(
        &self,
        agent: &Arc<str>,
        seq: Option<u64>,
        event: SourceEvent,
        raw: Option<Box<RawValue>>,
    ) -> crate::fleet::Upstream {
        crate::fleet::Upstream::Source {
            connection: Arc::clone(&self.connection),
            agent: Arc::clone(agent),
            seq,
            event,
            raw,
        }
    }

    /// sends one event for `agent`. `seq` increases across the whole
    /// connection, or is none; `raw` is cmx2's whole event payload, for
    /// contract 1.
    ///
    /// # Errors
    /// the fleet actor has stopped.
    pub async fn send(
        &self,
        agent: &Arc<str>,
        seq: Option<u64>,
        event: SourceEvent,
        raw: Option<Box<RawValue>>,
    ) -> Result<(), FleetGone> {
        self.fleet
            .send(self.envelope(agent, seq, event, raw))
            .await
            .map_err(|_| FleetGone)
    }
}

/// a thread a verb is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadRef {
    pub agent: String,
    pub id: String,
}

impl ThreadRef {
    #[must_use]
    pub fn key(&self) -> String {
        format!("{}:{}", self.agent, self.id)
    }
}

/// an ask a verb answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskRef {
    pub agent: String,
    pub id: String,
    pub kind: AskKind,
    /// the thread it waits in, when known.
    pub thread: Option<String>,
}

/// a person's answer to an ask.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub device: String,
    pub device_class: String,
    pub client_id: String,
    pub reply: Reply,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply {
    /// a permission's option id: once, always or reject.
    Option(String),
    /// a question's answers, one list per question.
    Answers(Vec<Vec<String>>),
    /// dismiss a question.
    Reject,
}

/// a page of a transcript: newest first from `before`, at most `limit`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Page {
    pub before: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Transcript {
    pub messages: Vec<MessageWithParts>,
    /// the cursor of the next older page, when there is one.
    pub next: Option<String>,
    pub upstream: Option<Stamp>,
}

/// an archived thread.
#[derive(Clone, Debug, PartialEq)]
pub struct Archived {
    pub key: String,
    /// when the agent archived it, ms.
    pub at: Option<f64>,
}

/// where an agent keeps bytes boxbox copies into its media store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaSource {
    pub agent: String,
    pub thread: Option<String>,
    /// the source's own locator: a url, a ticket, a path.
    pub locator: String,
}

/// bytes from an agent, streamed.
pub struct MediaBody {
    pub mime: String,
    pub size: Option<u64>,
    pub body: BoxStream<'static, Result<Bytes, VerbError>>,
}

impl std::fmt::Debug for MediaBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MediaBody")
            .field("mime", &self.mime)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

/// a model catalog (the model and reasoning capabilities).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Catalog {
    pub models: Vec<CatalogModel>,
    /// the model a thread runs with when none is picked.
    pub default: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogModel {
    /// what a send's `model` names.
    pub id: String,
    pub name: String,
    pub provider: Option<String>,
    /// the reasoning levels this model takes, when they differ from the agent's.
    pub levels: Option<Vec<String>>,
}

/// past threads, newest first (the history capability).
#[derive(Clone, Debug)]
pub struct HistoryPage {
    pub threads: Vec<ThreadFacts>,
    /// the cursor of the next older page, when there is one.
    pub next: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HistoryQuery {
    pub before: Option<String>,
    pub limit: Option<u32>,
}

/// a verb's failure, mapped to http in one place (`http/error.rs`).
#[derive(Debug, thiserror::Error)]
pub enum VerbError {
    /// the agent lacks the capability: 422 `unsupported`, never retried.
    #[error("the agent cannot do this ({})", .0.as_str())]
    Unsupported(Capability),
    /// no such agent, thread, message or ask.
    #[error("no such {what}")]
    Missing { what: &'static str },
    /// the request was malformed.
    #[error("{0}")]
    Bad(String),
    /// the agent could not be reached.
    #[error("the agent did not answer: {reason}")]
    Unreachable { reason: String },
    /// the source's request queue is full: 503 `agent-busy`.
    #[error("the agent is busy; try again shortly")]
    Busy,
    /// the agent refused it, in its words.
    #[error("the agent refused: {words}")]
    Refused { status: u16, words: String },
    /// the thread's generation moved: 409 `generation-changed`.
    #[error("the conversation changed; review and resend")]
    GenerationChanged,
    /// the ask was already answered: 409 `settled`, with who answered and when.
    #[error("already answered on {by}")]
    Settled { by: String, at: Option<i64> },
    /// the ask or message is gone: answered, or its turn ended.
    #[error("this is gone: it was answered, or its turn ended")]
    Gone,
    /// a queued prompt the agent already took cannot be taken back.
    #[error("already sent: the agent has it, so it cannot be taken back")]
    AlreadySent,
    /// a retry of a send that ended uncertain or cancelled: nothing is sent
    /// again (section 7); the person sends it again as a new message.
    #[error("not confirmed: the agent may not have this. send it again as a new message")]
    NotConfirmed,
    /// this source does not serve the verb yet; the route says when it will.
    #[error("not built yet: {0}")]
    NotBuilt(&'static str),
}

/// what a verb answers with.
pub type Verb<'a, T> = BoxFuture<'a, Result<T, VerbError>>;

fn unsupported<'a, T: std::marker::Send + 'a>(capability: Capability) -> Verb<'a, T> {
    Box::pin(std::future::ready(Err(VerbError::Unsupported(capability))))
}

/// a send through a source, as the trait takes it.
pub type Send = crate::wire::Send;
/// a new thread, as the trait takes it.
pub type Start = crate::wire::Start;

/// one kind of agent runtime, for one connection.
pub trait AgentSource: std::marker::Send + Sync + 'static {
    fn connection(&self) -> &ConnectionConfig;
    /// the connection's agents and their capabilities, as last published.
    fn agents(&self) -> watch::Receiver<Vec<AgentFacts>>;
    /// the connection's task: connect, sync, send events, until `shutdown`.
    fn run(
        self: Arc<Self>,
        fleet: SourceSender,
        shutdown: CancellationToken,
    ) -> BoxFuture<'static, Exit>;

    // every source
    fn transcript(&self, thread: &ThreadRef, page: Page) -> Verb<'_, Transcript>;
    fn message(&self, thread: &ThreadRef, message: &str) -> Verb<'_, Stamped<MessageWithParts>>;
    fn thread(&self, thread: &ThreadRef) -> Verb<'_, ThreadFacts>;
    fn prompt(&self, thread: &ThreadRef, send: Send) -> Verb<'_, Accepted>;
    fn abort(&self, thread: &ThreadRef) -> Verb<'_, ()>;
    /// the person has read up to `at` (ms on the agent's clock).
    fn mark_read(&self, thread: &ThreadRef, at: f64) -> Verb<'_, ()>;
    fn media(&self, source: &MediaSource) -> Verb<'_, MediaBody>;
    /// the connection's state now, for every agent on it (the agents
    /// screen). a source that tracks none says it is connecting.
    fn connection_status(&self) -> ConnectionStatus {
        let config = self.connection();
        ConnectionStatus {
            status: AgentStatus::Connecting,
            connection: AgentConnection {
                name: config.name().to_owned(),
                url: config.url().to_string(),
                origin: config.origin(),
                since: 0,
                last_error: None,
                connects: 0,
                version: None,
                pinned: None,
                untested: false,
                protocol: None,
                refused: None,
                contract: None,
                contract_matches: None,
                frames: crate::upstream::FrameCounts::default(),
                memory: None,
                system: None,
                reports_system: None,
                cursor: None,
            },
            host: None,
        }
    }

    // gated by a capability; the default answers `VerbError::Unsupported`
    /// threads (and places, worktree when asked).
    fn start(&self, agent: &str, start: Start) -> Verb<'_, Born> {
        let _ = (agent, start);
        unsupported(Capability::Threads)
    }
    /// approvals, questions.
    fn answer(&self, ask: &AskRef, answer: Answer) -> Verb<'_, ()> {
        let _ = answer;
        unsupported(match ask.kind {
            AskKind::Permission => Capability::Approvals,
            AskKind::Question => Capability::Questions,
        })
    }
    /// archive.
    fn archive(&self, thread: &ThreadRef) -> Verb<'_, Archived> {
        let _ = thread;
        unsupported(Capability::Archive)
    }
    /// reactions.
    fn react(&self, thread: &ThreadRef, message: &str, emoji: &str, on: bool) -> Verb<'_, ()> {
        let _ = (thread, message, emoji, on);
        unsupported(Capability::Reactions)
    }
    /// queue: a prompt for after the running turn.
    fn queue(&self, thread: &ThreadRef, send: Send) -> Verb<'_, Accepted> {
        let _ = (thread, send);
        unsupported(Capability::Queue)
    }
    /// queue: run what is queued now.
    fn run_now(&self, thread: &ThreadRef) -> Verb<'_, ()> {
        let _ = thread;
        unsupported(Capability::Queue)
    }
    /// queue: take back a queued prompt.
    fn unsend(&self, thread: &ThreadRef, message: &str) -> Verb<'_, ()> {
        let _ = (thread, message);
        unsupported(Capability::Queue)
    }
    /// steer.
    fn steer(&self, thread: &ThreadRef, send: Send) -> Verb<'_, Accepted> {
        let _ = (thread, send);
        unsupported(Capability::Steer)
    }
    /// compact.
    fn compact(&self, thread: &ThreadRef) -> Verb<'_, ()> {
        let _ = thread;
        unsupported(Capability::Compact)
    }
    /// model, reasoning. `directory` scopes it to a place, where the agent has places.
    fn catalog(&self, agent: &str, directory: Option<&str>) -> Verb<'_, Catalog> {
        let _ = (agent, directory);
        unsupported(Capability::Model)
    }
    /// places: the repos and folders threads start in.
    fn projects(&self, agent: &str) -> Verb<'_, Vec<Place>> {
        let _ = agent;
        unsupported(Capability::Places)
    }
    /// places: the folders inside `path`.
    fn folders(&self, agent: &str, path: &str) -> Verb<'_, Vec<String>> {
        let _ = (agent, path);
        unsupported(Capability::Places)
    }
    /// files: paths under `directory` matching `query`.
    fn find_file(
        &self,
        agent: &str,
        directory: Option<&str>,
        query: &str,
        limit: Option<u32>,
    ) -> Verb<'_, Vec<String>> {
        let _ = (agent, directory, query, limit);
        unsupported(Capability::Files)
    }
    /// shell: a `!` line.
    fn shell(&self, thread: &ThreadRef, client_id: &str, command: &str) -> Verb<'_, Accepted> {
        let _ = (thread, client_id, command);
        unsupported(Capability::Shell)
    }
    /// commands: the slash commands, by name and description.
    fn commands(&self, agent: &str) -> Verb<'_, Vec<(String, String)>> {
        let _ = agent;
        unsupported(Capability::Commands)
    }
    /// commands: run one.
    fn command(
        &self,
        thread: &ThreadRef,
        client_id: &str,
        command: &str,
        arguments: &str,
    ) -> Verb<'_, Accepted> {
        let _ = (thread, client_id, command, arguments);
        unsupported(Capability::Commands)
    }
    /// history: past threads.
    fn history(&self, agent: &str, query: HistoryQuery) -> Verb<'_, HistoryPage> {
        let _ = (agent, query);
        unsupported(Capability::History)
    }
    /// history: hold a past thread in the fleet.
    fn adopt(&self, thread: &ThreadRef) -> Verb<'_, ThreadFacts> {
        let _ = thread;
        unsupported(Capability::History)
    }
    /// admin: reload the runtime's config.
    fn reload(&self, agent: &str) -> Verb<'_, ()> {
        let _ = agent;
        unsupported(Capability::Admin)
    }
    /// admin: restart the runtime.
    fn restart(&self, agent: &str) -> Verb<'_, ()> {
        let _ = agent;
        unsupported(Capability::Admin)
    }
    /// terminal: the pty relay's verbs (cmx2 only).
    fn terminal(&self) -> Option<&dyn TerminalSource> {
        None
    }
    /// cmx2 only, while contract 1 lives: today's passthroughs, whose
    /// answers are the daemon's bytes (`Cmx2Raw`).
    fn cmx2_raw(&self) -> Option<&Cmx2Raw> {
        None
    }
}

impl std::fmt::Debug for dyn AgentSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentSource")
            .field("connection", &self.connection().name())
            .finish_non_exhaustive()
    }
}

/// the terminal capability's verbs. cmx2 only: its pty api and websocket
/// relay (`pty/`) live behind this.
pub trait TerminalSource: std::marker::Send + Sync {
    /// the connection terminals run on.
    fn host(&self) -> &crate::config::HostConfig;
}

/// contract 1's passthroughs: the cmx2 source itself, whose inherent
/// methods are the `/api/hosts` handlers' daemon calls moved whole. it
/// goes with contract 1.
pub type Cmx2Raw = cmx2::Cmx2Source;
