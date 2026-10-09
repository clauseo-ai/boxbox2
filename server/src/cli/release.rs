//! what `boxbox upgrade` and `boxbox service install` share about releases
//! and the installed binary: where releases come from, which tarball is
//! this machine's, how versions compare, and placing a binary by atomic
//! rename with the one it replaces kept as `boxbox.previous`.
//!
//! a release is laid out the way `ops/release/build.sh` and
//! `ops/release/mac.sh` make it (`docs/deploy.md`): `SHA256SUMS` beside one
//! `boxbox-<version>-<arch>-<os>.tar.gz` per machine, each holding a
//! `boxbox-<version>-<arch>-<os>/boxbox`.

use std::cmp::Ordering;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// the repository releases come from, stamped by the release build
/// (`BOXBOX_REPO`, which the workflow sets from `GITHUB_REPOSITORY`). a
/// source build has none, so an upgrade can only come from where its binary
/// did, never from a guessed name someone else could register.
const STAMPED_REPO: Option<&str> = option_env!("BOXBOX_REPO");

/// a release tarball is around 10 mb; nothing past this is read.
const TARBALL_CAP: u64 = 256 * 1024 * 1024;
/// `SHA256SUMS` is a few lines.
const SUMS_CAP: u64 = 64 * 1024;
/// a download slower than this has stalled.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, thiserror::Error)]
pub enum ReleaseError {
    #[error("{0}")]
    Refused(String),
    #[error("cannot read {what}: {source}")]
    Io { what: String, source: io::Error },
}

fn io_error(what: impl Into<String>) -> impl FnOnce(io::Error) -> ReleaseError {
    let what = what.into();
    move |source| ReleaseError::Io { what, source }
}

/// where `boxbox` is installed: `~/.local/bin/boxbox`, the path the units
/// run (`ops/boxbox.service`, the launchd agent).
///
/// # Errors
/// `HOME` is not set.
pub fn installed_binary() -> Result<PathBuf, ReleaseError> {
    home().map(|home| home.join(".local/bin/boxbox"))
}

/// `$HOME`, which every installed path hangs from.
///
/// # Errors
/// `HOME` is not set.
pub fn home() -> Result<PathBuf, ReleaseError> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            ReleaseError::Refused("HOME is not set, so there is no ~/.local to install into".into())
        })
}

/// the base url or directory a release is read from: `--from`, else
/// `$BOXBOX_RELEASE_BASE`, else the stamped (or `$BOXBOX_REPO`) repo's
/// github release, the latest or `version`.
///
/// # Errors
/// `--version` given with a base that already names one release, or no
/// repo known to fetch from.
pub fn base(
    from: Option<&str>,
    version: Option<&str>,
    env_base: Option<&str>,
    env_repo: Option<&str>,
) -> Result<String, ReleaseError> {
    let explicit = from.or(env_base.filter(|b| !b.is_empty()));
    if let Some(base) = explicit {
        if version.is_some() {
            return Err(ReleaseError::Refused(
                "--version picks among the repo's releases; with --from or $BOXBOX_RELEASE_BASE, point at the release you want".into(),
            ));
        }
        return Ok(base.trim_end_matches('/').to_owned());
    }
    let repo = env_repo
        .filter(|r| !r.is_empty())
        .or(STAMPED_REPO.filter(|r| !r.is_empty()))
        .ok_or_else(|| {
            ReleaseError::Refused(
                "this binary does not know which repository it was released from (a source build). set BOXBOX_REPO=clauseo-ai/boxbox2, or pass --from <url or dir>".into(),
            )
        })?;
    Ok(match version {
        Some(version) => format!(
            "https://github.com/{repo}/releases/download/v{}",
            version.trim_start_matches('v')
        ),
        None => format!("https://github.com/{repo}/releases/latest/download"),
    })
}

/// this machine's part of a tarball's name: `aarch64-darwin`,
/// `x86_64-linux`, ...
///
/// # Errors
/// no release is built for this os or architecture.
pub fn platform() -> Result<&'static str, ReleaseError> {
    platform_of(std::env::consts::OS, std::env::consts::ARCH)
}

