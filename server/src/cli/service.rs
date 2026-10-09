//! `boxbox service install | status | uninstall`: the server as a per-user
//! service that starts on its own and comes back when it stops, the same
//! shape as cmx2's `serve --install` (`packages/cli/src/service.ts`).
//!
//! - **macos**: a launchd agent, `~/Library/LaunchAgents/dev.boxbox.serve.plist`,
//!   loaded into the `user/<uid>` domain rather than the `gui/<uid>` one,
//!   with `LimitLoadToSessionType` `Background`: the gui domain ends with
//!   the gui login, and a login loads only `Aqua` agents into it, so it
//!   never starts a second copy (`docs/deploy.md`, the mac).
//! - **linux**: the systemd user unit the release ships (`ops/boxbox.service`),
//!   installed the way `install.sh` installs it.
//!
//! either way the unit runs the installed copy, `~/.local/bin/boxbox`, never
//! the file you ran: launchd stalls for minutes on a tcc consent prompt for
//! a binary under `~/Documents`. install places this binary there first
//! when it is not that file. the unit holds no secret; the config does.
//! `BOXBOX_SERVICE_LABEL` names another unit, so a test can install one
//! beside the real one.

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::{Duration, Instant};

use super::release::{self, ReleaseError, Staged};
use crate::config::{self, Config};

/// the launchd label, and on linux the unit the release ships.
pub const DEFAULT_LABEL: &str = "dev.boxbox.serve";
/// the systemd unit the release ships, read at build time so the binary
/// installs the very file the tarball carries.
const SYSTEMD_UNIT: &str = include_str!("../../../ops/boxbox.service");
/// the `--config` the shipped unit passes, replaced when install is given
/// another.
const SYSTEMD_CONFIG: &str = "--config %h/.config/boxbox/boxbox.toml";
/// how long a started unit has to answer before install says it did not.
const START_LIMIT: Duration = Duration::from_secs(15);
/// launchd waits this long after sigterm before it kills: the drain takes
/// at most 5 s (`main.rs`), and the systemd unit allows 8.
const EXIT_TIMEOUT_S: u32 = 8;
/// launchd starts the server again no sooner than this after it stops.
const THROTTLE_S: u32 = 5;

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Install { config: String },
    Status,
    Uninstall,
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Refused(String),
    #[error(transparent)]
    Release(#[from] ReleaseError),
    #[error("cannot write {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
}

/// the label in use: `$BOXBOX_SERVICE_LABEL`, else `dev.boxbox.serve`.
#[must_use]
pub fn label() -> String {
    std::env::var("BOXBOX_SERVICE_LABEL")
        .ok()
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| DEFAULT_LABEL.into())
}

