//! the upstream side: one watcher task per configured cmx2 host, owned by
//! a supervisor that starts and stops them as the host config changes.
//!
//! a watcher owns its host's connection, cursor, backoff and counters. it
//! publishes the host's state on a `watch` channel (a single slot, written
//! only on state changes) and counts frames in atomics, so reading
//! `GET /api/hosts` never contends with the event path. events go to the
//! fleet actor, which owns everything derived from them. one more task
//! reads the window tails the fleet asks for (`tails.rs`), a few at a time
//! per host.

pub mod backoff;
mod memory;
pub mod paired;
pub mod reconcile;
pub mod source;
pub mod sse;
mod tails;
mod watcher;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use utoipa::ToSchema;

use crate::config::{Credential, HostConfig, Origin};
use crate::fleet::Upstream;
use crate::fleet::model::TailRequest;
use crate::source::{AgentSource, ConnectionConfig, Exit, SourceSender};
pub use memory::Memory;

/// what `GET /api/hosts` says about one host.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    /// the host's name, from `boxbox.toml` or given when it was paired.
    pub name: String,
    /// the daemon's address (never its credential).
    pub url: String,
    pub origin: Origin,
    pub connection: Connection,
    /// when `connection` last changed, ms since the epoch.
    pub since: i64,
    /// the last `/global/health` answer; kept while the host is down so the
    /// ui can say which version was last seen.
    pub health: Option<Health>,
    /// why the last connection ended or failed, in plain words.
    pub last_error: Option<String>,
    /// connections made since the server started.
    pub connects: u64,
    pub frames: FrameCounts,
    /// the daemon's own memory report, sampled while connected; null until
    /// the first sample, and for a daemon that does not report it.
    pub memory: Option<Memory>,
    /// the watcher's cursor, `<epoch>:<seq>`, as of the last connection
    /// change: where that connection resumed from, or where the one before
    /// it stopped. null before the host was first read.
    pub cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    /// dialling, or waiting out the backoff before the next dial.
    Connecting,
    /// the event stream is open and bytes are arriving.
    Connected,
    /// the last attempt failed; the watcher will try again.
    Down,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub healthy: bool,
    pub version: String,
    /// the contract version the daemon speaks.
    pub contract: i64,
    /// whether that is the contract boxbox's types were generated from.
    pub contract_matches: bool,
    /// when this answer arrived, ms since the epoch.
    pub checked_at: i64,
    pub latency_ms: u64,
}

/// frames read from the host since the server started.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FrameCounts {
    pub decoded: u64,
    /// frames that did not decode into the generated `Event` union, or were
    /// over the frame cap; each was logged and skipped.
    pub undecodable: u64,
    /// events a resume replayed at or below the cursor, dropped so none
    /// applies twice.
    pub duplicates: u64,
}

#[derive(Debug, Default)]
struct Counters {
    decoded: AtomicU64,
    undecodable: AtomicU64,
    duplicates: AtomicU64,
}

/// the read side of one watcher, held by the http layer.
#[derive(Debug, Clone)]
pub struct HostView {
    /// the host as configured, credential included; it never leaves the server.
    pub config: Arc<HostConfig>,
    /// the connection's source: contract 1's routes call the daemon through it.
    pub source: Arc<source::Cmx2Source>,
    status: watch::Receiver<HostStatus>,
    memory: watch::Receiver<Option<Memory>>,
    counters: Arc<Counters>,
}

impl HostView {
    #[must_use]
    pub fn snapshot(&self) -> HostStatus {
        let mut status = self.status.borrow().clone();
        status.memory = *self.memory.borrow();
        status.frames = FrameCounts {
            decoded: self.counters.decoded.load(Ordering::Relaxed),
            undecodable: self.counters.undecodable.load(Ordering::Relaxed),
            duplicates: self.counters.duplicates.load(Ordering::Relaxed),
        };
        status
    }
}

