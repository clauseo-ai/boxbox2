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
mod reconcile;
pub mod sse;
mod tails;
mod watcher;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use reqwest::Url;
use serde::Serialize;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use utoipa::ToSchema;

use crate::config::{Credential, HostConfig, Origin};
use crate::fleet::Upstream;
use crate::fleet::model::TailRequest;
pub use memory::Memory;

/// what `GET /api/hosts` says about one host.
#[derive(Clone, Debug, Serialize, ToSchema)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    /// dialling, or waiting out the backoff before the next dial.
    Connecting,
    /// the event stream is open and bytes are arriving.
    Connected,
    /// the last attempt failed; the watcher will try again.
    Down,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
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
#[derive(Clone, Copy, Debug, Default, Serialize, ToSchema)]
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

/// the hosts being watched now, in config order.
pub type Hosts = Arc<[HostView]>;

/// what the rest of the server holds: the current hosts, and a way to
/// hand the supervisor a change to them.
#[derive(Debug, Clone)]
pub struct Upstreams {
    pub hosts: watch::Receiver<Hosts>,
    pub reload: mpsc::Sender<HostChange>,
}

/// a change to the hosts, from either source. the config file sends its
/// whole list (it is read whole); pairing sends one host at a time, so two
/// pairings in flight can never overwrite each other.
#[derive(Debug)]
pub enum HostChange {
    Configured(Vec<HostConfig>),
    Paired(HostConfig),
    Forgotten(String),
}

/// starts the supervisor, a watcher per host, and the reader of the window
/// tails the fleet asks for. everything stops when `shutdown` fires; the
/// handle finishes once every watcher and the reader have.
#[must_use]
pub fn spawn(
    hosts: Vec<HostConfig>,
    paired: Vec<HostConfig>,
    client: reqwest::Client,
    fleet: mpsc::Sender<Upstream>,
    tails: mpsc::Receiver<TailRequest>,
    shutdown: CancellationToken,
) -> (Upstreams, JoinHandle<()>) {
    let (published, current) = watch::channel::<Hosts>(Arc::from(Vec::new()));
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
    };
    supervisor.apply();
    let task = tokio::spawn(async move {
        supervisor.run(changes).await;
        let _ = reader.await;
    });
    (
        Upstreams {
            hosts: current,
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
}

impl Supervisor {
    async fn run(mut self, mut changes: mpsc::Receiver<HostChange>) {
        loop {
            tokio::select! {
                biased;
                () = self.shutdown.cancelled() => break,
                Some(change) = changes.recv() => {
                    match change {
                        HostChange::Configured(hosts) => self.configured = hosts,
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
    /// already taken, so a clash means `boxbox.toml` gained the name later:
    /// the file wins and the paired host waits, said once per change.
    fn merged(&self) -> Vec<HostConfig> {
        let mut hosts = self.configured.clone();
        for host in &self.paired {
            if hosts.iter().any(|h| h.name == host.name) {
                warn!(host = %host.name, "a paired host shares its name with one in boxbox.toml; the file wins until one is renamed");
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
        let watcher = watcher::Watcher::new(
            Arc::clone(&config),
            self.client.clone(),
            sender,
            Arc::clone(&counters),
            self.fleet.clone(),
            stop.clone(),
        );
        Running {
            view: HostView {
                config,
                status,
                memory,
                counters,
            },
            stop,
            task: tokio::spawn(watcher.run()),
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