/// the systemd unit's name for a label: `boxbox` for the default one.
fn systemd_name(label: &str) -> String {
    if label == DEFAULT_LABEL {
        "boxbox".into()
    } else {
        label.into()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Manager {
    Launchd,
    Systemd,
}

fn manager() -> Result<Manager, ServiceError> {
    match std::env::consts::OS {
        "macos" => Ok(Manager::Launchd),
        "linux" => Ok(Manager::Systemd),
        other => Err(ServiceError::Refused(format!(
            "boxbox service knows launchd (macos) and systemd (linux), not {other}"
        ))),
    }
}

pub fn run(action: &Action) -> ExitCode {
    let result = match action {
        Action::Install { config } => install(config),
        Action::Status => status(),
        Action::Uninstall => uninstall(),
    };
    match result {
        Ok(report) => {
            let _ = io::stdout().lock().write_all(report.text.as_bytes());
            if report.healthy {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            let _ = writeln!(io::stderr(), "boxbox service: {error}");
            ExitCode::FAILURE
        }
    }
}

/// what a subcommand printed, and whether it ends well.
struct Report {
    text: String,
    healthy: bool,
}

/// where the unit and its log live for a label.
struct Unit {
    manager: Manager,
    label: String,
    path: PathBuf,
    log: Option<PathBuf>,
}

impl Unit {
    fn for_label(label: String) -> Result<Self, ServiceError> {
        let manager = manager()?;
        let home = release::home()?;
        Ok(match manager {
            Manager::Launchd => Self {
                path: home.join(format!("Library/LaunchAgents/{label}.plist")),
                log: Some(home.join(format!("Library/Logs/boxbox/{label}.log"))),
                manager,
                label,
            },
            Manager::Systemd => {
                let config_home = std::env::var_os("XDG_CONFIG_HOME")
                    .filter(|d| !d.is_empty())
                    .map_or_else(|| home.join(".config"), PathBuf::from);
                Self {
                    path: config_home
                        .join(format!("systemd/user/{}.service", systemd_name(&label))),
                    log: None,
                    manager,
                    label,
                }
            }
        })
    }

    fn target(&self) -> Result<String, ServiceError> {
        Ok(format!("{}/{}", domain()?, self.label))
    }

    fn systemd_service(&self) -> String {
        format!("{}.service", systemd_name(&self.label))
    }
}

/// the domain the agent loads into, `user/<uid>`.
fn domain() -> Result<String, ServiceError> {
    Ok(format!("user/{}", uid()?))
}

/// the unit as launchd or systemd sees it, and as its file says.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct State {
    pub installed: bool,
    pub job: Job,
    /// the binary and the config the unit runs, read back from its file.
    pub binary: Option<String>,
    pub config: Option<String>,
    /// a copy also loaded in the gui domain, which a gui logout would stop.
    pub in_gui_domain: bool,
}

/// what the service manager is doing with the unit.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Job {
    /// launchd or systemd does not know it.
    #[default]
    NotLoaded,
    /// known, with no process: between restarts, or failed.
    Waiting,
    Running {
        pid: Option<u32>,
    },
}

impl Job {
    pub fn loaded(self) -> bool {
        self != Self::NotLoaded
    }

    pub fn pid(self) -> Option<u32> {
        match self {
            Self::Running { pid } => pid,
            _ => None,
        }
    }
}

/// reads the installed unit (the default label, or `$BOXBOX_SERVICE_LABEL`).
///
/// # Errors
/// the os has no service manager boxbox knows, or `HOME` is not set.
pub fn state() -> Result<State, ServiceError> {
    state_of(&Unit::for_label(label())?)
}

fn state_of(unit: &Unit) -> Result<State, ServiceError> {
    let mut state = State {
        installed: unit.path.is_file(),
        ..State::default()
    };
    let text = fs::read_to_string(&unit.path).unwrap_or_default();
    match unit.manager {
        Manager::Launchd => {
            let arguments = program_arguments(&text);
            state.binary = arguments.first().cloned();
            state.config = argument_after(&arguments, "--config");
            let (ok, out) = launchctl(&["print", &unit.target()?]);
            if ok {
                state.job = parse_launchctl_print(&out);
            }
            let gui = format!("gui/{}/{}", uid()?, unit.label);
            state.in_gui_domain = launchctl(&["print", &gui]).0;
        }
        Manager::Systemd => {
            let exec = text
                .lines()
                .find_map(|l| l.strip_prefix("ExecStart="))
                .unwrap_or_default();
            let words = exec_words(exec, &release::home()?);
            state.binary = words.first().cloned();
            state.config = argument_after(&words, "--config");
            let (ok, out) = run_command(
                "systemctl",
                &[
                    "--user",
                    "show",
                    &unit.systemd_service(),
                    "--property=LoadState,ActiveState,MainPID",
                ],
            );
            if ok {
                state.job = parse_systemctl_show(&out);
            }
        }
    }
    Ok(state)
}

/// the command that restarts the installed unit, for printing.
///
/// # Errors
/// the os has no service manager boxbox knows, or `HOME` is not set.
pub fn restart_command() -> Result<String, ServiceError> {
    let unit = Unit::for_label(label())?;
    Ok(match unit.manager {
        Manager::Launchd => format!("launchctl kickstart -k {}", unit.target()?),
        Manager::Systemd => format!("systemctl --user restart {}", unit.systemd_service()),
    })
}

/// restarts the installed unit and waits for a new process to answer on
/// `listen`; answers its pid. launchd's `kickstart -k` and systemd's
/// restart both stop it with sigterm, so it drains first.
///
/// # Errors
/// the restart is refused, or nothing new answers in time.
pub fn restart(listen: SocketAddr) -> Result<Option<u32>, ServiceError> {
    let unit = Unit::for_label(label())?;
    let before = state_of(&unit)?.job.pid();
    let command = restart_command()?;
    let words: Vec<&str> = command.split(' ').collect();
    let (ok, out) = match words.split_first() {
        Some((program, args)) => run_command(program, args),
        None => (false, String::new()),
    };
    if !ok {
        return Err(ServiceError::Refused(format!(
            "the restart failed: {}. run {command}",
            or_no_reason(&out)
        )));
    }
    wait_for_start(&unit, listen, before)
}

fn install(config_flag: &str) -> Result<Report, ServiceError> {
    let unit = Unit::for_label(label())?;
    let config_path =
        absolute(&config::expand_home(config_flag).map_err(|e| refused(e.to_string()))?)?;
    let config = Config::load(&config_path.display().to_string()).map_err(|e| {
        ServiceError::Refused(format!(
            "{e}. boxbox init writes a config; boxbox doctor says what is wrong with one"
        ))
    })?;
    let mut text = String::new();

    let binary = release::installed_binary()?;
    place_self(&binary, &mut text)?;

    let before = state_of(&unit)?;
    match unit.manager {
        Manager::Launchd => install_launchd(&unit, &binary, &config_path, &before, &mut text)?,
        Manager::Systemd => install_systemd(&unit, &config_path, &mut text)?,
    }

    let started = wait_for_start(&unit, config.listen, None);
    let _ = writeln!(text, "unit      {}", unit.path.display());
    if unit.manager == Manager::Launchd {
        let _ = writeln!(text, "domain    {}", domain()?);
    }
    let _ = writeln!(text, "binary    {}", binary.display());
    let _ = writeln!(text, "config    {}", config_path.display());
    match &unit.log {
        Some(log) => {
            let _ = writeln!(text, "logs      {}", log.display());
        }
        None => {
            let _ = writeln!(
                text,
                "logs      journalctl --user -u {}",
                unit.systemd_service()
            );
        }
    }
    let healthy = match started {
        Ok(pid) => {
            let pid = pid.map_or_else(String::new, |p| format!(", pid {p}"));
            let _ = writeln!(text, "running   on {}{pid}", config.listen);
            true
        }
        Err(error) => {
            let _ = writeln!(text, "running   no: {error}");
            false
        }
    };
    if unit.manager == Manager::Systemd && !lingering() {
        text.push_str(
            "\nto keep it running while you are logged out and after a reboot: loginctl enable-linger \"$USER\"\n",
        );
    }
    Ok(Report { text, healthy })
}

/// puts this binary at the installed path, unless it is that file.
fn place_self(binary: &Path, text: &mut String) -> Result<(), ServiceError> {
    let current = std::env::current_exe()
        .map_err(|e| refused(format!("cannot tell which binary this is: {e}")))?;
    if same_file(&current, binary) {
        return Ok(());
    }
    let bytes = fs::read(&current)
        .map_err(|e| refused(format!("cannot read {}: {e}", current.display())))?;
    let kept = Staged::write(binary, &bytes)?.place()?;
    let _ = writeln!(
        text,
        "placed {} at {}{}",
        current.display(),
        binary.display(),
        if kept {
            " (the one it replaced is boxbox.previous)"
        } else {
            ""
        }
    );
    Ok(())
}

fn install_launchd(
    unit: &Unit,
    binary: &Path,
    config: &Path,
    before: &State,
    text: &mut String,
) -> Result<(), ServiceError> {
    let home = release::home()?;
    let log = unit
        .log
        .clone()
        .unwrap_or_else(|| home.join("Library/Logs/boxbox/boxbox.log"));
    if let Some(dir) = log.parent() {
        create_private_dir(dir)?;
    }
    let plist = render_launchd(&LaunchdSpec {
        label: &unit.label,
        binary,
        config,
        home: &home,
        log: &log,
    });
    write_atomically(&unit.path, plist.as_bytes(), 0o644)?;

    let target = unit.target()?;
    let domain = domain()?;
    if before.job.loaded() {
        // launchd takes a changed plist only once the old job is booted out
        launchctl(&["bootout", &target]);
        wait_until(Duration::from_secs(10), || {
            !launchctl(&["print", &target]).0
        });
    }
    if before.in_gui_domain {
        let gui = format!("gui/{}/{}", uid()?, unit.label);
        launchctl(&["bootout", &gui]);
        let _ = writeln!(
            text,
            "booted a copy out of {gui}: the gui domain ends at logout, the user domain does not"
        );
    }
    let mut loaded = launchctl(&["bootstrap", &domain, &unit.path.display().to_string()]);
    if !loaded.0 {
        // bootout can return before launchd lets go of the label
        std::thread::sleep(Duration::from_secs(1));
        loaded = launchctl(&["bootstrap", &domain, &unit.path.display().to_string()]);
    }
    if !loaded.0 {
        return Err(refused(format!(
            "launchd would not load {} into {domain}: {}. check it with plutil -lint {}",
            unit.path.display(),
            or_no_reason(&loaded.1),
            unit.path.display()
        )));
    }
    let _ = writeln!(text, "loaded {} into {domain}", unit.label);
    Ok(())
}

fn install_systemd(unit: &Unit, config: &Path, text: &mut String) -> Result<(), ServiceError> {
    let default_config = release::home()?.join(".config/boxbox/boxbox.toml");
    let wanted = render_systemd(config, &default_config);
    match fs::read_to_string(&unit.path) {
        Ok(existing) if existing == wanted => {
            let _ = writeln!(text, "the unit at {} is current", unit.path.display());
        }
        Ok(_) => {
            let new = unit.path.with_extension("service.new");
            write_atomically(&new, wanted.as_bytes(), 0o644)?;
            let _ = writeln!(
                text,
                "your unit at {} differs from this boxbox's, so it was kept; the new one is {} (compare with diff)",
                unit.path.display(),
                new.display()
            );
        }
        Err(_) => {
            write_atomically(&unit.path, wanted.as_bytes(), 0o644)?;
            let _ = writeln!(text, "installed the unit at {}", unit.path.display());
        }
    }
    let service = unit.systemd_service();
    for args in [
        vec!["--user", "daemon-reload"],
        vec!["--user", "enable", "--now", service.as_str()],
        // enable --now leaves a running unit on its old binary
        vec!["--user", "restart", service.as_str()],
    ] {
        let (ok, out) = run_command("systemctl", &args);
        if !ok {
            return Err(refused(format!(
                "systemctl {} failed: {}. is there a user session bus? on a server, run loginctl enable-linger \"$USER\" once",
                args.join(" "),
                or_no_reason(&out)
            )));
        }
    }
    let _ = writeln!(text, "enabled and started {service}");
    Ok(())
}

fn status() -> Result<Report, ServiceError> {
    let unit = Unit::for_label(label())?;
    let state = state_of(&unit)?;
    let mut text = String::new();
    if !state.installed {
        let _ = writeln!(
            text,
            "not installed. boxbox service install sets it up ({})",
            unit.path.display()
        );
        if state.job.loaded() {
            let _ = writeln!(
                text,
                "but {} is still loaded; boxbox service uninstall clears it",
                unit.label
            );
        }
        return Ok(Report {
            text,
            healthy: false,
        });
    }
    let _ = writeln!(text, "unit      {}", unit.path.display());
    if unit.manager == Manager::Launchd {
        let _ = writeln!(text, "domain    {}", domain()?);
    }
    let binary = state.binary.as_deref().unwrap_or("unknown");
    let version = state.binary.as_deref().map_or_else(
        || "unknown".into(),
        |b| {
            release::run_version(Path::new(b), Duration::from_secs(10))
                .map_or_else(|e| format!("does not run: {e}"), |v| format!("boxbox {v}"))
        },
    );
    let _ = writeln!(text, "binary    {binary} ({version})");
    let _ = writeln!(
        text,
        "config    {}",
        state.config.as_deref().unwrap_or("unknown")
    );
    if let Some(log) = &unit.log {
        // launchd never rotates it, so its size is worth a look now and then
        let size = fs::metadata(log).map_or_else(
            |_| "not written yet".into(),
            |m| format!("{:.1} mb", bytes_as_mb(m.len())),
        );
        let _ = writeln!(text, "logs      {} ({size})", log.display());
    }
    let shown = match state.job {
        Job::Running { pid: Some(pid) } => format!("running, pid {pid}"),
        Job::Running { pid: None } => "running".into(),
        Job::Waiting => "loaded, not running".into(),
        Job::NotLoaded => "not loaded".into(),
    };
    let _ = writeln!(text, "state     {shown}");
    if state.in_gui_domain {
        let _ = writeln!(
            text,
            "note      a copy is also loaded in the gui domain, which a logout stops; boxbox service install moves it"
        );
    }
    let listen = state
        .config
        .as_deref()
        .and_then(|c| Config::load(c).ok())
        .map(|c| c.listen);
    let answering = listen.is_some_and(answers);
    let _ = match listen {
        Some(listen) => writeln!(
            text,
            "answers   {} on {listen}",
            if answering { "yes" } else { "no" }
        ),
        None => writeln!(text, "answers   unknown: the config does not load"),
    };
    Ok(Report {
        text,
        healthy: matches!(state.job, Job::Running { .. }) && answering,
    })
}

fn uninstall() -> Result<Report, ServiceError> {
    let unit = Unit::for_label(label())?;
    let state = state_of(&unit)?;
    if !state.installed && !state.job.loaded() {
        return Ok(Report {
            text: format!(
                "no service installed ({} is not there)\n",
                unit.path.display()
            ),
            healthy: true,
        });
    }
    match unit.manager {
        Manager::Launchd => {
            let target = unit.target()?;
            if state.job.loaded() {
                let (ok, out) = launchctl(&["bootout", &target]);
                // bootout returns before launchd lets go of the label; wait,
                // so a status right after tells the truth
                let gone = wait_until(Duration::from_secs(10), || {
                    !launchctl(&["print", &target]).0
                });
                if !ok && !gone {
                    return Err(refused(format!(
                        "launchd would not unload {}: {}",
                        unit.label,
                        or_no_reason(&out)
                    )));
                }
            }
        }
        Manager::Systemd => {
            run_command(
                "systemctl",
                &["--user", "disable", "--now", &unit.systemd_service()],
            );
        }
    }
    match fs::remove_file(&unit.path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(ServiceError::Write {
                path: unit.path.clone(),
                source,
            });
        }
    }
    if unit.manager == Manager::Systemd {
        run_command("systemctl", &["--user", "daemon-reload"]);
    }
    Ok(Report {
        text: format!(
            "stopped and removed {}. the binary, the config, the data and the logs stay\n",
            unit.path.display()
        ),
        healthy: true,
    })
}