#[cfg(test)]
impl HostView {
    /// a host with no watcher behind it, whose agent publishes `capabilities`:
    /// for the routes' tests, which judge what happens before the daemon.
    #[must_use]
    pub fn detached(config: HostConfig, capabilities: crate::wire::Capabilities) -> Self {
        let config = Arc::new(config);
        let (sender, status) = watch::channel(HostStatus {
            name: config.name.clone(),
            url: config.url.to_string(),
            origin: config.origin,
            connection: Connection::Connecting,
            since: 0,
            health: None,
            last_error: None,
            connects: 0,
            frames: FrameCounts::default(),
            memory: None,
            cursor: None,
        });
        let counters = Arc::new(Counters::default());
        let source = Arc::new(source::Cmx2Source::new(
            Arc::clone(&config),
            reqwest::Client::new(),
            Arc::new(sender),
            Arc::clone(&counters),
            &source::Shared::new(crate::media::Media::detached()),
        ));
        let mut agent = crate::source::cmx2::translate::agent(&config.name);
        agent.capabilities = capabilities;
        source.publish(agent);
        Self {
            config,
            source,
            status,
            memory: watch::channel(None).1,
            counters,
        }
    }
}

/// the hosts being watched now, in config order.
pub type Hosts = Arc<[HostView]>;

/// the running sources that are not cmx2 (openclaw, hermes), in config
/// order.
pub type Sources = Arc<[Arc<dyn AgentSource>]>;

/// a name a paired host may not take: a configured openclaw or hermes
/// connection's, or an agent key one of them pins (`agents.md`, section 3,
/// collisions: configured names always win).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reserved {
    pub name: String,
    /// what holds it, as a person reads it: `[[openclaw]] "vm-b"`.
    pub holder: String,
}

/// the names the configured openclaw and hermes connections hold.
#[must_use]
pub fn reserved(connections: &[ConnectionConfig]) -> Vec<Reserved> {
    let mut names = Vec::new();
    for connection in connections {
        let table = match connection {
            ConnectionConfig::Cmx2(_) => continue,
            ConnectionConfig::Openclaw(_) => "openclaw",
            ConnectionConfig::Hermes(_) => "hermes",
        };
        names.push(Reserved {
            name: connection.name().to_owned(),
            holder: format!("[[{table}]] \"{}\"", connection.name()),
        });
        if let ConnectionConfig::Openclaw(openclaw) = connection {
            for (foreign, agent) in &openclaw.agents {
                if let Some(key) = &agent.key {
                    names.push(Reserved {
                        name: key.clone(),
                        holder: format!(
                            "the key of agent \"{foreign}\" on [[openclaw]] \"{}\"",
                            openclaw.name
                        ),
                    });
                }
            }
        }
    }
    names
}

/// what the rest of the server holds: the current hosts and other sources,
/// the names they reserve, and a way to hand the supervisor a change.
#[derive(Debug, Clone)]
pub struct Upstreams {
    pub hosts: watch::Receiver<Hosts>,
    /// the sources that are not cmx2; the supervisor publishes them as their
    /// sources are built in (the openclaw lane, m9).
    pub others: watch::Receiver<Sources>,
    /// the names configured openclaw and hermes connections hold.
    pub reserved: watch::Receiver<Arc<[Reserved]>>,
    pub reload: mpsc::Sender<HostChange>,
}

impl Upstreams {
    /// every running source, one per connection: the cmx2 ones in config
    /// order, then the others.
    #[must_use]
    pub fn sources(&self) -> Vec<Arc<dyn AgentSource>> {
        let mut sources: Vec<Arc<dyn AgentSource>> = self
            .hosts
            .borrow()
            .iter()
            .map(|h| Arc::clone(&h.source) as Arc<dyn AgentSource>)
            .collect();
        sources.extend(self.others.borrow().iter().cloned());
        sources
    }

    /// the reservation that holds `name`, if one does.
    #[must_use]
    pub fn reservation(&self, name: &str) -> Option<Reserved> {
        self.reserved
            .borrow()
            .iter()
            .find(|r| r.name == name)
            .cloned()
    }

    /// a fixed set of hosts and sources with no supervisor behind them, for
    /// the routes' tests.
    #[cfg(test)]
    #[must_use]
    pub fn fixed(
        hosts: Vec<HostView>,
        others: Vec<Arc<dyn AgentSource>>,
        reserved: Vec<Reserved>,
    ) -> Self {
        let (published, hosts) = watch::channel::<Hosts>(Arc::from(hosts));
        let (offered, others) = watch::channel::<Sources>(Arc::from(others));
        let (held, reserved) = watch::channel::<Arc<[Reserved]>>(Arc::from(reserved));
        // the routes read these for as long as the test runs
        std::mem::forget((published, offered, held));
        Self {
            hosts,
            others,
            reserved,
            reload: mpsc::channel(1).0,
        }
    }
}