fn platform_of(os: &str, arch: &str) -> Result<&'static str, ReleaseError> {
    match (os, arch) {
        ("macos", "aarch64") => Ok("aarch64-darwin"),
        ("linux", "aarch64") => Ok("aarch64-linux"),
        ("linux", "x86_64") => Ok("x86_64-linux"),
        ("macos", other) => Err(ReleaseError::Refused(format!(
            "there is no mac release for {other}, only apple silicon; build from source with just build"
        ))),
        (os, arch) => Err(ReleaseError::Refused(format!(
            "there is no release for {arch} {os}; build from source with just build"
        ))),
    }
}

/// this platform's tarball and its sum, from `SHA256SUMS` (the release's
/// index: `<64 hex>  <name>`, the name optionally behind a `*`).
///
/// # Errors
/// the release has no tarball for this platform, or more than one.
pub fn tarball_for(sums: &str, platform: &str) -> Result<(String, String), ReleaseError> {
    let suffix = format!("-{platform}.tar.gz");
    let found: Vec<(String, String)> = sums
        .lines()
        .filter_map(|line| {
            let (sum, name) = line.trim().split_once(char::is_whitespace)?;
            let name = name.trim_start().trim_start_matches('*');
            let is_sum = sum.len() == 64 && sum.bytes().all(|b| b.is_ascii_hexdigit());
            (is_sum && name.starts_with("boxbox-") && name.ends_with(&suffix))
                .then(|| (name.to_owned(), sum.to_ascii_lowercase()))
        })
        .collect();
    match found.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(ReleaseError::Refused(format!(
            "SHA256SUMS names no {platform} tarball: that release has no build for this machine"
        ))),
        _ => Err(ReleaseError::Refused(format!(
            "SHA256SUMS names more than one {platform} tarball, so which to install is not clear"
        ))),
    }
}

/// the hex sha-256 of `bytes`.
#[must_use]
pub fn sha256(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
}

/// a file of the release: read from a directory, a `file://` url, or
/// fetched over http(s), never more than the cap.
///
/// # Errors
/// the file is missing, unreachable, answered with an error, or too large.
pub fn fetch(
    runtime: &tokio::runtime::Runtime,
    client: &reqwest::Client,
    base: &str,
    name: &str,
) -> Result<Vec<u8>, ReleaseError> {
    let cap = if name == "SHA256SUMS" {
        SUMS_CAP
    } else {
        TARBALL_CAP
    };
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        let path = Path::new(base.strip_prefix("file://").unwrap_or(base)).join(name);
        let file = fs::File::open(&path).map_err(io_error(path.display().to_string()))?;
        let mut bytes = Vec::new();
        file.take(cap + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error(path.display().to_string()))?;
        return within(bytes, cap, &path.display().to_string());
    }
    let url = format!("{base}/{name}");
    runtime.block_on(async {
        let response = tokio::time::timeout(DOWNLOAD_TIMEOUT, client.get(&url).send())
            .await
            .map_err(|_| {
                ReleaseError::Refused(format!(
                    "{url} did not answer within {} s",
                    DOWNLOAD_TIMEOUT.as_secs()
                ))
            })?
            .map_err(|e| {
                ReleaseError::Refused(format!(
                    "cannot reach {url}: {}",
                    crate::upstream::plain(&e)
                ))
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(ReleaseError::Refused(format!("{url} answered {status}")));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::time::timeout(DOWNLOAD_TIMEOUT, response.chunk())
                .await
                .map_err(|_| ReleaseError::Refused(format!("{url} stalled mid-download")))?
                .map_err(|e| {
                    ReleaseError::Refused(format!(
                        "{url} dropped mid-download: {}",
                        crate::upstream::plain(&e)
                    ))
                })?;
            let Some(chunk) = chunk else { break };
            bytes.extend_from_slice(&chunk);
            if bytes.len() as u64 > cap {
                break;
            }
        }
        within(bytes, cap, &url)
    })
}

