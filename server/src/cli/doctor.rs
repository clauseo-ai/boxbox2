//! `boxbox doctor`: whether this install can run, in one redacted report.
//! it reads the config through the parser `serve` uses, asks every host for
//! `/global/health` with its credential, looks at the data dir (the cookie
//! secret, `boxbox.db` and the push key in it, telemetry) and tries the
//! listen address. it never writes: the db is opened read-only, and nothing
//! is minted or created.
//!
//! nothing secret is printed: passwords are "set", never shown or counted,
//! and a url loses its userinfo and query.

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::Path;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use reqwest::Url;

use crate::cmx2;
use crate::config::{self, Config, ConfigError, Credential, HostConfig};
use crate::upstream;

/// the health route the upstream watcher starts every connection with.
const HEALTH: &str = "/global/health";
/// a host slower than this to answer its health is reported down.
const HOST_TIMEOUT: Duration = Duration::from_secs(5);
/// a health answer is a few hundred bytes; nothing larger is read.
const HEALTH_CAP: usize = 64 * 1024;
/// where push keeps its vapid key (`src/push/vapid.rs`, `src/store/schema.rs`).
const PUSH_KEY_TABLE: &str = "push_vapid";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Ok,
    /// neither a problem nor there yet, like a db before the first start.
    Note,
    Warn,
    Fail,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Note => "note",
            Self::Warn => "warn",
            Self::Fail => "fail",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Line {
    pub level: Level,
    pub text: String,
}

fn line(level: Level, text: impl Into<String>) -> Line {
    Line {
        level,
        text: text.into(),
    }
}

#[derive(Debug)]
struct Section {
    title: &'static str,
    subject: Option<String>,
    lines: Vec<Line>,
}

pub fn run(config_path: &str) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            let _ = writeln!(
                io::stderr(),
                "boxbox doctor: the async runtime did not start: {e}"
            );
            return ExitCode::FAILURE;
        }
    };
    let sections = examine(&runtime, config_path);
    let report = render(&sections);
    let _ = io::stdout().lock().write_all(report.as_bytes());
    let failed = sections
        .iter()
        .flat_map(|s| &s.lines)
        .any(|l| l.level == Level::Fail);
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// the runtime serves only the network checks; the file and db checks are
/// plain blocking calls, made outside it.
fn examine(runtime: &tokio::runtime::Runtime, config_path: &str) -> Vec<Section> {
    let (config_section, config) = examine_config(config_path);
    let mut sections = vec![config_section];
    let Some(config) = config else {
        return sections;
    };
    sections.push(Section {
        title: "hosts",
        subject: None,
        lines: runtime.block_on(examine_hosts(&config.hosts)),
    });
    sections.push(Section {
        title: "data",
        subject: Some(config.data_dir.display().to_string()),
        lines: examine_data(&config.data_dir),
    });
    sections.push(Section {
        title: "listen",
        subject: Some(config.listen.to_string()),
        lines: vec![runtime.block_on(examine_listen(config.listen))],
    });
    sections
}

