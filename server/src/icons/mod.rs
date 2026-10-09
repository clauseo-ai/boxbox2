//! the repo-icon lookups: a repo's favicon, found and read on its host
//! once and remembered, so the app can wear it beside the repo's name
//! (`GET /api/hosts/{host}/repo-icon`, `http/repo_icon.rs`).
//!
//! one task owns the state: the cache of what lookups concluded, the
//! lookups in flight, and three short memories about hosts (their project
//! list, whether they can read files, their home). requests reach it
//! by message on a bounded channel and wait on a oneshot for the answer; a
//! lookup that needs the network runs as a task of its own and reports back
//! by message, so the owner never waits on a daemon. concurrent requests
//! for one `(host, root)` join one lookup.
//!
//! what a lookup may do, and what each way of ending it is worth:
//!
//! | class | meaning | kept by the server | the client's `cache-control` |
//! |---|---|---|---|
//! | hit | the icon, its bytes and type from sniffing | 6 h | `private, max-age=21600` |
//! | barren | searched, the repo has none | 30 min | `private, max-age=1800` |
//! | unproven | the host has not shown the root to be real | not at all | `private, max-age=60` |
//! | unsupported | the daemon cannot read files (cmx2-asks a28) | per host, 5 min | `private, max-age=300` |
//! | refused | the root is the host user's home, or holds it: listing it would stall the daemon (cmx2-asks a29) | not at all; the host's home is kept 1 h | `private, max-age=3600` |
//! | transient | an error, a timeout, an empty answer where there must be one | 15 s, so a page of repos does not repeat the calls | `no-store` |
//!
//! a missing route is not a missing icon: it is a fact about the daemon,
//! remembered for the host, short enough that the first daemon that learns
//! the route shows icons within minutes, long enough that a page of repos
//! makes no daemon calls. only "searched, and there is none" is a verdict
//! about a repo, and only that is kept for half an hour.
//!
//! nothing is sent to a host for a root it has not proven: the root must be
//! a project the host lists (`GET /project`) or the project root or
//! directory of a session in the fleet. a daemon opens an instance for a
//! directory it is told about, and a lookup must never be how it learns of
//! one (cmx2-asks a28).
//!
//! a root that is the host user's home, or any directory above it, is
//! refused even when proven (a session started in `~` proves it): the
//! pinned daemon lists a directory with a synchronous ripgrep on its event
//! loop, and a home holds more files than that can walk in the 10 s it
//! gives itself, stalling every stream meanwhile (cmx2-asks a29). the
//! lookup also reads a short fixed list of well-known paths before it asks
//! for a listing at all (`discover.rs`).

mod cache;
mod discover;
mod rank;
mod sniff;
#[cfg(test)]
mod testing;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use sha2::{Digest, Sha256};
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::config::HostConfig;
use crate::fleet::Fleet;
use cache::{Cache, Key, Verdict};
use discover::{Daemon, Failure};

/// an icon is small by definition: a larger file riding every page load is
/// a mistake, not an identity.
pub const MAX_ICON: usize = 512 * 1024;
/// icons the server holds, and the bytes of them.
const CACHE_ENTRIES: usize = 256;
const CACHE_BYTES: usize = 8 * 1024 * 1024;
/// how long a hit and a verdict of none are kept; the client's `max-age`
/// is the same number.
pub const HIT_TTL: Duration = Duration::from_secs(6 * 60 * 60);
pub const BARREN_TTL: Duration = Duration::from_secs(30 * 60);
/// how long a root that is not proven answers as such to the client.
pub const UNPROVEN_MAX_AGE: Duration = Duration::from_secs(60);
/// how long a host that cannot read files is not asked again; the client's
/// `max-age` is the same number.
pub const UNSUPPORTED_TTL: Duration = Duration::from_secs(5 * 60);
/// how long a root the host's home contains answers as refused to the client.
pub const REFUSED_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// how long a host's home is remembered; it does not move.
const HOME_TTL: Duration = Duration::from_secs(60 * 60);
/// how long a lookup that could not conclude is not repeated.
const RETRY_TTL: Duration = Duration::from_secs(15);
/// how long a host's project list is trusted before it is read again, so
/// roots that are not proven cost no call to the daemon.
const PROJECTS_TTL: Duration = Duration::from_secs(30);
/// hosts remembered in each of the three short memories (project list, host
/// that cannot read files, home); a person has a handful.
const HOSTS_KEPT: usize = 64;
/// requests waiting for the task. when it is full a request is answered
/// as transient at once, never queued without bound.
const COMMANDS: usize = 256;
/// distinct lookups in flight. past it a new one is answered as transient
/// at once; its requester asks again on the next render.
const MAX_INFLIGHT: usize = 64;
/// lookups talking to daemons at once; the rest wait for a turn.
const CONCURRENT: usize = 4;
/// one lookup, start to end, queueing for a turn included. past the longest
/// listing (15 s) with room for the reads around it.
const LOOKUP_LIMIT: Duration = Duration::from_secs(60);