/// waits for the unit to run a process other than `before` that answers
/// on `listen`; answers its pid.
fn wait_for_start(
    unit: &Unit,
    listen: SocketAddr,
    before: Option<u32>,
) -> Result<Option<u32>, ServiceError> {
    let started = Instant::now();
    let mut last = State::default();
    while started.elapsed() < START_LIMIT {
        last = state_of(unit)?;
        let pid = last.job.pid();
        if pid.is_some() && pid != before && answers(listen) {
            return Ok(pid);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let log = unit.log.as_ref().map_or_else(
        || format!("journalctl --user -u {}", unit.systemd_service()),
        |l| l.display().to_string(),
    );
    let seen = match last.job {
        Job::Running { pid: Some(pid) } if Some(pid) != before => {
            format!("it runs (pid {pid}) but does not answer")
        }
        Job::Running { .. } => "no new process started".into(),
        Job::Waiting | Job::NotLoaded => "it is not running".into(),
    };
    Err(refused(format!(
        "{seen} on {listen} after {} s. read {log}; a port already taken is the usual cause",
        START_LIMIT.as_secs()
    )))
}

/// a boxbox answers on `listen`: its `/api/hosts` asks for a sign-in.
fn answers(listen: SocketAddr) -> bool {
    let addr = if listen.ip().is_unspecified() {
        SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), listen.port())
    } else {
        listen
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .is_ok_and(|runtime| runtime.block_on(super::doctor::answers_like_boxbox(addr)))
}

struct LaunchdSpec<'a> {
    label: &'a str,
    binary: &'a Path,
    config: &'a Path,
    home: &'a Path,
    log: &'a Path,
}