fn examine_config(path: &str) -> (Section, Option<Config>) {
    let mut lines = Vec::new();
    let loaded = Config::load(path);
    let shown = match &loaded {
        Ok(config) => config.path.display().to_string(),
        Err(_) => {
            config::expand_home(path).map_or_else(|_| path.to_owned(), |p| p.display().to_string())
        }
    };
    let config = match loaded {
        Ok(config) => Some(config),
        Err(ConfigError::Read { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
            lines.push(line(
                Level::Fail,
                "no config here: run `boxbox init` to write one, or pass --config <path>",
            ));
            None
        }
        Err(ConfigError::Exposed { mode, path }) => {
            lines.push(line(
                Level::Fail,
                format!(
                    "mode {mode:o}: others can read its passwords. run `chmod 600 {}`, then doctor again",
                    path.display()
                ),
            ));
            None
        }
        Err(error) => {
            lines.push(line(Level::Fail, format!("does not load: {error}")));
            None
        }
    };
    if let Some(config) = &config {
        lines.push(line(
            Level::Ok,
            format!(
                "mode {:o}, only you can read it",
                file_mode(&config.path).unwrap_or(0o600)
            ),
        ));
        lines.push(line(
            Level::Ok,
            format!(
                "loads: listen {}, {}",
                config.listen,
                count(config.hosts.len(), "host", "hosts")
            ),
        ));
        lines.push(line(Level::Ok, "gate password set (never shown)"));
        lines.push(if config.cookie.secure {
            line(Level::Ok, format!("cookie {}, secure", config.cookie.name))
        } else {
            line(
                Level::Warn,
                format!(
                    "cookie {} is not marked secure: right for plain http on this machine or a dev server, never behind https",
                    config.cookie.name
                ),
            )
        });
        if let Some(dev) = &config.dev {
            lines.push(line(
                Level::Warn,
                format!(
                    "[dev] proxies the app to vite at {}: a dev config, not one to deploy",
                    redact_url(&dev.vite)
                ),
            ));
        }
    }
    (
        Section {
            title: "config",
            subject: Some(shown),
            lines,
        },
        config,
    )
}

async fn examine_hosts(hosts: &[HostConfig]) -> Vec<Line> {
    if hosts.is_empty() {
        return vec![line(
            Level::Warn,
            "none: add a [[host]] for each cmx2 daemon; the server picks it up without a restart",
        )];
    }
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(HOST_TIMEOUT)
        .user_agent(concat!("boxbox-doctor/", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            return vec![line(
                Level::Fail,
                format!("the http client did not build: {e}"),
            )];
        }
    };
    let width = hosts.iter().map(|h| h.name.len()).max().unwrap_or(0);
    let checks = hosts.iter().map(|host| async {
        let (level, outcome) = check_host(&client, host).await;
        let credential = match &host.credential {
            Some(Credential::Basic { .. }) => ", with its password",
            Some(Credential::Bearer(_)) => ", paired (bearer)",
            None => ", no credential",
        };
        line(
            level,
            format!(
                "{:<width$}  {}  {outcome}{credential}",
                host.name,
                redact_url(&host.url)
            ),
        )
    });
    futures_util::future::join_all(checks).await
}

async fn check_host(client: &reqwest::Client, host: &HostConfig) -> (Level, String) {
    let started = Instant::now();
    let response = match upstream::get(client, host, HEALTH).send().await {
        Ok(response) => response,
        Err(error) => return (Level::Fail, upstream::plain(&error)),
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return (Level::Fail, refused_hint(host).into());
    }
    if !status.is_success() {
        return (Level::Fail, format!("answered {HEALTH} with {status}"));
    }
    let body = match read_capped(response, HEALTH_CAP).await {
        Ok(body) => body,
        Err(problem) => return (Level::Fail, problem),
    };
    let latency = started.elapsed().as_millis();
    let health: cmx2::HealthResponse = match serde_json::from_slice(&body) {
        Ok(health) => health,
        Err(e) => {
            return (
                Level::Fail,
                format!("answered {HEALTH}, but not as cmx2 does ({e}): is this a cmx2 daemon?"),
            );
        }
    };
    let summary = format!(
        "cmx2 {}, contract {}, {latency} ms",
        health.version, health.contract
    );
    if health.contract != cmx2::CONTRACT_VERSION {
        (
            Level::Warn,
            format!(
                "{summary}: this boxbox speaks contract {}, so frames may not decode",
                cmx2::CONTRACT_VERSION
            ),
        )
    } else if !health.healthy {
        (Level::Warn, format!("{summary}, reports itself unhealthy"))
    } else {
        (Level::Ok, summary)
    }
}

/// what a 401 means for how this host signs in.
fn refused_hint(host: &HostConfig) -> &'static str {
    match &host.credential {
        Some(Credential::Basic { .. }) => {
            "refused the credential (401): check this host's password"
        }
        Some(Credential::Bearer(_)) => {
            "refused the bearer (401): the daemon no longer knows this pairing (cmx2 pair --list there). pair again with cmx2 pair, and put the new bearer in this [[host]]"
        }
        None => {
            "refused the request (401): the daemon wants a credential. pair with it (cmx2 pair there, then boxbox init --pair or the machines screen), or give this host its password"
        }
    }
}

