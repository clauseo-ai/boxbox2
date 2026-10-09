//! `boxbox.toml`, the typed config. it holds the gate password and every
//! host's credential, so it must be readable by its owner only, and none
//! of it ever reaches a browser (architecture: auth, config, data).

use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

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
    pub hosts: Vec<HostConfig>,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
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
    #[serde(default, rename = "host")]
    hosts: Vec<HostFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DevFile {
    vite: String,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct PushFile {
    contact: Option<String>,
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

        let mut hosts: Vec<HostConfig> = Vec::with_capacity(file.hosts.len());
        for host in file.hosts {
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
        }

        let contact = file.push.contact.unwrap_or_else(|| DEFAULT_CONTACT.into());
        if !(contact.starts_with("mailto:") || contact.starts_with("https://")) {
            return Err(format!(
                "push.contact \"{contact}\" must be a mailto: or https: address"
            ));
        }

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
                }),
                None => None,
            },
            push: PushConfig { contact },
            hosts,
        })
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
        if next.hosts != hosts {
            let names: Vec<&str> = next.hosts.iter().map(|h| h.name.as_str()).collect();
            info!(hosts = names.join(", "), "host config reloaded");
            hosts.clone_from(&next.hosts);
            if reload
                .send(crate::upstream::HostChange::Configured(next.hosts))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Config, String> {
        let file: File = toml::from_str(text).map_err(|e| e.to_string())?;
        Config::from_file(file, Path::new("/etc/boxbox"))
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

    #[test]
    fn secrets_never_print() {
        let secret = Secret("hunter22".into());
        assert_eq!(format!("{secret:?}"), "Secret(..)");
    }
}
