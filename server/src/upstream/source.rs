//! the cmx2 source: one cmx2 daemon as an `AgentSource`. its task is
//! today's watcher (`watcher.rs`), its snapshot today's reconcile, and its
//! tails today's reader, each sending `SourceEvent`s through the cmx2
//! translation (`source/cmx2/translate.rs`). its agent is the connection,
//! keyed by the connection's name, with every capability cmx2 has.
//!
//! contract 1's `/api/hosts` routes reach the daemon through it: the verbs
//! whose answer is the daemon's bytes are its inherent methods
//! (`Cmx2Raw`, `source/cmx2/verbs/`), the handlers' daemon calls moved
//! whole, headers and caps included.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::watcher::Watcher;
use super::{Counters, HostStatus};
use crate::config::HostConfig;
use crate::source::cmx2::translate;
use crate::source::{
    AgentFacts, AgentSource, Answer, Archived, AskRef, Catalog, Cmx2Raw, ConnectionConfig,
    ConnectionStatus, Exit, MediaBody, MediaSource, MessageWithParts, Page, Send, SourceSender,
    Stamped, Start, TerminalSource, ThreadFacts, ThreadRef, Transcript, Verb, VerbError,
};
use crate::wire::{Accepted, Born};

/// one cmx2 daemon, for one `[[cmx2]]` (or `[[host]]`) connection.
#[derive(Debug)]
pub struct Cmx2Source {
    config: ConnectionConfig,
    host: Arc<HostConfig>,
    pub(crate) client: reqwest::Client,
    status: Arc<watch::Sender<HostStatus>>,
    counters: Arc<Counters>,
    agents: watch::Sender<Vec<AgentFacts>>,
    /// the media store: a send's attachments are read from it.
    pub(crate) media: crate::media::Media,
    /// the memory photos may take while their `data:` urls are built,
    /// shared by every cmx2 source.
    pub(crate) photos: Arc<tokio::sync::Semaphore>,
}

impl Cmx2Source {
    pub(super) fn new(
        host: Arc<HostConfig>,
        client: reqwest::Client,
        status: Arc<watch::Sender<HostStatus>>,
        counters: Arc<Counters>,
        shared: &Shared,
    ) -> Self {
        let (agents, _) = watch::channel(vec![translate::agent(&host.name)]);
        Self {
            config: ConnectionConfig::Cmx2((*host).clone()),
            host,
            client,
            status,
            counters,
            agents,
            media: shared.media.clone(),
            photos: Arc::clone(&shared.photos),
        }
    }

    /// the daemon as configured, credential included; it never leaves the server.
    #[must_use]
    pub fn host(&self) -> &Arc<HostConfig> {
        &self.host
    }

    /// the host's name: the connection's, and its one agent's key.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.host.name
    }

    /// publishes the agent with other capabilities: for the capability
    /// check's tests, which need a cmx2 agent that lacks one.
    #[cfg(test)]
    pub fn publish(&self, agent: AgentFacts) {
        self.agents.send_replace(vec![agent]);
    }
}

/// what every cmx2 source shares: the media store its sends read from, and
/// the photo budget.
#[derive(Debug, Clone)]
pub struct Shared {
    pub media: crate::media::Media,
    pub photos: Arc<tokio::sync::Semaphore>,
}

impl Shared {
    #[must_use]
    pub fn new(media: crate::media::Media) -> Self {
        Self {
            media,
            photos: Arc::new(tokio::sync::Semaphore::new(crate::http::PHOTO_BUDGET_MIB)),
        }
    }
}

