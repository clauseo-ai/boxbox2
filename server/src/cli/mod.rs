//! the command line. `serve` runs the server (`main.rs`); `init` writes a
//! first `boxbox.toml`, pairing with daemons on the way; `doctor` reports
//! whether an install can run; `service` installs it as a per-user unit;
//! `upgrade` swaps in a release. this module turns arguments into a typed
//! [`Command`] and owns the usage text.

pub mod doctor;
pub mod init;
pub mod pair;
pub mod release;
pub mod service;
pub mod upgrade;

use std::net::SocketAddr;

use crate::config;

pub const USAGE: &str = "boxbox, the server between your cmx2 daemons and your devices

usage
  boxbox serve [--config <path>]              run the server (the default command)
  boxbox init [flags]                         write a first boxbox.toml, asking what the flags leave out
  boxbox doctor [--config <path>]             check the config, reach every host, look at the data dir
  boxbox service install [--config <path>]    run the server in the background, started again if it stops
  boxbox service status                       where the unit is, what it runs, whether it answers
  boxbox service uninstall                    stop it and remove the unit; the binary, config and data stay
  boxbox upgrade [flags]                      swap in a release and restart the service
  boxbox openapi                              print boxbox's api document as json
  boxbox --version

init flags
  --config <path>                       where to write it
  --listen <address>                    where boxbox listens (127.0.0.1:3000)
  --data-dir <path>                     where its data lives (~/.local/share/boxbox)
  --plain-http                          it is reached over plain http on this machine
                                        (http://localhost), so its cookie is not marked secure
  --password-file <path>                the gate password, read from a file, or - for stdin;
                                        without one, init makes one and shows it once
  --host <name>=<url>                   a cmx2 daemon to watch; repeat it for each one
  --host-password-file <name>=<path>    that daemon's password, read from a file, or -
  --pair <name>=<url>                   a cmx2 daemon to pair with: init trades the token
                                        cmx2 pair printed there for a credential of its own
  --pair-token-file <name>=<path>       that token, or everything cmx2 pair printed, from a file or -
  passwords and tokens never go on the command line, where ps and shell history keep them.
  on a terminal, init asks for whatever the flags leave out.

upgrade flags
  --version <v>        a release other than the latest
  --from <url or dir>  a url or directory laid out like a release (SHA256SUMS and the
                       tarballs); $BOXBOX_RELEASE_BASE does the same
  --force              install it even when it is the version you have, or older
  --no-restart         replace the binary only, and print the restart command

config
  --config, else $BOXBOX_CONFIG, else ~/.config/boxbox/boxbox.toml.
  see boxbox.example.toml. logging follows RUST_LOG (default boxbox=info).";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Serve { config: String },
    Init(init::Options),
    Doctor { config: String },
    Service(service::Action),
    Upgrade(upgrade::Options),
    Openapi,
    Version,
    Help,
}

/// arguments that do not make a command; the message names the one at fault.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct UsageError(String);

