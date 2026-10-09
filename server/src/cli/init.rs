//! `boxbox init`: writes a first `boxbox.toml`. every answer comes from a
//! flag or, on a terminal, a question; passwords and pairing tokens come
//! from files, stdin or a prompt that does not echo, never from argv.
//!
//! a host is reached with its password, with the bearer credential a
//! pairing traded for (`--pair`, cmx2-asks a12: init trades the token
//! `cmx2 pair` printed at the daemon's `POST /pair`), or with nothing.
//! every pairing happens after every answer is in and checked, and the file
//! is written only once all of them succeeded. the gate password is minted
//! when none is given, and shown once.
//!
//! the file is written beside its final name with mode 0600, loaded back
//! through the same parser `serve` uses, and only then linked into place,
//! so a config that exists is always one the server accepts. an existing
//! config is never written over.

use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, IsTerminal, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use super::pair::{self, PairError, Pairing};
use crate::config::{self, Config, ConfigError};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    /// where to write, `~` not yet expanded.
    pub config: String,
    pub listen: Option<SocketAddr>,
    pub data_dir: Option<String>,
    /// the gate password's file, or `-` for stdin.
    pub password_file: Option<String>,
    pub hosts: Vec<HostFlag>,
    /// `(host name, file or -)`.
    pub host_password_files: Vec<(String, String)>,
    /// daemons to pair with, each traded a token from `cmx2 pair`.
    pub pairs: Vec<HostFlag>,
    /// `(paired host name, file or -)`: the token alone, or everything
    /// `cmx2 pair` printed.
    pub pair_token_files: Vec<(String, String)>,
    /// boxbox is reached over plain http on this machine, with no https in
    /// front, so its cookie must not be marked `Secure`.
    pub plain_http: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct HostFlag {
    pub name: String,
    pub url: String,
}

#[derive(Debug, thiserror::Error)]
pub enum InitError {
    #[error(
        "{path} already exists and others can read it (mode {mode:o}). it holds passwords: run `chmod 600 {path}`. init never writes over a config; edit it, or move it away to start again"
    )]
    ExistsExposed { path: PathBuf, mode: u32 },
    #[error(
        "{path} already exists. init never writes over a config: edit it, or move it away to start again"
    )]
    Exists { path: PathBuf },
    #[error("{0}")]
    Invalid(String),
    #[error(
        "--pair {0} needs its token: --pair-token-file {0}=<path> (- reads stdin), or run init on a terminal to paste it"
    )]
    NoToken(String),
    #[error("{host}: {source}. nothing was written{orphans}")]
    Pair {
        host: String,
        source: PairError,
        /// the pairings that went through before this one failed.
        orphans: String,
    },
    #[error("{source}{orphans}")]
    AfterPairing {
        source: Box<InitError>,
        orphans: String,
    },
    #[error("cannot start what pairing needs: {0}")]
    Runtime(String),
    #[error("init stopped before it had every answer; nothing was written")]
    Stopped,
    #[error("cannot read {what}: {source}")]
    Input { what: String, source: io::Error },
    #[error("cannot write {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
    #[error("the config init wrote does not load, so it was not kept: {0}")]
    Verify(ConfigError),
    #[error(transparent)]
    Config(#[from] ConfigError),
}

/// what the file will say. secrets stay out of `Debug`: none of these
/// derive it. `S` is how each host signs in: [`Sign`] while answers are
/// gathered, [`Signed`] once every pairing went through.
struct Answers<S> {
    listen: SocketAddr,
    data_dir: String,
    plain_http: bool,
    password: String,
    /// the password was made here, so the person has to be shown it once.
    generated: bool,
    hosts: Vec<HostAnswer<S>>,
}

struct HostAnswer<S> {
    name: String,
    url: String,
    sign: S,
}

/// how a host will sign in, as the person answered.
enum Sign {
    None,
    Password(String),
    /// a one-time token from `cmx2 pair`, not yet traded.
    Token(String),
}

/// how a host signs in, as the file says it.
enum Signed {
    None,
    Password(String),
    Bearer(Pairing),
}

/// where interactive answers come from: the terminal, or a script in tests.
trait Ask {
    /// one line, echoed; `None` at end of input.
    fn line(&mut self, prompt: &str) -> io::Result<Option<String>>;
    /// one line, not echoed.
    fn secret(&mut self, prompt: &str) -> io::Result<String>;
    /// a remark between questions.
    fn say(&mut self, text: &str);
}

pub fn run(options: &Options) -> ExitCode {
    let mut terminal = Terminal;
    let interactive = io::stdin().is_terminal();
    let result = init(
        options,
        interactive.then_some(&mut terminal as &mut dyn Ask),
    );
    let mut out = io::stdout().lock();
    match result {
        Ok(written) => {
            let _ = out.write_all(written.as_bytes());
            ExitCode::SUCCESS
        }
        Err(error) => {
            let _ = writeln!(io::stderr(), "boxbox init: {error}");
            ExitCode::FAILURE
        }
    }
}

/// gathers the answers, pairs, writes the file and returns what to tell
/// the person.
fn init(options: &Options, ask: Option<&mut dyn Ask>) -> Result<String, InitError> {
    let path = config::expand_home(&options.config)?;
    refuse_existing(&path)?;
    let answers = pair_hosts(gather(options, ask)?)?;
    write_config(&path, &render(&answers)).map_err(|source| {
        let orphans = orphans(&answers.hosts);
        if orphans.is_empty() {
            source
        } else {
            InitError::AfterPairing {
                source: Box::new(source),
                orphans,
            }
        }
    })?;
    Ok(summary(&path, &answers))
}