/// a change to the hosts, from either source. the config file sends its
/// whole list (it is read whole); pairing sends one host at a time, so two
/// pairings in flight can never overwrite each other.
#[derive(Debug)]
pub enum HostChange {
    /// the file's cmx2 hosts, and its other connections (whose names a
    /// paired host may not take).
    Configured {
        hosts: Vec<HostConfig>,
        others: Vec<ConnectionConfig>,
    },
    Paired(HostConfig),
    Forgotten(String),
}

/// starts the supervisor, a watcher per host, and the reader of the window
/// tails the fleet asks for. everything stops when `shutdown` fires; the
/// handle finishes once every watcher and the reader have.
#[must_use]
#[allow(
    clippy::too_many_arguments,
    reason = "everything the supervisor owns arrives once, at startup"
)]
pub fn spawn(
    hosts: Vec<HostConfig>,
    connections: &[ConnectionConfig],
    paired: Vec<HostConfig>,
    shared: source::Shared,
    client: reqwest::Client,
    fleet: mpsc::Sender<Upstream>,
    tails: mpsc::Receiver<TailRequest>,
    store: &crate::store::Store,
    shutdown: CancellationToken,
) -> (Upstreams, JoinHandle<()>) {
    // cmx2 connections run from \`hosts\` (and the paired ones); the others
    // each get their own source under the same supervision, published for
    // the routes through `Upstreams.others`
    let mut sources: Vec<Arc<dyn AgentSource>> = Vec::new();
    let mut tasks = Vec::new();
    for other in connections
        .iter()
        .filter(|c| !matches!(c, ConnectionConfig::Cmx2(_)))
    {
        // the hermes source is m10's
        let ConnectionConfig::Openclaw(config) = other else {
            warn!(
                connection = other.name(),
                source = other.source().as_str(),
                url = %other.url(),
                "no source of this kind is built into this server yet; the connection is not run"
            );
            continue;
        };
        match crate::openclaw::source::OpenclawSource::new(config.clone(), store.clone()) {
            Ok(source) => {
                info!(connection = %config.name, url = %config.url, "running an openclaw connection");
                let events = SourceSender::new(Arc::from(config.name.as_str()), fleet.clone());
                let source = Arc::new(source) as Arc<dyn AgentSource>;
                sources.push(Arc::clone(&source));
                tasks.push(tokio::spawn(supervise(
                    source,
                    events,
                    shutdown.child_token(),
                )));
            }
            Err(error) => {
                warn!(connection = %config.name, %error, "the openclaw connection cannot start");
            }
        }
    }
    let (published, current) = watch::channel::<Hosts>(Arc::from(Vec::new()));
    let (offered, others) = watch::channel::<Sources>(Arc::from(sources));
    let (held, reserved_names) =
        watch::channel::<Arc<[Reserved]>>(Arc::from(reserved(connections)));
    // a config change is rare; a second one while the first applies waits
    let (reload, changes) = mpsc::channel(4);
    let reader = tokio::spawn(tails::run(
        tails,
        current.clone(),
        client.clone(),
        fleet.clone(),
        shutdown.clone(),
    ));
    let mut supervisor = Supervisor {
        client,
        fleet,
        shutdown,
        configured: hosts,
        paired,
        running: Vec::new(),
        published,
        offered,
        held,
        shared,
    };
    supervisor.apply();
    let task = tokio::spawn(async move {
        supervisor.run(changes).await;
        for task in tasks {
            let _ = task.await;
        }
        let _ = reader.await;
    });
    (
        Upstreams {
            hosts: current,
            others,
            reserved: reserved_names,
            reload,
        },
        task,
    )
}

#[derive(Debug)]
struct Running {
    view: HostView,
    stop: CancellationToken,
    task: JoinHandle<()>,
}