/// the launchd agent. every path is absolute (launchd expands no `~`), the
/// environment carries `HOME` and the log level and nothing secret, and
/// `Umask` 0077 keeps the cookie secret and the db private, as the systemd
/// unit's `UMask` does.
fn render_launchd(spec: &LaunchdSpec<'_>) -> String {
    let arguments = [
        spec.binary.display().to_string(),
        "serve".into(),
        "--config".into(),
        spec.config.display().to_string(),
    ];
    let mut text = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <!-- written by boxbox service install (docs/deploy.md, the mac). it holds\n     no secret: those live in the config, mode 0600. -->\n\
         <plist version=\"1.0\">\n<dict>\n",
    );
    let key = |text: &mut String, key: &str, value: &str| {
        let _ = writeln!(
            text,
            "\t<key>{key}</key>\n\t<string>{}</string>",
            xml(value)
        );
    };
    key(&mut text, "Label", spec.label);
    text.push_str("\t<key>ProgramArguments</key>\n\t<array>\n");
    for argument in &arguments {
        let _ = writeln!(text, "\t\t<string>{}</string>", xml(argument));
    }
    text.push_str("\t</array>\n\t<key>EnvironmentVariables</key>\n\t<dict>\n");
    for (name, value) in [
        ("HOME", spec.home.display().to_string()),
        ("RUST_LOG", "boxbox=info".into()),
    ] {
        let _ = writeln!(
            text,
            "\t\t<key>{name}</key>\n\t\t<string>{}</string>",
            xml(&value)
        );
    }
    text.push_str("\t</dict>\n");
    key(
        &mut text,
        "WorkingDirectory",
        &spec.home.display().to_string(),
    );
    // the user domain outlives a gui logout; a login loads only aqua agents
    // into the gui domain, so this one is never started twice
    key(&mut text, "LimitLoadToSessionType", "Background");
    text.push_str("\t<key>RunAtLoad</key>\n\t<true/>\n\t<key>KeepAlive</key>\n\t<true/>\n");
    let _ = writeln!(
        text,
        "\t<key>ThrottleInterval</key>\n\t<integer>{THROTTLE_S}</integer>\n\t<key>ExitTimeOut</key>\n\t<integer>{EXIT_TIMEOUT_S}</integer>"
    );
    // without a process type launchd throttles cpu and io, and the server
    // answers a phone waiting on it
    key(&mut text, "ProcessType", "Interactive");
    text.push_str("\t<key>Umask</key>\n\t<integer>63</integer>\n");
    let log = spec.log.display().to_string();
    key(&mut text, "StandardOutPath", &log);
    key(&mut text, "StandardErrorPath", &log);
    text.push_str("</dict>\n</plist>\n");
    text
}