/// trades every token for its credential, in order. one failure stops the
/// rest, and names the pairings that already went through: their daemons
/// now list a client no file keeps.
fn pair_hosts(answers: Answers<Sign>) -> Result<Answers<Signed>, InitError> {
    // made at the first token, so a config without one starts nothing
    let mut pairer: Option<Pairer> = None;
    let mut hosts: Vec<HostAnswer<Signed>> = Vec::with_capacity(answers.hosts.len());
    for host in answers.hosts {
        let sign = match host.sign {
            Sign::None => Signed::None,
            Sign::Password(password) => Signed::Password(password),
            Sign::Token(token) => {
                let current = match pairer.take() {
                    Some(current) => current,
                    None => Pairer::new()?,
                };
                let url = config::http_url(&host.url).map_err(InitError::Invalid)?;
                let traded = current.exchange(&url, &token);
                pairer = Some(current);
                match traded {
                    Ok(pairing) => Signed::Bearer(pairing),
                    Err(source) => {
                        return Err(InitError::Pair {
                            host: host.name,
                            source,
                            orphans: orphans(&hosts),
                        });
                    }
                }
            }
        };
        hosts.push(HostAnswer {
            name: host.name,
            url: host.url,
            sign,
        });
    }
    Ok(Answers {
        listen: answers.listen,
        data_dir: answers.data_dir,
        plain_http: answers.plain_http,
        password: answers.password,
        generated: answers.generated,
        hosts,
    })
}

/// a runtime and a client for the exchanges, which are the only network
/// calls init makes.
struct Pairer {
    runtime: tokio::runtime::Runtime,
    client: reqwest::Client,
}

impl Pairer {
    fn new() -> Result<Self, InitError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| InitError::Runtime(e.to_string()))?;
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .user_agent(concat!("boxbox-init/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| InitError::Runtime(e.to_string()))?;
        Ok(Self { runtime, client })
    }

    fn exchange(&self, url: &reqwest::Url, token: &str) -> Result<Pairing, PairError> {
        self.runtime
            .block_on(pair::exchange(&self.client, url, token))
    }
}

/// what to run on each daemon that paired with a file that was never
/// written, or nothing when none did.
fn orphans(hosts: &[HostAnswer<Signed>]) -> String {
    let paired: Vec<String> = hosts
        .iter()
        .filter_map(|h| match &h.sign {
            Signed::Bearer(pairing) => {
                Some(format!("on {}, cmx2 pair --revoke {}", h.name, pairing.id))
            }
            _ => None,
        })
        .collect();
    if paired.is_empty() {
        String::new()
    } else {
        format!(
            ". these daemons paired already and now list a client no file keeps; remove it with {}",
            paired.join("; ")
        )
    }
}

fn refuse_existing(path: &Path) -> Result<(), InitError> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            let mode = mode_of(&meta);
            if mode & 0o077 != 0 {
                Err(InitError::ExistsExposed {
                    path: path.into(),
                    mode,
                })
            } else {
                Err(InitError::Exists { path: path.into() })
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(InitError::Input {
            what: path.display().to_string(),
            source,
        }),
    }
}

/// flags first, all of them checked and read before a single question, so
/// a mistake in one never costs the answers already typed; then questions
/// for what the flags left out.
fn gather(options: &Options, ask: Option<&mut dyn Ask>) -> Result<Answers<Sign>, InitError> {
    let secrets_on_stdin = options
        .password_file
        .iter()
        .chain(options.host_password_files.iter().map(|(_, file)| file))
        .chain(options.pair_token_files.iter().map(|(_, file)| file))
        .filter(|file| file.as_str() == "-")
        .count();
    if secrets_on_stdin > 1 {
        return Err(InitError::Invalid(
            "only one password or token can come from stdin (-); give the others as files".into(),
        ));
    }
    // stdin carries either a secret or the answers to questions, never both
    let mut ask = if secrets_on_stdin == 0 { ask } else { None };

    check_named_files(options)?;
    let mut hosts = hosts_from_flags(options)?;
    let given_password = match &options.password_file {
        Some(file) => {
            let password = first_line(&read_secret("the gate password", file)?);
            check_password(&password).map_err(InitError::Invalid)?;
            Some(password)
        }
        None => None,
    };
    read_host_files(options, &mut hosts)?;
    // a --pair without its token file: asked for on a terminal, refused without one
    for host in &mut hosts {
        let paired = options.pairs.iter().any(|p| p.name == host.name);
        if paired && matches!(host.sign, Sign::None) {
            let Some(ask) = &mut ask else {
                return Err(InitError::NoToken(host.name.clone()));
            };
            host.sign = Sign::Token(ask_token(&mut **ask, &host.name)?);
        }
    }

    let listen = match (options.listen, &mut ask) {
        (Some(listen), _) => listen,
        (None, Some(ask)) => ask_listen(&mut **ask)?,
        (None, None) => config::DEFAULT_LISTEN,
    };
    let (password, generated) = match (given_password, &mut ask) {
        (Some(password), _) => (password, false),
        (None, Some(ask)) => ask_password(&mut **ask)?,
        // nobody to ask: mint one, shown once in the summary
        (None, None) => (generate_password(), true),
    };
    if options.hosts.is_empty()
        && options.pairs.is_empty()
        && let Some(ask) = ask
    {
        hosts = ask_hosts(ask)?;
    }

    Ok(Answers {
        listen,
        data_dir: options
            .data_dir
            .clone()
            .unwrap_or_else(|| config::DEFAULT_DATA_DIR.into()),
        plain_http: options.plain_http,
        password,
        generated,
        hosts,
    })
}

/// the `--host` and `--pair` hosts, checked, in that order.
fn hosts_from_flags(options: &Options) -> Result<Vec<HostAnswer<Sign>>, InitError> {
    let mut hosts: Vec<HostAnswer<Sign>> =
        Vec::with_capacity(options.hosts.len() + options.pairs.len());
    for (flag, pairing) in options
        .hosts
        .iter()
        .map(|h| (h, false))
        .chain(options.pairs.iter().map(|h| (h, true)))
    {
        check_host_name(&flag.name, &hosts).map_err(InitError::Invalid)?;
        check_url(&flag.url).map_err(|e| {
            let flag_name = if pairing { "--pair" } else { "--host" };
            InitError::Invalid(format!("{flag_name} {}: {e}", flag.name))
        })?;
        hosts.push(HostAnswer {
            name: flag.name.clone(),
            url: flag.url.clone(),
            sign: Sign::None,
        });
    }
    Ok(hosts)
}