/// a repo's icon, ready to serve.
#[derive(Debug)]
pub struct Icon {
    pub bytes: Bytes,
    /// found from the bytes (`sniff.rs`), never from a name or a header.
    pub content_type: &'static str,
    /// a quoted hash of the bytes, for `if-none-match`.
    pub etag: String,
}

impl Icon {
    /// the icon in `bytes`: they must be non-empty, within `MAX_ICON`, and
    /// an image a browser draws in an `<img>`.
    #[must_use]
    pub fn from_bytes(bytes: Vec<u8>) -> Option<Self> {
        if bytes.is_empty() || bytes.len() > MAX_ICON {
            return None;
        }
        let content_type = sniff::image_type(&bytes)?;
        let hash = Sha256::digest(&bytes);
        Some(Self {
            etag: format!("\"{}\"", data_encoding::HEXLOWER.encode(&hash[..16])),
            content_type,
            bytes: Bytes::from(bytes),
        })
    }
}

/// how a lookup ended, as the table above.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Hit,
    Barren,
    Unproven,
    Unsupported,
    Refused,
    Transient,
}

impl Class {
    /// the word logs and the `x-repo-icon` header carry.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Hit => "hit",
            Self::Barren => "barren",
            Self::Unproven => "unproven",
            Self::Unsupported => "unsupported",
            Self::Refused => "refused",
            Self::Transient => "transient",
        }
    }
}

/// what a request is told.
#[derive(Debug, Clone)]
pub struct Answer {
    pub class: Class,
    /// present exactly when the class is `Hit`.
    pub icon: Option<Arc<Icon>>,
}

impl Answer {
    fn of(class: Class) -> Self {
        Self { class, icon: None }
    }

    fn hit(icon: Arc<Icon>) -> Self {
        Self {
            class: Class::Hit,
            icon: Some(icon),
        }
    }
}

/// where the places a host has shown to be real come from: the fleet.
pub trait Places: Send + Sync + 'static {
    /// the project roots and session directories on `host`; none when the
    /// source has stopped.
    fn of(&self, host: &str) -> impl Future<Output = Option<HashSet<String>>> + Send;
}

impl Places for Fleet {
    async fn of(&self, host: &str) -> Option<HashSet<String>> {
        Fleet::places(self, host.to_owned()).await.ok()
    }
}

/// the handle every route holds.
#[derive(Debug, Clone)]
pub struct Icons {
    commands: mpsc::Sender<Command>,
}

impl Icons {
    /// the icon of the project at `root` on `host`, or why there is none.
    /// `root` is absolute with no trailing slash.
    /// `request` is the request's id, for the one log line the lookup writes.
    pub async fn lookup(
        &self,
        host: Arc<HostConfig>,
        root: String,
        request: Option<Arc<str>>,
    ) -> Answer {
        let (reply, answer) = oneshot::channel();
        let sent = self.commands.try_send(Command::Lookup {
            host,
            root,
            request,
            reply,
        });
        if sent.is_err() {
            // full, or the task has stopped: nothing is queued past the bound
            return Answer::of(Class::Transient);
        }
        answer
            .await
            .unwrap_or_else(|_| Answer::of(Class::Transient))
    }
}

#[derive(Debug)]
enum Command {
    Lookup {
        host: Arc<HostConfig>,
        root: String,
        request: Option<Arc<str>>,
        reply: oneshot::Sender<Answer>,
    },
}

/// how a network lookup ended.
#[derive(Debug)]
enum Outcome {
    Icon(Arc<Icon>),
    Barren,
    Unproven,
    Unsupported,
    Refused,
    Transient(String),
}

/// a lookup's report to the task that owns the state.
#[derive(Debug)]
struct Finished {
    key: Key,
    outcome: Outcome,
    /// the host's project list, when this lookup read it afresh.
    projects: Option<Arc<HashSet<String>>>,
    /// the host's home, when this lookup read it afresh.
    home: Option<Arc<str>>,
    calls: u32,
    started: std::time::Instant,
}

