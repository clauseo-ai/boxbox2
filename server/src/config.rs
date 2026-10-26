//! `boxbox.toml`, the typed config. it holds the gate password and every
//! host's credential, so it must be readable by its owner only, and none
//! of it ever reaches a browser (architecture: auth, config, data).

use std::collections::BTreeMap;
use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::source::{AgentOverride, ConnectionConfig, HermesConfig, OpenclawConfig, OpenclawMode};

/// where the server looks when `--config` and `BOXBOX_CONFIG` are unset.
pub const DEFAULT_PATH: &str = "~/.config/boxbox/boxbox.toml";

/// the vapid contact when `[push] contact` is unset.
pub const DEFAULT_CONTACT: &str = "mailto:boxbox@localhost";

/// where the server listens when `listen` is unset: loopback, behind an
/// https front (docs/deploy.md).
pub const DEFAULT_LISTEN: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 3000);

/// where the data lives when `data_dir` is unset.
pub const DEFAULT_DATA_DIR: &str = "~/.local/share/boxbox";

/// the gate password's shortest length, in bytes.
pub const MIN_PASSWORD_BYTES: usize = 8;

/// the transcript cache across connections when `[cache] transcript_bytes`
/// is unset (`docs/agents.md`, the transcript cache).
pub const DEFAULT_TRANSCRIPT_BYTES: u64 = 256 * 1024 * 1024;

/// the longest openclaw or hermes connection name, so every derived agent
/// key fits in 32 characters (`docs/agents.md`, section 3).
pub const MAX_GATEWAY_NAME: usize = 24;

/// the named assistant palette slots an agent's `palette` may choose
/// (`docs/design.md`, assistant palettes).
pub const ASSISTANT_PALETTES: [&str; 5] = ["coral", "lime", "jade", "lagoon", "orchid"];

#[derive(Debug, Clone)]
pub struct Config {
    /// the file this was read from, `~` expanded.
    pub path: PathBuf,
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub password: Secret,
    pub cookie: CookieConfig,
    pub dev: Option<DevConfig>,
    pub push: PushConfig,
    pub media: MediaConfig,
    /// every cmx2 daemon: the `[[host]]` entries, then the `[[cmx2]]` ones,
    /// each in file order.
    pub hosts: Vec<HostConfig>,
    pub openclaw: Vec<OpenclawConfig>,
    /// reserved (decision 35): parsed and checked, run by nothing yet.
    pub hermes: Vec<HermesConfig>,
    pub cache: CacheConfig,
    /// `[board]`: the keypad add-on (`docs/board.md`). none, the default,
    /// turns the board off: no route, no projection, no task.
    pub board: Option<BoardConfig>,
}