/// the shipped unit, with `--config` pointed elsewhere when install was
/// given another config.
fn render_systemd(config: &Path, default_config: &Path) -> String {
    if config == default_config {
        return SYSTEMD_UNIT.to_owned();
    }
    let path = config.display().to_string();
    let quoted = if path.contains(|c: char| c.is_whitespace() || "\"'\\%".contains(c)) {
        format!(
            "\"{}\"",
            path.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('%', "%%")
        )
    } else {
        path
    };
    SYSTEMD_UNIT.replace(SYSTEMD_CONFIG, &format!("--config {quoted}"))
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn unxml(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// the strings of the plist's `ProgramArguments`, as this module writes it.
fn program_arguments(plist: &str) -> Vec<String> {
    let Some(start) = plist.find("<key>ProgramArguments</key>") else {
        return Vec::new();
    };
    let rest = &plist[start..];
    let Some(end) = rest.find("</array>") else {
        return Vec::new();
    };
    rest[..end]
        .split("<string>")
        .skip(1)
        .filter_map(|s| s.split_once("</string>").map(|(value, _)| unxml(value)))
        .collect()
}

fn argument_after(arguments: &[String], flag: &str) -> Option<String> {
    let at = arguments.iter().position(|a| a == flag)?;
    arguments.get(at + 1).cloned()
}

/// the words of a systemd unit's `ExecStart` as the paths they name, read
/// back the way [`render_systemd`] writes them: a word in double quotes may
/// hold spaces, `\\` and `\"`, and the specifiers are expanded, `%h` to the
/// home directory and `%%` to `%` (systemd.unit(5), specifiers). taken as
/// text, the shipped unit's `%h/.config/boxbox/boxbox.toml` is a path that
/// does not exist, and upgrade could not load the config to check its
/// restart. a specifier the unit never uses stays as it is written.
fn exec_words(line: &str, home: &Path) -> Vec<String> {
    let home = home.display().to_string();
    let mut words = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        let Some(&first) = chars.peek() else {
            return words;
        };
        let mut word = String::new();
        if first == '"' {
            chars.next();
            while let Some(c) = chars.next() {
                match c {
                    '"' => break,
                    '\\' => word.extend(chars.next()),
                    _ => word.push(c),
                }
            }
        } else {
            while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
                word.push(c);
            }
        }
        let mut expanded = String::with_capacity(word.len());
        let mut letters = word.chars();
        while let Some(c) = letters.next() {
            match (c, letters.clone().next()) {
                ('%', Some('h')) => {
                    expanded.push_str(&home);
                    letters.next();
                }
                ('%', Some('%')) => {
                    expanded.push('%');
                    letters.next();
                }
                _ => expanded.push(c),
            }
        }
        words.push(expanded);
    }
}