/// a host's project list and when it was read.
type Projects = (Instant, Arc<HashSet<String>>);
/// a host's home and when it was read.
type Home = (Instant, Arc<str>);

/// who is waiting on a lookup running now.
#[derive(Debug)]
struct Waiting {
    /// the first asker's request id, which the lookup's log line carries.
    request: Option<Arc<str>>,
    replies: Vec<oneshot::Sender<Answer>>,
}

/// starts the task; it stops when `shutdown` fires.
#[must_use]
pub fn spawn<P: Places>(
    client: reqwest::Client,
    places: P,
    shutdown: CancellationToken,
) -> (Icons, JoinHandle<()>) {
    let (commands, requests) = mpsc::channel(COMMANDS);
    // each lookup in flight sends one report, so this never holds more
    // than the lookups there can be
    let (report, reports) = mpsc::channel(MAX_INFLIGHT);
    let owner = Owner {
        client,
        places: Arc::new(places),
        cache: Cache::new(CACHE_ENTRIES, CACHE_BYTES),
        inflight: HashMap::new(),
        unsupported: HashMap::new(),
        projects: HashMap::new(),
        homes: HashMap::new(),
        turns: Arc::new(Semaphore::new(CONCURRENT)),
        report,
    };
    let task = tokio::spawn(owner.run(requests, reports, shutdown));
    (Icons { commands }, task)
}

#[derive(Debug)]
struct Owner<P> {
    client: reqwest::Client,
    places: Arc<P>,
    cache: Cache,
    /// who is waiting on each lookup running now.
    inflight: HashMap<Key, Waiting>,
    /// hosts that cannot read files, until when.
    unsupported: HashMap<String, Instant>,
    /// each host's project list as last read.
    projects: HashMap<String, Projects>,
    /// each host's home directory as last read.
    homes: HashMap<String, Home>,
    turns: Arc<Semaphore>,
    report: mpsc::Sender<Finished>,
}