fn within(bytes: Vec<u8>, cap: u64, what: &str) -> Result<Vec<u8>, ReleaseError> {
    if bytes.len() as u64 > cap {
        Err(ReleaseError::Refused(format!(
            "{what} is larger than {} mb, more than any release file; nothing was installed",
            cap / 1024 / 1024
        )))
    } else {
        Ok(bytes)
    }
}

/// the `boxbox` binary inside a release tarball: the regular file named
/// `boxbox` in its one top-level directory.
///
/// # Errors
/// the tarball does not unpack, or holds no such file.
pub fn binary_in(tarball: &[u8], name: &str) -> Result<Vec<u8>, ReleaseError> {
    let unpack = |e: io::Error| ReleaseError::Refused(format!("{name} does not unpack: {e}"));
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tarball));
    for entry in archive.entries().map_err(unpack)? {
        let mut entry = entry.map_err(unpack)?;
        let path = entry.path().map_err(unpack)?.into_owned();
        let mut parts = path.components();
        let top = parts.next();
        let file = parts.next();
        let is_binary = top.is_some()
            && file.is_some_and(|f| f.as_os_str() == "boxbox")
            && parts.next().is_none()
            && entry.header().entry_type().is_file();
        if is_binary {
            if entry.size() > TARBALL_CAP {
                return Err(ReleaseError::Refused(format!(
                    "{name} holds a binary larger than any release's"
                )));
            }
            let mut bytes = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
            entry.read_to_end(&mut bytes).map_err(unpack)?;
            return Ok(bytes);
        }
    }
    Err(ReleaseError::Refused(format!(
        "{name} holds no boxbox binary"
    )))
}

/// `-1`, `0` or `1` for two versions like `0.1.0` (a leading `v` and a
/// `boxbox ` prefix are fine); a prerelease (`0.1.0-dirty`) sorts below its
/// release, as cmx2's upgrade compares.
#[must_use]
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parse(text: &str) -> ([u64; 3], Option<&str>) {
        let text = text.trim();
        let text = text.strip_prefix("boxbox ").unwrap_or(text);
        let text = text.strip_prefix('v').unwrap_or(text);
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let mut numbers = [0; 3];
        for (slot, part) in numbers.iter_mut().zip(core.split('.')) {
            *slot = part.parse().unwrap_or(0);
        }
        (numbers, pre)
    }
    let (x, x_pre) = parse(a);
    let (y, y_pre) = parse(b);
    x.cmp(&y).then_with(|| match (x_pre, y_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => x.cmp(y),
    })
}

/// the version out of `boxbox --version`'s line, `boxbox 0.1.0`.
#[must_use]
pub fn version_of(line: &str) -> Option<&str> {
    let version = line.trim().strip_prefix("boxbox ")?;
    let numeric = version.split(['.', '-']).take(3).all(|p| !p.is_empty())
        && version.as_bytes().first().is_some_and(u8::is_ascii_digit);
    numeric.then_some(version)
}

/// a binary staged beside its final name, removed unless it is placed.
pub struct Staged {
    path: PathBuf,
    target: PathBuf,
    placed: bool,
}

impl Staged {
    /// writes `bytes` beside `target` (mode 0755, synced), where a rename
    /// onto `target` is atomic: one directory, one filesystem.
    ///
    /// # Errors
    /// the directory cannot be made or written.
    pub fn write(target: &Path, bytes: &[u8]) -> Result<Self, ReleaseError> {
        let dir = parent_of(target);
        fs::create_dir_all(dir).map_err(io_error(dir.display().to_string()))?;
        let path = dir.join(format!(".boxbox.new.{}", std::process::id()));
        let staged = Self {
            path,
            target: target.to_owned(),
            placed: false,
        };
        let what = staged.path.display().to_string();
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o755);
        let mut file = options.open(&staged.path).map_err(io_error(&what))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(io_error(&what))?;
        #[cfg(unix)]
        fs::set_permissions(
            &staged.path,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .map_err(io_error(&what))?;
        Ok(staged)
    }

