//! `install`, `uninstall`, `login` and `status`: the daemon's own setup on a
//! mac (`docs/board.md`, files). the binary goes to `~/.local/bin`, signed so
//! the microphone grant can survive upgrades, and a launch agent in the
//! user's gui domain keeps it running.
//!
//! the test seam: `BOXBOX_BOARD_NO_LAUNCHCTL=1` skips every `launchctl` call
//! in `install` and `uninstall`, so an install into a scratch `HOME` writes
//! its files without loading anything into the real login session. never set
//! in an install.

use std::fmt;
use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::config::{self, Config, ConfigError};

/// the launch agent's label, the signing identifier and the bundle id.
pub const LABEL: &str = "dev.boxbox.board";
/// the self-signed identity `install` signs with when the keychain has it.
pub const IDENTITY_NAME: &str = "boxbox-board signing";
/// the test seam (module docs).
pub const NO_LAUNCHCTL_ENV: &str = "BOXBOX_BOARD_NO_LAUNCHCTL";
/// the origin `config::TEMPLATE` ships with: still there means not set up.
const TEMPLATE_ORIGIN: &str = "https://boxbox.example.ts.net";
const BIN_NAME: &str = "boxbox-board";

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error("cannot find the running binary: {0}")]
    CurrentExe(io::Error),
    #[error("cannot {what} {path}: {source}")]
    Io {
        what: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    #[error("cannot run {program}: {source}. it ships with macos; check PATH")]
    Spawn {
        program: &'static str,
        source: io::Error,
    },
    #[error("{command} failed: {detail}")]
    Failed { command: String, detail: String },
    #[error("`id -u` printed {0:?}, not a uid")]
    Uid(String),
    #[error("{0} is not utf-8: move the binary or the state dir to a plain path")]
    NotUtf8(PathBuf),
    #[error("no password given: type it and press return, or pipe it in")]
    EmptyPassword,
    #[error("cannot read the password from stdin: {0}")]
    Stdin(io::Error),
    #[error("cannot write to stdout: {0}")]
    Stdout(io::Error),
}

fn io_err(what: &'static str, path: &Path) -> impl FnOnce(io::Error) -> InstallError {
    let path = path.to_owned();
    move |source| InstallError::Io { what, path, source }
}

fn say(args: fmt::Arguments<'_>) -> Result<(), InstallError> {
    writeln!(io::stdout().lock(), "{args}").map_err(InstallError::Stdout)
}

fn home() -> Result<PathBuf, InstallError> {
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() => Ok(PathBuf::from(home)),
        _ => Err(ConfigError::NoHome.into()),
    }
}

fn bin_path() -> Result<PathBuf, InstallError> {
    Ok(home()?.join(".local").join("bin").join(BIN_NAME))
}

fn plist_path() -> Result<PathBuf, InstallError> {
    Ok(home()?
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LABEL}.plist")))
}

fn launchctl_skipped() -> bool {
    std::env::var_os(NO_LAUNCHCTL_ENV).is_some_and(|v| v == "1")
}

fn run(program: &'static str, command: &mut Command) -> Result<Output, InstallError> {
    command
        .output()
        .map_err(|source| InstallError::Spawn { program, source })
}

/// the first non-empty lines of a failed command's stderr, else its stdout.
fn detail(output: &Output) -> String {
    let pick = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .take(3)
            .collect::<Vec<_>>()
            .join("; ")
    };
    let err = pick(&output.stderr);
    if err.is_empty() {
        let out = pick(&output.stdout);
        if out.is_empty() {
            format!("exit {}", output.status)
        } else {
            out
        }
    } else {
        err
    }
}