/// each host's password or pairing token, from the files the flags name.
fn read_host_files(options: &Options, hosts: &mut [HostAnswer<Sign>]) -> Result<(), InitError> {
    for host in hosts {
        if let Some(file) = last_named(&options.host_password_files, &host.name) {
            let password = first_line(&read_secret(&format!("{}'s password", host.name), file)?);
            if password.is_empty() {
                return Err(InitError::Invalid(format!(
                    "{}'s password is empty on the first line of {}",
                    host.name,
                    shown_file(file)
                )));
            }
            host.sign = Sign::Password(password);
        }
        if let Some(file) = last_named(&options.pair_token_files, &host.name) {
            let text = read_secret(&format!("{}'s pairing token", host.name), file)?;
            let token = pair::token_in(&text).ok_or_else(|| {
                InitError::Invalid(format!(
                    "{}'s pairing token in {} is not one cmx2 pair prints: give the token line, or everything cmx2 pair printed",
                    host.name,
                    shown_file(file)
                ))
            })?;
            host.sign = Sign::Token(token);
        }
    }
    Ok(())
}

/// every `--host-password-file` names a `--host`, and every
/// `--pair-token-file` a `--pair`.
fn check_named_files(options: &Options) -> Result<(), InitError> {
    for (name, _) in &options.host_password_files {
        if options.pairs.iter().any(|p| &p.name == name) {
            return Err(InitError::Invalid(format!(
                "--host-password-file names \"{name}\", a --pair: a paired host signs in with the credential pairing trades for, not a password"
            )));
        }
        if !options.hosts.iter().any(|h| &h.name == name) {
            return Err(InitError::Invalid(format!(
                "--host-password-file names \"{name}\", which no --host gives"
            )));
        }
    }
    for (name, _) in &options.pair_token_files {
        if !options.pairs.iter().any(|p| &p.name == name) {
            return Err(InitError::Invalid(format!(
                "--pair-token-file names \"{name}\", which no --pair gives"
            )));
        }
    }
    Ok(())
}

/// the file given last for `name`, so a repeated flag means the later one.
fn last_named<'a>(files: &'a [(String, String)], name: &str) -> Option<&'a String> {
    files
        .iter()
        .rev()
        .find(|(named, _)| named == name)
        .map(|(_, file)| file)
}

fn ask_listen(ask: &mut dyn Ask) -> Result<SocketAddr, InitError> {
    loop {
        let answer = required(ask.line(&format!(
            "where boxbox listens [{}]: ",
            config::DEFAULT_LISTEN
        )))?;
        if answer.is_empty() {
            return Ok(config::DEFAULT_LISTEN);
        }
        match answer.parse() {
            Ok(listen) => return Ok(listen),
            Err(_) => ask.say(&format!(
                "\"{answer}\" is not an address like 127.0.0.1:3000; try again"
            )),
        }
    }
}

fn ask_password(ask: &mut dyn Ask) -> Result<(String, bool), InitError> {
    ask.say("the gate password opens boxbox on every device. leave it blank and init makes one.");
    loop {
        let first = ask.secret("gate password: ").map_err(prompt_error)?;
        if first.is_empty() {
            return Ok((generate_password(), true));
        }
        if let Err(problem) = check_password(&first) {
            ask.say(&format!("{problem}; try again"));
            continue;
        }
        let again = ask.secret("the same again: ").map_err(prompt_error)?;
        if again == first {
            return Ok((first, false));
        }
        ask.say("the two did not match; try again");
    }
}

fn ask_hosts(ask: &mut dyn Ask) -> Result<Vec<HostAnswer<Sign>>, InitError> {
    ask.say(
        "now the cmx2 daemons to watch. a name is part of every thread's identity, so pick it once.",
    );
    let mut hosts: Vec<HostAnswer<Sign>> = Vec::new();
    loop {
        let prompt = if hosts.is_empty() {
            "a daemon's name, like desk (blank to add none now): "
        } else {
            "another daemon's name (blank when done): "
        };
        let name = required(ask.line(prompt))?;
        if name.is_empty() {
            return Ok(hosts);
        }
        if let Err(problem) = check_host_name(&name, &hosts) {
            ask.say(&format!("{problem}; try again"));
            continue;
        }
        let url = loop {
            let answer = required(ask.line(&format!(
                "{name}'s url, or the url line cmx2 pair printed [http://127.0.0.1:4096]: "
            )))?;
            let url = match pair::url_in(&answer) {
                "" => "http://127.0.0.1:4096".to_owned(),
                url => url.to_owned(),
            };
            match check_url(&url) {
                Ok(()) => break url,
                Err(problem) => ask.say(&format!("{problem}; try again")),
            }
        };
        let sign = ask_sign(ask, &name)?;
        hosts.push(HostAnswer { name, url, sign });
    }
}

/// a cmx2 0.8 daemon pairs (`cmx2 pair` on it prints a token); an older
/// one, or one started with `CMX2_SERVER_PASSWORD`, takes its password.
fn ask_sign(ask: &mut dyn Ask, name: &str) -> Result<Sign, InitError> {
    loop {
        let how = required(ask.line(&format!(
            "how boxbox signs in to {name}: pair (run cmx2 pair there), password, or none [pair]: "
        )))?;
        match how.as_str() {
            "" | "pair" => return Ok(Sign::Token(ask_token(ask, name)?)),
            "password" => {
                let password = ask
                    .secret(&format!("{name}'s password: "))
                    .map_err(prompt_error)?;
                if password.is_empty() {
                    ask.say("a blank password is none; answer none for that. try again");
                    continue;
                }
                return Ok(Sign::Password(password));
            }
            "none" => return Ok(Sign::None),
            other => ask.say(&format!(
                "\"{other}\" is not pair, password or none; try again"
            )),
        }
    }
}

