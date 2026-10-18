//! the `boxbox-board` binary: `run` (what the launch agent starts),
//! `install`, `uninstall`, `status` and `login` (`docs/board.md`).

#![forbid(unsafe_code)]

use std::io::Write;
use std::process::ExitCode;

const USAGE: &str = "usage: boxbox-board <run | install | uninstall | status | login>
  run        the daemon (the launch agent runs this)
  install    the binary to ~/.local/bin, the launch agent, a config to fill in
  uninstall  the launch agent and the binary; config and state stay
  status     whether the board is here, the stream, memory and cpu
  login      reads the server's password from stdin into the password file";

fn say(to_err: bool, text: &str) {
    if to_err {
        let _ = writeln!(std::io::stderr().lock(), "{text}");
    } else {
        let _ = writeln!(std::io::stdout().lock(), "{text}");
    }
}

#[cfg(target_os = "macos")]
fn main() -> ExitCode {
    use boxbox_board::install;

    let arg = std::env::args().nth(1).unwrap_or_default();
    let done = match arg.as_str() {
        "run" => return run(),
        "install" => install::install(),
        "uninstall" => install::uninstall(),
        "status" => install::status(),
        "login" => install::login(),
        "-h" | "--help" | "help" => {
            say(false, USAGE);
            return ExitCode::SUCCESS;
        }
        _ => {
            say(true, USAGE);
            return ExitCode::from(2);
        }
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            say(true, &format!("boxbox-board {arg}: {e}"));
            ExitCode::FAILURE
        }
    }
}

#[cfg(target_os = "macos")]
fn run() -> ExitCode {
    use std::os::unix::fs::DirBuilderExt;
    use std::path::Path;

    use boxbox_board::config::{Config, config_path, default_state_dir};
    use boxbox_board::daemon::Daemon;
    use boxbox_board::log::Log;

    fn private_dir(dir: &Path) -> std::io::Result<()> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }

    // the capped log comes first, so nothing can fail unrecorded: launchd's
    // own output goes to /dev/null. a config that cannot be read is logged
    // and exits 0, so the agent (kept alive only after a failure) stays down
    // until `install` or a kickstart instead of respawning every 10 s.
    let default_dir = match default_state_dir() {
        Ok(dir) => dir,
        Err(e) => {
            say(true, &format!("boxbox-board run: {e}"));
            return ExitCode::SUCCESS;
        }
    };
    let mut log = match private_dir(&default_dir) {
        Ok(()) => Log::open(&default_dir),
        Err(_) => Log::null(),
    };
    let cfg = match config_path().and_then(|path| Config::load(&path)) {
        Ok(cfg) => cfg,
        Err(e) => {
            log.error("config.invalid", &e.to_string());
            say(true, &format!("boxbox-board run: {e}"));
            return ExitCode::SUCCESS;
        }
    };
    if cfg.state_dir != default_dir {
        if let Err(e) = private_dir(&cfg.state_dir) {
            log.error("config.state_dir", &format!("error={:?}", e.kind()));
            return ExitCode::SUCCESS;
        }
        log = Log::open(&cfg.state_dir);
    }
    match Daemon::start(cfg, log.clone()) {
        Ok(daemon) => match daemon.run() {
            Ok(()) => {
                log.info("daemon.down", "");
                ExitCode::SUCCESS
            }
            Err(e) => {
                log.error("daemon.down", &format!("why={}", e.0));
                ExitCode::FAILURE
            }
        },
        Err(e) => {
            log.error("daemon.start_failed", &format!("error={:?}", e.kind()));
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() -> ExitCode {
    say(
        true,
        "boxbox-board runs on macos, where the board is plugged in (docs/board.md).",
    );
    let _ = USAGE;
    ExitCode::FAILURE
}