fn uid() -> Result<u32, InstallError> {
    let output = run("id", Command::new("id").arg("-u"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() {
        return Err(InstallError::Failed {
            command: "id -u".to_owned(),
            detail: detail(&output),
        });
    }
    text.parse().map_err(|_| InstallError::Uid(text))
}

/// the config if one parses, with the reason when it does not.
fn load_config() -> Result<(PathBuf, Result<Config, ConfigError>), InstallError> {
    let path = config::config_path()?;
    let loaded = Config::load(&path);
    Ok((path, loaded))
}

/// creates `dir` (parents as usual) and sets it to 0700 exactly, whatever the umask.
fn private_dir(dir: &Path) -> Result<(), InstallError> {
    fs::create_dir_all(dir).map_err(io_err("create", dir))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(io_err("chmod", dir))
}

/// a temp name beside `path`, so the rename stays on one filesystem.
fn temp_beside(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned());
    path.with_file_name(format!(".{name}.tmp-{}", std::process::id()))
}

/// writes `bytes` to `path` with `mode` through a temp file and a rename.
fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), InstallError> {
    let temp = temp_beside(path);
    let result = (|| {
        let _ = fs::remove_file(&temp);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temp)
            .map_err(io_err("create", &temp))?;
        file.write_all(bytes).map_err(io_err("write", &temp))?;
        file.sync_all().map_err(io_err("write", &temp))?;
        fs::set_permissions(&temp, fs::Permissions::from_mode(mode))
            .map_err(io_err("chmod", &temp))?;
        fs::rename(&temp, path).map_err(io_err("replace", path))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

// ---------------------------------------------------------------- install

/// copies this binary to `~/.local/bin/boxbox-board`, signs it, makes the
/// config and state dirs, writes the config template if there is none, and
/// loads the launch agent.
///
/// # Errors
/// a file that cannot be written, codesign failing even ad hoc, or launchctl
/// refusing the agent.
pub fn install() -> Result<(), InstallError> {
    let exe = std::env::current_exe().map_err(InstallError::CurrentExe)?;
    let bin = bin_path()?;
    install_binary(&exe, &bin)?;

    let (config_path, loaded) = load_config()?;
    let config_dir = config::config_dir()?;
    private_dir(&config_dir)?;
    if let Some(parent) = config_path.parent()
        && parent != config_dir
        && !parent.as_os_str().is_empty()
    {
        private_dir(parent)?;
    }
    let loaded = match loaded {
        Err(ConfigError::Missing { .. }) => {
            write_template(&config_path)?;
            Config::load(&config_path)
        }
        other => {
            say(format_args!("kept the config at {}", config_path.display()))?;
            other
        }
    };
    let state_dir = match &loaded {
        Ok(config) => config.state_dir.clone(),
        Err(e) => {
            say(format_args!(
                "the config does not load ({e}); using the default state dir"
            ))?;
            config::default_state_dir()?
        }
    };
    private_dir(&state_dir)?;
    say(format_args!("state dir {} (0700)", state_dir.display()))?;

    let plist = plist_path()?;
    let text = plist_text(&bin)?;
    if let Some(parent) = plist.parent() {
        fs::create_dir_all(parent).map_err(io_err("create", parent))?;
    }
    write_atomic(&plist, text.as_bytes(), 0o644)?;
    say(format_args!("wrote the launch agent {}", plist.display()))?;

    if launchctl_skipped() {
        say(format_args!(
            "skipped launchctl ({NO_LAUNCHCTL_ENV}=1): the agent is not loaded"
        ))?;
    } else {
        load_agent(&plist, &state_dir.join("board.log"))?;
    }

    if loaded
        .as_ref()
        .is_ok_and(|config| config.origin == TEMPLATE_ORIGIN)
    {
        say(format_args!("next:"))?;
        say(format_args!(
            "  set origin in {} to your boxbox server",
            config_path.display()
        ))?;
        say(format_args!(
            "  run `boxbox-board login` and type its password"
        ))?;
        say(format_args!(
            "  restart the agent: launchctl kickstart -k gui/$(id -u)/{LABEL}"
        ))?;
    }
    Ok(())
}

fn write_template(path: &Path) -> Result<(), InstallError> {
    let created = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path);
    match created {
        Ok(mut file) => {
            file.write_all(config::TEMPLATE.as_bytes())
                .map_err(io_err("write", path))?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(io_err("chmod", path))?;
            say(format_args!(
                "wrote a new config at {} (0600)",
                path.display()
            ))
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            say(format_args!("kept the config at {}", path.display()))
        }
        Err(source) => Err(InstallError::Io {
            what: "create",
            path: path.to_owned(),
            source,
        }),
    }
}

/// copy to a temp name beside the target, chmod, sign, rename: the installed
/// path never holds a half-copied or unsigned binary.
fn install_binary(exe: &Path, bin: &Path) -> Result<(), InstallError> {
    let dir = bin.parent().unwrap_or(Path::new("/"));
    fs::create_dir_all(dir).map_err(io_err("create", dir))?;
    let temp = temp_beside(bin);
    let result = (|| {
        let _ = fs::remove_file(&temp);
        fs::copy(exe, &temp).map_err(io_err("copy the binary to", &temp))?;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o755))
            .map_err(io_err("chmod", &temp))?;
        sign(&temp)?;
        fs::rename(&temp, bin).map_err(io_err("replace", bin))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    say(format_args!("installed {}", bin.display()))
}

/// signs with the stable identity when the keychain has it, else ad hoc.
/// no hardened runtime: it would need the audio-input entitlement and adds
/// nothing to a binary that is not notarized.
fn sign(bin: &Path) -> Result<(), InstallError> {
    let found = run(
        "security",
        Command::new("security").args(["find-identity", "-p", "codesigning"]),
    )
    .map(|output| identities(&String::from_utf8_lossy(&output.stdout), IDENTITY_NAME))
    .unwrap_or_default();
    if let Some(sha1) = found.first() {
        if found.len() > 1 {
            say(format_args!(
                "{} identities are named \"{IDENTITY_NAME}\"; signing with the first, {sha1}",
                found.len()
            ))?;
        }
        match codesign(bin, sha1) {
            Ok(()) => {
                return say(format_args!(
                    "signed with \"{IDENTITY_NAME}\" ({sha1}): the microphone grant survives upgrades"
                ));
            }
            Err(e) => say(format_args!(
                "signing with \"{IDENTITY_NAME}\" failed ({e}); signing ad hoc instead"
            ))?,
        }
    }
    codesign(bin, "-")?;
    say(format_args!(
        "signed ad hoc: macos will ask for the microphone again after each upgrade."
    ))?;
    say(format_args!(
        "  to keep the grant, make the \"{IDENTITY_NAME}\" identity (docs/board.md) and install again"
    ))
}

fn codesign(bin: &Path, identity: &str) -> Result<(), InstallError> {
    let output = run(
        "codesign",
        Command::new("codesign")
            .args(["--force", "-s", identity, "-i", LABEL])
            .arg(bin),
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(InstallError::Failed {
            command: format!("codesign -s {identity}"),
            detail: detail(&output),
        })
    }
}

/// the sha1s of the identities named exactly `name` in the "matching
/// identities" section of `security find-identity -p codesigning`. a
/// self-signed identity is never in "valid identities only".
fn identities(output: &str, name: &str) -> Vec<String> {
    let quoted = format!("\"{name}\"");
    let mut matching = false;
    let mut found = Vec::new();
    for line in output.lines().map(str::trim) {
        if line.eq_ignore_ascii_case("matching identities") {
            matching = true;
            continue;
        }
        if line.eq_ignore_ascii_case("valid identities only") || line.starts_with("Policy:") {
            matching = false;
            continue;
        }
        if !matching {
            continue;
        }
        // `1) C0E1...B7CD "name" (CSSMERR_TP_NOT_TRUSTED)`
        let Some((index, rest)) = line.split_once(") ") else {
            continue;
        };
        if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Some((sha1, rest)) = rest.split_once(' ') else {
            continue;
        };
        let rest = rest.trim_start();
        let named = rest
            .strip_prefix(&quoted)
            .is_some_and(|after| after.is_empty() || after.starts_with(' '));
        if named && sha1.len() == 40 && sha1.bytes().all(|b| b.is_ascii_hexdigit()) {
            found.push(sha1.to_owned());
        }
    }
    found
}

fn xml_escape(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// the launch agent: no environment, no secrets; the daemon reads its config.
/// the agent: kept alive only after a failure (a config error exits 0 and
/// stays down until `install` or a kickstart), and its stdout and stderr
/// go nowhere, since the daemon writes its own capped `board.log`.
fn plist_text(bin: &Path) -> Result<String, InstallError> {
    let bin = xml_escape(
        bin.to_str()
            .ok_or_else(|| InstallError::NotUtf8(bin.to_owned()))?,
    );
    let log = "/dev/null";
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{bin}</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#
    ))
}

