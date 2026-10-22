//! a scripted source for the route tests: an assistant that publishes the
//! capabilities a test gives it, records every verb that reaches it, and
//! answers sends as the test scripts them (accepted, a lost
//! acknowledgement, a refusal, slowly). what it proves is how the routes
//! route and refuse, never how a real runtime behaves (`AGENTS.md`,
//! integration tests run against a real daemon).

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{
    AgentFacts, AgentSource, Archived, AskRef, Catalog, CatalogModel, ConnectionConfig, Exit,
    HistoryPage, HistoryQuery, MediaBody, MediaSource, MessageWithParts, OpenclawConfig,
    OpenclawMode, Page, Send, SourceSender, Stamped, Start, ThreadFacts, ThreadRef, Transcript,
    Verb, VerbError,
};
use crate::config::Origin;
use crate::wire::{Accepted, AcceptedState, Born, Capabilities, Kind, Place};

/// how the source answers the next send.
#[derive(Debug, Clone)]
pub enum Scripted {
    Accept,
    /// the acknowledgement was lost: `checking`.
    LostAck,
    /// refused by the agent: nothing reached it.
    Refuse,
    /// could not reach the agent.
    Unreachable,
    /// answers after a while.
    Slow(Duration, Box<Scripted>),
}

/// a scripted assistant on a connection named `vm-b`.
#[derive(Debug)]
pub struct ScriptedSource {
    config: ConnectionConfig,
    agents: watch::Sender<Vec<AgentFacts>>,
    /// every verb that reached it, as `verb agent:thread`.
    pub calls: Mutex<Vec<String>>,
    /// what the next sends answer; `Accept` once it runs out.
    pub script: Mutex<VecDeque<Scripted>>,
    /// the generation its threads are at; a send naming another is refused.
    pub generation: Option<String>,
}

impl ScriptedSource {
    #[must_use]
    pub fn new(key: &str, capabilities: Capabilities) -> Arc<Self> {
        let config = ConnectionConfig::Openclaw(OpenclawConfig {
            name: "vm-b".into(),
            url: reqwest::Url::parse("ws://127.0.0.1:9").unwrap(),
            token_file: "/tmp/boxbox-scripted.token".into(),
            device_key: None,
            mode: OpenclawMode::Full,
            machine: None,
            agents: BTreeMap::new(),
            origin: Origin::Config,
        });
        let facts = super::identity::foreign(
            &config,
            "main",
            key.to_owned(),
            Kind::Assistant,
            Some("assistant"),
            capabilities,
        );
        Arc::new(Self {
            config,
            agents: watch::channel(vec![facts]).0,
            calls: Mutex::new(Vec::new()),
            script: Mutex::new(VecDeque::new()),
            generation: Some("g1".into()),
        })
    }

    pub fn script(&self, answers: impl IntoIterator<Item = Scripted>) {
        self.script.lock().unwrap().extend(answers);
    }

    #[must_use]
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn called(&self, verb: &str, on: &str) {
        self.calls.lock().unwrap().push(format!("{verb} {on}"));
    }

    fn ok<'a, T: std::marker::Send + 'a>(&self, verb: &str, on: &str, value: T) -> Verb<'a, T> {
        self.called(verb, on);
        Box::pin(std::future::ready(Ok(value)))
    }

    fn answer_send<'a>(
        &'a self,
        verb: &str,
        thread: &ThreadRef,
        send: &Send,
    ) -> Verb<'a, Accepted> {
        self.called(verb, &thread.key());
        if send
            .generation
            .as_ref()
            .is_some_and(|g| Some(g) != self.generation.as_ref())
        {
            return Box::pin(std::future::ready(Err(VerbError::GenerationChanged)));
        }
        let next = self
            .script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Scripted::Accept);
        Box::pin(play(next))
    }
}

fn play(script: Scripted) -> BoxFuture<'static, Result<Accepted, VerbError>> {
    Box::pin(async move {
        match script {
            Scripted::Accept => Ok(Accepted {
                state: AcceptedState::Accepted,
                message: Some("m_scripted".into()),
            }),
            Scripted::LostAck => Ok(Accepted {
                state: AcceptedState::Checking,
                message: None,
            }),
            Scripted::Refuse => Err(VerbError::Refused {
                status: 400,
                words: "the gateway refused it".into(),
            }),
            Scripted::Unreachable => Err(VerbError::Unreachable {
                reason: "socket closed".into(),
            }),
            Scripted::Slow(wait, then) => {
                tokio::time::sleep(wait).await;
                play(*then).await
            }
        }
    })
}

impl AgentSource for ScriptedSource {
    fn connection(&self) -> &ConnectionConfig {
        &self.config
    }

    fn agents(&self) -> watch::Receiver<Vec<AgentFacts>> {
        self.agents.subscribe()
    }