async fn read_capped(mut response: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > cap {
                    return Err(format!(
                        "answered {HEALTH} with more than {} kb: is this a cmx2 daemon?",
                        cap / 1024
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(body),
            Err(error) => return Err(upstream::plain(&error)),
        }
    }
}

fn examine_data(dir: &Path) -> Vec<Line> {
    match fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return vec![line(
                Level::Fail,
                "is not a directory: point data_dir at one",
            )];
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return vec![line(
                Level::Note,
                "not there yet: the server makes it, mode 700, on its first start",
            )];
        }
        Err(e) => return vec![line(Level::Fail, format!("cannot look at it: {e}"))],
    }
    let mut lines = Vec::new();
    lines.push(match file_mode(dir) {
        Some(mode) if mode & 0o077 != 0 => line(
            Level::Warn,
            format!(
                "mode {mode:o}: others can look inside. run `chmod 700 {}`",
                dir.display()
            ),
        ),
        Some(mode) => line(Level::Ok, format!("mode {mode:o}")),
        None => line(Level::Ok, "present"),
    });
    lines.push(examine_secret(&dir.join("secret")));
    lines.extend(examine_db(&dir.join("boxbox.db")));
    lines.push(examine_telemetry(&dir.join("telemetry")));
    lines
}

fn examine_secret(path: &Path) -> Line {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return line(
                Level::Note,
                "no cookie secret yet: the server mints one on its first start",
            );
        }
        Err(e) => return line(Level::Fail, format!("cannot read the cookie secret: {e}")),
    };
    let text = text.trim();
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return line(
            Level::Fail,
            format!(
                "the cookie secret is not 64 hex characters: delete {} and every device signs in again",
                path.display()
            ),
        );
    }
    match file_mode(path) {
        Some(mode) if mode & 0o077 != 0 => line(
            Level::Warn,
            format!(
                "cookie secret present, but mode {mode:o}: run `chmod 600 {}`",
                path.display()
            ),
        ),
        _ => line(Level::Ok, "cookie secret present, mode 600"),
    }
}

/// `boxbox.db` and the push key in it, read-only: a running server keeps
/// writing while doctor reads.
fn examine_db(path: &Path) -> Vec<Line> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};

    if !path.exists() {
        return vec![
            line(
                Level::Note,
                "no boxbox.db yet: the server creates it on its first start",
            ),
            line(
                Level::Note,
                "no push key yet: the server mints one into boxbox.db",
            ),
        ];
    }
    let bytes = file_size(path) + file_size(&path.with_extension("db-wal"));
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let checked = Connection::open_with_flags(path, flags).and_then(|db| {
        db.busy_timeout(Duration::from_secs(2))?;
        let integrity: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        let schema: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let has_push: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [PUSH_KEY_TABLE],
            |r| r.get(0),
        )?;
        let key: Option<(i64, i64)> = if has_push {
            db.query_row(
                &format!(
                    "SELECT length(private_key), created_at FROM {PUSH_KEY_TABLE} WHERE id = 1"
                ),
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
        } else {
            None
        };
        Ok((integrity, schema, has_push, key))
    });
    let (integrity, schema, has_push, key) = match checked {
        Ok(checked) => checked,
        Err(e) => {
            return vec![line(Level::Fail, format!("boxbox.db cannot be read: {e}"))];
        }
    };
    let db = if integrity == "ok" {
        line(
            Level::Ok,
            format!("boxbox.db {}, schema {schema}, integrity ok", size(bytes)),
        )
    } else {
        line(
            Level::Fail,
            format!("boxbox.db fails its integrity check: {integrity}. restore it from a backup"),
        )
    };
    let push = match key {
        // a p-256 private key is a 32-byte scalar
        Some((32, created_at)) => line(
            Level::Ok,
            format!("push key present, minted {}", day_of(created_at)),
        ),
        Some((length, _)) => line(
            Level::Fail,
            format!(
                "the push key in boxbox.db is {length} bytes, not a p-256 key: every device has to subscribe again once it is replaced"
            ),
        ),
        None if has_push => line(
            Level::Warn,
            "no push key in boxbox.db: the server mints one when it starts",
        ),
        None => line(
            Level::Note,
            "no push key yet: this boxbox.db predates push; the server adds it at start",
        ),
    };
    vec![db, push]
}