/// reads the arguments after the program name. `$BOXBOX_CONFIG` is passed in
/// rather than read here, so parsing stays a pure function.
///
/// # Errors
/// an unknown command or flag, a flag without its value, or a value that
/// cannot be what the flag asks for.
pub fn parse(args: &[String], env_config: Option<&str>) -> Result<Command, UsageError> {
    let (command, rest) = match args.split_first() {
        None => ("serve", args),
        // serve is the default command, so its flag may come first alone
        Some((first, _)) if first == "--config" || first.starts_with("--config=") => {
            ("serve", args)
        }
        Some((first, rest)) => (first.as_str(), rest),
    };
    let config_path = |flag: Option<String>| {
        flag.or_else(|| env_config.map(String::from))
            .unwrap_or_else(|| config::DEFAULT_PATH.into())
    };
    match command {
        "serve" => {
            let mut config = None;
            for flag in Flags::new(rest, &[]) {
                match flag? {
                    ("--config", value) => config = Some(value),
                    (other, _) => return Err(unknown_flag("serve", other)),
                }
            }
            Ok(Command::Serve {
                config: config_path(config),
            })
        }
        "doctor" => {
            let mut config = None;
            for flag in Flags::new(rest, &[]) {
                match flag? {
                    ("--config", value) => config = Some(value),
                    (other, _) => return Err(unknown_flag("doctor", other)),
                }
            }
            Ok(Command::Doctor {
                config: config_path(config),
            })
        }
        "init" => {
            let mut options = init::Options::default();
            let mut config = None;
            for flag in Flags::new(rest, &["--plain-http"]) {
                match flag? {
                    ("--config", value) => config = Some(value),
                    ("--plain-http", _) => options.plain_http = true,
                    ("--listen", value) => {
                        options.listen = Some(value.parse::<SocketAddr>().map_err(|_| {
                            UsageError(format!(
                                "--listen \"{value}\" is not an address like 127.0.0.1:3000"
                            ))
                        })?);
                    }
                    ("--data-dir", value) => options.data_dir = Some(value),
                    ("--password-file", value) => options.password_file = Some(value),
                    ("--host", value) => {
                        let (name, url) = split_pair("--host", &value, "<name>=<url>")?;
                        options.hosts.push(init::HostFlag { name, url });
                    }
                    ("--host-password-file", value) => {
                        let pair = split_pair("--host-password-file", &value, "<name>=<path>")?;
                        options.host_password_files.push(pair);
                    }
                    ("--pair", value) => {
                        let (name, url) = split_pair("--pair", &value, "<name>=<url>")?;
                        options.pairs.push(init::HostFlag { name, url });
                    }
                    ("--pair-token-file", value) => {
                        let pair = split_pair("--pair-token-file", &value, "<name>=<path>")?;
                        options.pair_token_files.push(pair);
                    }
                    (other, _) => return Err(unknown_flag("init", other)),
                }
            }
            options.config = config_path(config);
            Ok(Command::Init(options))
        }
        "service" => parse_service(rest, &config_path),
        "upgrade" => {
            let mut options = upgrade::Options::default();
            for flag in Flags::new(rest, &["--force", "--no-restart"]) {
                match flag? {
                    ("--version", value) => options.version = Some(value),
                    ("--from", value) => options.from = Some(value),
                    ("--force", _) => options.force = true,
                    ("--no-restart", _) => options.no_restart = true,
                    (other, _) => return Err(unknown_flag("upgrade", other)),
                }
            }
            Ok(Command::Upgrade(options))
        }
        "openapi" if rest.is_empty() => Ok(Command::Openapi),
        "--version" | "-V" if rest.is_empty() => Ok(Command::Version),
        "--help" | "-h" | "help" => Ok(Command::Help),
        "openapi" | "--version" | "-V" => Err(UsageError(format!("{command} takes no arguments"))),
        other => Err(UsageError(format!("unknown command \"{other}\""))),
    }
}

fn parse_service(
    args: &[String],
    config_path: &dyn Fn(Option<String>) -> String,
) -> Result<Command, UsageError> {
    let Some((action, rest)) = args.split_first() else {
        return Err(UsageError(
            "service needs install, status or uninstall".into(),
        ));
    };
    let action = match action.as_str() {
        "install" => {
            let mut config = None;
            for flag in Flags::new(rest, &[]) {
                match flag? {
                    ("--config", value) => config = Some(value),
                    (other, _) => return Err(unknown_flag("service install", other)),
                }
            }
            service::Action::Install {
                config: config_path(config),
            }
        }
        "status" | "uninstall" if !rest.is_empty() => {
            return Err(UsageError(format!("service {action} takes no arguments")));
        }
        "status" => service::Action::Status,
        "uninstall" => service::Action::Uninstall,
        other => {
            return Err(UsageError(format!(
                "service has no \"{other}\": it takes install, status or uninstall"
            )));
        }
    };
    Ok(Command::Service(action))
}