fn ask_token(ask: &mut dyn Ask, name: &str) -> Result<String, InitError> {
    loop {
        let answer = ask
            .secret(&format!(
                "the token line cmx2 pair printed on {name} (not shown): "
            ))
            .map_err(prompt_error)?;
        match pair::token_in(&answer) {
            Some(token) => return Ok(token),
            None => {
                ask.say("that is not a token cmx2 pair prints; paste the token line. try again");
            }
        }
    }
}

fn required(line: io::Result<Option<String>>) -> Result<String, InitError> {
    match line {
        Ok(Some(line)) => Ok(line.trim().to_owned()),
        Ok(None) => Err(InitError::Stopped),
        Err(source) => Err(prompt_error(source)),
    }
}

fn prompt_error(source: io::Error) -> InitError {
    if source.kind() == io::ErrorKind::UnexpectedEof {
        InitError::Stopped
    } else {
        InitError::Input {
            what: "the terminal".into(),
            source,
        }
    }
}

fn check_password(password: &str) -> Result<(), String> {
    if password.len() < config::MIN_PASSWORD_BYTES {
        Err(format!(
            "the gate password must be at least {} characters",
            config::MIN_PASSWORD_BYTES
        ))
    } else {
        Ok(())
    }
}

fn check_host_name<S>(name: &str, taken: &[HostAnswer<S>]) -> Result<(), String> {
    if !config::is_host_name(name) {
        Err(format!(
            "\"{name}\" must be lowercase letters, digits and dashes, 32 at most"
        ))
    } else if taken.iter().any(|h| h.name == name) {
        Err(format!("there is already a host named \"{name}\""))
    } else {
        Ok(())
    }
}

fn check_url(url: &str) -> Result<(), String> {
    config::http_url(url).map(|_| ())
}

/// a secret from a file or stdin, whole: a password is its first line, a
/// pairing token may sit among everything `cmx2 pair` printed.
fn read_secret(what: &str, file: &str) -> Result<String, InitError> {
    let mut text = String::new();
    let read = if file == "-" {
        io::stdin().lock().read_to_string(&mut text)
    } else {
        fs::File::open(file).and_then(|mut f| f.read_to_string(&mut text))
    };
    read.map_err(|source| InitError::Input {
        what: format!("{what} from {}", shown_file(file)),
        source,
    })?;
    if text.trim().is_empty() {
        return Err(InitError::Invalid(format!(
            "{what} is empty in {}",
            shown_file(file)
        )));
    }
    Ok(text)
}

/// a password is the first line of what was read.
fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().to_owned()
}

fn shown_file(file: &str) -> &str {
    if file == "-" { "stdin" } else { file }
}

/// four groups of five from an alphabet without look-alikes (no 0, 1, l,
/// o): 100 bits, and easy to type on a phone.
fn generate_password() -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut password = String::with_capacity(23);
    for i in 0..20 {
        if i > 0 && i % 5 == 0 {
            password.push('-');
        }
        let index = rand::random_range(0..ALPHABET.len());
        password.push(char::from(ALPHABET[index]));
    }
    password
}

/// the file's text. every value is written as a toml basic string.
fn render(answers: &Answers<Signed>) -> String {
    let mut text = String::from(
        "# boxbox.toml, written by `boxbox init`. it holds passwords, so keep it\n\
         # mode 0600: boxbox refuses a config others can read. every setting is\n\
         # explained in boxbox.example.toml.\n\n",
    );
    text.push_str(if answers.plain_http {
        "# loopback, opened from this machine over plain http (docs/deploy.md, the mac)\n"
    } else {
        "# loopback, behind an https front on your private network (docs/deploy.md)\n"
    });
    let _ = writeln!(
        text,
        "listen = {}",
        toml_string(&answers.listen.to_string())
    );
    let _ = writeln!(text, "data_dir = {}", toml_string(&answers.data_dir));
    let _ = writeln!(text, "password = {}", toml_string(&answers.password));
    if answers.plain_http {
        text.push_str(
            "\n# reached over plain http on this machine (boxbox init --plain-http), where\n\
             # not every browser keeps a Secure cookie. behind https, make this true.\n\
             [cookie]\nsecure = false\n",
        );
    }
    text.push_str(
        "\n# one [[host]] per cmx2 daemon. the server picks up a change here without\n\
         # a restart.\n",
    );
    if answers.hosts.is_empty() {
        text.push_str(
            "# [[host]]\n# name = \"desk\"\n# url = \"http://127.0.0.1:4096\"\n# password = \"the daemon's password\"\n",
        );
    }
    for host in &answers.hosts {
        text.push_str("\n[[host]]\n");
        let _ = writeln!(text, "name = {}", toml_string(&host.name));
        let _ = writeln!(text, "url = {}", toml_string(&host.url));
        match &host.sign {
            Signed::None => {}
            Signed::Password(password) => {
                let _ = writeln!(text, "password = {}", toml_string(password));
            }
            Signed::Bearer(pairing) => {
                let _ = writeln!(
                    text,
                    "# paired by boxbox init; on the daemon, cmx2 pair --revoke {} cuts it off",
                    pairing.id
                );
                let _ = writeln!(
                    text,
                    "bearer = {}",
                    toml_string(pairing.credential.expose())
                );
            }
        }
    }
    text
}