    /// the staged file, to run before it replaces anything.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// renames the staged file onto the target. the old binary keeps its
    /// inode under `boxbox.previous` (a hard link, no copy), and a running
    /// process keeps running it until it restarts: a binary is never
    /// written over in place (`docs/scars.md`, line 842).
    ///
    /// # Errors
    /// the link or the rename fails; the target is then untouched.
    pub fn place(mut self) -> Result<bool, ReleaseError> {
        let previous = parent_of(&self.target).join("boxbox.previous");
        let kept = match fs::symlink_metadata(&self.target) {
            Ok(_) => {
                match fs::remove_file(&previous) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(io_error(previous.display().to_string())(e)),
                }
                fs::hard_link(&self.target, &previous)
                    .map_err(io_error(previous.display().to_string()))?;
                true
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => false,
            Err(e) => return Err(io_error(self.target.display().to_string())(e)),
        };
        fs::rename(&self.path, &self.target)
            .map_err(io_error(self.target.display().to_string()))?;
        self.placed = true;
        // the rename is durable once its directory is
        if let Ok(dir) = fs::File::open(parent_of(&self.target)) {
            let _ = dir.sync_all();
        }
        Ok(kept)
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.placed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn parent_of(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

/// runs `binary --version` and answers its version, waiting at most
/// `limit`: a binary this machine cannot run fails here, before it
/// replaces anything.
///
/// # Errors
/// it does not start, fails, hangs, or prints something else.
pub fn run_version(binary: &Path, limit: Duration) -> Result<String, String> {
    let mut child = std::process::Command::new(binary)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("it does not start: {e}"))?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("it did not answer within {} s", limit.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("waiting for it failed: {e}")),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("reading its answer failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next().unwrap_or_default();
    match version_of(line) {
        Some(version) if output.status.success() => Ok(version.to_owned()),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let said = stderr.trim();
            let said = if said.is_empty() { line.trim() } else { said };
            Err(format!(
                "it exited {} saying \"{}\"",
                output.status,
                said.chars().take(200).collect::<String>()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMS: &str = "\
1111111111111111111111111111111111111111111111111111111111111111  boxbox-0.2.0-aarch64-linux.tar.gz
2222222222222222222222222222222222222222222222222222222222222222  boxbox-0.2.0-x86_64-linux.tar.gz
3333333333333333333333333333333333333333333333333333333333333333 *boxbox-0.2.0-aarch64-darwin.tar.gz
4444444444444444444444444444444444444444444444444444444444444444  install.sh
";

    #[test]
    fn sha256sums_names_this_machines_tarball_and_its_sum() {
        assert_eq!(
            tarball_for(SUMS, "aarch64-darwin").unwrap(),
            (
                "boxbox-0.2.0-aarch64-darwin.tar.gz".to_owned(),
                "3".repeat(64)
            )
        );
        assert_eq!(tarball_for(SUMS, "x86_64-linux").unwrap().1, "2".repeat(64));
        let none = tarball_for("4444  install.sh\n", "aarch64-darwin").unwrap_err();
        assert!(
            none.to_string().contains("no aarch64-darwin tarball"),
            "{none}"
        );
        let twice = format!(
            "{SUMS}{}  boxbox-0.3.0-x86_64-linux.tar.gz\n",
            "5".repeat(64)
        );
        assert!(tarball_for(&twice, "x86_64-linux").is_err());
    }

    #[test]
    fn every_platform_with_a_release_is_named_and_others_are_refused() {
        assert_eq!(platform_of("macos", "aarch64").unwrap(), "aarch64-darwin");
        assert_eq!(platform_of("linux", "x86_64").unwrap(), "x86_64-linux");
        assert!(
            platform_of("macos", "x86_64")
                .unwrap_err()
                .to_string()
                .contains("apple silicon")
        );
        assert!(platform_of("windows", "x86_64").is_err());
    }

    #[test]
    fn the_base_is_the_flag_then_the_environment_then_the_repo() {
        let base = |from, version, env_base, env_repo| base(from, version, env_base, env_repo);
        assert_eq!(base(Some("dist/"), None, Some("x"), None).unwrap(), "dist");
        assert_eq!(
            base(None, None, Some("https://mirror/r/"), None).unwrap(),
            "https://mirror/r"
        );
        assert_eq!(
            base(None, Some("v0.2.0"), None, Some("o/r")).unwrap(),
            "https://github.com/o/r/releases/download/v0.2.0"
        );
        assert_eq!(
            base(None, None, None, Some("o/r")).unwrap(),
            "https://github.com/o/r/releases/latest/download"
        );
        assert!(base(Some("dist"), Some("0.2.0"), None, None).is_err());
        if STAMPED_REPO.is_none() {
            let source = base(None, None, None, None).unwrap_err().to_string();
            assert!(source.contains("a source build"), "{source}");
        }
    }

    #[test]
    fn versions_compare_as_semver_with_a_prerelease_below_its_release() {
        assert_eq!(compare_versions("0.1.0", "0.1.0"), Ordering::Equal);
        assert_eq!(
            compare_versions("boxbox 0.2.0", "v0.1.9"),
            Ordering::Greater
        );
        assert_eq!(compare_versions("0.1.10", "0.1.9"), Ordering::Greater);
        assert_eq!(compare_versions("0.1.0-dirty", "0.1.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "0.9.9"), Ordering::Greater);
    }

    #[test]
    fn the_version_line_is_read_and_anything_else_is_not() {
        assert_eq!(version_of("boxbox 0.1.0\n"), Some("0.1.0"));
        assert_eq!(version_of("boxbox 0.1.0-dirty"), Some("0.1.0-dirty"));
        assert_eq!(version_of("cmx2 0.8.3"), None);
        assert_eq!(version_of("boxbox, the server"), None);
    }

    fn tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (path, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, path, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn the_binary_is_the_file_named_boxbox_in_the_top_directory() {
        let packed = tarball(&[
            ("boxbox-0.2.0-aarch64-darwin/LICENSE", b"mit"),
            ("boxbox-0.2.0-aarch64-darwin/boxbox", b"\x7fELF binary"),
        ]);
        assert_eq!(binary_in(&packed, "t.tar.gz").unwrap(), b"\x7fELF binary");
        let nested = tarball(&[("a/b/boxbox", b"no")]);
        assert!(
            binary_in(&nested, "t.tar.gz")
                .unwrap_err()
                .to_string()
                .contains("holds no boxbox binary")
        );
        assert!(
            binary_in(b"not gzip", "t.tar.gz")
                .unwrap_err()
                .to_string()
                .contains("does not unpack")
        );
    }

    #[test]
    fn placing_renames_over_the_target_and_keeps_the_old_inode_as_previous() {
        let dir = std::env::temp_dir().join(format!(
            "boxbox-place-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("boxbox");

        let first = Staged::write(&target, b"one").unwrap();
        assert!(!first.place().unwrap(), "nothing was there to keep");
        let open_before = fs::File::open(&target).unwrap();

        let second = Staged::write(&target, b"two").unwrap();
        assert_eq!(fs::read(second.path()).unwrap(), b"two");
        assert!(second.place().unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"two");
        assert_eq!(fs::read(dir.join("boxbox.previous")).unwrap(), b"one");
        let mut still = String::new();
        let mut open_before = open_before;
        open_before.read_to_string(&mut still).unwrap();
        assert_eq!(still, "one", "an open handle keeps the old file");

        let dropped = Staged::write(&target, b"three").unwrap();
        let staged_path = dropped.path().to_owned();
        drop(dropped);
        assert!(!staged_path.exists(), "an unplaced stage is removed");
        assert_eq!(fs::read(&target).unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_binary_that_does_not_say_its_version_is_refused() {
        assert_eq!(
            run_version(Path::new("/nonexistent/boxbox"), Duration::from_secs(1))
                .unwrap_err()
                .split(':')
                .next(),
            Some("it does not start")
        );
        // echo prints something, and exits 0, but not a boxbox version
        let said = run_version(Path::new("/bin/echo"), Duration::from_secs(5)).unwrap_err();
        assert!(said.starts_with("it exited"), "{said}");
    }
}