#[allow(
    dead_code,
    reason = "contract 2's hydration routes call these (m9, the journals lane)"
)]
fn not_built<'a, T: std::marker::Send + 'a>(what: &'static str) -> Verb<'a, T> {
    Box::pin(std::future::ready(Err(VerbError::NotBuilt(what))))
}

impl AgentSource for Cmx2Source {
    fn connection(&self) -> &ConnectionConfig {
        &self.config
    }

    fn agents(&self) -> watch::Receiver<Vec<AgentFacts>> {
        self.agents.subscribe()
    }

    fn run(
        self: Arc<Self>,
        fleet: SourceSender,
        shutdown: CancellationToken,
    ) -> BoxFuture<'static, Exit> {
        Box::pin(async move {
            Watcher::new(
                Arc::clone(&self.host),
                self.client.clone(),
                Arc::clone(&self.status),
                Arc::clone(&self.counters),
                fleet,
                shutdown,
            )
            .run()
            .await;
            Exit::Stopped
        })
    }

    // contract 2's hydration translates message by message; it comes with
    // the journals (m9, the neutral wire). contract 1 reads through `Cmx2Raw`.
    fn transcript(&self, _thread: &ThreadRef, _page: Page) -> Verb<'_, Transcript> {
        not_built("contract 2's hydration of a cmx2 thread")
    }

    fn message(&self, _thread: &ThreadRef, _message: &str) -> Verb<'_, Stamped<MessageWithParts>> {
        not_built("contract 2's hydration of a cmx2 message")
    }

    fn thread(&self, _thread: &ThreadRef) -> Verb<'_, ThreadFacts> {
        not_built("contract 2's read of one cmx2 thread")
    }

    fn prompt(&self, thread: &ThreadRef, send: Send) -> Verb<'_, Accepted> {
        let thread = thread.clone();
        Box::pin(async move { self.typed_prompt(&thread, send).await })
    }

    fn abort(&self, thread: &ThreadRef) -> Verb<'_, ()> {
        let thread = thread.clone();
        Box::pin(async move { self.typed_abort(&thread).await })
    }

    fn start(&self, agent: &str, start: Start) -> Verb<'_, Born> {
        let agent = agent.to_owned();
        Box::pin(async move { self.typed_start(&agent, start).await })
    }

    fn answer(&self, ask: &AskRef, answer: Answer) -> Verb<'_, ()> {
        let ask = ask.clone();
        Box::pin(async move { self.typed_answer(&ask, answer).await })
    }

    fn archive(&self, thread: &ThreadRef) -> Verb<'_, Archived> {
        let thread = thread.clone();
        Box::pin(async move { self.typed_archive(&thread).await })
    }

    fn queue(&self, thread: &ThreadRef, send: Send) -> Verb<'_, Accepted> {
        let thread = thread.clone();
        Box::pin(async move { self.typed_queue(&thread, send).await })
    }

    fn run_now(&self, thread: &ThreadRef) -> Verb<'_, ()> {
        let thread = thread.clone();
        Box::pin(async move { self.typed_run_now(&thread).await })
    }

    fn unsend(&self, thread: &ThreadRef, message: &str) -> Verb<'_, ()> {
        let (thread, message) = (thread.clone(), message.to_owned());
        Box::pin(async move { self.typed_unsend(&thread, &message).await })
    }

    fn steer(&self, thread: &ThreadRef, send: Send) -> Verb<'_, Accepted> {
        let thread = thread.clone();
        Box::pin(async move { self.typed_steer(&thread, send).await })
    }

    fn compact(&self, thread: &ThreadRef) -> Verb<'_, ()> {
        let thread = thread.clone();
        Box::pin(async move { self.typed_compact(&thread).await })
    }

    fn catalog(&self, _agent: &str, _directory: Option<&str>) -> Verb<'_, Catalog> {
        Box::pin(self.typed_catalog())
    }

    fn adopt(&self, thread: &ThreadRef) -> Verb<'_, ThreadFacts> {
        let thread = thread.clone();
        Box::pin(async move { self.typed_adopt(&thread).await })
    }

    fn connection_status(&self) -> ConnectionStatus {
        let mut status = self.status.borrow().clone();
        status.frames = super::FrameCounts {
            decoded: self
                .counters
                .decoded
                .load(std::sync::atomic::Ordering::Relaxed),
            undecodable: self
                .counters
                .undecodable
                .load(std::sync::atomic::Ordering::Relaxed),
            duplicates: self
                .counters
                .duplicates
                .load(std::sync::atomic::Ordering::Relaxed),
        };
        translate::connection(status)
    }

    fn mark_read(&self, _thread: &ThreadRef, _at: f64) -> Verb<'_, ()> {
        // cmx2 keeps no read state; boxbox's own marks are the fleet's
        Box::pin(std::future::ready(Ok(())))
    }

    fn media(&self, _source: &MediaSource) -> Verb<'_, MediaBody> {
        // cmx2's files travel inline as data urls (decision 32)
        Box::pin(std::future::ready(Err(VerbError::Missing {
            what: "media",
        })))
    }

    fn terminal(&self) -> Option<&dyn TerminalSource> {
        Some(self)
    }

    fn cmx2_raw(&self) -> Option<&Cmx2Raw> {
        Some(self)
    }
}

impl TerminalSource for Cmx2Source {
    fn host(&self) -> &HostConfig {
        &self.host
    }
}