/// a toml basic string: quotes, backslashes and control characters escaped.
fn toml_string(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for c in value.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            c if c.is_control() => {
                let _ = write!(quoted, "\\u{:04X}", u32::from(c));
            }
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// writes beside the final name (0600), proves the server would load it,
/// then links it into place. a link fails when the name exists, so a
/// config that appeared meanwhile is still never written over.
fn write_config(path: &Path, text: &str) -> Result<(), InitError> {
    let write_error = |source| InitError::Write {
        path: path.into(),
        source,
    };
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    create_private_dir(parent).map_err(write_error)?;
    let name = path.file_name().map_or_else(
        || "boxbox.toml".into(),
        |n| n.to_string_lossy().into_owned(),
    );
    let staged = Staged(parent.join(format!(".{name}.init-{}", std::process::id())));

    let mut file = create_private_file(&staged.0).map_err(write_error)?;
    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(write_error)?;
    drop(file);
    Config::load(&staged.0.display().to_string()).map_err(InitError::Verify)?;

    match fs::hard_link(&staged.0, path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            return Err(InitError::Exists { path: path.into() });
        }
        Err(source) => return Err(write_error(source)),
    }
    // the link is durable once its directory is
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// the staged file, removed however `write_config` ends.
struct Staged(PathBuf);

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn create_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

fn create_private_file(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options.open(path)?;
    // the umask may have taken bits away; 0600 exactly is the promise
    #[cfg(unix)]
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(file)
}

#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> u32 {
    std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o777
}

#[cfg(not(unix))]
fn mode_of(_: &fs::Metadata) -> u32 {
    0o600
}

fn summary(path: &Path, answers: &Answers<Signed>) -> String {
    let mut text = format!("wrote {} (mode 600)\n", path.display());
    let _ = writeln!(text, "  listen    {}", answers.listen);
    let _ = writeln!(text, "  data dir  {}", answers.data_dir);
    if answers.plain_http {
        text.push_str("  cookie    not marked secure, for plain http on this machine\n");
    }
    if answers.hosts.is_empty() {
        text.push_str("  hosts     none yet: add a [[host]] for each cmx2 daemon\n");
    }
    for (i, host) in answers.hosts.iter().enumerate() {
        let label = if i == 0 { "hosts" } else { "" };
        let credential = match &host.sign {
            Signed::None => "no credential".to_owned(),
            Signed::Password(_) => "with a password".to_owned(),
            Signed::Bearer(pairing) => {
                let contract = if pairing.contract == crate::cmx2::CONTRACT_VERSION {
                    String::new()
                } else {
                    format!(
                        ", contract {} where this boxbox speaks {}, so frames may not decode",
                        pairing.contract,
                        crate::cmx2::CONTRACT_VERSION
                    )
                };
                format!(
                    "paired ({}), cmx2 {}{contract}",
                    pairing.id, pairing.version
                )
            }
        };
        let _ = writeln!(
            text,
            "  {label:<8}  {} {}, {credential}",
            host.name, host.url
        );
    }
    if answers.generated {
        let _ = write!(
            text,
            "\nthe gate password is {}\nit is shown this once. keep it somewhere safe; it also lives in the file above.\n",
            answers.password
        );
    }
    text.push_str(
        "\nnext\n  boxbox doctor            checks the config, reaches each daemon, looks at the data dir\n  boxbox service install   runs the server in the background and keeps it running\n  boxbox serve             runs it here, in the foreground\n",
    );
    text
}

/// stdin is locked per read, never held: `--password-file -` reads it too,
/// and its lock is not reentrant.
struct Terminal;

impl Ask for Terminal {
    fn line(&mut self, prompt: &str) -> io::Result<Option<String>> {
        let mut err = io::stderr().lock();
        err.write_all(prompt.as_bytes())?;
        err.flush()?;
        let mut line = String::new();
        if io::stdin().lock().read_line(&mut line)? == 0 {
            return Ok(None);
        }
        Ok(Some(line.trim_end_matches(['\n', '\r']).to_owned()))
    }

    fn secret(&mut self, prompt: &str) -> io::Result<String> {
        rpassword::prompt_password(prompt)
    }