/// bootout (not loaded is fine), then bootstrap. launchd tears the old job
/// down asynchronously, so a bootstrap right after a bootout can fail with
/// an i/o error until it is gone: retry for about two seconds.
fn load_agent(plist: &Path, log: &Path) -> Result<(), InstallError> {
    let domain = format!("gui/{}", uid()?);
    let service = format!("{domain}/{LABEL}");
    let out = run(
        "launchctl",
        Command::new("launchctl").args(["bootout", &service]),
    )?;
    if out.status.success() {
        say(format_args!("stopped the running agent"))?;
    }
    let mut last = None;
    for attempt in 0..10 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        let output = run(
            "launchctl",
            Command::new("launchctl")
                .args(["bootstrap", &domain])
                .arg(plist),
        )?;
        if output.status.success() {
            return say(format_args!(
                "loaded and started {service} (a fixed config takes effect now); it logs to {}",
                log.display()
            ));
        }
        last = Some(detail(&output));
    }
    Err(InstallError::Failed {
        command: format!("launchctl bootstrap {domain} {}", plist.display()),
        detail: format!(
            "{}. check {} and `launchctl print {service}`",
            last.unwrap_or_default(),
            log.display()
        ),
    })
}

// -------------------------------------------------------------- uninstall

/// unloads the agent and removes the plist and the binary. the config and
/// the state stay.
///
/// # Errors
/// a plist or binary that exists but cannot be removed.
pub fn uninstall() -> Result<(), InstallError> {
    if launchctl_skipped() {
        say(format_args!(
            "skipped launchctl ({NO_LAUNCHCTL_ENV}=1): nothing unloaded"
        ))?;
    } else {
        let service = format!("gui/{}/{LABEL}", uid()?);
        let out = run(
            "launchctl",
            Command::new("launchctl").args(["bootout", &service]),
        )?;
        if out.status.success() {
            say(format_args!("unloaded {service}"))?;
        } else {
            say(format_args!("{service} was not loaded"))?;
        }
    }
    for (what, path) in [("launch agent", plist_path()?), ("binary", bin_path()?)] {
        match fs::remove_file(&path) {
            Ok(()) => say(format_args!("removed the {what} {}", path.display()))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                say(format_args!("no {what} at {}", path.display()))?;
            }
            Err(source) => {
                return Err(InstallError::Io {
                    what: "remove",
                    path,
                    source,
                });
            }
        }
    }
    let (config_path, loaded) = load_config()?;
    let state_dir = match loaded {
        Ok(config) => config.state_dir,
        Err(_) => config::default_state_dir()?,
    };
    say(format_args!(
        "kept the config at {} and the state in {}; remove them by hand if you want them gone",
        config_path.display(),
        state_dir.display()
    ))
}

