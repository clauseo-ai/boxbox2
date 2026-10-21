//! `boxbox upgrade`: swaps in a release, the same shape as cmx2's upgrade
//! (`packages/cli/src/commands/upgrade.ts`). it reads `SHA256SUMS` and this
//! machine's tarball from the github release (or `--from`), refuses a
//! tarball whose sum does not match, runs the new binary's `--version`
//! before it replaces anything, refuses the same or an older version
//! without `--force`, places it by atomic rename with the old one kept as
//! `boxbox.previous`, and restarts the installed service unless told not
//! to. each step is printed as it happens.

use std::cmp::Ordering;
use std::fmt::Write as _;
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use super::release::{self, ReleaseError, Staged};
use super::service;
use crate::config::Config;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// a binary that has not said its version in this long will not.
const VERSION_LIMIT: Duration = Duration::from_secs(30);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub version: Option<String>,
    pub from: Option<String>,
    pub force: bool,
    pub no_restart: bool,
}

#[derive(Debug, thiserror::Error)]
enum UpgradeError {
    #[error("{0}")]
    Refused(String),
    #[error(transparent)]
    Release(#[from] ReleaseError),
    #[error(transparent)]
    Service(#[from] service::ServiceError),
}

pub fn run(options: &Options) -> ExitCode {
    let mut out = io::stdout().lock();
    let mut say = |line: &str| {
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    };
    match upgrade(options, &mut say) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(io::stderr(), "boxbox upgrade: {error}");
            ExitCode::FAILURE
        }
    }
}

fn upgrade(options: &Options, say: &mut dyn FnMut(&str)) -> Result<(), UpgradeError> {
    let base = release::base(
        options.from.as_deref(),
        options.version.as_deref(),
        std::env::var("BOXBOX_RELEASE_BASE").ok().as_deref(),
        std::env::var("BOXBOX_REPO").ok().as_deref(),
    )?;
    let target = release::installed_binary()?;
    if replace(&base, release::platform()?, &target, options.force, say)? {
        restart(&target, options.no_restart, say)?;
    }
    Ok(())
}

/// everything up to and including the rename; answers whether the binary
/// was replaced.
fn replace(
    base: &str,
    platform: &str,
    target: &Path,
    force: bool,
    say: &mut dyn FnMut(&str),
) -> Result<bool, UpgradeError> {
    if !target.exists() {
        return Err(UpgradeError::Refused(format!(
            "there is no boxbox at {} to upgrade. boxbox service install puts this one there; on linux, so does install.sh",
            target.display()
        )));
    }
    let installed = installed_version(target);

    say(&format!("checking {base}"));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| UpgradeError::Refused(format!("the async runtime did not start: {e}")))?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("boxbox-upgrade/", env!("CARGO_PKG_VERSION")))
        // the bytes checked against SHA256SUMS are the file's own: never decoded on the way
        .no_gzip()
        .build()
        .map_err(|e| UpgradeError::Refused(format!("the http client did not build: {e}")))?;
    let sums = release::fetch(&runtime, &client, base, "SHA256SUMS")?;
    let sums = String::from_utf8_lossy(&sums);
    let (tarball, want) = release::tarball_for(&sums, platform)?;
    let bytes = release::fetch(&runtime, &client, base, &tarball)?;
    let got = release::sha256(&bytes);
    if got != want {
        return Err(UpgradeError::Refused(format!(
            "{tarball} does not match its checksum (expected {want}, got {got}); nothing was replaced. try again, and report it if it repeats"
        )));
    }
    say(&format!(
        "downloaded {tarball}, {}, checksum ok ({}...)",
        size(bytes.len()),
        &got[..16]
    ));
    let binary = release::binary_in(&bytes, &tarball)?;
    drop(bytes);

    // staged beside the target, run there, and renamed into place: the
    // bytes that ran are the bytes that land
    let staged = Staged::write(target, &binary)?;
    drop(binary);
    let version = release::run_version(staged.path(), VERSION_LIMIT).map_err(|e| {
        UpgradeError::Refused(format!(
            "the new binary does not run on this machine ({e}); nothing was replaced"
        ))
    })?;
    say(&format!("the new binary runs: boxbox {version}"));
    match release::compare_versions(&version, &installed) {
        Ordering::Equal if !force => {
            say(&format!(
                "already on {installed}, nothing replaced. --force reinstalls it"
            ));
            return Ok(false);
        }
        Ordering::Less if !force => {
            return Err(UpgradeError::Refused(format!(
                "the release is {version}, older than the {installed} installed; nothing was replaced. --force installs it anyway"
            )));
        }
        _ => {}
    }
    let kept = staged.place()?;
    say(&format!(
        "replaced {}: {installed} -> {version}{}",
        target.display(),
        if kept {
            " (the old one is boxbox.previous)"
        } else {
            ""
        }
    ));
    Ok(true)
}