#[derive(Debug)]
struct Supervisor {
    client: reqwest::Client,
    fleet: mpsc::Sender<Upstream>,
    shutdown: CancellationToken,
    /// the hosts `boxbox.toml` names, in its order.
    configured: Vec<HostConfig>,
    /// the hosts paired from the app, oldest first.
    paired: Vec<HostConfig>,
    running: Vec<Running>,
    published: watch::Sender<Hosts>,
    /// the other sources, published for the routes (the openclaw lane fills it).
    #[allow(
        dead_code,
        reason = "the openclaw source publishes through it (m9, the openclaw lane)"
    )]
    offered: watch::Sender<Sources>,
    /// the names the file's other connections hold.
    held: watch::Sender<Arc<[Reserved]>>,
    shared: source::Shared,
}

impl Supervisor {
    async fn run(mut self, mut changes: mpsc::Receiver<HostChange>) {
        loop {
            tokio::select! {
                biased;
                () = self.shutdown.cancelled() => break,
                Some(change) = changes.recv() => {
                    match change {
                        HostChange::Configured { hosts, others } => {
                            self.configured = hosts;
                            self.held.send_replace(Arc::from(reserved(&others)));
                        }
                        HostChange::Paired(host) => {
                            self.paired.retain(|h| h.name != host.name);
                            self.paired.push(host);
                        }
                        HostChange::Forgotten(name) => self.paired.retain(|h| h.name != name),
                    }
                    self.apply();
                }
                else => break,
            }
        }
        for running in self.running {
            let _ = running.task.await;
        }
    }

    /// the configured hosts, then the paired ones. pairing refuses a name
    /// already taken, so a clash means `boxbox.toml` gained the name later
    /// (a `[[cmx2]]`, or an `[[openclaw]]` or `[[hermes]]` connection or a
    /// key one pins): the file wins and the paired host waits, said once per
    /// change.
    fn merged(&self) -> Vec<HostConfig> {
        let mut hosts = self.configured.clone();
        let reserved = self.held.borrow().clone();
        for host in &self.paired {
            if hosts.iter().any(|h| h.name == host.name) {
                warn!(host = %host.name, "a paired host shares its name with one in boxbox.toml; the file wins until one is renamed");
            } else if let Some(taken) = reserved.iter().find(|r| r.name == host.name) {
                warn!(host = %host.name, holder = %taken.holder, "a paired host's name is held by a connection in boxbox.toml; the file wins and the paired host is not watched until one is renamed");
            } else {
                hosts.push(host.clone());
            }
        }
        hosts
    }

    /// keeps each watcher whose host is unchanged, stops the rest and
    /// starts the new ones. a host whose url or credential changed gets a
    /// fresh watcher, which reads it afresh.
    fn apply(&mut self) {
        let hosts = self.merged();
        let mut kept: Vec<Running> = Vec::with_capacity(hosts.len());
        let mut previous = std::mem::take(&mut self.running);
        for host in hosts {
            if let Some(at) = previous.iter().position(|r| *r.view.config == host) {
                kept.push(previous.swap_remove(at));
                continue;
            }
            if let Some(at) = previous
                .iter()
                .position(|r| r.view.config.name == host.name)
            {
                let changed = previous.swap_remove(at);
                info!(host = %host.name, url = %host.url, "host changed; restarting its watcher");
                changed.stop.cancel();
            } else {
                info!(host = %host.name, url = %host.url, "watching a new host");
            }
            kept.push(self.start(host));
        }
        for gone in previous {
            info!(host = %gone.view.config.name, "host left the config or was forgotten; its watcher stops");
            gone.stop.cancel();
            // the fleet drops the host; if it is stopping too, nothing needs telling
            let _ = self
                .fleet
                .try_send(Upstream::HostRemoved(gone.view.config.name.clone()));
        }
        self.running = kept;
        let views: Vec<HostView> = self.running.iter().map(|r| r.view.clone()).collect();
        self.published.send_replace(Arc::from(views));
    }

    fn start(&self, host: HostConfig) -> Running {
        let counters = Arc::new(Counters::default());
        let config = Arc::new(host);
        let (sender, status) = watch::channel(HostStatus {
            name: config.name.clone(),
            url: config.url.to_string(),
            origin: config.origin,
            connection: Connection::Connecting,
            since: crate::now_ms(),
            health: None,
            last_error: None,
            connects: 0,
            frames: FrameCounts::default(),
            memory: None,
            cursor: None,
        });
        let stop = self.shutdown.child_token();
        let (memory_sender, memory) = watch::channel(None);
        tokio::spawn(memory::sample(
            Arc::clone(&config),
            self.client.clone(),
            status.clone(),
            memory_sender,
            stop.clone(),
        ));
        let source = Arc::new(source::Cmx2Source::new(
            Arc::clone(&config),
            self.client.clone(),
            Arc::new(sender),
            Arc::clone(&counters),
            &self.shared,
        ));
        let events = SourceSender::new(Arc::from(config.name.as_str()), self.fleet.clone());
        let task = tokio::spawn(supervise(
            Arc::clone(&source) as Arc<dyn AgentSource>,
            events,
            stop.clone(),
        ));
        Running {
            view: HostView {
                config,
                source,
                status,
                memory,
                counters,
            },
            stop,
            task,
        }
    }
}