/// the job from a successful `launchctl print <domain>/<label>`: the
/// first `state =` and `pid =` lines, which are the job's own (nested
/// blocks like its endpoints come after).
fn parse_launchctl_print(out: &str) -> Job {
    let value = |key: &str| {
        out.lines()
            .find_map(|l| l.trim().strip_prefix(key).map(str::trim))
    };
    if value("state = ") == Some("running") {
        Job::Running {
            pid: value("pid = ").and_then(|p| p.parse().ok()),
        }
    } else {
        Job::Waiting
    }
}

/// the job from `systemctl --user show <unit> --property=LoadState,ActiveState,MainPID`.
fn parse_systemctl_show(out: &str) -> Job {
    let has = |line: &str| out.lines().any(|l| l == line);
    if !has("LoadState=loaded") {
        Job::NotLoaded
    } else if has("ActiveState=active") {
        Job::Running {
            pid: out
                .lines()
                .find_map(|l| l.strip_prefix("MainPID="))
                .and_then(|p| p.parse().ok())
                .filter(|&p| p != 0),
        }
    } else {
        Job::Waiting
    }
}

fn launchctl(args: &[&str]) -> (bool, String) {
    run_command("launchctl", args)
}

fn run_command(program: &str, args: &[&str]) -> (bool, String) {
    match Command::new(program).args(args).output() {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            (output.status.success(), text.trim().to_owned())
        }
        Err(e) => (false, format!("{program} did not run: {e}")),
    }
}