    fn say(&mut self, text: &str) {
        let _ = writeln!(io::stderr(), "{text}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// a person at the terminal, answering from a script.
    struct Script {
        answers: VecDeque<&'static str>,
        said: Vec<String>,
    }

    impl Script {
        fn new(answers: &[&'static str]) -> Self {
            Self {
                answers: answers.iter().copied().collect(),
                said: Vec::new(),
            }
        }
    }

    impl Ask for Script {
        fn line(&mut self, _: &str) -> io::Result<Option<String>> {
            Ok(self.answers.pop_front().map(String::from))
        }
        fn secret(&mut self, _: &str) -> io::Result<String> {
            self.answers
                .pop_front()
                .map(String::from)
                .ok_or_else(|| io::ErrorKind::UnexpectedEof.into())
        }
        fn say(&mut self, text: &str) {
            self.said.push(text.to_owned());
        }
    }

    /// a directory of its own under the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "boxbox-init-{name}-{}-{}",
                std::process::id(),
                rand::random::<u32>()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn config(&self) -> String {
            self.0.join("boxbox/boxbox.toml").display().to_string()
        }
        fn file(&self, name: &str, text: &str) -> String {
            let path = self.0.join(name);
            fs::write(&path, text).unwrap();
            path.display().to_string()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mode(path: &str) -> u32 {
        mode_of(&fs::metadata(path).unwrap())
    }

    #[test]
    fn from_flags_it_writes_a_private_file_the_server_loads() {
        let dir = TempDir::new("flags");
        let options = Options {
            config: dir.config(),
            listen: Some(SocketAddr::from(([127, 0, 0, 1], 3041))),
            password_file: Some(dir.file("gate", "a long gate password\n")),
            hosts: vec![HostFlag {
                name: "desk".into(),
                url: "http://127.0.0.1:4900".into(),
            }],
            host_password_files: vec![("desk".into(), dir.file("desk", "daemon secret"))],
            ..Options::default()
        };
        let said = init(&options, None).unwrap();
        assert!(said.starts_with("wrote "), "{said}");
        assert!(
            !said.contains("a long gate password"),
            "the summary never echoes a given password"
        );
        assert_eq!(mode(&dir.config()), 0o600);
        let config = Config::load(&dir.config()).unwrap();
        assert_eq!(config.listen.port(), 3041);
        assert_eq!(config.password.expose(), "a long gate password");
        let Some(crate::config::Credential::Basic { password, .. }) = &config.hosts[0].credential
        else {
            panic!("the host has no password");
        };
        assert_eq!(password.expose(), "daemon secret");
        assert!(
            fs::read_dir(dir.0.join("boxbox")).unwrap().count() == 1,
            "the staged file is gone"
        );
    }

    #[test]
    fn plain_http_writes_a_cookie_that_is_not_marked_secure() {
        let dir = TempDir::new("plain");
        let options = Options {
            config: dir.config(),
            password_file: Some(dir.file("gate", "a long gate password")),
            plain_http: true,
            ..Options::default()
        };
        let said = init(&options, None).unwrap();
        assert!(said.contains("cookie    not marked secure"), "{said}");
        assert!(!Config::load(&dir.config()).unwrap().cookie.secure);
    }

    #[test]
    fn it_never_writes_over_a_config_and_names_an_exposed_one() {
        let dir = TempDir::new("exists");
        let options = Options {
            config: dir.config(),
            password_file: Some(dir.file("gate", "a long gate password")),
            ..Options::default()
        };
        init(&options, None).unwrap();
        let before = fs::read_to_string(dir.config()).unwrap();
        assert!(matches!(
            init(&options, None),
            Err(InitError::Exists { .. })
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.config(), fs::Permissions::from_mode(0o644)).unwrap();
            let error = init(&options, None).unwrap_err();
            assert!(matches!(
                error,
                InitError::ExistsExposed { mode: 0o644, .. }
            ));
            assert!(error.to_string().contains("chmod 600"), "{error}");
        }
        assert_eq!(fs::read_to_string(dir.config()).unwrap(), before);
    }

    #[test]
    fn without_a_terminal_or_a_password_file_the_gate_password_is_minted_and_shown_once() {
        let dir = TempDir::new("mint");
        let options = Options {
            config: dir.config(),
            ..Options::default()
        };
        let said = init(&options, None).unwrap();
        let config = Config::load(&dir.config()).unwrap();
        let password = config.password.expose();
        assert_eq!(password.len(), 23);
        assert!(
            said.contains(&format!(
                "the gate password is {password}\nit is shown this once"
            )),
            "{said}"
        );
        assert_eq!(said.matches(password).count(), 1, "shown once");
    }

    #[test]
    fn flags_that_do_not_add_up_are_refused_before_anything_is_written() {
        let dir = TempDir::new("refuse");
        let gate = dir.file("gate", "a long gate password");
        let host = |name: &str, url: &str| HostFlag {
            name: name.into(),
            url: url.into(),
        };
        let cases = [
            (vec![host("Desk", "http://a")], vec![], "lowercase"),
            (
                vec![host("a", "http://a"), host("a", "http://b")],
                vec![],
                "already a host",
            ),
            (vec![host("a", "ftp://a")], vec![], "http or https"),
            (
                vec![],
                vec![("ghost".to_owned(), gate.clone())],
                "no --host gives",
            ),
        ];
        for (hosts, host_password_files, expected) in cases {
            let options = Options {
                config: dir.config(),
                password_file: Some(gate.clone()),
                hosts,
                host_password_files,
                ..Options::default()
            };
            let error = init(&options, None).unwrap_err().to_string();
            assert!(error.contains(expected), "{error}");
        }
        let short = Options {
            config: dir.config(),
            password_file: Some(dir.file("short", "short")),
            ..Options::default()
        };
        assert!(
            init(&short, None)
                .unwrap_err()
                .to_string()
                .contains("at least 8")
        );
        assert!(!Path::new(&dir.config()).exists());
    }

    #[test]
    fn interactively_it_asks_again_until_each_answer_is_usable() {
        let dir = TempDir::new("ask");
        let mut script = Script::new(&[
            "3041",                           // listen: not an address
            "127.0.0.1:3041",                 // listen
            "short",                          // password: too short
            "a long gate password",           // password
            "a long gate pasword",            // again: a typo
            "a long gate password",           // password
            "a long gate password",           // again
            "Desk",                           // host name: not lowercase
            "desk",                           // host name
            "",                               // url: the default
            "nothing",                        // how it signs in: not an answer
            "none",                           // how it signs in
            "vm",                             // another host
            "url    https://vm.example:4096", // the url line cmx2 pair prints
            "password",
            "vm secret",
            "", // done
        ]);
        let options = Options {
            config: dir.config(),
            ..Options::default()
        };
        init(&options, Some(&mut script)).unwrap();
        assert!(
            script.answers.is_empty(),
            "every scripted answer was asked for"
        );
        assert_eq!(
            script
                .said
                .iter()
                .filter(|s| s.ends_with("try again"))
                .count(),
            5
        );
        let config = Config::load(&dir.config()).unwrap();
        assert_eq!(config.listen.port(), 3041);
        assert_eq!(config.hosts[0].url.as_str(), "http://127.0.0.1:4096/");
        assert!(config.hosts[0].credential.is_none());
        let Some(crate::config::Credential::Basic { password, .. }) = &config.hosts[1].credential
        else {
            panic!("the vm has no password");
        };
        assert_eq!(password.expose(), "vm secret");
    }

    #[test]
    fn a_bad_flag_is_refused_before_any_question_is_asked() {
        let dir = TempDir::new("flag-first");
        let mut script = Script::new(&["127.0.0.1:3041", "a long gate password"]);
        let options = Options {
            config: dir.config(),
            hosts: vec![HostFlag {
                name: "Desk".into(),
                url: "http://a".into(),
            }],
            ..Options::default()
        };
        assert!(matches!(
            init(&options, Some(&mut script)),
            Err(InitError::Invalid(_))
        ));
        assert_eq!(script.answers.len(), 2, "nothing was asked");
    }

    #[test]
    fn only_one_secret_can_come_from_stdin() {
        let dir = TempDir::new("stdin-twice");
        let options = Options {
            config: dir.config(),
            password_file: Some("-".into()),
            hosts: vec![HostFlag {
                name: "desk".into(),
                url: "http://a".into(),
            }],
            host_password_files: vec![("desk".into(), "-".into())],
            ..Options::default()
        };
        let error = init(&options, None).unwrap_err().to_string();
        assert!(
            error.contains("only one password or token can come from stdin"),
            "{error}"
        );
        let token_too = Options {
            config: dir.config(),
            password_file: Some("-".into()),
            pairs: vec![HostFlag {
                name: "desk".into(),
                url: "http://a".into(),
            }],
            pair_token_files: vec![("desk".into(), "-".into())],
            ..Options::default()
        };
        assert!(matches!(init(&token_too, None), Err(InitError::Invalid(_))));
    }

    fn pair_flag(name: &str, url: &str) -> HostFlag {
        HostFlag {
            name: name.into(),
            url: url.into(),
        }
    }

    #[test]
    fn pairing_flags_that_do_not_add_up_are_refused_before_any_daemon_is_called() {
        let dir = TempDir::new("pair-refuse");
        let gate = dir.file("gate", "a long gate password");
        let token = dir.file("token", "cmx2p_abc\n");
        let base = || Options {
            config: dir.config(),
            password_file: Some(gate.clone()),
            ..Options::default()
        };
        let error = |options: Options| init(&options, None).unwrap_err().to_string();

        let no_token = Options {
            pairs: vec![pair_flag("desk", "http://127.0.0.1:9")],
            ..base()
        };
        assert_eq!(
            error(no_token),
            "--pair desk needs its token: --pair-token-file desk=<path> (- reads stdin), or run init on a terminal to paste it"
        );
        let stray_token = Options {
            pair_token_files: vec![("desk".into(), token.clone())],
            ..base()
        };
        assert!(error(stray_token).contains("which no --pair gives"));
        let password_for_a_pair = Options {
            pairs: vec![pair_flag("desk", "http://127.0.0.1:9")],
            pair_token_files: vec![("desk".into(), token.clone())],
            host_password_files: vec![("desk".into(), gate.clone())],
            ..base()
        };
        assert!(error(password_for_a_pair).contains("a paired host signs in with the credential"));
        let twice = Options {
            hosts: vec![pair_flag("desk", "http://a")],
            pairs: vec![pair_flag("desk", "http://b")],
            pair_token_files: vec![("desk".into(), token.clone())],
            ..base()
        };
        assert!(error(twice).contains("already a host named \"desk\""));
        let not_a_token = Options {
            pairs: vec![pair_flag("desk", "http://127.0.0.1:9")],
            pair_token_files: vec![("desk".into(), dir.file("words", "two words\n"))],
            ..base()
        };
        assert!(error(not_a_token).contains("is not one cmx2 pair prints"));
        assert!(!Path::new(&dir.config()).exists());
    }

    #[test]
    fn a_daemon_that_cannot_be_reached_writes_nothing_and_says_which() {
        let dir = TempDir::new("pair-unreachable");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let options = Options {
            config: dir.config(),
            password_file: Some(dir.file("gate", "a long gate password")),
            pairs: vec![pair_flag("desk", &format!("http://127.0.0.1:{port}"))],
            pair_token_files: vec![("desk".into(), dir.file("token", "token  cmx2p_abc\n"))],
            ..Options::default()
        };
        let error = init(&options, None).unwrap_err();
        let text = error.to_string();
        assert!(matches!(error, InitError::Pair { .. }));
        assert!(
            text.starts_with(&format!("desk: http://127.0.0.1:{port} did not answer")),
            "{text}"
        );
        assert!(text.ends_with("nothing was written"), "{text}");
        assert!(!text.contains("cmx2p_abc"), "the token is never shown");
        assert!(!Path::new(&dir.config()).exists());
    }

    fn pairing(id: &str) -> Pairing {
        Pairing {
            id: id.into(),
            credential: crate::config::Secret::new("cmx2_secret-credential".into()),
            version: "0.8.3".into(),
            contract: crate::cmx2::CONTRACT_VERSION,
        }
    }

    #[test]
    fn a_paired_host_is_written_with_its_bearer_and_summarised_without_it() {
        let dir = TempDir::new("bearer");
        let answers = Answers {
            listen: config::DEFAULT_LISTEN,
            data_dir: config::DEFAULT_DATA_DIR.into(),
            plain_http: false,
            password: "a long gate password".into(),
            generated: false,
            hosts: vec![HostAnswer {
                name: "desk".into(),
                url: "http://127.0.0.1:4096".into(),
                sign: Signed::Bearer(pairing("cred_1")),
            }],
        };
        let path = PathBuf::from(dir.config());
        write_config(&path, &render(&answers)).unwrap();
        let config = Config::load(&dir.config()).unwrap();
        assert_eq!(
            config.hosts[0].credential,
            Some(crate::config::Credential::Bearer(
                crate::config::Secret::new("cmx2_secret-credential".into())
            ))
        );
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("cmx2 pair --revoke cred_1"), "{text}");
        let said = summary(&path, &answers);
        assert!(
            said.contains("desk http://127.0.0.1:4096, paired (cred_1), cmx2 0.8.3"),
            "{said}"
        );
        assert!(
            !said.contains("cmx2_secret"),
            "the credential is never shown"
        );
    }

    #[test]
    fn pairings_that_went_through_before_a_failure_are_named_with_how_to_revoke_them() {
        let host = |name: &str, sign: Signed| HostAnswer {
            name: name.into(),
            url: "http://a".into(),
            sign,
        };
        assert_eq!(orphans(&[host("vm", Signed::None)]), "");
        let note = orphans(&[
            host("desk", Signed::Bearer(pairing("cred_1"))),
            host("vm", Signed::Password("x".into())),
            host("lab", Signed::Bearer(pairing("cred_2"))),
        ]);
        assert_eq!(
            note,
            ". these daemons paired already and now list a client no file keeps; remove it with on desk, cmx2 pair --revoke cred_1; on lab, cmx2 pair --revoke cred_2"
        );
    }

    #[test]
    fn interactively_a_daemon_is_paired_with_the_token_line_pasted() {
        let dir = TempDir::new("ask-pair");
        let mut script = Script::new(&[
            "127.0.0.1:3041",
            "a long gate password",
            "a long gate password",
            "desk",
            "",
            "", // pair, the default
            "not a token at all",
        ]);
        let options = Options {
            config: dir.config(),
            ..Options::default()
        };
        // the script runs out at the token prompt: asked twice, then stopped
        assert!(matches!(
            init(&options, Some(&mut script)),
            Err(InitError::Stopped)
        ));
        assert!(
            script
                .said
                .iter()
                .any(|s| s.starts_with("that is not a token")),
            "{:?}",
            script.said
        );
        assert!(!Path::new(&dir.config()).exists());
    }

    /// pairs for real with the pinned daemon `ops/test/daemon.ts --port
    /// 4980` runs: a token minted by that daemon's own cli, traded by init,
    /// written, loaded, and the daemon's health read back with the bearer.
    /// it then shows a spent token refused in the daemon's words.
    #[test]
    #[ignore = "needs the pinned daemon: bun ops/test/daemon.ts --port 4980, then BOXBOX_TEST_DAEMON=/tmp/boxbox-ops-bench-4980"]
    fn pairs_with_a_real_pinned_daemon() {
        let bench = PathBuf::from(
            std::env::var("BOXBOX_TEST_DAEMON").expect("BOXBOX_TEST_DAEMON names the bench dir"),
        );
        let daemon: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(bench.join("daemon.json")).unwrap()).unwrap();
        let field = |name: &str| daemon[name].as_str().unwrap().to_owned();
        let minted = std::process::Command::new("bun")
            .args([field("cli").as_str(), "pair", "--name", "boxbox-init-test"])
            .args(["--port", &field("port")])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap())
            .env("HOME", field("home"))
            .env("CMX2_CONFIG_DIR", field("configDir"))
            .env("CMX2_DATA_DIR", field("dataDir"))
            .output()
            .unwrap();
        assert!(minted.status.success(), "{minted:?}");
        let printed = String::from_utf8(minted.stdout).unwrap();

        let dir = TempDir::new("real-pair");
        let token_file = dir.file("printed", &printed);
        let options = Options {
            config: dir.config(),
            password_file: Some(dir.file("gate", "a long gate password")),
            pairs: vec![pair_flag("bench", &field("url"))],
            pair_token_files: vec![("bench".into(), token_file.clone())],
            ..Options::default()
        };
        let said = init(&options, None).unwrap();
        println!("{said}");
        assert!(said.contains(", paired (cred_"), "{said}");
        let config = Config::load(&dir.config()).unwrap();
        let host = &config.hosts[0];
        assert!(matches!(
            host.credential,
            Some(crate::config::Credential::Bearer(_))
        ));

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = reqwest::Client::new();
        let health = runtime
            .block_on(async {
                crate::upstream::get(&client, host, "/global/health")
                    .send()
                    .await?
                    .error_for_status()?
                    .bytes()
                    .await
            })
            .unwrap();
        let health: serde_json::Value = serde_json::from_slice(&health).unwrap();
        println!("GET /global/health with the bearer -> {health}");
        assert_eq!(health["healthy"], serde_json::Value::Bool(true));

        // the token is spent: a second init with it is refused in the daemon's words
        let again = Options {
            config: dir.0.join("again/boxbox.toml").display().to_string(),
            ..options
        };
        let refused = init(&again, None).unwrap_err().to_string();
        println!("{refused}");
        assert!(
            refused.starts_with("bench: the daemon refused the token: that pairing token is not one this daemon issued, or it was already used"),
            "{refused}"
        );
        assert!(!Path::new(&again.config).exists());
    }

    #[test]
    fn a_blank_password_is_generated_and_shown_once() {
        let dir = TempDir::new("generate");
        let mut script = Script::new(&["", "", ""]);
        let options = Options {
            config: dir.config(),
            ..Options::default()
        };
        let said = init(&options, Some(&mut script)).unwrap();
        let config = Config::load(&dir.config()).unwrap();
        let password = config.password.expose();
        assert_eq!(password.len(), 23);
        assert!(said.contains(password));
        assert!(said.contains("hosts     none yet"));
    }

    #[test]
    fn end_of_input_stops_without_writing() {
        let dir = TempDir::new("eof");
        let mut script = Script::new(&["127.0.0.1:3041"]);
        let options = Options {
            config: dir.config(),
            ..Options::default()
        };
        assert!(matches!(
            init(&options, Some(&mut script)),
            Err(InitError::Stopped)
        ));
        assert!(!Path::new(&dir.config()).exists());
    }

    #[test]
    fn any_password_survives_the_round_trip_through_toml() {
        let tricky = "quote \" backslash \\ tab \t bell \u{7} unicode é end";
        let parsed: toml::Table = toml::from_str(&format!("p = {}", toml_string(tricky))).unwrap();
        assert_eq!(parsed["p"].as_str(), Some(tricky));
    }

    #[test]
    fn generated_passwords_are_grouped_and_unambiguous() {
        let password = generate_password();
        let groups: Vec<&str> = password.split('-').collect();
        assert_eq!(groups.len(), 4);
        assert!(groups.iter().all(|g| g.len() == 5));
        assert!(!password.contains(['0', '1', 'l', 'o']));
        assert_ne!(password, generate_password());
    }
}