/// the board's machine lights, at most `boxbox_board_wire::MAX_MACHINES`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardConfig {
    /// each a `label.machine`, in key order (`/ * - +`); none for the
    /// app's machine order.
    pub machines: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheConfig {
    /// the transcript cache across connections, in bytes, more than 0.
    pub transcript_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaConfig {
    /// `[media] max_bytes`: the most bytes the media store keeps, every file
    /// counted; least recently used files go past it (`agents.md`, media).
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushConfig {
    /// the vapid `sub`: a `mailto:` or `https:` address a push service can
    /// reach about this server's pushes. apple's service wants a real one.
    pub contact: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CookieConfig {
    /// dev servers use their own name so a secure production cookie on the
    /// same host never shadows them (`scars.md`, line 674).
    pub name: String,
    /// `Secure` on the cookie: on behind https, off for a plain-http dev server.
    pub secure: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevConfig {
    /// the vite dev server the asset routes proxy to.
    pub vite: Url,
    /// the auto-clear sweep every 10 s, with its waits in minutes, not hours
    /// (`fleet::model::SweepPace::fast`): for seeing auto-clear on a dev
    /// server. a config without `[dev]` cannot ask for it.
    pub sweep_fast: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostConfig {
    /// the identity half of `host:session`: lowercase, digits and dashes.
    pub name: String,
    pub url: Url,
    /// how boxbox proves itself to the daemon, when the daemon asks.
    pub credential: Option<Credential>,
    pub origin: Origin,
}

/// where a host came from, which decides who may change it.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, utoipa::ToSchema,
)]
#[serde(rename_all = "lowercase")]
#[schema(as = HostOrigin)]
pub enum Origin {
    /// a `[[host]]` in `boxbox.toml`: edited there, never from the app.
    Config,
    /// paired from the machines screen (cmx2-asks a12): kept in `boxbox.db`,
    /// forgotten from the same screen.
    Paired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    /// the daemon's password, sent as basic auth (`user` is `cmx2` unless set).
    Basic { user: String, password: Secret },
    /// the credential the daemon's `POST /pair` traded for a one-time token.
    Bearer(Secret),
}

impl Credential {
    /// the `authorization` header, marked sensitive so no debug print or
    /// log line carries it. `None` when the secret holds bytes a header
    /// cannot (pairing refuses such a credential before it is kept).
    #[must_use]
    pub fn header(&self) -> Option<reqwest::header::HeaderValue> {
        let text = match self {
            Self::Basic { user, password } => format!(
                "Basic {}",
                data_encoding::BASE64.encode(format!("{user}:{}", password.expose()).as_bytes())
            ),
            Self::Bearer(token) => format!("Bearer {}", token.expose()),
        };
        let mut value = reqwest::header::HeaderValue::from_str(&text).ok()?;
        value.set_sensitive(true);
        Some(value)
    }
}

/// a string that never prints.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    #[must_use]
    pub fn new(text: String) -> Self {
        Self(text)
    }

    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("{path}: {message}")]
    Parse { path: PathBuf, message: String },
    #[error(
        "{path} holds passwords and is readable by others (mode {mode:o}): run `chmod 600 {path}`"
    )]
    Exposed { path: PathBuf, mode: u32 },
    #[error("{path}: {message}")]
    Invalid { path: PathBuf, message: String },
    #[error("HOME is not set, so `~` in {0} cannot be expanded")]
    NoHome(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    listen: Option<SocketAddr>,
    data_dir: Option<String>,
    password: Secret,
    #[serde(default)]
    cookie: CookieFile,
    dev: Option<DevFile>,
    #[serde(default)]
    push: PushFile,
    #[serde(default)]
    media: MediaFile,
    #[serde(default, rename = "host")]
    hosts: Vec<HostFile>,
    /// `[[host]]` under its own name: the same fields and rules.
    #[serde(default)]
    cmx2: Vec<HostFile>,
    #[serde(default)]
    openclaw: Vec<OpenclawFile>,
    #[serde(default)]
    hermes: Vec<HermesFile>,
    #[serde(default)]
    cache: CacheFile,
    board: Option<BoardFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BoardFile {
    machines: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenclawFile {
    name: String,
    url: String,
    token_file: String,
    device_key: Option<String>,
    mode: Option<String>,
    machine: Option<String>,
    #[serde(default)]
    agents: BTreeMap<String, AgentFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentFile {
    key: Option<String>,
    name: Option<String>,
    palette: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HermesFile {
    name: String,
    url: String,
    token_file: Option<String>,
    machine: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CacheFile {
    transcript_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DevFile {
    vite: String,
    #[serde(default)]
    sweep_fast: bool,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct PushFile {
    contact: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaFile {
    max_bytes: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CookieFile {
    name: Option<String>,
    secure: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostFile {
    name: String,
    url: String,
    user: Option<String>,
    password: Option<Secret>,
    /// the credential `POST /pair` traded for a token from `cmx2 pair`
    /// (`boxbox init --pair` writes it).
    bearer: Option<Secret>,
}

impl Config {
    /// reads and validates the file at `path` (`~` expands to `$HOME`).
    ///
    /// # Errors
    /// the file is missing, unreadable, readable by others, malformed, or
    /// describes something the server cannot run with.
    pub fn load(path: &str) -> Result<Self, ConfigError> {
        let path = expand_home(path)?;
        let text = std::fs::read_to_string(&path).map_err(|source| ConfigError::Read {
            path: path.clone(),
            source,
        })?;
        refuse_exposed(&path)?;
        let file: File = toml::from_str(&text).map_err(|e| ConfigError::Parse {
            path: path.clone(),
            message: e.to_string(),
        })?;
        let base = path.parent().map_or_else(PathBuf::new, Path::to_path_buf);
        let mut config = Self::from_file(file, &base).map_err(|message| ConfigError::Invalid {
            path: path.clone(),
            message,
        })?;
        config.path = path;
        Ok(config)
    }

    /// the settings that differ from `next` and apply only at the next start.
    fn needs_restart(&self, next: &Self) -> Vec<&'static str> {
        [
            ("listen", self.listen != next.listen),
            ("data_dir", self.data_dir != next.data_dir),
            ("password", self.password != next.password),
            ("cookie", self.cookie != next.cookie),
            ("dev", self.dev != next.dev),
            // the vapid identity is built from it once, at start
            ("push", self.push != next.push),
            // the media task takes its cap once, at start
            ("media", self.media != next.media),
            // the source supervisor reads these once, at start
            ("openclaw", self.openclaw != next.openclaw),
            ("hermes", self.hermes != next.hermes),
            ("cache", self.cache != next.cache),
            // the routes and the board's handle are built once, at start
            ("board", self.board != next.board),
        ]
        .into_iter()
        .filter_map(|(name, differs)| differs.then_some(name))
        .collect()
    }

    fn from_file(file: File, base: &Path) -> Result<Self, String> {
        if file.password.expose().len() < MIN_PASSWORD_BYTES {
            return Err(format!(
                "password must be at least {MIN_PASSWORD_BYTES} characters"
            ));
        }
        let data_dir = file.data_dir.as_deref().unwrap_or(DEFAULT_DATA_DIR);
        let data_dir = expand_home(data_dir).map_err(|e| e.to_string())?;
        let data_dir = if data_dir.is_relative() {
            base.join(data_dir)
        } else {
            data_dir
        };

        let (hosts, openclaw, hermes) =
            connections(file.hosts, file.cmx2, file.openclaw, file.hermes, base)?;

        let transcript_bytes = file
            .cache
            .transcript_bytes
            .unwrap_or(DEFAULT_TRANSCRIPT_BYTES);
        if transcript_bytes == 0 {
            return Err(
                "cache.transcript_bytes must be more than 0; leave it out for 256 MiB".into(),
            );
        }

        let contact = file.push.contact.unwrap_or_else(|| DEFAULT_CONTACT.into());
        if !(contact.starts_with("mailto:") || contact.starts_with("https://")) {
            return Err(format!(
                "push.contact \"{contact}\" must be a mailto: or https: address"
            ));
        }

        let max_bytes = file
            .media
            .max_bytes
            .unwrap_or(crate::media::DEFAULT_MAX_BYTES);
        if max_bytes < crate::media::MIN_MAX_BYTES {
            return Err(format!(
                "media.max_bytes is {max_bytes}; the media store needs at least {} (1 MiB)",
                crate::media::MIN_MAX_BYTES
            ));
        }

        let board = file.board.map(board_of).transpose()?;

        Ok(Self {
            path: PathBuf::new(),
            listen: file.listen.unwrap_or(DEFAULT_LISTEN),
            data_dir,
            password: file.password,
            cookie: CookieConfig {
                name: file.cookie.name.unwrap_or_else(|| "boxbox_session".into()),
                secure: file.cookie.secure.unwrap_or(true),
            },
            dev: match file.dev {
                Some(dev) => Some(DevConfig {
                    vite: http_url(&dev.vite).map_err(|e| format!("dev.vite: {e}"))?,
                    sweep_fast: dev.sweep_fast,
                }),
                None => None,
            },
            push: PushConfig { contact },
            media: MediaConfig { max_bytes },
            hosts,
            openclaw,
            hermes,
            cache: CacheConfig { transcript_bytes },
            board,
        })
    }

    /// every connection the file describes: the cmx2 daemons in their
    /// order, then the openclaw gateways, then the hermes ones.
    #[must_use]
    pub fn connections(&self) -> Vec<ConnectionConfig> {
        let cmx2 = self.hosts.iter().cloned().map(ConnectionConfig::Cmx2);
        let openclaw = self
            .openclaw
            .iter()
            .cloned()
            .map(ConnectionConfig::Openclaw);
        let hermes = self.hermes.iter().cloned().map(ConnectionConfig::Hermes);
        cmx2.chain(openclaw).chain(hermes).collect()
    }
}

/// connection names are one namespace across every table
/// (`docs/agents.md`, section 3, collisions).
fn claim_name(
    names: &mut Vec<(String, String)>,
    name: &str,
    described: String,
) -> Result<(), String> {
    if let Some((_, taken)) = names.iter().find(|(n, _)| n == name) {
        return Err(format!(
            "{described} and {taken} share a name: connection names are one namespace, so rename one"
        ));
    }
    names.push((name.to_owned(), described));
    Ok(())
}

/// a pinned agent key never takes a connection's name or another pinned key.
fn refuse_taken_keys(
    names: &[(String, String)],
    openclaw: &[OpenclawConfig],
) -> Result<(), String> {
    let mut pinned: Vec<(&str, String)> = Vec::new();
    for connection in openclaw {
        for (foreign, agent) in &connection.agents {
            let Some(key) = agent.key.as_deref() else {
                continue;
            };
            let described = format!(
                "the key \"{key}\" pinned for agent \"{foreign}\" on [[openclaw]] \"{}\"",
                connection.name
            );
            if let Some((_, taken)) = names.iter().find(|(n, _)| n == key) {
                return Err(format!(
                    "{described} is the name of {taken}: pin another key or rename the connection"
                ));
            }
            if let Some((_, taken)) = pinned.iter().find(|(k, _)| *k == key) {
                return Err(format!(
                    "{described} is also {taken}: every agent key is one agent's, so pin another"
                ));
            }
            pinned.push((key, described));
        }
    }
    Ok(())
}

fn openclaw_of(entry: OpenclawFile, base: &Path) -> Result<OpenclawConfig, String> {
    let name = gateway_name("openclaw", entry.name)?;
    let url = ws_url(&entry.url).map_err(|e| format!("openclaw \"{name}\": {e}"))?;
    let token_file = config_path(&entry.token_file, base)
        .map_err(|e| format!("openclaw \"{name}\": token_file {e}"))?;
    let device_key = match entry.device_key {
        Some(path) => Some(
            config_path(&path, base).map_err(|e| format!("openclaw \"{name}\": device_key {e}"))?,
        ),
        None => None,
    };
    let mode = match entry.mode.as_deref() {
        None | Some("full") => OpenclawMode::Full,
        Some("watch") => OpenclawMode::Watch,
        Some(other) => {
            return Err(format!(
                "openclaw \"{name}\": mode \"{other}\" must be \"full\" or \"watch\""
            ));
        }
    };
    let machine = machine_of("openclaw", &name, entry.machine)?;
    let mut agents = BTreeMap::new();
    for (foreign, agent) in entry.agents {
        let at = || format!("openclaw \"{name}\" agent \"{foreign}\"");
        if foreign.is_empty() {
            return Err(format!(
                "openclaw \"{name}\": an [openclaw.agents.\"\"] table names no agent; use the gateway's agent id"
            ));
        }
        if let Some(key) = &agent.key
            && !is_host_name(key)
        {
            return Err(format!(
                "{}: key \"{key}\" must be 1 to 32 lowercase letters, digits and dashes",
                at()
            ));
        }
        if agent.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
            return Err(format!("{}: name is empty; give one or leave it out", at()));
        }
        if let Some(palette) = &agent.palette
            && !ASSISTANT_PALETTES.contains(&palette.as_str())
        {
            return Err(format!(
                "{}: palette \"{palette}\" is not an assistant palette; pick one of {}",
                at(),
                ASSISTANT_PALETTES.join(", ")
            ));
        }
        agents.insert(
            foreign,
            AgentOverride {
                key: agent.key,
                name: agent.name,
                palette: agent.palette,
            },
        );
    }
    Ok(OpenclawConfig {
        name,
        url,
        token_file,
        device_key,
        mode,
        machine,
        agents,
        origin: Origin::Config,
    })
}

fn hermes_of(entry: HermesFile, base: &Path) -> Result<HermesConfig, String> {
    let name = gateway_name("hermes", entry.name)?;
    let url = ws_url(&entry.url).map_err(|e| format!("hermes \"{name}\": {e}"))?;
    let token_file = match entry.token_file {
        Some(path) => Some(
            config_path(&path, base).map_err(|e| format!("hermes \"{name}\": token_file {e}"))?,
        ),
        None => None,
    };
    let machine = machine_of("hermes", &name, entry.machine)?;
    Ok(HermesConfig {
        name,
        url,
        token_file,
        machine,
        origin: Origin::Config,
    })
}

/// today's host rule, at most 24 characters so derived agent keys fit.
fn gateway_name(table: &str, name: String) -> Result<String, String> {
    if is_host_name(&name) && name.len() <= MAX_GATEWAY_NAME {
        Ok(name)
    } else {
        Err(format!(
            "{table} name \"{name}\" must be 1 to {MAX_GATEWAY_NAME} lowercase letters, digits and dashes"
        ))
    }
}

/// the most characters a `[board] machines` name may have; a `label.machine`
/// is a computer's name.
const MAX_BOARD_MACHINE: usize = 64;

fn board_of(file: BoardFile) -> Result<BoardConfig, String> {
    let Some(machines) = file.machines else {
        return Ok(BoardConfig { machines: None });
    };
    let most = boxbox_board_wire::MAX_MACHINES;
    if machines.is_empty() || machines.len() > most {
        return Err(format!(
            "board.machines lists {} machines; give 1 to {most}, or leave it out for the app's order",
            machines.len()
        ));
    }
    for (at, name) in machines.iter().enumerate() {
        if name.trim().is_empty() || name.trim() != name || name.chars().count() > MAX_BOARD_MACHINE
        {
            return Err(format!(
                "board.machines: \"{name}\" is not a machine; give the label.machine its agents carry (for cmx2, the host's name)"
            ));
        }
        if machines[..at].contains(name) {
            return Err(format!("board.machines names \"{name}\" twice"));
        }
    }
    Ok(BoardConfig {
        machines: Some(machines),
    })
}

fn machine_of(table: &str, name: &str, machine: Option<String>) -> Result<Option<String>, String> {
    match machine {
        Some(m) if m.trim().is_empty() => Err(format!(
            "{table} \"{name}\": machine is empty; give the computer's name or leave it out"
        )),
        machine => Ok(machine),
    }
}

/// a path in the file: `~` is the home, a relative path is relative to the
/// config file, as `data_dir` is. the file itself is never read here.
fn config_path(text: &str, base: &Path) -> Result<PathBuf, String> {
    if text.is_empty() {
        return Err("is empty: give the file's path".into());
    }
    let path = expand_home(text).map_err(|e| e.to_string())?;
    Ok(if path.is_relative() {
        base.join(path)
    } else {
        path
    })
}

/// a gateway's websocket: `wss://`, or `ws://` only to this machine,
/// since a plain socket elsewhere would carry the token in the clear.
pub(crate) fn ws_url(text: &str) -> Result<Url, String> {
    let url = Url::parse(text).map_err(|e| format!("\"{text}\" is not a url ({e})"))?;
    let host = url.host_str().unwrap_or("");
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = bare.parse::<std::net::IpAddr>().map_or_else(
        |_| bare.eq_ignore_ascii_case("localhost"),
        |ip| ip.is_loopback(),
    );
    match url.scheme() {
        "wss" if url.host().is_some() => Ok(url),
        "ws" if loopback => Ok(url),
        "ws" => Err(format!(
            "\"{text}\" is plain ws:// to another machine: use wss://, since ws:// is only for 127.0.0.1, ::1 or localhost"
        )),
        _ => Err(format!(
            "\"{text}\" must be wss://, or ws:// to 127.0.0.1, ::1 or localhost"
        )),
    }
}

/// a host signs in with a password (basic auth, the user `cmx2` unless
/// set) or with the bearer a pairing traded for, never both: a host with
/// both would leave which one the daemon sees to chance.
fn credential_of(
    name: &str,
    user: Option<String>,
    password: Option<Secret>,
    bearer: Option<Secret>,
) -> Result<Option<Credential>, String> {
    match (user, password, bearer) {
        (None, None, Some(bearer)) => {
            if Credential::Bearer(bearer.clone()).header().is_none() {
                return Err(format!(
                    "host \"{name}\": the bearer holds characters a header cannot carry; pair again with `boxbox init --pair`"
                ));
            }
            Ok(Some(Credential::Bearer(bearer)))
        }
        (_, Some(_), Some(_)) => Err(format!(
            "host \"{name}\" has both a bearer and a password: a paired host signs in with its bearer, so remove the password"
        )),
        (Some(_), None, Some(_)) => Err(format!(
            "host \"{name}\" has both a bearer and a user: the user goes with a password, so remove it"
        )),
        (user, Some(password), None) => Ok(Some(Credential::Basic {
            user: user.unwrap_or_else(|| "cmx2".into()),
            password,
        })),
        (_, None, None) => Ok(None),
    }
}

/// how often the config file is looked at.
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(1);

/// watches the config file and hands every valid change of hosts to
/// `reload`, so a host added, moved or given a new password is picked up
/// without a restart (in dev, `just cmx2` rewrites the file as it starts).
/// a change that does not load is logged and the running config stays.
pub async fn watch(
    started: Config,
    reload: mpsc::Sender<crate::upstream::HostChange>,
    shutdown: CancellationToken,
) {
    // restart-only settings are measured against what the server runs
    // with; hosts against the last config applied
    let mut hosts = started.hosts.clone();
    let mut held: Vec<ConnectionConfig> = started
        .connections()
        .into_iter()
        .filter(|c| !matches!(c, ConnectionConfig::Cmx2(_)))
        .collect();
    let mut ticker = tokio::time::interval(WATCH_EVERY);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut stamp = file_stamp(&started.path).await;
    let mut digest = file_digest(&started.path).await;
    loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => break,
            _ = ticker.tick() => {}
        }
        let now = file_stamp(&started.path).await;
        if now == stamp {
            continue;
        }
        stamp = now;
        let now = file_digest(&started.path).await;
        if now.is_none() || now == digest {
            continue;
        }
        digest = now;
        let path = started.path.display().to_string();
        let loaded = tokio::task::spawn_blocking(move || Config::load(&path)).await;
        let next = match loaded {
            Ok(Ok(next)) => next,
            Ok(Err(error)) => {
                warn!(%error, "the config changed but does not load; the running config stays");
                continue;
            }
            Err(error) => {
                warn!(%error, "reading the changed config failed; the running config stays");
                continue;
            }
        };
        let restart = started.needs_restart(&next);
        if !restart.is_empty() {
            warn!(
                settings = restart.join(", "),
                "the config changed settings that apply at the next start; restart to apply"
            );
        }
        let others: Vec<ConnectionConfig> = next
            .connections()
            .into_iter()
            .filter(|c| !matches!(c, ConnectionConfig::Cmx2(_)))
            .collect();
        if next.hosts != hosts || others != held {
            let names: Vec<&str> = next.hosts.iter().map(|h| h.name.as_str()).collect();
            info!(hosts = names.join(", "), "host config reloaded");
            hosts.clone_from(&next.hosts);
            held.clone_from(&others);
            if reload
                .send(crate::upstream::HostChange::Configured {
                    hosts: next.hosts,
                    others,
                })
                .await
                .is_err()
            {
                break;
            }
        }
    }
}

/// the file's modified time and length; a cheap look before reading it.
async fn file_stamp(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// the file's content hash, so a touch without a change reloads nothing.
async fn file_digest(path: &Path) -> Option<[u8; 32]> {
    let bytes = tokio::fs::read(path).await.ok()?;
    Some(Sha256::digest(&bytes).into())
}

pub(crate) fn http_url(text: &str) -> Result<Url, String> {
    let url = Url::parse(text).map_err(|e| format!("\"{text}\" is not a url ({e})"))?;
    if matches!(url.scheme(), "http" | "https") {
        Ok(url)
    } else {
        Err(format!("\"{text}\" must be http or https"))
    }
}

pub(crate) fn is_host_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub(crate) fn expand_home(path: &str) -> Result<PathBuf, ConfigError> {
    match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .ok_or_else(|| ConfigError::NoHome(path.into())),
        None => Ok(PathBuf::from(path)),
    }
}

#[cfg(unix)]
fn refuse_exposed(path: &Path) -> Result<(), ConfigError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path)
        .map_err(|source| ConfigError::Read {
            path: path.into(),
            source,
        })?
        .permissions()
        .mode()
        & 0o777;
    let exposed_to_group_or_world = mode & 0o077 != 0;
    if exposed_to_group_or_world {
        Err(ConfigError::Exposed {
            path: path.into(),
            mode,
        })
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn refuse_exposed(_: &Path) -> Result<(), ConfigError> {
    Ok(())
}

/// the cmx2 daemons, openclaw gateways and hermes gateways a file names.
type Connections = (Vec<HostConfig>, Vec<OpenclawConfig>, Vec<HermesConfig>);

/// every connection the file names, checked: `[[host]]` then `[[cmx2]]`,
/// then `[[openclaw]]` and `[[hermes]]`, one namespace for their names and
/// the agent keys they pin.
fn connections(
    host_entries: Vec<HostFile>,
    cmx2_entries: Vec<HostFile>,
    openclaw_entries: Vec<OpenclawFile>,
    hermes_entries: Vec<HermesFile>,
    base: &Path,
) -> Result<Connections, String> {
    let mut hosts: Vec<HostConfig> = Vec::with_capacity(host_entries.len() + cmx2_entries.len());
    // `[[host]]` first, then `[[cmx2]]`: the same entry under two names
    let mut tables: Vec<&'static str> = Vec::with_capacity(hosts.capacity());
    let host_files = (host_entries.into_iter().map(|h| ("[[host]]", h)))
        .chain(cmx2_entries.into_iter().map(|h| ("[[cmx2]]", h)));
    for (table, host) in host_files {
        if !is_host_name(&host.name) {
            return Err(format!(
                "host name \"{}\" must be lowercase letters, digits and dashes",
                host.name
            ));
        }
        if hosts.iter().any(|h| h.name == host.name) {
            return Err(format!("two hosts are named \"{}\"", host.name));
        }
        let url = http_url(&host.url).map_err(|e| format!("host \"{}\": {e}", host.name))?;
        let credential = credential_of(&host.name, host.user, host.password, host.bearer)?;
        hosts.push(HostConfig {
            name: host.name,
            url,
            credential,
            origin: Origin::Config,
        });
        tables.push(table);
    }
    let mut names: Vec<(String, String)> = hosts
        .iter()
        .zip(tables)
        .map(|(h, table)| (h.name.clone(), format!("{table} \"{}\"", h.name)))
        .collect();

    let mut openclaw = Vec::with_capacity(openclaw_entries.len());
    for entry in openclaw_entries {
        let entry = openclaw_of(entry, base)?;
        claim_name(
            &mut names,
            &entry.name,
            format!("[[openclaw]] \"{}\"", entry.name),
        )?;
        openclaw.push(entry);
    }
    let mut hermes = Vec::with_capacity(hermes_entries.len());
    for entry in hermes_entries {
        let entry = hermes_of(entry, base)?;
        claim_name(
            &mut names,
            &entry.name,
            format!("[[hermes]] \"{}\"", entry.name),
        )?;
        hermes.push(entry);
    }
    refuse_taken_keys(&names, &openclaw)?;
    Ok((hosts, openclaw, hermes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Config, String> {
        let file: File = toml::from_str(text).map_err(|e| e.to_string())?;
        Config::from_file(file, Path::new("/etc/boxbox"))
    }

    #[test]
    fn sweep_fast_is_a_dev_setting_and_off_unless_asked() {
        let dev = |extra: &str| {
            parse(&format!(
                "password = \"long enough\"\n[dev]\nvite = \"http://127.0.0.1:3002\"\n{extra}"
            ))
            .unwrap()
            .dev
            .unwrap()
        };
        assert!(!dev("").sweep_fast);
        assert!(dev("sweep_fast = true").sweep_fast);
        assert!(
            parse("password = \"long enough\"\nsweep_fast = true").is_err(),
            "only [dev] takes it"
        );
    }

    #[test]
    fn a_minimal_file_gets_production_defaults() {
        let config = parse("password = \"long enough\"").unwrap();
        assert_eq!(config.listen, SocketAddr::from(([127, 0, 0, 1], 3000)));
        assert_eq!(config.cookie.name, "boxbox_session");
        assert!(config.cookie.secure);
        assert!(config.hosts.is_empty());
        assert!(config.dev.is_none());
        assert_eq!(config.push.contact, DEFAULT_CONTACT);
    }

    #[test]
    fn the_media_cap_is_two_gib_unless_set_and_never_under_one_mib() {
        let config = parse("password = \"long enough\"").unwrap();
        assert_eq!(config.media.max_bytes, crate::media::DEFAULT_MAX_BYTES);
        let set = parse("password = \"long enough\"\n[media]\nmax_bytes = 3145728").unwrap();
        assert_eq!(set.media.max_bytes, 3 * 1024 * 1024);
        let tiny = parse("password = \"long enough\"\n[media]\nmax_bytes = 1000").unwrap_err();
        assert!(tiny.contains("at least"), "{tiny}");
    }

    #[test]
    fn the_board_is_off_unless_its_section_is_there() {
        let off = parse("password = \"long enough\"").unwrap();
        assert!(off.board.is_none());
        let on = parse("password = \"long enough\"\n[board]").unwrap();
        assert_eq!(on.board, Some(BoardConfig { machines: None }));
        let named =
            parse("password = \"long enough\"\n[board]\nmachines = [\"desk\", \"vm\", \"laptop\", \"mini\"]")
                .unwrap();
        assert_eq!(
            named.board.unwrap().machines.unwrap(),
            ["desk", "vm", "laptop", "mini"]
        );
    }

    #[test]
    fn the_board_takes_one_to_four_distinct_machines() {
        let five = parse(
            "password = \"long enough\"\n[board]\nmachines = [\"a\", \"b\", \"c\", \"d\", \"e\"]",
        )
        .unwrap_err();
        assert!(five.contains("1 to 4"), "{five}");
        let none = parse("password = \"long enough\"\n[board]\nmachines = []").unwrap_err();
        assert!(none.contains("1 to 4"), "{none}");
        let twice = parse("password = \"long enough\"\n[board]\nmachines = [\"desk\", \"desk\"]")
            .unwrap_err();
        assert!(twice.contains("twice"), "{twice}");
        let blank = parse("password = \"long enough\"\n[board]\nmachines = [\" \"]").unwrap_err();
        assert!(blank.contains("not a machine"), "{blank}");
        let unknown = parse("password = \"long enough\"\n[board]\nkeys = 17").unwrap_err();
        assert!(unknown.contains("unknown field"), "{unknown}");
    }

    #[test]
    fn the_push_contact_must_be_an_address_a_push_service_can_use() {
        let config =
            parse("password = \"long enough\"\n[push]\ncontact = \"mailto:me@example.com\"");
        assert_eq!(config.unwrap().push.contact, "mailto:me@example.com");
        let bad = parse("password = \"long enough\"\n[push]\ncontact = \"me@example.com\"");
        assert!(bad.unwrap_err().contains("mailto:"));
    }

    #[test]
    fn hosts_carry_a_basic_credential_only_when_a_password_is_given() {
        let config = parse(
            r#"
            password = "long enough"
            [[host]]
            name = "desk"
            url = "http://127.0.0.1:4840"
            password = "bench"
            [[host]]
            name = "vm"
            url = "https://vm.example:4096"
            "#,
        )
        .unwrap();
        let Some(Credential::Basic { user, password }) = &config.hosts[0].credential else {
            panic!("the desk has no password");
        };
        assert_eq!((user.as_str(), password.expose()), ("cmx2", "bench"));
        assert!(config.hosts[1].credential.is_none());
    }

    #[test]
    fn a_paired_host_carries_its_bearer() {
        let config = parse(
            "password = \"long enough\"\n[[host]]\nname = \"desk\"\nurl = \"http://a\"\nbearer = \"cmx2_abc\"",
        )
        .unwrap();
        assert_eq!(
            config.hosts[0].credential,
            Some(Credential::Bearer(Secret::new("cmx2_abc".into())))
        );
        let header = config.hosts[0]
            .credential
            .as_ref()
            .unwrap()
            .header()
            .unwrap();
        assert_eq!(header.to_str().unwrap(), "Bearer cmx2_abc");
        assert!(header.is_sensitive());
    }

    #[test]
    fn a_bearer_never_shares_a_host_with_a_password_or_a_user() {
        let host = |extra: &str| {
            parse(&format!(
                "password = \"long enough\"\n[[host]]\nname = \"desk\"\nurl = \"http://a\"\nbearer = \"cmx2_abc\"\n{extra}"
            ))
        };
        let both = host("password = \"bench\"").unwrap_err();
        assert!(both.contains("both a bearer and a password"), "{both}");
        assert!(
            !both.contains("cmx2_abc"),
            "the error never shows the bearer"
        );
        let user = host("user = \"cmx2\"").unwrap_err();
        assert!(user.contains("both a bearer and a user"), "{user}");
        let newline = parse(
            "password = \"long enough\"\n[[host]]\nname = \"desk\"\nurl = \"http://a\"\nbearer = \"a\\nb\"",
        );
        assert!(newline.unwrap_err().contains("pair again"));
    }

    #[test]
    fn a_relative_data_dir_is_relative_to_the_config_file() {
        let config = parse("password = \"long enough\"\ndata_dir = \"data\"").unwrap();
        assert_eq!(config.data_dir, PathBuf::from("/etc/boxbox/data"));
    }

    #[test]
    fn refuses_what_it_cannot_run_with() {
        assert!(
            parse("password = \"short\"")
                .unwrap_err()
                .contains("at least 8")
        );
        let bad_name = "password = \"long enough\"\n[[host]]\nname = \"Desk\"\nurl = \"http://a\"";
        assert!(parse(bad_name).unwrap_err().contains("lowercase"));
        let twice = "password = \"long enough\"\n[[host]]\nname = \"a\"\nurl = \"http://a\"\n\
                     [[host]]\nname = \"a\"\nurl = \"http://b\"";
        assert!(parse(twice).unwrap_err().contains("two hosts"));
        assert!(parse("password = \"long enough\"\npasword = \"typo\"").is_err());
    }

    #[test]
    fn only_settings_a_running_server_cannot_change_ask_for_a_restart() {
        let base = parse("password = \"long enough\"\n[[host]]\nname = \"a\"\nurl = \"http://a\"")
            .unwrap();
        let hosts_moved =
            parse("password = \"long enough\"\n[[host]]\nname = \"a\"\nurl = \"http://b\"")
                .unwrap();
        assert!(base.needs_restart(&hosts_moved).is_empty());
        assert_ne!(base.hosts, hosts_moved.hosts);
        let listen_moved =
            parse("password = \"other password\"\nlisten = \"127.0.0.1:9\"").unwrap();
        assert_eq!(base.needs_restart(&listen_moved), ["listen", "password"]);
    }

    #[test]
    fn the_example_config_is_one_the_server_runs_with() {
        let config = parse(include_str!("../../boxbox.example.toml")).unwrap();
        assert_eq!(config.hosts.len(), 1);
        assert!(matches!(
            config.hosts[0].credential,
            Some(Credential::Basic { .. })
        ));
    }

    const GATE: &str = "password = \"long enough\"\n";

    fn gateway(name: &str, url: &str) -> String {
        format!(
            "[[openclaw]]\nname = \"{name}\"\nurl = \"{url}\"\ntoken_file = \"/etc/boxbox/{name}.token\"\n"
        )
    }

    #[test]
    fn cmx2_entries_are_hosts_after_the_host_entries_in_file_order() {
        let config = parse(&format!(
            "{GATE}[[cmx2]]\nname = \"c1\"\nurl = \"http://c1\"\nbearer = \"cmx2_abc\"\n\
             [[host]]\nname = \"h1\"\nurl = \"http://h1\"\npassword = \"bench\"\n\
             [[cmx2]]\nname = \"c2\"\nurl = \"http://c2\"\n\
             [[host]]\nname = \"h2\"\nurl = \"http://h2\"\n"
        ))
        .unwrap();
        let names: Vec<&str> = config.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["h1", "h2", "c1", "c2"]);
        assert!(matches!(
            config.hosts[2].credential,
            Some(Credential::Bearer(_))
        ));
        assert!(config.hosts.iter().all(|h| h.origin == Origin::Config));
    }

    #[test]
    fn a_cmx2_entry_follows_every_host_rule() {
        let bad = |extra: &str| parse(&format!("{GATE}[[cmx2]]\n{extra}")).unwrap_err();
        assert!(bad("name = \"Desk\"\nurl = \"http://a\"").contains("lowercase"));
        assert!(bad("name = \"desk\"\nurl = \"ws://a\"").contains("http or https"));
        assert!(
            bad("name = \"desk\"\nurl = \"http://a\"\nbearer = \"b\"\npassword = \"p\"")
                .contains("both a bearer and a password")
        );
        assert!(bad("name = \"desk\"\nurl = \"http://a\"\nport = 1").contains("unknown field"));
    }

    #[test]
    fn an_openclaw_entry_reads_every_field() {
        let config = parse(&format!(
            "{GATE}[[openclaw]]\nname = \"vm-b\"\nurl = \"wss://vm-b.example.ts.net\"\n\
             token_file = \"secrets/vm-b.token\"\ndevice_key = \"/etc/boxbox/vm-b.key\"\n\
             machine = \"vm-b\"\nmode = \"watch\"\n\
             [openclaw.agents.main]\nkey = \"assistant\"\nname = \"assistant\"\npalette = \"coral\"\n\
             [openclaw.agents.ops]\n"
        ))
        .unwrap();
        let gateway = &config.openclaw[0];
        assert_eq!(gateway.name, "vm-b");
        assert_eq!(gateway.url.as_str(), "wss://vm-b.example.ts.net/");
        assert_eq!(
            gateway.token_file,
            PathBuf::from("/etc/boxbox/secrets/vm-b.token"),
            "a relative path is relative to the config file"
        );
        assert_eq!(
            gateway.device_key,
            Some(PathBuf::from("/etc/boxbox/vm-b.key"))
        );
        assert_eq!(gateway.machine.as_deref(), Some("vm-b"));
        assert_eq!(gateway.mode, OpenclawMode::Watch);
        assert_eq!(gateway.origin, Origin::Config);
        assert_eq!(
            gateway.agents["main"],
            AgentOverride {
                key: Some("assistant".into()),
                name: Some("assistant".into()),
                palette: Some("coral".into()),
            }
        );
        assert_eq!(gateway.agents["ops"], AgentOverride::default());
    }

    #[test]
    fn an_openclaw_entry_defaults_to_full_mode_without_a_device_key() {
        let config = parse(&format!("{GATE}{}", gateway("vm-b", "wss://a"))).unwrap();
        assert_eq!(config.openclaw[0].mode, OpenclawMode::Full);
        assert!(config.openclaw[0].device_key.is_none());
        assert!(config.openclaw[0].machine.is_none());
        assert!(config.openclaw[0].agents.is_empty());
        let bad = parse(&format!(
            "{GATE}{}mode = \"read\"\n",
            gateway("vm-b", "wss://a")
        ));
        assert!(bad.unwrap_err().contains("\"full\" or \"watch\""));
    }

    #[test]
    fn a_token_file_path_expands_home_and_is_never_read() {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let config = parse(&format!(
            "{GATE}[[openclaw]]\nname = \"vm-b\"\nurl = \"wss://a\"\ntoken_file = \"~/no-such-dir/vm-b.token\"\n"
        ))
        .unwrap();
        assert_eq!(
            config.openclaw[0].token_file,
            PathBuf::from(home).join("no-such-dir/vm-b.token")
        );
        let empty = parse(&format!(
            "{GATE}[[openclaw]]\nname = \"vm-b\"\nurl = \"wss://a\"\ntoken_file = \"\"\n"
        ));
        assert!(empty.unwrap_err().contains("token_file is empty"));
        let missing = parse(&format!(
            "{GATE}[[openclaw]]\nname = \"vm-b\"\nurl = \"wss://a\"\n"
        ));
        assert!(missing.unwrap_err().contains("token_file"));
    }

    #[test]
    fn an_openclaw_name_is_a_host_name_of_at_most_24_characters() {
        let name = "a".repeat(24);
        assert!(parse(&format!("{GATE}{}", gateway(&name, "wss://a"))).is_ok());
        let long = "a".repeat(25);
        let error = parse(&format!("{GATE}{}", gateway(&long, "wss://a"))).unwrap_err();
        assert!(error.contains("1 to 24 lowercase"), "{error}");
        assert!(parse(&format!("{GATE}{}", gateway("Vm", "wss://a"))).is_err());
        assert!(parse(&format!("{GATE}{}", gateway("", "wss://a"))).is_err());
    }

    #[test]
    fn a_gateway_url_is_wss_or_ws_to_this_machine_only() {
        for good in [
            "wss://vm-b.example.ts.net:18789",
            "ws://127.0.0.1:18789",
            "ws://[::1]:18789",
            "ws://localhost:18789",
        ] {
            assert!(
                parse(&format!("{GATE}{}", gateway("vm-b", good))).is_ok(),
                "{good}"
            );
        }
        let remote = parse(&format!("{GATE}{}", gateway("vm-b", "ws://vm-b.example:1")));
        assert!(remote.unwrap_err().contains("use wss://"));
        for bad in ["https://vm-b.example", "http://127.0.0.1:1", "not a url"] {
            assert!(
                parse(&format!("{GATE}{}", gateway("vm-b", bad))).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn openclaw_and_its_agent_tables_refuse_unknown_fields() {
        let typo = parse(&format!(
            "{GATE}{}tokenfile = \"x\"\n",
            gateway("vm-b", "wss://a")
        ));
        assert!(typo.unwrap_err().contains("unknown field"));
        let agent = parse(&format!(
            "{GATE}{}[openclaw.agents.main]\ncolour = \"coral\"\n",
            gateway("vm-b", "wss://a")
        ));
        assert!(agent.unwrap_err().contains("unknown field"));
        let cache = parse(&format!("{GATE}[cache]\nbytes = 1\n"));
        assert!(cache.unwrap_err().contains("unknown field"));
    }

    #[test]
    fn a_pinned_agent_key_name_and_palette_are_checked() {
        let agent = |body: &str| {
            parse(&format!(
                "{GATE}{}[openclaw.agents.main]\n{body}\n",
                gateway("vm-b", "wss://a")
            ))
        };
        assert!(agent(&format!("key = \"{}\"", "a".repeat(32))).is_ok());
        for bad in ["key = \"\"", "key = \"Assistant\"", "key = \"a_b\""] {
            assert!(
                agent(bad).unwrap_err().contains("1 to 32 lowercase"),
                "{bad}"
            );
        }
        let long = agent(&format!("key = \"{}\"", "a".repeat(33)));
        assert!(long.unwrap_err().contains("1 to 32 lowercase"));
        assert!(agent("name = \" \"").unwrap_err().contains("name is empty"));
        let palette = agent("palette = \"teal\"").unwrap_err();
        assert!(
            palette.contains("coral, lime, jade, lagoon, orchid"),
            "{palette}"
        );
        for slot in ASSISTANT_PALETTES {
            assert!(agent(&format!("palette = \"{slot}\"")).is_ok(), "{slot}");
        }
    }

    #[test]
    fn a_hermes_entry_is_parsed_and_checked() {
        let config = parse(&format!(
            "{GATE}[[hermes]]\nname = \"vm-c\"\nurl = \"wss://vm-c.example\"\n\
             [[hermes]]\nname = \"vm-d\"\nurl = \"ws://127.0.0.1:9\"\ntoken_file = \"vm-d.token\"\nmachine = \"vm-d\"\n"
        ))
        .unwrap();
        assert_eq!(config.hermes.len(), 2);
        assert!(config.hermes[0].token_file.is_none());
        assert_eq!(
            config.hermes[1].token_file,
            Some(PathBuf::from("/etc/boxbox/vm-d.token"))
        );
        assert_eq!(config.hermes[1].machine.as_deref(), Some("vm-d"));
        assert_eq!(config.hermes[1].origin, Origin::Config);
        let bad = |body: &str| parse(&format!("{GATE}[[hermes]]\n{body}\n")).unwrap_err();
        assert!(bad("name = \"vm-c\"\nurl = \"ws://vm-c.example\"").contains("use wss://"));
        assert!(
            bad(&format!("name = \"{}\"\nurl = \"wss://a\"", "a".repeat(25))).contains("1 to 24")
        );
        assert!(
            bad("name = \"vm-c\"\nurl = \"wss://a\"\nmode = \"watch\"").contains("unknown field")
        );
        assert!(
            bad("name = \"vm-c\"\nurl = \"wss://a\"\nmachine = \"\"").contains("machine is empty")
        );
    }

    #[test]
    fn the_transcript_cache_defaults_to_256_mib_and_is_never_zero() {
        let config = parse(GATE).unwrap();
        assert_eq!(config.cache.transcript_bytes, 256 * 1024 * 1024);
        let set = parse(&format!("{GATE}[cache]\ntranscript_bytes = 1048576\n")).unwrap();
        assert_eq!(set.cache.transcript_bytes, 1_048_576);
        let zero = parse(&format!("{GATE}[cache]\ntranscript_bytes = 0\n"));
        assert!(zero.unwrap_err().contains("more than 0"));
        assert!(parse(&format!("{GATE}[cache]\ntranscript_bytes = -1\n")).is_err());
    }

    #[test]
    fn connection_names_are_one_namespace_across_every_table() {
        let host = "[[host]]\nname = \"vm-a\"\nurl = \"http://a\"\n";
        let cmx2 = "[[cmx2]]\nname = \"vm-a\"\nurl = \"http://b\"\n";
        let hermes = "[[hermes]]\nname = \"vm-a\"\nurl = \"wss://c\"\n";
        let both = parse(&format!("{GATE}{host}{cmx2}")).unwrap_err();
        assert!(both.contains("two hosts are named \"vm-a\""), "{both}");
        let openclaw = parse(&format!("{GATE}{host}{}", gateway("vm-a", "wss://a"))).unwrap_err();
        assert!(
            openclaw.contains("[[openclaw]] \"vm-a\" and [[host]] \"vm-a\" share a name"),
            "{openclaw}"
        );
        let cross = parse(&format!("{GATE}{cmx2}{hermes}")).unwrap_err();
        assert!(
            cross.contains("[[hermes]] \"vm-a\" and [[cmx2]] \"vm-a\" share a name"),
            "{cross}"
        );
        let gateways = parse(&format!(
            "{GATE}{}{}",
            gateway("vm-b", "wss://a"),
            gateway("vm-b", "wss://b")
        ))
        .unwrap_err();
        assert!(gateways.contains("[[openclaw]] \"vm-b\" and [[openclaw]] \"vm-b\""));
    }

    #[test]
    fn a_pinned_key_never_takes_a_connection_name_or_another_pinned_key() {
        let pin = |connection: &str, agent: &str, key: &str| {
            format!(
                "{}[openclaw.agents.{agent}]\nkey = \"{key}\"\n",
                gateway(connection, "wss://a")
            )
        };
        let host = "[[host]]\nname = \"vm-a\"\nurl = \"http://a\"\n";
        let named = parse(&format!("{GATE}{host}{}", pin("vm-b", "main", "vm-a"))).unwrap_err();
        assert!(
            named.contains("the key \"vm-a\" pinned for agent \"main\" on [[openclaw]] \"vm-b\" is the name of [[host]] \"vm-a\""),
            "{named}"
        );
        let later = parse(&format!(
            "{GATE}{}[[hermes]]\nname = \"helper\"\nurl = \"wss://c\"\n",
            pin("vm-b", "main", "helper")
        ))
        .unwrap_err();
        assert!(
            later.contains("is the name of [[hermes]] \"helper\""),
            "{later}"
        );
        let own = parse(&format!("{GATE}{}", pin("vm-b", "main", "vm-b"))).unwrap_err();
        assert!(
            own.contains("is the name of [[openclaw]] \"vm-b\""),
            "{own}"
        );
        let twice = parse(&format!(
            "{GATE}{}{}",
            pin("vm-b", "main", "assistant"),
            pin("vm-c", "ops", "assistant")
        ))
        .unwrap_err();
        assert!(
            twice.contains("on [[openclaw]] \"vm-c\" is also the key \"assistant\" pinned for agent \"main\" on [[openclaw]] \"vm-b\""),
            "{twice}"
        );
    }

    #[test]
    fn connections_list_cmx2_then_openclaw_then_hermes() {
        let config = parse(&format!(
            "{GATE}[[hermes]]\nname = \"hm\"\nurl = \"wss://h\"\n{}\
             [[cmx2]]\nname = \"c1\"\nurl = \"http://c\"\n[[host]]\nname = \"h1\"\nurl = \"http://h\"\n",
            gateway("oc", "wss://o")
        ))
        .unwrap();
        let connections = config.connections();
        let seen: Vec<(&str, crate::wire::Source)> =
            connections.iter().map(|c| (c.name(), c.source())).collect();
        assert_eq!(
            seen,
            [
                ("h1", crate::wire::Source::Cmx2),
                ("c1", crate::wire::Source::Cmx2),
                ("oc", crate::wire::Source::Openclaw),
                ("hm", crate::wire::Source::Hermes),
            ]
        );
    }

    #[test]
    fn a_changed_gateway_or_cache_asks_for_a_restart() {
        let base = parse(&format!("{GATE}{}", gateway("vm-b", "wss://a"))).unwrap();
        let moved = parse(&format!("{GATE}{}", gateway("vm-b", "wss://b"))).unwrap();
        assert_eq!(base.needs_restart(&moved), ["openclaw"]);
        let cache = parse(&format!(
            "{GATE}{}[cache]\ntranscript_bytes = 1\n",
            gateway("vm-b", "wss://a")
        ))
        .unwrap();
        assert_eq!(base.needs_restart(&cache), ["cache"]);
    }

    #[test]
    fn the_commented_examples_in_the_example_config_load_when_uncommented() {
        fn setting(l: &str) -> Option<&str> {
            l.strip_prefix("# ").filter(|rest| {
                (rest.starts_with('[') && rest.ends_with(']'))
                    || rest.split_once(" = ").is_some_and(|(k, _)| {
                        !k.is_empty() && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    })
            })
        }
        let example = include_str!("../../boxbox.example.toml");
        let uncommented: String = example
            .lines()
            .map(|l| setting(l).unwrap_or(l))
            .collect::<Vec<_>>()
            .join("\n");
        let config = parse(&uncommented).unwrap();
        let names: Vec<&str> = config.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["desk", "vm", "vm-a"]);
        assert_eq!(config.openclaw.len(), 1);
        assert_eq!(
            config.openclaw[0].agents["main"].key.as_deref(),
            Some("assistant")
        );
        assert_eq!(config.cache.transcript_bytes, DEFAULT_TRANSCRIPT_BYTES);
    }

    #[test]
    fn secrets_never_print() {
        let secret = Secret("hunter22".into());
        assert_eq!(format!("{secret:?}"), "Secret(..)");
    }
}
