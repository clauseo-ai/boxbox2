//! the server, while a board is plugged in and only then: the stream reader
//! (`GET /api/board/stream`), the poster (`POST /api/board/act` and
//! telemetry), and the login they share. both threads end with the plug:
//! an idle daemon holds no connection.
//!
//! posts go through ureq (pooled, so a key's act rides a warm connection).
//! the stream is read here over a socket this module owns, because an
//! unplug must close it at once (`shutdown`), which a blocking client's
//! body reader cannot be told to do from another thread. tls on both is the
//! system's (native-tls, security framework on macos, its roots and its
//! verifier): no tls stack compiled in. ureq's native-tls feature also
//! carries webpki's roots, which nothing here asks for.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use boxbox_board_wire::{Act, Frame, PROTOCOL};

use crate::controller::After;
use crate::daemon::Msg;
use crate::log::Log;
use crate::sse::Parser;
use crate::telemetry::{Batch, Event};

/// the server heartbeats every 15 s; 45 s without a byte is a dead stream
/// (a connection that survives a mac's sleep can stay established forever
/// while delivering nothing).
pub const STREAM_IDLE: Duration = Duration::from_secs(45);
pub const BACKOFF_FIRST: Duration = Duration::from_millis(500);
pub const BACKOFF_CAP: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const POST_TIMEOUT: Duration = Duration::from_secs(10);
/// acts and batches waiting for the poster; a key press past this is dropped
/// and logged rather than blocking the main loop.
pub const POST_QUEUE: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error("the origin {0} is not a url this daemon can reach")]
    Origin(String),
    #[error("cannot reach the server: {0}")]
    Io(#[from] std::io::Error),
    #[error("tls failed: {0}")]
    Tls(String),
    #[error("the server answered {0}")]
    Status(u16),
    #[error("the server's answer was not http")]
    Garbled,
    #[error("no password: write it with `boxbox-board login` ({0})")]
    NoPassword(String),
    #[error("the server set no cookie on login")]
    NoCookie,
    #[error("post failed: {0}")]
    Post(&'static str),
    #[error("stopped")]
    Stopped,
}

impl NetError {
    /// what kind of failure, for the log: never the error's text, which can
    /// carry the origin, an address or a path.
    #[must_use]
    pub fn kind(&self) -> String {
        match self {
            Self::Origin(_) => "origin".into(),
            Self::Io(e) => format!("io:{:?}", e.kind()),
            Self::Tls(_) => "tls".into(),
            Self::Status(code) => format!("status:{code}"),
            Self::Garbled => "garbled".into(),
            Self::NoPassword(_) => "no_password".into(),
            Self::NoCookie => "no_cookie".into(),
            Self::Post(kind) => format!("post:{kind}"),
            Self::Stopped => "stopped".into(),
        }
    }
}

/// a ureq failure's kind, for the log.
#[must_use]
pub fn ureq_kind(e: &ureq::Error) -> &'static str {
    match e {
        ureq::Error::Io(_) => "io",
        ureq::Error::Timeout(_) => "timeout",
        ureq::Error::HostNotFound => "host_not_found",
        ureq::Error::ConnectionFailed => "connection_failed",
        ureq::Error::Tls(_) | ureq::Error::TlsRequired => "tls",
        ureq::Error::StatusCode(_) => "status",
        ureq::Error::Protocol(_) | ureq::Error::Http(_) => "protocol",
        ureq::Error::BodyStalled => "stalled",
        _ => "other",
    }
}

/// the login the stream and the poster share: the gate cookie, kept 0600 in
/// the state dir so a restart does not log in again.
#[derive(Debug)]
pub struct Auth {
    origin: String,
    password_file: PathBuf,
    cookie_file: PathBuf,
    cookie: Mutex<Option<String>>,
    log: Log,
}

impl Auth {
    #[must_use]
    pub fn new(
        origin: String,
        password_file: PathBuf,
        state_dir: &std::path::Path,
        log: Log,
    ) -> Self {
        let cookie_file = state_dir.join("cookie");
        let cookie = std::fs::read_to_string(&cookie_file)
            .ok()
            .map(|c| c.trim().to_owned())
            .filter(|c| c.contains('='));
        Self {
            origin,
            password_file,
            cookie_file,
            cookie: Mutex::new(cookie),
            log,
        }
    }