impl<P: Places> Owner<P> {
    async fn run(
        mut self,
        mut requests: mpsc::Receiver<Command>,
        mut reports: mpsc::Receiver<Finished>,
        shutdown: CancellationToken,
    ) {
        loop {
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                Some(finished) = reports.recv() => self.finished(finished),
                Some(Command::Lookup { host, root, request, reply }) = requests.recv() => {
                    self.lookup(&host, root, request, reply);
                }
                else => break,
            }
        }
    }

    fn lookup(
        &mut self,
        host: &Arc<HostConfig>,
        root: String,
        request: Option<Arc<str>>,
        reply: oneshot::Sender<Answer>,
    ) {
        let now = Instant::now();
        let key = Key {
            host: host.name.clone(),
            root,
        };
        if let Some(verdict) = self.cache.get(&key, now) {
            let answer = match verdict {
                Verdict::Icon(icon) => Answer::hit(icon),
                Verdict::Barren => Answer::of(Class::Barren),
                Verdict::Retry => Answer::of(Class::Transient),
            };
            debug!(host = %key.host, repo = repo_of(&key.root), class = answer.class.name(), source = "cache", "repo icon");
            let _ = reply.send(answer);
            return;
        }
        if self
            .unsupported
            .get(&key.host)
            .is_some_and(|until| *until > now)
        {
            debug!(host = %key.host, repo = repo_of(&key.root), class = "unsupported", source = "memory", "repo icon");
            let _ = reply.send(Answer::of(Class::Unsupported));
            return;
        }
        if let Some(waiting) = self.inflight.get_mut(&key) {
            waiting.replies.push(reply);
            return;
        }
        if self.inflight.len() >= MAX_INFLIGHT {
            warn!(host = %key.host, repo = repo_of(&key.root), limit = MAX_INFLIGHT, "repo icon lookups are backed up; answered as transient");
            let _ = reply.send(Answer::of(Class::Transient));
            return;
        }
        let projects = self
            .projects
            .get(&key.host)
            .filter(|(read, _)| now.duration_since(*read) < PROJECTS_TTL)
            .map(|(_, list)| Arc::clone(list));
        let home = self
            .homes
            .get(&key.host)
            .filter(|(read, _)| now.duration_since(*read) < HOME_TTL)
            .map(|(_, home)| Arc::clone(home));
        let job = Job {
            client: self.client.clone(),
            host: Arc::clone(host),
            root: key.root.clone(),
            places: Arc::clone(&self.places),
            projects,
            home,
            turns: Arc::clone(&self.turns),
        };
        self.inflight.insert(
            key.clone(),
            Waiting {
                request,
                replies: vec![reply],
            },
        );
        let report = self.report.clone();
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            // a lookup that panics must still report, or its waiters wait for ever
            let ran = tokio::spawn(tokio::time::timeout(LOOKUP_LIMIT, work(job))).await;
            let finished = match ran {
                Ok(Ok(done)) => Finished {
                    key,
                    outcome: done.outcome,
                    projects: done.projects,
                    home: done.home,
                    calls: done.calls,
                    started,
                },
                Ok(Err(_)) => Finished::failed(key, started, "the lookup ran past its limit"),
                Err(_) => Finished::failed(key, started, "the lookup stopped unexpectedly"),
            };
            // the owner may be gone at shutdown; nobody is left to tell
            let _ = report.send(finished).await;
        });
    }

    fn finished(&mut self, finished: Finished) {
        let now = Instant::now();
        let Finished {
            key,
            outcome,
            projects,
            home,
            calls,
            started,
        } = finished;
        if let Some(home) = home {
            remember(&mut self.homes, &key.host, (now, home), |(read, _)| *read);
        }
        if let Some(list) = projects {
            remember(&mut self.projects, &key.host, (now, list), |(read, _)| {
                *read
            });
        }
        let (answer, reason) = match outcome {
            Outcome::Icon(icon) => {
                self.cache
                    .insert(key.clone(), Verdict::Icon(Arc::clone(&icon)), HIT_TTL, now);
                (Answer::hit(icon), None)
            }
            Outcome::Barren => {
                self.cache
                    .insert(key.clone(), Verdict::Barren, BARREN_TTL, now);
                (Answer::of(Class::Barren), None)
            }
            Outcome::Unproven => (Answer::of(Class::Unproven), None),
            Outcome::Refused => (Answer::of(Class::Refused), None),
            Outcome::Unsupported => {
                remember(
                    &mut self.unsupported,
                    &key.host,
                    now + UNSUPPORTED_TTL,
                    |until| *until,
                );
                (Answer::of(Class::Unsupported), None)
            }
            Outcome::Transient(reason) => {
                self.cache
                    .insert(key.clone(), Verdict::Retry, RETRY_TTL, now);
                (Answer::of(Class::Transient), Some(reason))
            }
        };
        let waiting = self.inflight.remove(&key).unwrap_or(Waiting {
            request: None,
            replies: Vec::new(),
        });
        info!(
            request = waiting.request.as_deref().unwrap_or(""),
            host = %key.host,
            repo = repo_of(&key.root),
            root = %root_hash(&key),
            class = answer.class.name(),
            reason = reason.as_deref().unwrap_or(""),
            calls,
            waiting = waiting.replies.len(),
            latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "repo icon"
        );
        for reply in waiting.replies {
            let _ = reply.send(answer.clone());
        }
    }
}

impl Finished {
    fn failed(key: Key, started: std::time::Instant, reason: &str) -> Self {
        Self {
            key,
            outcome: Outcome::Transient(reason.to_owned()),
            projects: None,
            home: None,
            calls: 0,
            started,
        }
    }
}

/// keeps `value` for `host`, forgetting the one whose time `when` names
/// earliest if the memory is full.
fn remember<T>(
    memory: &mut HashMap<String, T>,
    host: &str,
    value: T,
    when: impl Fn(&T) -> Instant,
) {
    if !memory.contains_key(host)
        && memory.len() >= HOSTS_KEPT
        && let Some(oldest) = memory
            .iter()
            .min_by_key(|(_, kept)| when(kept))
            .map(|(name, _)| name.clone())
    {
        memory.remove(&oldest);
    }
    memory.insert(host.to_owned(), value);
}

/// the repo's own name, for a log line a person reads: the root's last segment.
fn repo_of(root: &str) -> &str {
    root.rsplit('/').find(|part| !part.is_empty()).unwrap_or("")
}

/// eight hex digits that tell two roots apart in the logs without the path.
fn root_hash(key: &Key) -> String {
    let hash = Sha256::digest(format!("{}\0{}", key.host, key.root));
    data_encoding::HEXLOWER.encode(&hash[..4])
}

/// everything a lookup needs, owned, so it can run as a task.
#[derive(Debug)]
struct Job<P> {
    client: reqwest::Client,
    host: Arc<HostConfig>,
    root: String,
    places: Arc<P>,
    /// the host's project list, when it is fresh enough to use.
    projects: Option<Arc<HashSet<String>>>,
    /// the host's home, when it is fresh enough to use.
    home: Option<Arc<str>>,
    turns: Arc<Semaphore>,
}