/// runs one connection's source until its token fires. a source that asks
/// to retry, or panics, runs again after the jittered backoff; one that
/// refuses waits for the config to change (its token). a source never
/// takes another down.
async fn supervise(source: Arc<dyn AgentSource>, events: SourceSender, stop: CancellationToken) {
    let name = source.connection().name().to_owned();
    let mut backoff = backoff::Backoff::new(watcher::BACKOFF_FLOOR, watcher::BACKOFF_CAP);
    loop {
        let run = tokio::spawn(Arc::clone(&source).run(events.clone(), stop.clone()));
        let exit = match run.await {
            Ok(exit) => exit,
            Err(error) if error.is_panic() => Exit::Retry {
                why: "the source panicked".to_owned(),
            },
            Err(_) => Exit::Stopped,
        };
        match exit {
            Exit::Stopped => break,
            Exit::Retry { why } => {
                let delay = backoff.next_delay();
                warn!(connection = %name, why, retry_in_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX), "a source stopped; it runs again after the backoff");
                tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    () = tokio::time::sleep(delay) => {}
                }
            }
            Exit::Refused { why } => {
                warn!(connection = %name, why, "a source refused its connection; it waits for the config to change");
                stop.cancelled().await;
                break;
            }
        }
    }
}

/// the daemon's url with `route` appended to its path, so a daemon served
/// under a prefix keeps it. a query in `route` becomes the url's query;
/// given to `set_path` it would be escaped into the path.
#[must_use]
pub fn route_url(base: &Url, route: &str) -> Url {
    let (path, query) = route
        .split_once('?')
        .map_or((route, None), |(path, query)| (path, Some(query)));
    let mut url = base.clone();
    url.set_path(&format!("{}{path}", base.path().trim_end_matches('/')));
    url.set_query(query);
    url
}

/// a `GET` of `route` on the host, with its credential when it has one.
pub fn get(client: &reqwest::Client, host: &HostConfig, route: &str) -> reqwest::RequestBuilder {
    request(client, host, reqwest::Method::GET, route)
}

/// a request of `route` on the host, with its credential when it has one.
pub fn request(
    client: &reqwest::Client,
    host: &HostConfig,
    method: reqwest::Method,
    route: &str,
) -> reqwest::RequestBuilder {
    let request = client.request(method, route_url(&host.url, route));
    match host.credential.as_ref().and_then(Credential::header) {
        Some(value) => request.header(reqwest::header::AUTHORIZATION, value),
        None => request,
    }
}

/// a request failure in plain words. reqwest's own message ("error sending
/// request for url (...)") hides the cause, which is the part a person at
/// 2 am needs, so this names the kind and the innermost cause.
#[must_use]
pub fn plain(error: &reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = error;
    while let Some(next) = cause.source() {
        cause = next;
    }
    let cause = cause.to_string().to_lowercase();
    if error.is_connect() {
        format!("cannot connect ({cause})")
    } else if error.is_timeout() {
        "timed out".into()
    } else if error.is_body() || error.is_decode() {
        format!("the connection dropped mid-answer ({cause})")
    } else {
        cause
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_append_to_the_daemon_url() {
        let at = |base: &str| route_url(&Url::parse(base).unwrap(), "/global/event").to_string();
        assert_eq!(
            at("http://127.0.0.1:4840"),
            "http://127.0.0.1:4840/global/event"
        );
        assert_eq!(
            at("http://127.0.0.1:4840/"),
            "http://127.0.0.1:4840/global/event"
        );
        assert_eq!(
            at("https://vm.example/cmx2/"),
            "https://vm.example/cmx2/global/event"
        );
    }
}