// ------------------------------------------------------------------ login

/// reads the server's password from stdin (one line) into the config's
/// `password_file`, 0600. the password is never printed.
///
/// the terminal's echo, off while the password is typed and back on however
/// the read ends: a return, an error, or a ctrl-c (a signal thread restores
/// it before the process exits, since a signal skips drops).
struct EchoOff;

impl EchoOff {
    fn start() -> Self {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
        // stty works on its stdin, inherited from ours: the terminal.
        let _ = Command::new("stty").arg("-echo").status();
        if let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGINT, SIGTERM, SIGHUP]) {
            let _ = std::thread::Builder::new()
                .name("login-echo".into())
                .spawn(move || {
                    if signals.forever().next().is_some() {
                        let _ = Command::new("stty").arg("echo").status();
                        let _ = writeln!(io::stdout().lock());
                        std::process::exit(130);
                    }
                });
        }
        Self
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        let _ = Command::new("stty").arg("echo").status();
    }
}

/// # Errors
/// no config, an empty line, or a file that cannot be written.
pub fn login() -> Result<(), InstallError> {
    let config = Config::load(&config::config_path()?)?;
    let stdin = io::stdin();
    let tty = stdin.is_terminal();
    let mut line = String::new();
    if tty {
        write!(io::stdout().lock(), "password for {}: ", config.origin)
            .and_then(|()| io::stdout().lock().flush())
            .map_err(InstallError::Stdout)?;
    }
    let echo_off = tty.then(EchoOff::start);
    let read = stdin.lock().read_line(&mut line);
    if let Some(guard) = echo_off {
        drop(guard);
        say(format_args!(""))?;
    }
    read.map_err(InstallError::Stdin)?;
    let password = line.trim_end_matches(['\n', '\r']);
    if password.is_empty() {
        return Err(InstallError::EmptyPassword);
    }
    let path = &config.password_file;
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        private_dir(parent)?;
    }
    write_atomic(path, format!("{password}\n").as_bytes(), 0o600)?;
    say(format_args!(
        "wrote the password to {} (0600)",
        path.display()
    ))?;
    say(format_args!(
        "to use it now, restart the agent: launchctl kickstart -k gui/$(id -u)/{LABEL}"
    ))
}