/// this user's id, which names the launchd domain.
fn uid() -> Result<u32, ServiceError> {
    let (ok, out) = run_command("id", &["-u"]);
    out.parse().ok().filter(|_| ok).ok_or_else(|| {
        refused(format!(
            "cannot tell this user's id: {}",
            or_no_reason(&out)
        ))
    })
}

fn lingering() -> bool {
    let user = std::env::var("USER").unwrap_or_default();
    run_command("loginctl", &["show-user", &user, "--property=Linger"])
        .1
        .contains("Linger=yes")
}

fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < limit {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    done()
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn absolute(path: &Path) -> Result<PathBuf, ServiceError> {
    if path.is_absolute() {
        return Ok(path.to_owned());
    }
    std::env::current_dir()
        .map(|dir| dir.join(path))
        .map_err(|e| refused(format!("cannot tell the current directory: {e}")))
}

/// writes beside `path` and renames over it, so a unit is never half written.
fn write_atomically(path: &Path, bytes: &[u8], mode: u32) -> Result<(), ServiceError> {
    let write_error = |source| ServiceError::Write {
        path: path.to_owned(),
        source,
    };
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(write_error)?;
    let name = path
        .file_name()
        .map_or_else(|| "unit".into(), |n| n.to_string_lossy().into_owned());
    let staged = dir.join(format!(".{name}.{}", std::process::id()));
    let written = fs::write(&staged, bytes)
        .and_then(|()| set_mode(&staged, mode))
        .and_then(|()| fs::rename(&staged, path));
    if written.is_err() {
        let _ = fs::remove_file(&staged);
    }
    written.map_err(write_error)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) -> io::Result<()> {
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), ServiceError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path).map_err(|source| ServiceError::Write {
        path: path.to_owned(),
        source,
    })
}