fn examine_telemetry(dir: &Path) -> Line {
    let Ok(entries) = fs::read_dir(dir) else {
        return line(
            Level::Note,
            "no telemetry yet: the server writes a file a day into telemetry/",
        );
    };
    let mut days: Vec<String> = Vec::new();
    let mut bytes = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(day) = name.strip_suffix(".jsonl") {
            bytes += entry.metadata().map_or(0, |m| m.len());
            days.push(day.to_owned());
        }
    }
    days.sort_unstable();
    match days.last() {
        Some(newest) => line(
            Level::Ok,
            format!(
                "telemetry: {}, {}, newest {newest}",
                count(days.len(), "day", "days"),
                size(bytes)
            ),
        ),
        None => line(
            Level::Note,
            "no telemetry yet: the server writes a file a day into telemetry/",
        ),
    }
}

/// free, taken by a boxbox (which answers `/api/hosts` with its sign-in
/// error), or taken by something else.
async fn examine_listen(addr: SocketAddr) -> Line {
    let bound = std::net::TcpListener::bind(addr);
    match bound {
        Ok(listener) => {
            drop(listener);
            line(Level::Ok, "free")
        }
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            if answers_like_boxbox(addr).await {
                line(
                    Level::Note,
                    "a boxbox already answers here; a second one on this address would not start",
                )
            } else {
                line(
                    Level::Fail,
                    "something else listens here, so boxbox cannot: pick another listen address",
                )
            }
        }
        Err(e) if e.kind() == io::ErrorKind::AddrNotAvailable => line(
            Level::Fail,
            format!("no interface on this machine has {}", addr.ip()),
        ),
        Err(e) => line(Level::Fail, format!("cannot listen here: {e}")),
    }
}

pub(crate) async fn answers_like_boxbox(addr: SocketAddr) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    let Ok(response) = client.get(format!("http://{addr}/api/hosts")).send().await else {
        return false;
    };
    if response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return false;
    }
    read_capped(response, 4096)
        .await
        .is_ok_and(|body| String::from_utf8_lossy(&body).contains("\"code\":\"sign-in\""))
}

/// a url without its userinfo, query or fragment, which may carry secrets.
fn redact_url(url: &Url) -> String {
    let mut shown = url.clone();
    let had_userinfo = !url.username().is_empty() || url.password().is_some();
    let _ = shown.set_username("");
    let _ = shown.set_password(None);
    let had_query = url.query().is_some() || url.fragment().is_some();
    shown.set_query(None);
    shown.set_fragment(None);
    let mut text = shown.to_string();
    if text.ends_with('/') && url.path() == "/" {
        text.pop();
    }
    if had_userinfo && let Some(at) = text.find("://") {
        text.insert_str(at + 3, "***@");
    }
    if had_query {
        text.push_str("?***");
    }
    text
}

fn render(sections: &[Section]) -> String {
    let mut text = format!(
        "boxbox {}, built against cmx2 contract {}\n",
        env!("CARGO_PKG_VERSION"),
        cmx2::CONTRACT_VERSION
    );
    let (mut ok, mut notes, mut warnings, mut failures) = (0, 0, 0, 0);
    for section in sections {
        text.push('\n');
        match &section.subject {
            Some(subject) => {
                let _ = writeln!(text, "{:<8}  {subject}", section.title);
            }
            None => {
                let _ = writeln!(text, "{}", section.title);
            }
        }
        for line in &section.lines {
            *match line.level {
                Level::Ok => &mut ok,
                Level::Note => &mut notes,
                Level::Warn => &mut warnings,
                Level::Fail => &mut failures,
            } += 1;
            let _ = writeln!(text, "  {:<6}  {}", line.level.label(), line.text);
        }
    }
    let counts = [
        (failures, "failed", "failed"),
        (warnings, "warning", "warnings"),
        (ok, "ok", "ok"),
        (notes, "note", "notes"),
    ]
    .iter()
    .filter(|(n, ..)| *n > 0)
    .map(|&(n, one, many)| count(n, one, many))
    .collect::<Vec<_>>()
    .join(", ");
    text.push('\n');
    let verdict = if failures > 0 {
        "fix what failed, then run doctor again."
    } else if warnings > 0 {
        "boxbox can run; the warnings say what to look at."
    } else {
        "ready to serve."
    };
    let _ = writeln!(text, "{counts}. {verdict}");
    text
}

fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn size(bytes: u64) -> String {
    if bytes < 1_048_576 {
        format!("{} kb", bytes.div_ceil(1024))
    } else {
        #[allow(clippy::cast_precision_loss, reason = "a size shown to one decimal")]
        let mb = bytes as f64 / 1_048_576.0;
        format!("{mb:.1} mb")
    }
}

/// the local day, as telemetry names its files.
fn day_of(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map_or_else(
        |_| "at an unreadable time".into(),
        |t| {
            t.to_zoned(jiff::tz::TimeZone::system())
                .strftime("%Y-%m-%d")
                .to_string()
        },
    )
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |m| m.len())
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .ok()
        .map(|m| m.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn file_mode(_: &Path) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "boxbox-doctor-{name}-{}-{}",
                std::process::id(),
                rand::random::<u32>()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn chmod(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    fn write_config(dir: &TempDir, text: &str) -> String {
        let path = dir.0.join("boxbox.toml");
        fs::write(&path, text).unwrap();
        #[cfg(unix)]
        chmod(&path, 0o600);
        path.display().to_string()
    }

    fn levels(lines: &[Line]) -> Vec<Level> {
        lines.iter().map(|l| l.level).collect()
    }

    #[test]
    fn urls_lose_their_userinfo_and_query() {
        let shown = |text: &str| redact_url(&Url::parse(text).unwrap());
        assert_eq!(shown("http://127.0.0.1:4096"), "http://127.0.0.1:4096");
        assert_eq!(
            shown("https://vm.example/cmx2/"),
            "https://vm.example/cmx2/"
        );
        assert_eq!(
            shown("http://cmx2:hunter22@desk.example:4096/?token=abc"),
            "http://***@desk.example:4096?***"
        );
    }

    #[test]
    fn the_report_never_prints_a_password() {
        let dir = TempDir::new("redact");
        let path = write_config(
            &dir,
            &format!(
                "password = \"gate-hunter22\"\ndata_dir = \"{}\"\n\
                 [[host]]\nname = \"desk\"\nurl = \"http://u:url-hunter22@127.0.0.1:9\"\npassword = \"host-hunter22\"\n",
                dir.0.join("data").display()
            ),
        );
        let (section, config) = examine_config(&path);
        let mut text = render(&[section]);
        text.push_str(&redact_url(&config.unwrap().hosts[0].url));
        assert!(!text.contains("hunter22"), "{text}");
    }

    #[test]
    fn a_paired_host_is_reported_without_its_bearer_and_a_refusal_says_pair_again() {
        let dir = TempDir::new("bearer");
        let path = write_config(
            &dir,
            "password = \"gate-long-enough\"\n[[host]]\nname = \"desk\"\nurl = \"http://127.0.0.1:9\"\nbearer = \"cmx2_hunter22\"\n",
        );
        let (section, config) = examine_config(&path);
        let config = config.unwrap();
        assert!(!render(&[section]).contains("hunter22"));
        let hint = refused_hint(&config.hosts[0]);
        assert!(hint.starts_with("refused the bearer (401)"), "{hint}");
        assert!(!hint.contains("hunter22"));
    }

    #[cfg(unix)]
    #[test]
    fn a_config_others_can_read_fails_with_the_fix() {
        let dir = TempDir::new("exposed");
        let path = write_config(&dir, "password = \"long enough\"");
        chmod(Path::new(&path), 0o644);
        let (section, config) = examine_config(&path);
        assert!(config.is_none());
        assert_eq!(levels(&section.lines), [Level::Fail]);
        assert!(section.lines[0].text.contains("chmod 600"));
    }

    #[test]
    fn a_missing_config_points_at_init() {
        let (section, config) = examine_config("/nonexistent/boxbox.toml");
        assert!(config.is_none());
        assert!(section.lines[0].text.contains("boxbox init"));
    }

    #[test]
    fn a_fresh_data_dir_is_a_note_not_a_failure() {
        let dir = TempDir::new("fresh");
        let lines = examine_data(&dir.0.join("not-yet"));
        assert_eq!(levels(&lines), [Level::Note]);

        #[cfg(unix)]
        chmod(&dir.0, 0o700);
        let lines = examine_data(&dir.0);
        assert_eq!(
            levels(&lines),
            [
                Level::Ok,
                Level::Note,
                Level::Note,
                Level::Note,
                Level::Note
            ]
        );
    }

    #[test]
    fn a_malformed_cookie_secret_fails_and_a_good_one_passes() {
        let dir = TempDir::new("secret");
        let path = dir.0.join("secret");
        fs::write(&path, "not hex").unwrap();
        assert_eq!(examine_secret(&path).level, Level::Fail);
        fs::write(&path, format!("{}\n", "ab".repeat(32))).unwrap();
        #[cfg(unix)]
        chmod(&path, 0o600);
        assert_eq!(examine_secret(&path).level, Level::Ok);
    }

    #[test]
    fn the_push_key_is_read_from_the_db_push_writes() {
        let dir = TempDir::new("db");
        let path = dir.0.join("boxbox.db");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA user_version = 1; CREATE TABLE unrelated (id INTEGER);")
            .unwrap();
        let lines = examine_db(&path);
        assert_eq!(levels(&lines), [Level::Ok, Level::Note]);
        assert!(
            lines[0].text.contains("schema 1, integrity ok"),
            "{}",
            lines[0].text
        );

        db.execute_batch(
            "CREATE TABLE push_vapid (id INTEGER PRIMARY KEY CHECK (id = 1), private_key BLOB NOT NULL, created_at INTEGER NOT NULL);",
        )
        .unwrap();
        assert_eq!(examine_db(&path)[1].level, Level::Warn);

        db.execute(
            "INSERT INTO push_vapid (id, private_key, created_at) VALUES (1, ?1, ?2)",
            rusqlite::params![vec![7u8; 32], 1_790_000_000_000_i64],
        )
        .unwrap();
        let push = &examine_db(&path)[1];
        assert_eq!(push.level, Level::Ok);
        assert!(
            push.text.starts_with("push key present, minted 2026-"),
            "{}",
            push.text
        );
        assert!(!push.text.contains("0707"), "the key itself is never shown");
    }

    #[test]
    fn sizes_read_in_kb_until_a_megabyte() {
        assert_eq!(size(0), "0 kb");
        assert_eq!(size(4096), "4 kb");
        assert_eq!(size(4097), "5 kb");
        assert_eq!(size(3 * 1_048_576 / 2), "1.5 mb");
    }

    #[test]
    fn telemetry_is_counted_by_day() {
        let dir = TempDir::new("telemetry");
        let telemetry = dir.0.join("telemetry");
        fs::create_dir_all(&telemetry).unwrap();
        fs::write(telemetry.join("2026-09-30.jsonl"), "{}\n").unwrap();
        fs::write(telemetry.join("2026-10-01.jsonl"), "{}\n").unwrap();
        let line = examine_telemetry(&telemetry);
        assert_eq!(line.level, Level::Ok);
        assert!(line.text.contains("2 days") && line.text.ends_with("newest 2026-10-01"));
    }

    #[tokio::test]
    async fn an_unreachable_host_fails_in_plain_words() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let host = HostConfig {
            name: "desk".into(),
            url: Url::parse(&format!("http://127.0.0.1:{port}")).unwrap(),
            credential: None,
            origin: crate::config::Origin::Config,
        };
        let lines = examine_hosts(&[host]).await;
        assert_eq!(levels(&lines), [Level::Fail]);
        assert!(
            lines[0].text.contains("cannot connect"),
            "{}",
            lines[0].text
        );
    }

    #[tokio::test]
    async fn a_taken_listen_address_is_told_apart_from_a_free_one() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = listener.local_addr().unwrap();
        assert_eq!(examine_listen(taken).await.level, Level::Fail);
        drop(listener);
        assert_eq!(examine_listen(taken).await, line(Level::Ok, "free"));
    }

    #[test]
    fn the_summary_leads_with_what_failed() {
        let sections = [Section {
            title: "hosts",
            subject: None,
            lines: vec![
                line(Level::Ok, "a"),
                line(Level::Fail, "b"),
                line(Level::Note, "c"),
            ],
        }];
        let text = render(&sections);
        assert!(
            text.ends_with("1 failed, 1 ok, 1 note. fix what failed, then run doctor again.\n")
        );
    }
}