// ----------------------------------------------------------------- status

#[derive(Debug, Default, PartialEq, Eq)]
struct Agent {
    state: Option<String>,
    pid: Option<u32>,
}

/// the service's own `state = ` and `pid = ` lines from `launchctl print`,
/// ignoring the nested blocks (endpoints, sockets) that have their own.
fn parse_launchctl_print(text: &str) -> Agent {
    let mut agent = Agent::default();
    let mut depth = 0usize;
    for line in text.lines().map(str::trim) {
        if line.starts_with('}') {
            depth = depth.saturating_sub(1);
            continue;
        }
        if depth == 1 {
            if let Some(v) = line.strip_prefix("state = ") {
                agent.state.get_or_insert_with(|| v.trim().to_owned());
            } else if let Some(v) = line.strip_prefix("pid = ")
                && agent.pid.is_none()
            {
                agent.pid = v.trim().parse().ok();
            }
        }
        if line.ends_with('{') {
            depth += 1;
        }
    }
    agent
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Stream {
    Off,
    Connecting,
    Up,
}

impl fmt::Display for Stream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Off => "off",
            Self::Connecting => "connecting",
            Self::Up => "up",
        })
    }
}

/// `<state dir>/status.json`, written by the running daemon.
#[derive(Debug, Deserialize, PartialEq, Eq)]
struct DaemonStatus {
    pid: u32,
    board: bool,
    stream: Stream,
    /// wall ms when the stream entered its state.
    since: u64,
}

fn parse_status(text: &str) -> Result<DaemonStatus, serde_json::Error> {
    serde_json::from_str(text)
}

/// `12 s ago`, `5 min ago`, `3 h 4 min ago`, `2 d 1 h ago`.
fn ago(now_ms: u64, since_ms: u64) -> String {
    let Some(ms) = now_ms.checked_sub(since_ms) else {
        return "in the future (check the clock)".to_owned();
    };
    let s = ms / 1000;
    let (d, h, m) = (s / 86_400, s / 3600 % 24, s / 60 % 60);
    if d > 0 {
        format!("{d} d {h} h ago")
    } else if h > 0 {
        format!("{h} h {m} min ago")
    } else if m > 0 {
        format!("{m} min ago")
    } else {
        format!("{s} s ago")
    }
}

#[derive(Debug, PartialEq)]
struct Usage {
    rss_kib: u64,
    cpu: String,
    cputime: String,
}