#[allow(clippy::cast_precision_loss, reason = "a size shown to one decimal")]
fn bytes_as_mb(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

fn refused(text: impl Into<String>) -> ServiceError {
    ServiceError::Refused(text.into())
}

fn or_no_reason(out: &str) -> &str {
    if out.is_empty() {
        "no reason given"
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_plist(binary: &str) -> String {
        render_launchd(&LaunchdSpec {
            label: "dev.boxbox.serve",
            binary: Path::new(binary),
            config: Path::new("/Users/someone/.config/boxbox/boxbox.toml"),
            home: Path::new("/Users/someone"),
            log: Path::new("/Users/someone/Library/Logs/boxbox/dev.boxbox.serve.log"),
        })
    }

    #[test]
    fn the_agent_runs_the_installed_copy_in_the_user_domain_and_keeps_it_alive() {
        let plist = spec_plist("/Users/someone/.local/bin/boxbox");
        for wanted in [
            "<key>Label</key>\n\t<string>dev.boxbox.serve</string>",
            "<string>/Users/someone/.local/bin/boxbox</string>\n\t\t<string>serve</string>\n\t\t<string>--config</string>\n\t\t<string>/Users/someone/.config/boxbox/boxbox.toml</string>",
            "<key>LimitLoadToSessionType</key>\n\t<string>Background</string>",
            "<key>RunAtLoad</key>\n\t<true/>",
            "<key>KeepAlive</key>\n\t<true/>",
            "<key>ThrottleInterval</key>\n\t<integer>5</integer>",
            "<key>ExitTimeOut</key>\n\t<integer>8</integer>",
            "<key>HOME</key>\n\t\t<string>/Users/someone</string>",
            "<key>StandardErrorPath</key>\n\t<string>/Users/someone/Library/Logs/boxbox/dev.boxbox.serve.log</string>",
        ] {
            assert!(plist.contains(wanted), "missing {wanted} in\n{plist}");
        }
        assert!(
            !plist.to_lowercase().contains("password"),
            "no secret in the unit"
        );
        assert!(!plist.contains("Documents"));
    }

    #[test]
    fn the_agents_arguments_read_back_through_escaping() {
        let plist = spec_plist("/Users/a & b/<bin>/boxbox");
        assert!(plist.contains("<string>/Users/a &amp; b/&lt;bin&gt;/boxbox</string>"));
        let arguments = program_arguments(&plist);
        assert_eq!(arguments[0], "/Users/a & b/<bin>/boxbox");
        assert_eq!(
            argument_after(&arguments, "--config").as_deref(),
            Some("/Users/someone/.config/boxbox/boxbox.toml")
        );
        assert!(program_arguments("<plist/>").is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn plutil_accepts_the_agent() {
        let path = std::env::temp_dir().join(format!(
            "boxbox-plist-{}-{}.plist",
            std::process::id(),
            rand::random::<u32>()
        ));
        fs::write(&path, spec_plist("/Users/a & b/boxbox")).unwrap();
        let (ok, out) = run_command("plutil", &["-lint", &path.display().to_string()]);
        let _ = fs::remove_file(&path);
        assert!(ok, "{out}");
    }

    #[test]
    fn the_systemd_unit_is_the_shipped_one_unless_the_config_moved() {
        let default = Path::new("/home/u/.config/boxbox/boxbox.toml");
        assert_eq!(render_systemd(default, default), SYSTEMD_UNIT);
        assert!(
            SYSTEMD_UNIT.contains(SYSTEMD_CONFIG),
            "the shipped unit names its config"
        );
        let moved = render_systemd(Path::new("/srv/boxbox.toml"), default);
        assert!(moved.contains("ExecStart=%h/.local/bin/boxbox serve --config /srv/boxbox.toml\n"));
        let spaced = render_systemd(Path::new("/srv/my 100% config.toml"), default);
        assert!(
            spaced.contains("--config \"/srv/my 100%% config.toml\"\n"),
            "{spaced}"
        );
    }

    #[test]
    fn a_units_exec_start_reads_back_as_the_paths_install_wrote() {
        let home = Path::new("/home/u");
        let default = home.join(".config/boxbox/boxbox.toml");
        for config in [
            default.clone(),
            PathBuf::from("/srv/boxbox.toml"),
            PathBuf::from("/srv/my 100% \"odd\" \\ config.toml"),
        ] {
            let unit = render_systemd(&config, &default);
            let exec = unit
                .lines()
                .find_map(|l| l.strip_prefix("ExecStart="))
                .expect("the unit has an ExecStart");
            let words = exec_words(exec, home);
            assert_eq!(
                words.first().map(String::as_str),
                Some("/home/u/.local/bin/boxbox"),
                "{exec}"
            );
            assert_eq!(
                argument_after(&words, "--config"),
                Some(config.display().to_string()),
                "{exec}"
            );
        }
        // a specifier the unit never uses is left as written, and an escaped one stays literal
        assert_eq!(
            exec_words("%h/bin/x %t/run %%h", home),
            ["/home/u/bin/x", "%t/run", "%h"]
        );
    }

    #[test]
    fn launchctl_print_gives_the_jobs_own_state_and_pid() {
        let running = "dev.boxbox.serve = {\n\tactive count = 1\n\tpath = /Users/x/Library/LaunchAgents/dev.boxbox.serve.plist\n\ttype = LaunchAgent\n\tstate = running\n\n\tprogram = /Users/x/.local/bin/boxbox\n\tpid = 4242\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n";
        assert_eq!(
            parse_launchctl_print(running),
            Job::Running { pid: Some(4242) }
        );
        let waiting = "dev.boxbox.serve = {\n\tstate = not running\n\tlast exit code = 1\n}\n";
        assert_eq!(parse_launchctl_print(waiting), Job::Waiting);
    }

    #[test]
    fn systemctl_show_gives_the_units_state_and_pid() {
        let show = |text: &str| parse_systemctl_show(text);
        assert_eq!(
            show("LoadState=loaded\nActiveState=active\nMainPID=77"),
            Job::Running { pid: Some(77) }
        );
        assert_eq!(
            show("LoadState=loaded\nActiveState=failed\nMainPID=0"),
            Job::Waiting
        );
        assert_eq!(
            show("LoadState=not-found\nActiveState=inactive\nMainPID=0"),
            Job::NotLoaded
        );
    }

    #[test]
    fn the_default_label_is_boxbox_to_systemd_and_others_keep_their_name() {
        assert_eq!(systemd_name(DEFAULT_LABEL), "boxbox");
        assert_eq!(systemd_name("dev.boxbox.test"), "dev.boxbox.test");
    }
}
