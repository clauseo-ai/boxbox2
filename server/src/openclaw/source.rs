//! the openclaw connection behind the seam's `AgentSource` trait, so the
//! supervisor runs every `[[openclaw]]` entry.
//!
//! this phase runs the connection only: it dials, pairs, keeps its device
//! token and reconnects, and its state is on `Client::state`. it publishes
//! no agents yet, so nothing reaches the fleet (every fleet event names an
//! agent); agents, snapshots and the verbs come with the sync engine,
//! which takes the event stream this source drains for now.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use tokio::sync::{Mutex, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use super::client::{Client, Event, Events, RequestError};
use super::connection::{Connection, TlsSetupError, open};
use crate::source::{
    AgentFacts, AgentSource, ConnectionConfig, ConnectionStatus, Exit, MediaBody, MediaSource,
    MessageWithParts, OpenclawConfig, Page, Send, SourceSender, Stamped, ThreadFacts, ThreadRef,
    Transcript, Verb, VerbError,
};
use crate::store::Store;
use crate::upstream::FrameCounts;
use crate::wire::Accepted;

/// one openclaw gateway, as the supervisor holds it.
pub struct OpenclawSource {
    config: ConnectionConfig,
    /// the same entry, unwrapped, for the status mapping.
    entry: OpenclawConfig,
    client: Client,
    agents: watch::Sender<Vec<AgentFacts>>,
    /// the task's own half; `run` holds it while the connection runs, and
    /// the supervisor never runs one source twice at once.
    task: Mutex<(Connection, Events)>,
}

impl std::fmt::Debug for OpenclawSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenclawSource")
            .field("name", &self.config.name())
            .finish_non_exhaustive()
    }
}

impl OpenclawSource {
    /// the constructor the supervisor calls for an `[[openclaw]]` entry.
    ///
    /// # Errors
    /// the platform's tls settings did not build.
    pub fn new(config: OpenclawConfig, store: Store) -> Result<Self, TlsSetupError> {
        let (client, events, connection) = open(config.clone(), store)?;
        Ok(Self {
            config: ConnectionConfig::Openclaw(config.clone()),
            entry: config,
            client,
            agents: watch::channel(Vec::new()).0,
            task: Mutex::new((connection, events)),
        })
    }

    /// requests, and the connection's state.
    #[must_use]
    pub fn client(&self) -> &Client {
        &self.client
    }
}

fn not_built<'a, T: std::marker::Send + 'a>() -> Verb<'a, T> {
    Box::pin(std::future::ready(Err(VerbError::NotBuilt(
        "openclaw threads arrive with the openclaw sync engine",
    ))))
}

impl AgentSource for OpenclawSource {
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
            let _ = fleet;
            let mut task = self.task.lock().await;
            let (connection, events) = &mut *task;
            let name = self.config.name().to_owned();
            let drain = async {
                while let Some(event) = events.recv().await {
                    match event {
                        Event::Connected(hello) => {
                            info!(connection = %name, restarted = hello.restarted, "openclaw hello accepted");
                        }
                        Event::Disconnected { why } => {
                            debug!(connection = %name, why, "openclaw socket gone");
                        }
                        Event::Frame(_) => {}
                    }
                }
            };
            tokio::select! {
                exit = connection.run(shutdown) => exit,
                () = drain => Exit::Stopped,
            }
        })
    }

    fn transcript(&self, _: &ThreadRef, _: Page) -> Verb<'_, Transcript> {
        not_built()
    }

    fn message(&self, _: &ThreadRef, _: &str) -> Verb<'_, Stamped<MessageWithParts>> {
        not_built()
    }

    fn thread(&self, _: &ThreadRef) -> Verb<'_, ThreadFacts> {
        not_built()
    }

    fn prompt(&self, _: &ThreadRef, _: Send) -> Verb<'_, Accepted> {
        not_built()
    }

    fn abort(&self, _: &ThreadRef) -> Verb<'_, ()> {
        not_built()
    }

    fn mark_read(&self, _: &ThreadRef, _: f64) -> Verb<'_, ()> {
        not_built()
    }

    fn media(&self, _: &MediaSource) -> Verb<'_, MediaBody> {
        not_built()
    }

    /// the pairing state machine as the agents screen reads it. connected
    /// is `syncing` until the sync engine says every window has its read,
    /// which this phase never does.
    fn connection_status(&self) -> ConnectionStatus {
        self.client
            .state()
            .borrow()
            .connection_status(&self.entry, false, FrameCounts::default())
    }
}

/// a request's failure, as a verb answers it (the verbs phase refines
/// this as it learns each method's answers).
impl From<RequestError> for VerbError {
    fn from(error: RequestError) -> Self {
        match error {
            RequestError::Busy { .. } => Self::Busy,
            RequestError::Watch { .. } | RequestError::NoAdmin { .. } => Self::Refused {
                status: 403,
                words: error.to_string(),
            },
            RequestError::Unsupported { method } => Self::Refused {
                status: 422,
                words: format!("the gateway does not offer {method}"),
            },
            RequestError::Gateway { ref error, .. } => Self::Refused {
                status: 502,
                words: error.message.clone(),
            },
            RequestError::NotConnected
            | RequestError::Timeout { .. }
            | RequestError::Lost { .. }
            | RequestError::Stopped => Self::Unreachable {
                reason: error.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::AgentStatus;

    #[tokio::test]
    async fn the_status_is_the_connections_own_and_says_the_pin() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let config = OpenclawConfig {
            name: "vm-b".into(),
            url: "ws://127.0.0.1:1".parse().expect("url"),
            token_file: "/nonexistent".into(),
            device_key: None,
            mode: crate::source::OpenclawMode::Full,
            machine: None,
            agents: std::collections::BTreeMap::new(),
            origin: crate::config::Origin::Config,
        };
        let source = OpenclawSource::new(config, store).expect("tls builds");
        let status = source.connection_status();
        assert_eq!(status.status, AgentStatus::Connecting);
        assert_eq!(status.connection.name, "vm-b");
        assert_eq!(
            status.connection.pinned.as_deref(),
            Some(super::super::protocol::PINNED_VERSION)
        );
        assert!(status.host.is_none());
        drop(source);
        thread.join().expect("store stops");
        std::fs::remove_dir_all(dir).expect("cleanup");
    }
}