fn unknown_flag(command: &str, flag: &str) -> UsageError {
    UsageError(format!("{command} has no flag \"{flag}\""))
}

fn split_pair(flag: &str, value: &str, shape: &str) -> Result<(String, String), UsageError> {
    match value.split_once('=') {
        Some((name, rest)) if !name.is_empty() && !rest.is_empty() => {
            Ok((name.to_owned(), rest.to_owned()))
        }
        _ => Err(UsageError(format!(
            "{flag} \"{value}\" must look like {shape}"
        ))),
    }
}

/// `--flag value` and `--flag=value`, one pair at a time; a switch (a flag
/// that takes no value, like `--force`) comes with an empty value.
struct Flags<'a> {
    args: std::slice::Iter<'a, String>,
    switches: &'a [&'a str],
}

impl<'a> Flags<'a> {
    fn new(args: &'a [String], switches: &'a [&'a str]) -> Self {
        Self {
            args: args.iter(),
            switches,
        }
    }
}

impl<'a> Iterator for Flags<'a> {
    type Item = Result<(&'a str, String), UsageError>;

    fn next(&mut self) -> Option<Self::Item> {
        let arg = self.args.next()?;
        if !arg.starts_with("--") {
            return Some(Err(UsageError(format!("unexpected argument \"{arg}\""))));
        }
        if self.switches.contains(&arg.as_str()) {
            return Some(Ok((arg.as_str(), String::new())));
        }
        if let Some((flag, value)) = arg.split_once('=') {
            if self.switches.contains(&flag) {
                return Some(Err(UsageError(format!("{flag} takes no value"))));
            }
            return Some(Ok((flag, value.to_owned())));
        }
        Some(match self.args.next() {
            Some(value) if !value.starts_with("--") => Ok((arg.as_str(), value.clone())),
            _ => Err(UsageError(format!("{arg} needs a value"))),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(String::from).collect()
    }

    fn parsed(text: &str) -> Result<Command, UsageError> {
        parse(&args(text), None)
    }

    #[test]
    fn no_arguments_serve_the_default_config() {
        assert_eq!(
            parsed(""),
            Ok(Command::Serve {
                config: config::DEFAULT_PATH.into()
            })
        );
    }

    #[test]
    fn the_config_flag_beats_the_environment_which_beats_the_default() {
        let from_env = parse(&args("doctor"), Some("/env.toml"));
        assert_eq!(
            from_env,
            Ok(Command::Doctor {
                config: "/env.toml".into()
            })
        );
        let from_flag = parse(&args("serve --config /flag.toml"), Some("/env.toml"));
        assert_eq!(
            from_flag,
            Ok(Command::Serve {
                config: "/flag.toml".into()
            })
        );
    }

    #[test]
    fn a_bare_config_flag_means_serve_and_both_flag_spellings_work() {
        let expected = Ok(Command::Serve {
            config: "/a.toml".into(),
        });
        assert_eq!(parsed("--config /a.toml"), expected);
        assert_eq!(parsed("serve --config=/a.toml"), expected);
    }

    #[test]
    fn init_reads_every_flag_and_keeps_hosts_in_order() {
        let Ok(Command::Init(options)) = parsed(
            "init --config /c.toml --listen 127.0.0.1:3041 --data-dir /d \
             --password-file - --host desk=http://127.0.0.1:4096 \
             --host vm=https://vm.example:4096 --host-password-file desk=/p --plain-http",
        ) else {
            panic!("init did not parse")
        };
        assert_eq!(options.config, "/c.toml");
        assert_eq!(
            options.listen,
            Some(SocketAddr::from(([127, 0, 0, 1], 3041)))
        );
        assert_eq!(options.data_dir.as_deref(), Some("/d"));
        assert!(options.plain_http);
        assert_eq!(options.password_file.as_deref(), Some("-"));
        let names: Vec<&str> = options.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["desk", "vm"]);
        assert_eq!(options.hosts[1].url, "https://vm.example:4096");
        assert_eq!(
            options.host_password_files,
            [("desk".to_owned(), "/p".to_owned())]
        );
    }

    #[test]
    fn refuses_what_it_cannot_read_and_says_which_part() {
        let error = |text: &str| parsed(text).unwrap_err().to_string();
        assert_eq!(error("deploy"), "unknown command \"deploy\"");
        assert_eq!(error("serve --port 3"), "serve has no flag \"--port\"");
        assert_eq!(error("doctor --config"), "--config needs a value");
        assert_eq!(
            error("init --host desk"),
            "--host \"desk\" must look like <name>=<url>"
        );
        assert_eq!(
            error("init --listen 3041"),
            "--listen \"3041\" is not an address like 127.0.0.1:3000"
        );
        assert_eq!(error("serve extra"), "unexpected argument \"extra\"");
        assert_eq!(error("openapi --json"), "openapi takes no arguments");
    }

    #[test]
    fn init_reads_pairs_and_their_token_files() {
        let Ok(Command::Init(options)) = parsed(
            "init --pair mac=http://127.0.0.1:4840 --pair-token-file mac=- --host vm=http://vm:4096",
        ) else {
            panic!("init did not parse")
        };
        assert_eq!(options.pairs[0].name, "mac");
        assert_eq!(options.pairs[0].url, "http://127.0.0.1:4840");
        assert_eq!(
            options.pair_token_files,
            [("mac".to_owned(), "-".to_owned())]
        );
        assert_eq!(options.hosts[0].name, "vm");
        assert_eq!(
            parsed("init --pair mac").unwrap_err().to_string(),
            "--pair \"mac\" must look like <name>=<url>"
        );
    }

    #[test]
    fn service_takes_one_of_three_actions_and_install_takes_a_config() {
        assert_eq!(
            parse(&args("service install"), Some("/env.toml")),
            Ok(Command::Service(service::Action::Install {
                config: "/env.toml".into()
            }))
        );
        assert_eq!(
            parsed("service install --config /c.toml"),
            Ok(Command::Service(service::Action::Install {
                config: "/c.toml".into()
            }))
        );
        assert_eq!(
            parsed("service status"),
            Ok(Command::Service(service::Action::Status))
        );
        assert_eq!(
            parsed("service uninstall"),
            Ok(Command::Service(service::Action::Uninstall))
        );
        let error = |text: &str| parsed(text).unwrap_err().to_string();
        assert_eq!(
            error("service"),
            "service needs install, status or uninstall"
        );
        assert_eq!(
            error("service restart"),
            "service has no \"restart\": it takes install, status or uninstall"
        );
        assert_eq!(
            error("service status --config /c"),
            "service status takes no arguments"
        );
    }

    #[test]
    fn upgrade_reads_its_switches_and_values() {
        assert_eq!(
            parsed("upgrade --from target/dist --force --no-restart"),
            Ok(Command::Upgrade(upgrade::Options {
                from: Some("target/dist".into()),
                force: true,
                no_restart: true,
                ..upgrade::Options::default()
            }))
        );
        assert_eq!(
            parsed("upgrade --version=0.2.0"),
            Ok(Command::Upgrade(upgrade::Options {
                version: Some("0.2.0".into()),
                ..upgrade::Options::default()
            }))
        );
        let error = |text: &str| parsed(text).unwrap_err().to_string();
        assert_eq!(error("upgrade --force=yes"), "--force takes no value");
        assert_eq!(error("upgrade --from"), "--from needs a value");
        assert_eq!(error("upgrade --pre 1"), "upgrade has no flag \"--pre\"");
    }

    #[test]
    fn a_password_never_has_a_flag_of_its_own() {
        // secrets on argv end up in ps and shell history
        assert!(parsed("init --password hunter22").is_err());
    }
}