fn restart(target: &Path, no_restart: bool, say: &mut dyn FnMut(&str)) -> Result<(), UpgradeError> {
    let state = service::state()?;
    if !state.installed {
        say("no service installed, so nothing to restart. boxbox service install runs it");
        return Ok(());
    }
    if let Some(binary) = &state.binary
        && Path::new(binary) != target
    {
        say(&format!(
            "note: the service runs {binary}, not {}. boxbox service install points it at the installed copy",
            target.display()
        ));
    }
    let command = service::restart_command()?;
    if no_restart {
        say(&format!(
            "the service runs the old binary until it restarts: {command}"
        ));
        return Ok(());
    }
    let listen = state
        .config
        .as_deref()
        .and_then(|c| Config::load(c).ok())
        .map(|c| c.listen)
        .ok_or_else(|| {
            UpgradeError::Refused(format!(
                "the binary is replaced, but the service's config does not load, so its restart cannot be checked. fix it (boxbox doctor), then run {command}"
            ))
        })?;
    let mut line = format!("restarting the service ({command})");
    if let Some(pid) = state.job.pid() {
        let _ = write!(line, ", pid {pid}");
    }
    say(&line);
    let pid = service::restart(listen)
        .map_err(|e| UpgradeError::Refused(format!("the binary is replaced, but {e}")))?;
    say(&format!(
        "restarted: {} answering on {listen}",
        pid.map_or_else(|| "it is".into(), |p| format!("pid {p}"))
    ));
    Ok(())
}

/// the installed binary's version: this one's when it is that file, else
/// what it says. one that cannot say is older than anything.
fn installed_version(target: &Path) -> String {
    let this = std::env::current_exe().and_then(std::fs::canonicalize);
    if this.is_ok_and(|this| std::fs::canonicalize(target).is_ok_and(|t| t == this)) {
        return VERSION.into();
    }
    release::run_version(target, VERSION_LIMIT).unwrap_or_else(|_| "0.0.0".into())
}