    fn cookie(&self) -> Option<String> {
        self.cookie
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// `POST /api/login {password}`; the cookie's name comes from the
    /// answer's `Set-Cookie`, never assumed.
    fn login(&self, agent: &ureq::Agent, stale: Option<&str>) -> Result<String, NetError> {
        let mut held = self.cookie.lock().unwrap_or_else(PoisonError::into_inner);
        // another thread logged in while this one waited.
        if let Some(current) = held.as_deref()
            && Some(current) != stale
        {
            return Ok(current.to_owned());
        }
        let password = std::fs::read_to_string(&self.password_file)
            .map_err(|e| NetError::NoPassword(format!("{}: {e}", self.password_file.display())))?;
        let password = password.trim_end_matches(['\n', '\r']);
        let body = serde_json::json!({ "password": password }).to_string();
        let answer = agent
            .post(format!("{}/api/login", self.origin))
            .header("content-type", "application/json")
            .send(body.as_bytes())
            .map_err(|e| NetError::Post(ureq_kind(&e)))?;
        let status = answer.status().as_u16();
        if status != 200 && status != 204 {
            self.log
                .error("net.login_rejected", &format!("status={status}"));
            return Err(NetError::Status(status));
        }
        let cookie = answer
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .map(str::trim)
            .find(|pair| pair.contains('=') && !pair.ends_with('='))
            .map(str::to_owned)
            .ok_or(NetError::NoCookie)?;
        if let Err(e) = write_private(&self.cookie_file, &cookie) {
            self.log
                .warn("net.cookie_unsaved", &format!("error={:?}", e.kind()));
        }
        self.log.info("net.login", "");
        *held = Some(cookie.clone());
        Ok(cookie)
    }
}

/// writes `text` to `path` 0600, through a temp file and a rename.
///
/// # Errors
/// the file could not be written.
pub fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("tmp");
    // a stale temp from a crash could have any mode: remove it, and create
    // the new one fresh so the 0600 always applies.
    match std::fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .timeout_global(Some(POST_TIMEOUT))
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .build()
        .into()
}

/// a job for the poster.
#[derive(Debug)]
pub enum Job {
    Act { act: Act, after: After, at: u64 },
    Telemetry(Vec<Event>),
}

/// what one plug session holds of the network.
#[derive(Debug)]
pub struct Session {
    jobs: SyncSender<Job>,
    stop: Arc<AtomicBool>,
    /// dropping it wakes a stream thread sleeping out its backoff.
    wake: Option<SyncSender<()>>,
    socket: Arc<Mutex<Option<TcpStream>>>,
    /// disconnects when the poster has finished its queue and ended.
    done: Option<Receiver<()>>,
}

#[derive(Debug)]
pub struct Setup {
    pub auth: Arc<Auth>,
    pub device: String,
    pub addrs: String,
    pub generation: u64,
    pub tx: SyncSender<Msg>,
    pub log: Log,
    /// the process's monotonic clock: ms since start.
    pub epoch: Instant,
}

impl Session {
    /// starts the poster and the stream reader.
    ///
    /// # Errors
    /// a thread could not start.
    pub fn start(setup: Setup) -> std::io::Result<Self> {
        let (jobs, job_rx) = sync_channel(POST_QUEUE);
        let (wake, wake_rx) = sync_channel(1);
        let (done_tx, done) = sync_channel::<()>(1);
        let stop = Arc::new(AtomicBool::new(false));
        let socket = Arc::new(Mutex::new(None));
        let Setup {
            auth,
            device,
            addrs,
            generation,
            tx,
            log,
            epoch,
        } = setup;
        {
            let (auth, tx, log, device) = (auth.clone(), tx.clone(), log.clone(), device.clone());
            std::thread::Builder::new()
                .name("board-post".into())
                .spawn(move || {
                    post_loop(&job_rx, &auth, &device, &tx, &log, epoch);
                    drop(done_tx);
                })?;
        }
        {
            let stop = stop.clone();
            let socket = socket.clone();
            std::thread::Builder::new()
                .name("board-stream".into())
                .spawn(move || {
                    let stream = Stream {
                        auth,
                        device,
                        addrs,
                        generation,
                        tx,
                        log,
                        stop,
                        wake: wake_rx,
                        socket,
                    };
                    stream.run();
                })?;
        }
        Ok(Self {
            jobs,
            stop,
            wake: Some(wake),
            socket,
            done: Some(done),
        })
    }