    fn run(
        self: Arc<Self>,
        _fleet: SourceSender,
        shutdown: CancellationToken,
    ) -> BoxFuture<'static, Exit> {
        Box::pin(async move {
            shutdown.cancelled().await;
            Exit::Stopped
        })
    }

    fn transcript(&self, thread: &ThreadRef, _page: Page) -> Verb<'_, Transcript> {
        self.ok(
            "transcript",
            &thread.key(),
            Transcript {
                messages: Vec::new(),
                next: None,
                upstream: None,
            },
        )
    }

    fn message(&self, thread: &ThreadRef, _message: &str) -> Verb<'_, Stamped<MessageWithParts>> {
        self.called("message", &thread.key());
        Box::pin(std::future::ready(Err(VerbError::Missing {
            what: "message",
        })))
    }

    fn thread(&self, thread: &ThreadRef) -> Verb<'_, ThreadFacts> {
        self.called("thread", &thread.key());
        Box::pin(std::future::ready(Err(VerbError::Missing {
            what: "thread",
        })))
    }

    fn prompt(&self, thread: &ThreadRef, send: Send) -> Verb<'_, Accepted> {
        self.answer_send("prompt", thread, &send)
    }

    fn abort(&self, thread: &ThreadRef) -> Verb<'_, ()> {
        self.ok("abort", &thread.key(), ())
    }

    fn mark_read(&self, thread: &ThreadRef, _at: f64) -> Verb<'_, ()> {
        self.ok("mark_read", &thread.key(), ())
    }

    fn media(&self, source: &MediaSource) -> Verb<'_, MediaBody> {
        self.called("media", &source.agent);
        Box::pin(std::future::ready(Err(VerbError::Missing {
            what: "media",
        })))
    }

    fn start(&self, agent: &str, start: Start) -> Verb<'_, Born> {
        self.called("start", agent);
        let key = format!("{agent}:oc_scripted{}", start.send.client_id.len());
        Box::pin(std::future::ready(Ok(Born {
            thread: key
                .split_once(':')
                .map(|(_, t)| t.to_owned())
                .unwrap_or_default(),
            key,
        })))
    }

    fn answer(&self, ask: &AskRef, _answer: super::Answer) -> Verb<'_, ()> {
        self.ok("answer", &format!("{}:{}", ask.agent, ask.id), ())
    }

    fn archive(&self, thread: &ThreadRef) -> Verb<'_, Archived> {
        self.ok(
            "archive",
            &thread.key(),
            Archived {
                key: thread.key(),
                at: Some(1.0),
            },
        )
    }

    fn fork(&self, thread: &ThreadRef, before: Option<&str>) -> Verb<'_, Born> {
        self.called(
            "fork",
            &format!("{} {}", thread.key(), before.unwrap_or("whole")),
        );
        if before == Some("mGONE") {
            return Box::pin(std::future::ready(Err(VerbError::Missing { what: "turn" })));
        }
        Box::pin(std::future::ready(Ok(Born {
            key: format!("{}:oc_forked", thread.agent),
            thread: "oc_forked".into(),
        })))
    }

    fn react(&self, thread: &ThreadRef, message: &str, emoji: &str, on: bool) -> Verb<'_, ()> {
        self.ok(
            "react",
            &format!("{} {message} {emoji} {on}", thread.key()),
            (),
        )
    }

    fn queue(&self, thread: &ThreadRef, send: Send) -> Verb<'_, Accepted> {
        self.answer_send("queue", thread, &send)
    }

    fn run_now(&self, thread: &ThreadRef) -> Verb<'_, ()> {
        self.ok("run_now", &thread.key(), ())
    }

    fn unsend(&self, thread: &ThreadRef, message: &str) -> Verb<'_, ()> {
        self.ok("unsend", &format!("{} {message}", thread.key()), ())
    }

    fn catalog(&self, agent: &str, _directory: Option<&str>) -> Verb<'_, Catalog> {
        self.ok(
            "catalog",
            agent,
            Catalog {
                models: vec![CatalogModel {
                    id: "scripted/one".into(),
                    name: "one".into(),
                    provider: None,
                    levels: None,
                }],
                default: None,
            },
        )
    }

    fn history(&self, agent: &str, _query: HistoryQuery) -> Verb<'_, HistoryPage> {
        self.ok(
            "history",
            agent,
            HistoryPage {
                threads: Vec::new(),
                next: None,
            },
        )
    }

    fn adopt(&self, thread: &ThreadRef) -> Verb<'_, ThreadFacts> {
        self.called("adopt", &thread.key());
        Box::pin(std::future::ready(Err(VerbError::Missing {
            what: "thread",
        })))
    }

    fn projects(&self, agent: &str) -> Verb<'_, Vec<Place>> {
        self.ok("projects", agent, Vec::new())
    }
}