#[derive(Debug)]
struct Done {
    outcome: Outcome,
    projects: Option<Arc<HashSet<String>>>,
    home: Option<Arc<str>>,
    calls: u32,
}

/// a path without the slash a client may have added.
fn plain_root(path: &str) -> &str {
    if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    }
}

async fn work<P: Places>(job: Job<P>) -> Done {
    let Ok(_turn) = job.turns.acquire().await else {
        return Done {
            outcome: Outcome::Transient("the lookups are stopping".into()),
            projects: None,
            home: None,
            calls: 0,
        };
    };
    let daemon = Daemon::new(&job.client, &job.host, &job.root);
    let mut fetched = None;
    let mut home = None;
    let outcome = match prove(&job, &daemon, &mut fetched).await {
        Err(failure) => failed(failure),
        Ok(false) => Outcome::Unproven,
        Ok(true) => match holds_home(&job, &daemon, &mut home).await {
            Err(failure) => failed(failure),
            Ok(true) => Outcome::Refused,
            Ok(false) => match discover::find_icon(&daemon).await {
                Ok(Some(icon)) => Outcome::Icon(Arc::new(icon)),
                Ok(None) => Outcome::Barren,
                Err(failure) => failed(failure),
            },
        },
    };
    Done {
        outcome,
        projects: fetched,
        home,
        calls: daemon.calls(),
    }
}

/// whether the root is the host user's home or a directory above it, which
/// no lookup may list (cmx2-asks a29). the home is read once per host and
/// kept.
async fn holds_home<P: Places>(
    job: &Job<P>,
    daemon: &Daemon<'_>,
    fetched: &mut Option<Arc<str>>,
) -> Result<bool, Failure> {
    let home = if let Some(home) = &job.home {
        Arc::clone(home)
    } else {
        let home: Arc<str> = daemon.home().await?.into();
        *fetched = Some(Arc::clone(&home));
        home
    };
    let home = plain_root(&home);
    let root = job.root.as_str();
    Ok(root == "/" || home == root || home.starts_with(&format!("{root}/")))
}

fn failed(failure: Failure) -> Outcome {
    match failure {
        Failure::Unsupported => Outcome::Unsupported,
        Failure::Transient(reason) => Outcome::Transient(reason),
    }
}

/// whether the host has shown the root to be real: a session in the fleet
/// works in it, or the daemon lists it as a project. the project list is
/// read only when the fleet does not know the root, and kept for a while.
async fn prove<P: Places>(
    job: &Job<P>,
    daemon: &Daemon<'_>,
    fetched: &mut Option<Arc<HashSet<String>>>,
) -> Result<bool, Failure> {
    let known = job
        .places
        .of(&job.host.name)
        .await
        .ok_or_else(|| Failure::Transient("the fleet is stopping".into()))?;
    if known.iter().any(|place| plain_root(place) == job.root) {
        return Ok(true);
    }
    let projects = if let Some(list) = &job.projects {
        Arc::clone(list)
    } else {
        let list: HashSet<String> = daemon
            .projects()
            .await?
            .iter()
            .map(|root| plain_root(root).to_owned())
            .collect();
        let list = Arc::new(list);
        *fetched = Some(Arc::clone(&list));
        list
    };
    Ok(projects.contains(&job.root))
}

#[cfg(test)]
mod tests {
    use super::rank::WELL_KNOWN;
    use super::testing::{Fake, PNG, Served, serve};
    use super::*;

    /// the places the fleet shows, fixed.
    struct Known(HashSet<String>);

    impl Places for Known {
        async fn of(&self, _host: &str) -> Option<HashSet<String>> {
            Some(self.0.clone())
        }
    }

    fn known(roots: &[&str]) -> Known {
        Known(roots.iter().map(|r| (*r).to_owned()).collect())
    }

    fn start(places: Known) -> (Icons, CancellationToken) {
        let shutdown = CancellationToken::new();
        let (icons, _task) = spawn(reqwest::Client::new(), places, shutdown.clone());
        (icons, shutdown)
    }

    async fn ask(icons: &Icons, daemon: &Served, root: &str) -> Answer {
        icons
            .lookup(Arc::clone(&daemon.host), root.into(), None)
            .await
    }

    fn calls(daemon: &Served) -> usize {
        daemon.requests().len()
    }

    fn png_only() -> Fake {
        Fake::default()
            .listing("favicon", &["public/favicon.png"])
            .file("public/favicon.png", PNG)
    }