    /// queues a post without blocking the main loop.
    ///
    /// # Errors
    /// the queue is full (the server stalls): the job comes back.
    pub fn post(&self, job: Job) -> Result<(), Box<Job>> {
        self.jobs.try_send(job).map_err(|e| match e {
            TrySendError::Full(job) | TrySendError::Disconnected(job) => Box::new(job),
        })
    }

    /// closes the stream and waits at most `within` for the poster to
    /// finish what is queued: a stop must never hang the exit.
    pub fn finish(mut self, within: Duration) {
        let done = self.done.take();
        self.close();
        if let Some(done) = done {
            let _ = done.recv_timeout(within);
        }
    }

    /// closes the stream now; the poster finishes what is queued (the gone,
    /// the last telemetry) and ends.
    pub fn close(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.wake.take();
        if let Some(s) = self
            .socket
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

fn ms_since(epoch: Instant) -> u64 {
    u64::try_from(epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn post_loop(
    jobs: &Receiver<Job>,
    auth: &Auth,
    device: &str,
    tx: &SyncSender<Msg>,
    log: &Log,
    epoch: Instant,
) {
    let agent = agent();
    while let Ok(job) = jobs.recv() {
        match job {
            Job::Act { act, after, at } => {
                let body = serde_json::to_vec(&act).unwrap_or_default();
                let ok = post_json(&agent, auth, "/api/board/act", &body, log);
                let _ = tx.try_send(Msg::Answered {
                    after,
                    ok,
                    ms: ms_since(epoch).saturating_sub(at),
                });
            }
            Job::Telemetry(events) => {
                let body = serde_json::to_vec(&Batch {
                    device,
                    device_class: "board",
                    events: &events,
                })
                .unwrap_or_default();
                let ok = post_json(&agent, auth, "/api/telemetry", &body, log);
                if !ok {
                    let _ = tx.try_send(Msg::TelemetryRefused(events));
                }
            }
        }
    }
}

/// one post, logging in first or again on a 401. true on a 2xx.
fn post_json(agent: &ureq::Agent, auth: &Auth, path: &str, body: &[u8], log: &Log) -> bool {
    let mut cookie = auth.cookie();
    for attempt in 0..2 {
        let current = match cookie.clone() {
            Some(c) => c,
            None => match auth.login(agent, None) {
                Ok(c) => c,
                Err(e) => {
                    log.warn("net.login_failed", &format!("error={}", e.kind()));
                    return false;
                }
            },
        };
        let sent = agent
            .post(format!("{}{path}", auth.origin))
            .header("content-type", "application/json")
            .header("cookie", &current)
            .send(body);
        match sent {
            Ok(answer) => {
                let status = answer.status().as_u16();
                if status == 401 && attempt == 0 {
                    cookie = auth.login(agent, Some(&current)).ok();
                    if cookie.is_none() {
                        return false;
                    }
                    continue;
                }
                if !(200..300).contains(&status) {
                    log.warn("net.post", &format!("path={path} status={status}"));
                }
                return (200..300).contains(&status);
            }
            Err(e) => {
                log.warn(
                    "net.post_failed",
                    &format!("path={path} error={}", ureq_kind(&e)),
                );
                return false;
            }
        }
    }
    false
}

struct Stream {
    auth: Arc<Auth>,
    device: String,
    addrs: String,
    generation: u64,
    tx: SyncSender<Msg>,
    log: Log,
    stop: Arc<AtomicBool>,
    wake: Receiver<()>,
    socket: Arc<Mutex<Option<TcpStream>>>,
}

/// how a stream ended.
enum End {
    /// dropped: dial again after the backoff.
    Retry,
    /// another board stream took over: do not dial again until the next plug.
    Replaced,
    /// stopped by the unplug.
    Done,
}

impl Stream {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn run(&self) {
        let agent = agent();
        let mut backoff = BACKOFF_FIRST;
        loop {
            if self.stopped() {
                return;
            }
            let _ = self.tx.send(Msg::StreamConnecting {
                generation: self.generation,
            });
            let mut connected = false;
            let ended = self.once(&agent, &mut connected);
            // a stream the server took (its 200) resets the backoff however
            // it ended: a stall after a mac's sleep must not leave every
            // redial at the cap.
            backoff = backoff_for(backoff, connected);
            match ended {
                Ok(End::Done) => return,
                Ok(End::Replaced) => {
                    let _ = self.tx.send(Msg::StreamReplaced {
                        generation: self.generation,
                    });
                    return;
                }
                Ok(End::Retry) => {}
                Err(e) => {
                    if self.stopped() {
                        return;
                    }
                    self.log
                        .warn("stream.failed", &format!("error={}", e.kind()));
                }
            }
            let _ = self.tx.send(Msg::StreamDown {
                generation: self.generation,
            });
            match self.wake.recv_timeout(backoff) {
                Err(RecvTimeoutError::Timeout) => {}
                Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            }
            backoff = (backoff * 2).min(BACKOFF_CAP);
        }
    }

    /// one stream: dial, log in on a 401, read frames until it ends.
    fn once(&self, agent: &ureq::Agent, connected: &mut bool) -> Result<End, NetError> {
        let mut cookie = self.auth.cookie();
        if cookie.is_none() {
            cookie = Some(self.auth.login(agent, None)?);
        }
        for attempt in 0..2 {
            let current = cookie.clone().unwrap_or_default();
            let mut conn = self.dial(&current)?;
            let status = read_status(&mut conn.reader)?;
            match status.code {
                200 => {
                    *connected = true;
                    return self.read(conn, status.chunked);
                }
                401 if attempt == 0 => {
                    cookie = Some(self.auth.login(agent, Some(&current))?);
                }
                409 => {
                    self.log.error(
                        "stream.protocol",
                        &format!("ours={PROTOCOL} server refused it: update the daemon"),
                    );
                    return Err(NetError::Status(409));
                }
                code => return Err(NetError::Status(code)),
            }
        }
        Err(NetError::Status(401))
    }

    fn dial(&self, cookie: &str) -> Result<Conn, NetError> {
        let origin = Origin::parse(&self.auth.origin)?;
        let addr = (origin.host.as_str(), origin.port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| NetError::Origin(self.auth.origin.clone()))?;
        let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
        tcp.set_read_timeout(Some(STREAM_IDLE))?;
        tcp.set_nodelay(true)?;
        *self.socket.lock().unwrap_or_else(PoisonError::into_inner) = Some(tcp.try_clone()?);
        if self.stopped() {
            let _ = tcp.shutdown(Shutdown::Both);
            return Err(NetError::Stopped);
        }
        let io: Box<dyn ReadWrite> = if origin.tls {
            let connector =
                native_tls::TlsConnector::new().map_err(|e| NetError::Tls(e.to_string()))?;
            Box::new(
                connector
                    .connect(&origin.host, tcp)
                    .map_err(|e| NetError::Tls(e.to_string()))?,
            )
        } else {
            Box::new(tcp)
        };
        let mut reader = BufReader::with_capacity(8 * 1024, io);
        let request = format!(
            "GET /api/board/stream?protocol={PROTOCOL}&device={}&addrs={} HTTP/1.1\r\nhost: {}\r\naccept: text/event-stream\r\ncache-control: no-cache\r\ncookie: {cookie}\r\nuser-agent: boxbox-board/{}\r\n\r\n",
            self.device,
            self.addrs,
            origin.host_header,
            env!("CARGO_PKG_VERSION"),
        );
        reader.get_mut().write_all(request.as_bytes())?;
        reader.get_mut().flush()?;
        Ok(Conn { reader })
    }

    fn read(&self, conn: Conn, chunked: bool) -> Result<End, NetError> {
        let _ = self.tx.send(Msg::StreamUp {
            generation: self.generation,
        });
        self.log.info("stream.up", "");
        let mut body = Body {
            inner: conn.reader,
            chunked,
            left: 0,
            done: false,
        };
        let mut parser = Parser::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = match body.read(&mut buf) {
                Ok(0) => return Ok(End::Retry),
                Ok(n) => n,
                Err(e) if self.stopped() => {
                    let _ = e;
                    return Ok(End::Done);
                }
                Err(e) => return Err(NetError::Io(e)),
            };
            let events = parser
                .feed(&buf[..n])
                .map_err(|e| NetError::Io(std::io::Error::other(e)))?;
            for data in events {
                let frame = match serde_json::from_str::<Frame>(&data) {
                    Ok(frame) => frame,
                    Err(e) => {
                        self.log.warn("stream.unreadable", &format!("error={e}"));
                        continue;
                    }
                };
                match frame {
                    Frame::Hello { protocol, .. } if protocol != PROTOCOL => {
                        self.log.error(
                            "stream.protocol",
                            &format!("theirs={protocol} ours={PROTOCOL}"),
                        );
                        return Err(NetError::Status(409));
                    }
                    Frame::Hello { .. } => {}
                    Frame::Replaced => {
                        self.log.warn("stream.replaced", "");
                        return Ok(End::Replaced);
                    }
                    frame => {
                        if self
                            .tx
                            .send(Msg::Frame {
                                generation: self.generation,
                                frame: Box::new(frame),
                            })
                            .is_err()
                        {
                            return Ok(End::Done);
                        }
                    }
                }
            }
        }
    }
}

/// the wait before the next dial: back to the first step once the server
/// took the stream (its 200), however the stream then ended.
#[must_use]
pub fn backoff_for(current: Duration, connected: bool) -> Duration {
    if connected { BACKOFF_FIRST } else { current }
}

trait ReadWrite: Read + Write + Send {}
impl<T: Read + Write + Send> ReadWrite for T {}

struct Conn {
    reader: BufReader<Box<dyn ReadWrite>>,
}

struct Status {
    code: u16,
    chunked: bool,
}

fn read_status(reader: &mut impl BufRead) -> Result<Status, NetError> {
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let code = line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .filter(|_| line.starts_with("HTTP/1."))
        .ok_or(NetError::Garbled)?;
    let mut chunked = false;
    let mut total = 0usize;
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        total += n;
        if n == 0 || total > 64 * 1024 {
            return Err(NetError::Garbled);
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        }
    }
    Ok(Status { code, chunked })
}

/// a response body: chunked, or read to the close.
struct Body<R> {
    inner: R,
    chunked: bool,
    left: usize,
    done: bool,
}

impl<R: BufRead> Read for Body<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if !self.chunked {
            return self.inner.read(buf);
        }
        if self.done {
            return Ok(0);
        }
        if self.left == 0 {
            let mut line = String::new();
            // the crlf closing the previous chunk, then the size line.
            loop {
                line.clear();
                if self.inner.read_line(&mut line)? == 0 {
                    return Ok(0);
                }
                if !line.trim().is_empty() {
                    break;
                }
            }
            let size = line.trim().split(';').next().unwrap_or("");
            self.left = usize::from_str_radix(size, 16)
                .map_err(|_| std::io::Error::other("bad chunk size"))?;
            if self.left == 0 {
                self.done = true;
                return Ok(0);
            }
        }
        let cap = buf.len().min(self.left);
        let n = self.inner.read(&mut buf[..cap])?;
        self.left -= n;
        Ok(n)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Origin {
    tls: bool,
    host: String,
    port: u16,
    host_header: String,
}

impl Origin {
    fn parse(origin: &str) -> Result<Self, NetError> {
        let bad = || NetError::Origin(origin.to_owned());
        let (tls, rest) = if let Some(rest) = origin.strip_prefix("https://") {
            (true, rest)
        } else if let Some(rest) = origin.strip_prefix("http://") {
            (false, rest)
        } else {
            return Err(bad());
        };
        let authority = rest.split('/').next().unwrap_or("");
        if authority.is_empty() {
            return Err(bad());
        }
        let default = if tls { 443 } else { 80 };
        let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
            let (h, after) = v6.split_once(']').ok_or_else(bad)?;
            let port = match after.strip_prefix(':') {
                Some(p) => p.parse().map_err(|_| bad())?,
                None => default,
            };
            (h.to_owned(), port)
        } else if let Some((h, p)) = authority.rsplit_once(':') {
            (h.to_owned(), p.parse().map_err(|_| bad())?)
        } else {
            (authority.to_owned(), default)
        };
        Ok(Self {
            tls,
            host,
            port,
            host_header: authority.to_owned(),
        })
    }
}

/// every address of this mac a browser on it could reach the server from:
/// non-loopback v4 and v6 (tailnet and lan), link-local left out.
#[must_use]
pub fn local_addrs() -> String {
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return String::new();
    };
    let mut out: Vec<String> = ifaces
        .into_iter()
        .filter(|i| !i.is_loopback())
        .map(|i| i.ip())
        .filter(|ip| match ip {
            std::net::IpAddr::V4(v4) => !v4.is_link_local(),
            std::net::IpAddr::V6(v6) => !v6.is_unicast_link_local(),
        })
        .map(|ip| ip.to_string())
        .collect();
    out.sort();
    out.dedup();
    out.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ureq compiles its native-tls connector only under its full
    /// `native-tls` feature; with `native-tls-no-default` alone every https
    /// post panicked on a real server ("provider is `NativeTls` but feature is
    /// not enabled"), which the harness, on plain http, never reached. an
    /// https post to a socket that speaks no tls must come back as an error.
    #[test]
    fn an_https_post_fails_as_an_error_not_a_panic() -> std::io::Result<()> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let server = std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0_u8; 512];
                let _ = std::io::Read::read(&mut s, &mut buf);
                let _ = std::io::Write::write_all(&mut s, b"HTTP/1.1 400 not tls\r\n\r\n");
            }
        });
        let result = agent()
            .post(format!("https://127.0.0.1:{port}/api/login"))
            .send("x");
        assert!(result.is_err());
        let _ = server.join();
        Ok(())
    }

    #[test]
    fn a_private_file_is_0600_even_over_a_wide_stale_temp() -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("boxbox-board-private-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("cookie");
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, "stale")?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o666))?;
        write_private(&path, "a=b")?;
        let mode = std::fs::metadata(&path)?.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&path)?, "a=b");
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn errors_log_their_kind_never_their_text() {
        let e = NetError::Origin("https://desk.example.ts.net".into());
        assert_eq!(e.kind(), "origin");
        let e = NetError::NoPassword("/Users/someone/pw: missing".into());
        assert!(!e.kind().contains('/'));
        let e = NetError::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "100.64.0.1:3000",
        ));
        assert_eq!(e.kind(), "io:ConnectionRefused");
    }

    #[test]
    fn a_stream_the_server_took_resets_the_backoff_however_it_ended() {
        assert_eq!(backoff_for(BACKOFF_CAP, true), BACKOFF_FIRST);
        assert_eq!(backoff_for(BACKOFF_CAP, false), BACKOFF_CAP);
    }

    #[test]
    fn origins_parse() -> Result<(), NetError> {
        let o = Origin::parse("https://boxbox.example.ts.net")?;
        assert_eq!(
            (o.tls, o.host.as_str(), o.port),
            (true, "boxbox.example.ts.net", 443)
        );
        let o = Origin::parse("http://127.0.0.1:3014")?;
        assert_eq!((o.tls, o.host.as_str(), o.port), (false, "127.0.0.1", 3014));
        assert_eq!(o.host_header, "127.0.0.1:3014");
        let o = Origin::parse("http://[fd7a::1]:3014")?;
        assert_eq!((o.host.as_str(), o.port), ("fd7a::1", 3014));
        assert!(Origin::parse("ftp://x").is_err());
        Ok(())
    }

    #[test]
    fn a_chunked_body_reads_whole() -> std::io::Result<()> {
        let raw = b"5\r\nhello\r\n7\r\n, world\r\n0\r\n\r\n";
        let mut body = Body {
            inner: &raw[..],
            chunked: true,
            left: 0,
            done: false,
        };
        let mut out = String::new();
        body.read_to_string(&mut out)?;
        assert_eq!(out, "hello, world");
        Ok(())
    }

    #[test]
    fn the_status_line_and_chunking_are_read() -> Result<(), NetError> {
        let raw = b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\nrest";
        let mut r = &raw[..];
        let s = read_status(&mut r)?;
        assert_eq!((s.code, s.chunked), (200, true));
        Ok(())
    }
}