fn size(bytes: usize) -> String {
    #[allow(clippy::cast_precision_loss, reason = "a size shown to one decimal")]
    let mb = bytes as f64 / 1_048_576.0;
    format!("{mb:.1} mb")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "boxbox-upgrade-{name}-{}-{}",
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

    /// a release directory whose tarball holds a shell script that answers
    /// `--version` like boxbox does.
    fn release_dir(dir: &Path, version: &str, tamper: bool) {
        let platform = release::platform().unwrap();
        let name = format!("boxbox-{version}-{platform}");
        let script = format!("#!/bin/sh\necho 'boxbox {version}'\n");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(script.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, format!("{name}/boxbox"), script.as_bytes())
            .unwrap();
        let mut packed = builder.into_inner().unwrap().finish().unwrap();
        let sum = release::sha256(&packed);
        if tamper {
            packed.push(0);
        }
        fs::write(dir.join(format!("{name}.tar.gz")), &packed).unwrap();
        fs::write(dir.join("SHA256SUMS"), format!("{sum}  {name}.tar.gz\n")).unwrap();
    }

    #[test]
    fn an_upgrade_checks_the_sum_runs_the_binary_compares_versions_and_places_it() {
        let platform = release::platform().unwrap();
        let home = TempDir::new("home");
        let target = home.0.join(".local/bin/boxbox");
        let bin = target.parent().unwrap().to_owned();
        let replace_from = |dir: &TempDir, force: bool| {
            let mut said = Vec::new();
            let result = replace(
                &dir.0.display().to_string(),
                platform,
                &target,
                force,
                &mut |line| said.push(line.to_owned()),
            );
            (result, said)
        };

        let missing = TempDir::new("missing");
        release_dir(&missing.0, "0.2.0", false);
        let error = replace_from(&missing, false).0.unwrap_err().to_string();
        assert!(error.starts_with("there is no boxbox at "), "{error}");

        fs::create_dir_all(&bin).unwrap();
        fs::write(&target, "#!/bin/sh\necho 'boxbox 0.1.0'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let tampered = TempDir::new("tampered");
        release_dir(&tampered.0, "0.2.0", true);
        let error = replace_from(&tampered, false).0.unwrap_err().to_string();
        assert!(error.contains("does not match its checksum"), "{error}");
        assert!(
            fs::read_to_string(&target)
                .unwrap()
                .contains("boxbox 0.1.0")
        );

        let older = TempDir::new("older");
        release_dir(&older.0, "0.0.9", false);
        let error = replace_from(&older, false).0.unwrap_err().to_string();
        assert!(error.contains("older than the 0.1.0 installed"), "{error}");

        let same = TempDir::new("same");
        release_dir(&same.0, "0.1.0", false);
        let (result, said) = replace_from(&same, false);
        assert!(!result.unwrap());
        assert_eq!(
            said.last().unwrap(),
            "already on 0.1.0, nothing replaced. --force reinstalls it"
        );

        let newer = TempDir::new("newer");
        release_dir(&newer.0, "0.2.0", false);
        let (result, said) = replace_from(&newer, false);
        assert!(result.unwrap());
        assert!(said[0].starts_with("checking "), "{said:?}");
        assert!(said[1].contains("checksum ok"), "{said:?}");
        assert_eq!(said[2], "the new binary runs: boxbox 0.2.0");
        assert!(
            said[3].ends_with(": 0.1.0 -> 0.2.0 (the old one is boxbox.previous)"),
            "{said:?}"
        );
        assert!(
            fs::read_to_string(&target)
                .unwrap()
                .contains("boxbox 0.2.0")
        );
        assert!(
            fs::read_to_string(bin.join("boxbox.previous"))
                .unwrap()
                .contains("boxbox 0.1.0")
        );
        let leftovers = fs::read_dir(&bin)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(".boxbox.new"))
            .count();
        assert_eq!(leftovers, 0, "no staged file is left behind");

        let (result, said) = replace_from(&older, true);
        assert!(result.unwrap());
        assert!(
            said[3].ends_with(": 0.2.0 -> 0.0.9 (the old one is boxbox.previous)"),
            "{said:?}"
        );
    }

    #[test]
    fn a_tarball_whose_binary_does_not_run_replaces_nothing() {
        let platform = release::platform().unwrap();
        let home = TempDir::new("broken");
        let target = home.0.join("boxbox");
        fs::write(&target, "#!/bin/sh\necho 'boxbox 0.1.0'\n").unwrap();
        let dir = TempDir::new("broken-release");
        let name = format!("boxbox-0.2.0-{platform}");
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let script = b"#!/bin/sh\nexit 3\n";
        let mut header = tar::Header::new_gnu();
        header.set_size(script.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, format!("{name}/boxbox"), &script[..])
            .unwrap();
        let packed = builder.into_inner().unwrap().finish().unwrap();
        fs::write(
            dir.0.join("SHA256SUMS"),
            format!("{}  {name}.tar.gz\n", release::sha256(&packed)),
        )
        .unwrap();
        fs::write(dir.0.join(format!("{name}.tar.gz")), packed).unwrap();
        let error = replace(
            &dir.0.display().to_string(),
            platform,
            &target,
            true,
            &mut |_| {},
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.starts_with("the new binary does not run on this machine (it exited"),
            "{error}"
        );
        assert!(error.ends_with("nothing was replaced"), "{error}");
        assert!(
            fs::read_to_string(&target)
                .unwrap()
                .contains("boxbox 0.1.0")
        );
        assert!(!home.0.join("boxbox.previous").exists());
    }

    #[test]
    fn sizes_read_in_megabytes() {
        assert_eq!(size(10 * 1_048_576 + 104_858), "10.1 mb");
    }
}