    #[tokio::test]
    async fn a_proven_roots_icon_is_found_and_the_second_ask_costs_no_call() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        let first = ask(&icons, &daemon, "/work/app").await;
        assert_eq!(first.class, Class::Hit);
        let icon = first.icon.expect("a hit carries its icon");
        assert_eq!(icon.content_type, "image/png");
        assert!(icon.etag.starts_with('"') && icon.etag.ends_with('"'));
        let calls_after_first = calls(&daemon);
        let second = ask(&icons, &daemon, "/work/app").await;
        assert_eq!(second.class, Class::Hit);
        assert_eq!(calls(&daemon), calls_after_first, "served from memory");
    }

    #[tokio::test]
    async fn a_trailing_slash_on_a_known_place_still_proves_the_root() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&["/work/app/"]));
        assert_eq!(ask(&icons, &daemon, "/work/app").await.class, Class::Hit);
    }

    #[tokio::test]
    async fn a_monorepo_of_empty_placeholder_icons_is_remembered_not_walked_again() {
        let mut fake = Fake::default().listing(
            "favicon",
            &[
                "packages/a/public/favicon.ico",
                "packages/b/public/favicon.ico",
            ],
        );
        for path in [
            "packages/a/public/favicon.ico",
            "packages/b/public/favicon.ico",
        ] {
            fake = fake.file(path, b"");
        }
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        assert_eq!(ask(&icons, &daemon, "/work/app").await.class, Class::Barren);
        let seen = calls(&daemon);
        assert_eq!(ask(&icons, &daemon, "/work/app").await.class, Class::Barren);
        assert_eq!(calls(&daemon), seen, "no second walk of the repo");
    }

    #[tokio::test]
    async fn a_repo_searched_and_without_an_icon_is_remembered_as_none() {
        let fake = Fake::default()
            .listing("favicon", &["src/main.rs"])
            .listing("icon.", &["src/main.rs"]);
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        assert_eq!(ask(&icons, &daemon, "/work/app").await.class, Class::Barren);
        let seen = calls(&daemon);
        assert_eq!(ask(&icons, &daemon, "/work/app").await.class, Class::Barren);
        assert_eq!(calls(&daemon), seen, "a verdict is not asked for again");
    }

    #[tokio::test]
    async fn a_root_nothing_has_shown_is_unproven_and_the_daemon_hears_nothing_about_it() {
        let mut fake = png_only();
        fake.projects = vec!["/work/other".into()];
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        let answer = ask(&icons, &daemon, "/work/ghost").await;
        assert_eq!(answer.class, Class::Unproven);
        assert_eq!(
            daemon.log(),
            ["project"],
            "only the project list was read: no find, no read, no directory"
        );
        assert_eq!(daemon.requests()[0].directory, None);
    }

    #[tokio::test]
    async fn roots_that_are_not_proven_share_one_read_of_the_project_list() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&[]));
        for root in ["/a", "/b", "/c"] {
            assert_eq!(ask(&icons, &daemon, root).await.class, Class::Unproven);
        }
        assert_eq!(daemon.count("project"), 1);
    }

    #[tokio::test]
    async fn a_project_the_daemon_lists_is_proven_though_no_session_is_in_it() {
        let mut fake = png_only();
        fake.projects = vec!["/work/app".into()];
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&[]));
        assert_eq!(ask(&icons, &daemon, "/work/app").await.class, Class::Hit);
    }

    #[tokio::test]
    async fn a_root_the_fleet_knows_needs_no_project_list() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        ask(&icons, &daemon, "/work/app").await;
        assert_eq!(daemon.count("project"), 0);
    }

    #[tokio::test]
    async fn asks_that_arrive_together_make_one_lookup() {
        let mut fake = png_only();
        fake.delay = Duration::from_millis(30);
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        let asks = (0..8).map(|_| ask(&icons, &daemon, "/work/app"));
        let answers = futures_util::future::join_all(asks).await;
        assert!(answers.iter().all(|a| a.class == Class::Hit));
        // one walk down the well-known paths, to public/favicon.png, for all eight
        let reached = WELL_KNOWN.iter().position(|p| *p == "public/favicon.png");
        assert_eq!(Some(daemon.count("read")), reached.map(|n| n + 1));
        assert_eq!(daemon.count("home"), 1);
    }

    #[tokio::test]
    async fn the_same_root_on_two_hosts_is_looked_up_twice() {
        let one = serve(png_only()).await;
        let two = serve(png_only()).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        icons
            .lookup(Arc::clone(&one.host), "/work/app".into(), None)
            .await;
        let other = Arc::new(HostConfig {
            name: "laptop".into(),
            ..(*two.host).clone()
        });
        icons.lookup(other, "/work/app".into(), None).await;
        assert_eq!(one.count("home"), 1);
        assert_eq!(two.count("home"), 1);
    }

    #[tokio::test]
    async fn a_host_without_the_file_route_is_remembered_so_the_next_repo_costs_no_call() {
        let mut fake = png_only();
        fake.no_file_route = true;
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&["/work/app", "/work/other"]));
        assert_eq!(
            ask(&icons, &daemon, "/work/app").await.class,
            Class::Unsupported
        );
        let seen = calls(&daemon);
        assert_eq!(
            ask(&icons, &daemon, "/work/other").await.class,
            Class::Unsupported
        );
        assert_eq!(
            ask(&icons, &daemon, "/work/app").await.class,
            Class::Unsupported
        );
        assert_eq!(calls(&daemon), seen);
    }

    #[tokio::test]
    async fn a_host_that_cannot_read_files_never_has_its_repos_remembered_as_without_icons() {
        let mut fake = png_only();
        fake.no_file_route = true;
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        let answer = ask(&icons, &daemon, "/work/app").await;
        assert_ne!(answer.class, Class::Barren);
        assert!(answer.icon.is_none());
    }

    #[tokio::test]
    async fn a_failure_is_transient_and_not_asked_again_for_a_few_seconds() {
        let fake = Fake {
            find_status: Some(500),
            ..Fake::default()
        };
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        assert_eq!(
            ask(&icons, &daemon, "/work/app").await.class,
            Class::Transient
        );
        let seen = calls(&daemon);
        assert_eq!(
            ask(&icons, &daemon, "/work/app").await.class,
            Class::Transient
        );
        assert_eq!(
            calls(&daemon),
            seen,
            "a page of repos does not repeat a failing call"
        );
    }

    #[tokio::test]
    async fn a_host_that_cannot_be_reached_is_transient() {
        let (icons, _stop) = start(known(&["/work/app"]));
        let host = super::testing::host_at("http://127.0.0.1:9");
        let answer = icons.lookup(host, "/work/app".into(), None).await;
        assert_eq!(answer.class, Class::Transient);
    }

    #[tokio::test]
    async fn lookups_past_the_inflight_bound_are_answered_transient_at_once() {
        let mut fake = png_only();
        fake.delay = Duration::from_millis(3);
        let daemon = serve(fake).await;
        let roots: Vec<String> = (0..MAX_INFLIGHT + 6)
            .map(|n| format!("/work/app{n}"))
            .collect();
        let places = Known(roots.iter().cloned().collect());
        let (icons, _stop) = start(places);
        let asks = roots.iter().map(|root| ask(&icons, &daemon, root));
        let answers = futures_util::future::join_all(asks).await;
        let transient = answers
            .iter()
            .filter(|a| a.class == Class::Transient)
            .count();
        let hits = answers.iter().filter(|a| a.class == Class::Hit).count();
        assert_eq!(transient, 6);
        assert_eq!(hits, MAX_INFLIGHT);
    }

    #[tokio::test]
    async fn the_hosts_home_is_refused_even_though_a_session_proves_it() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&["/home/dev"]));
        let answer = ask(&icons, &daemon, "/home/dev").await;
        assert_eq!(answer.class, Class::Refused);
        assert!(answer.icon.is_none());
        assert_eq!(
            daemon.log(),
            ["home"],
            "the home was read; nothing was listed or read of it"
        );
    }

    #[tokio::test]
    async fn a_directory_above_the_home_is_refused_too() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&["/home", "/"]));
        assert_eq!(ask(&icons, &daemon, "/home").await.class, Class::Refused);
        assert_eq!(daemon.count("find"), 0);
        assert_eq!(daemon.count("read"), 0);
    }

    #[tokio::test]
    async fn a_project_under_the_home_and_a_sibling_of_it_are_looked_up() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&[
            "/home/dev/code/app",
            "/home/dev2",
            "/home/dev-tools",
        ]));
        for root in ["/home/dev/code/app", "/home/dev2", "/home/dev-tools"] {
            assert_eq!(ask(&icons, &daemon, root).await.class, Class::Hit, "{root}");
        }
    }

    #[tokio::test]
    async fn the_home_is_read_once_per_host_not_once_per_root() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&["/home/dev", "/home", "/home/dev/a", "/home/dev/b"]));
        for root in ["/home/dev", "/home", "/home/dev/a", "/home/dev/b"] {
            ask(&icons, &daemon, root).await;
        }
        assert_eq!(daemon.count("home"), 1);
    }

    #[tokio::test]
    async fn a_root_that_is_not_proven_is_unproven_before_the_home_is_ever_asked() {
        let daemon = serve(png_only()).await;
        let (icons, _stop) = start(known(&[]));
        assert_eq!(
            ask(&icons, &daemon, "/home/dev").await.class,
            Class::Unproven
        );
        assert_eq!(daemon.count("home"), 0);
    }

    #[tokio::test]
    async fn a_folder_browser_that_fails_makes_the_lookup_transient_not_unguarded() {
        let fake = Fake {
            fs_status: Some(500),
            ..png_only()
        };
        let daemon = serve(fake).await;
        let (icons, _stop) = start(known(&["/work/app"]));
        assert_eq!(
            ask(&icons, &daemon, "/work/app").await.class,
            Class::Transient
        );
        assert_eq!(
            daemon.count("read"),
            0,
            "no read without knowing where the home is"
        );
    }

    #[tokio::test]
    async fn what_holds_the_home_is_the_home_and_its_ancestors_by_whole_names() {
        async fn holds(home: &str, root: &str) -> bool {
            let host = super::testing::host_at("http://127.0.0.1:9");
            let job = Job {
                client: reqwest::Client::new(),
                host: Arc::clone(&host),
                root: root.to_owned(),
                places: Arc::new(known(&[])),
                projects: None,
                home: Some(home.into()),
                turns: Arc::new(Semaphore::new(1)),
            };
            let client = reqwest::Client::new();
            let daemon = Daemon::new(&client, &host, root);
            holds_home(&job, &daemon, &mut None).await.unwrap()
        }
        assert!(holds("/Users/me", "/Users/me").await);
        assert!(holds("/Users/me/", "/Users/me").await);
        assert!(holds("/Users/me", "/Users").await);
        assert!(holds("/Users/me", "/").await);
        assert!(!holds("/Users/me", "/Users/mentor").await);
        assert!(!holds("/Users/me", "/Users/me/code").await);
        assert!(!holds("/Users/me", "/Use").await);
    }

    #[test]
    fn an_icon_is_only_made_of_small_non_empty_images() {
        assert!(Icon::from_bytes(PNG.to_vec()).is_some());
        assert!(Icon::from_bytes(Vec::new()).is_none());
        assert!(Icon::from_bytes(b"<html></html>".to_vec()).is_none());
        let mut big = PNG.to_vec();
        big.resize(MAX_ICON + 1, 0);
        assert!(Icon::from_bytes(big).is_none());
        let mut limit = PNG.to_vec();
        limit.resize(MAX_ICON, 0);
        assert!(Icon::from_bytes(limit).is_some());
    }

    #[test]
    fn the_etag_follows_the_bytes() {
        let one = Icon::from_bytes(PNG.to_vec()).unwrap();
        let again = Icon::from_bytes(PNG.to_vec()).unwrap();
        let mut other = PNG.to_vec();
        other.push(1);
        let other = Icon::from_bytes(other).unwrap();
        assert_eq!(one.etag, again.etag);
        assert_ne!(one.etag, other.etag);
    }

    #[test]
    fn the_hosts_remembered_are_bounded_and_the_oldest_is_forgotten() {
        let start = Instant::now();
        let mut memory: HashMap<String, Instant> = HashMap::new();
        for n in 0..HOSTS_KEPT {
            remember(
                &mut memory,
                &format!("h{n}"),
                start + Duration::from_secs(n as u64),
                |t| *t,
            );
        }
        remember(&mut memory, "new", start + Duration::from_secs(999), |t| *t);
        assert_eq!(memory.len(), HOSTS_KEPT);
        assert!(!memory.contains_key("h0"));
        assert!(memory.contains_key("new"));
        // a host already there is replaced, nothing is forgotten for it
        remember(&mut memory, "new", start, |t| *t);
        assert_eq!(memory.len(), HOSTS_KEPT);
        assert!(memory.contains_key("h1"));
    }

    #[test]
    fn a_log_names_the_repo_and_a_hash_never_the_path() {
        assert_eq!(repo_of("/Users/me/code/app"), "app");
        assert_eq!(repo_of("/"), "");
        let key = Key {
            host: "desk".into(),
            root: "/Users/me/code/app".into(),
        };
        let hash = root_hash(&key);
        assert_eq!(hash.len(), 8);
        assert!(!hash.contains("Users"));
    }
}