/// one line of `ps -o rss=,%cpu=,cputime=`.
fn parse_ps(text: &str) -> Option<Usage> {
    let mut fields = text.split_whitespace();
    let rss_kib = fields.next()?.parse().ok()?;
    let cpu = fields.next()?.to_owned();
    let cputime = fields.next()?.to_owned();
    Some(Usage {
        rss_kib,
        cpu,
        cputime,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// prints the agent, the daemon's own status and its memory and cpu. read
/// only; a missing piece is reported, not an error.
///
/// # Errors
/// only without HOME, without `id`, or when stdout is gone.
pub fn status() -> Result<(), InstallError> {
    let bin = bin_path()?;
    if bin.exists() {
        say(format_args!("binary: {}", bin.display()))?;
    } else {
        say(format_args!("binary: not installed at {}", bin.display()))?;
    }

    let (config_path, loaded) = load_config()?;
    let state_dir = match &loaded {
        Ok(config) => {
            say(format_args!(
                "config: {} (origin {})",
                config_path.display(),
                config.origin
            ))?;
            let pw = if config.password_file.exists() {
                "set"
            } else {
                "missing, run `boxbox-board login`"
            };
            say(format_args!("password: {pw}"))?;
            config.state_dir.clone()
        }
        Err(e) => {
            say(format_args!("config: {e}"))?;
            config::default_state_dir()?
        }
    };

    let service = format!("gui/{}/{LABEL}", uid()?);
    let out = run(
        "launchctl",
        Command::new("launchctl").args(["print", &service]),
    )?;
    let agent = if out.status.success() {
        let agent = parse_launchctl_print(&String::from_utf8_lossy(&out.stdout));
        say(format_args!(
            "agent: loaded, {}{}",
            agent.state.as_deref().unwrap_or("state unknown"),
            agent
                .pid
                .map_or_else(String::new, |pid| format!(", pid {pid}"))
        ))?;
        agent
    } else {
        say(format_args!("agent: not loaded ({service})"))?;
        Agent::default()
    };

    print_daemon(&state_dir, agent.pid)?;

    let Some(pid) = agent.pid else {
        return say(format_args!("usage: no running daemon to measure"));
    };
    let out = run(
        "ps",
        Command::new("ps")
            .args(["-o", "rss=,%cpu=,cputime=", "-p"])
            .arg(pid.to_string()),
    )?;
    match parse_ps(&String::from_utf8_lossy(&out.stdout)) {
        Some(usage) => say(format_args!(
            "usage: {} kib resident, {}% cpu now, {} cpu in total",
            usage.rss_kib, usage.cpu, usage.cputime
        )),
        None => say(format_args!("usage: ps has no process {pid}")),
    }
}

/// the daemon's own word on the board and the stream.
fn print_daemon(state_dir: &Path, agent_pid: Option<u32>) -> Result<(), InstallError> {
    let status_path = state_dir.join("status.json");
    let daemon = if let Ok(text) = fs::read_to_string(&status_path) {
        match parse_status(&text) {
            Ok(daemon) => Some(daemon),
            Err(e) => {
                say(format_args!(
                    "daemon: {} is not readable ({e})",
                    status_path.display()
                ))?;
                None
            }
        }
    } else {
        say(format_args!(
            "daemon: no status at {}",
            status_path.display()
        ))?;
        None
    };
    if let Some(daemon) = &daemon {
        let stale = match agent_pid {
            Some(pid) if pid != daemon.pid => {
                format!(" (written by pid {}, not the running one)", daemon.pid)
            }
            _ => String::new(),
        };
        say(format_args!(
            "board present: {}{stale}",
            if daemon.board { "yes" } else { "no" }
        ))?;
        say(format_args!(
            "stream: {}, since {}",
            daemon.stream,
            ago(now_ms(), daemon.since)
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIND_IDENTITY: &str = r#"
Policy: Code Signing
  Matching identities
  1) C0E1B32FFD0FF7AD715809AC9F1CA530CACDB7CD "boxbox-board signing" (CSSMERR_TP_NOT_TRUSTED)
  2) 20272318464499B44456E61DCBB744D366AB6985 "boxbox-board signing extra" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found

  Valid identities only
  1) 1111111111111111111111111111111111111111 "boxbox-board signing"
     0 valid identities found
"#;

    #[test]
    fn find_identity_takes_the_exact_name_from_matching() {
        assert_eq!(
            identities(FIND_IDENTITY, IDENTITY_NAME),
            vec!["C0E1B32FFD0FF7AD715809AC9F1CA530CACDB7CD".to_owned()]
        );
        assert!(identities(FIND_IDENTITY, "boxbox-board").is_empty());
        assert!(
            identities(
                "  Matching identities\n     0 identities found\n",
                IDENTITY_NAME
            )
            .is_empty()
        );
    }

    #[test]
    fn launchctl_print_reads_the_service_lines_only() {
        let text = "gui/501/dev.boxbox.board = {\n\tactive count = 1\n\tpath = /x.plist\n\tstate = running\n\n\tprogram = /bin/x\n\tendpoints = {\n\t\tstate = active\n\t\tpid = 9\n\t}\n\tpid = 4242\n}\n";
        assert_eq!(
            parse_launchctl_print(text),
            Agent {
                state: Some("running".to_owned()),
                pid: Some(4242)
            }
        );
        let idle = "gui/501/dev.boxbox.board = {\n\tstate = not running\n}\n";
        assert_eq!(
            parse_launchctl_print(idle),
            Agent {
                state: Some("not running".to_owned()),
                pid: None
            }
        );
    }

    #[test]
    fn the_plist_runs_the_binary_and_carries_no_environment() -> Result<(), InstallError> {
        let text = plist_text(Path::new("/Users/someone/.local/bin/boxbox-board"))?;
        assert!(text.contains("<string>dev.boxbox.board</string>"));
        assert!(text.contains(
            "<array>\n\t\t<string>/Users/someone/.local/bin/boxbox-board</string>\n\t\t<string>run</string>\n\t</array>"
        ));
        assert!(text.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(text.contains(
            "<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>"
        ));
        assert!(text.contains("<string>Interactive</string>"));
        assert_eq!(text.matches("<string>/dev/null</string>").count(), 2);
        assert!(!text.contains("EnvironmentVariables"));
        assert!(!text.contains("launchd.log"));
        let odd = plist_text(Path::new("/a&b/<c>"))?;
        assert!(odd.contains("<string>/a&amp;b/&lt;c&gt;</string>"));
        Ok(())
    }

    #[test]
    fn status_json_parses() -> Result<(), serde_json::Error> {
        assert_eq!(
            parse_status(r#"{"pid":123,"board":true,"stream":"up","since":1760000000000}"#)?,
            DaemonStatus {
                pid: 123,
                board: true,
                stream: Stream::Up,
                since: 1_760_000_000_000
            }
        );
        assert_eq!(
            parse_status(r#"{"pid":1,"board":false,"stream":"connecting","since":0}"#)?.stream,
            Stream::Connecting
        );
        assert!(parse_status(r#"{"pid":1,"board":false,"stream":"sideways","since":0}"#).is_err());
        Ok(())
    }

    #[test]
    fn ago_reads_plainly() {
        assert_eq!(ago(10_000, 2_000), "8 s ago");
        assert_eq!(ago(5 * 60_000 + 999, 0), "5 min ago");
        assert_eq!(ago(3 * 3_600_000 + 4 * 60_000, 0), "3 h 4 min ago");
        assert_eq!(ago(2 * 86_400_000 + 3_600_000, 0), "2 d 1 h ago");
        assert_eq!(ago(0, 1), "in the future (check the clock)");
    }

    #[test]
    fn ps_line_parses() {
        assert_eq!(
            parse_ps("  5120   0.1   0:00.04\n"),
            Some(Usage {
                rss_kib: 5120,
                cpu: "0.1".to_owned(),
                cputime: "0:00.04".to_owned()
            })
        );
        assert_eq!(parse_ps(""), None);
    }
}
