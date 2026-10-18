//! `board.toml`: where the server is, where the password lives, the verb
//! timings, the night curve and the voice. read once at start; a change
//! takes a restart (`launchctl kickstart -k gui/<uid>/dev.boxbox.board`), so
//! no file watcher runs beside an idle daemon.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// the harness seam: a config somewhere else (never set in an install).
pub const CONFIG_ENV: &str = "BOXBOX_BOARD_CONFIG";

/// whispers at 3am, speaks at noon: the global brightness byte by local hour.
pub const NIGHT_CURVE: [u8; 24] = [
    60, 50, 45, 45, 50, 70, 110, 160, 200, 230, 250, 255, 255, 255, 255, 255, 250, 240, 220, 200,
    170, 140, 110, 80,
];

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("no config at {path}: run `boxbox-board install`, then set origin in it")]
    Missing { path: PathBuf },
    #[error("cannot read {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("{path} is not valid: {source}")]
    Parse {
        path: PathBuf,
        source: Box<toml::de::Error>,
    },
    #[error("{path}: {what}")]
    Invalid { path: PathBuf, what: &'static str },
    #[error("HOME is not set")]
    NoHome,
}

/// the file as written. every timing may be absent: the defaults are v1's.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(clippy::struct_field_names)]
struct File {
    origin: String,
    #[serde(default)]
    password_file: Option<String>,
    #[serde(default)]
    state_dir: Option<String>,
    #[serde(default)]
    hold_ms: Option<u64>,
    #[serde(default)]
    double_ms: Option<u64>,
    #[serde(default)]
    reject_arm_ms: Option<u64>,
    #[serde(default)]
    away_ms: Option<u64>,
    #[serde(default)]
    hands_free_silence_ms: Option<u64>,
    #[serde(default)]
    night_curve: Option<Vec<u8>>,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    say_command: Option<String>,
    #[serde(default)]
    mic_meter: Option<bool>,
}

/// the timings the controller reads, apart from the paths and the origin, so
/// tests build one without a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timings {
    /// a press longer than this is a hold.
    pub hold_ms: u64,
    /// a second press inside this after the first release is a double.
    pub double_ms: u64,
    /// how long the pit's reject key stays armed for its second press.
    pub reject_arm_ms: u64,
    /// the board away longer than this earns the briefing when it is back.
    pub away_ms: u64,
    /// hands-free is dead reckoning: this long without voice on the meter
    /// clears it (with no meter, this long after the double tap). 0 never.
    pub hands_free_silence_ms: u64,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            hold_ms: 350,
            double_ms: 300,
            reject_arm_ms: 5_000,
            away_ms: 30 * 60_000,
            hands_free_silence_ms: 45_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    /// the boxbox server, e.g. `https://boxbox.example.ts.net`, no trailing slash.
    pub origin: String,
    pub password_file: PathBuf,
    pub state_dir: PathBuf,
    pub timings: Timings,
    pub night_curve: [u8; 24],
    /// readback's voice, `say -v <voice>`; empty for the system's.
    pub voice: String,
    /// readback's binary, run as `<say_command> [-v voice] <words>`.
    pub say_command: String,
    /// the mic meter while talking; off draws no meter and opens no microphone.
    pub mic_meter: bool,
}

/// `~/.config/boxbox-board`.
///
/// # Errors
/// without HOME.
pub fn config_dir() -> Result<PathBuf, ConfigError> {
    Ok(home()?.join(".config").join("boxbox-board"))
}

/// where the config is read from: the seam, else `~/.config/boxbox-board/board.toml`.
///
/// # Errors
/// without HOME.
pub fn config_path() -> Result<PathBuf, ConfigError> {
    match std::env::var_os(CONFIG_ENV) {
        Some(path) if !path.is_empty() => Ok(PathBuf::from(path)),
        _ => Ok(config_dir()?.join("board.toml")),
    }
}

/// `~/.local/share/boxbox-board`.
///
/// # Errors
/// without HOME.
pub fn default_state_dir() -> Result<PathBuf, ConfigError> {
    Ok(home()?.join(".local").join("share").join("boxbox-board"))
}

fn home() -> Result<PathBuf, ConfigError> {
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() => Ok(PathBuf::from(home)),
        _ => Err(ConfigError::NoHome),
    }
}

fn expand(raw: &str) -> Result<PathBuf, ConfigError> {
    match raw.strip_prefix("~/") {
        Some(rest) => Ok(home()?.join(rest)),
        None => Ok(PathBuf::from(raw)),
    }
}

impl Config {
    /// reads and checks the file at `path`.
    ///
    /// # Errors
    /// a missing, unreadable or invalid file.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ConfigError::Missing {
                    path: path.to_owned(),
                });
            }
            Err(source) => {
                return Err(ConfigError::Read {
                    path: path.to_owned(),
                    source,
                });
            }
        };
        Self::parse(path, &text)
    }

    /// parses `text` as if read from `path`.
    ///
    /// # Errors
    /// invalid toml, an unknown key, or a value out of range.
    pub fn parse(path: &Path, text: &str) -> Result<Self, ConfigError> {
        let file: File = toml::from_str(text).map_err(|source| ConfigError::Parse {
            path: path.to_owned(),
            source: Box::new(source),
        })?;
        let invalid = |what| ConfigError::Invalid {
            path: path.to_owned(),
            what,
        };
        let origin = file.origin.trim().trim_end_matches('/').to_owned();
        if !(origin.starts_with("http://") || origin.starts_with("https://")) {
            return Err(invalid("origin must start with http:// or https://"));
        }
        let night_curve = match file.night_curve {
            None => NIGHT_CURVE,
            Some(values) => {
                <[u8; 24]>::try_from(values).map_err(|_| invalid("night_curve needs 24 values"))?
            }
        };
        let defaults = Timings::default();
        let timings = Timings {
            hold_ms: file.hold_ms.unwrap_or(defaults.hold_ms),
            double_ms: file.double_ms.unwrap_or(defaults.double_ms),
            reject_arm_ms: file.reject_arm_ms.unwrap_or(defaults.reject_arm_ms),
            away_ms: file.away_ms.unwrap_or(defaults.away_ms),
            hands_free_silence_ms: file
                .hands_free_silence_ms
                .unwrap_or(defaults.hands_free_silence_ms),
        };
        if timings.hold_ms == 0 || timings.double_ms == 0 {
            return Err(invalid("hold_ms and double_ms must be above 0"));
        }
        let say_command = file.say_command.unwrap_or_else(|| "say".to_owned());
        if say_command.trim().is_empty() {
            return Err(invalid("say_command must name a binary"));
        }
        Ok(Self {
            origin,
            password_file: match file.password_file {
                Some(raw) => expand(&raw)?,
                None => config_dir()?.join("password"),
            },
            state_dir: match file.state_dir {
                Some(raw) => expand(&raw)?,
                None => default_state_dir()?,
            },
            timings,
            night_curve,
            voice: file.voice.unwrap_or_default(),
            say_command,
            mic_meter: file.mic_meter.unwrap_or(true),
        })
    }
}

/// what `install` writes when there is no config yet (0600, never over one).
pub const TEMPLATE: &str = r#"# the board daemon's config (docs/board.md). a change takes a restart:
#   launchctl kickstart -k gui/$(id -u)/dev.boxbox.board

# the boxbox server this mac's board talks to.
origin = "https://boxbox.example.ts.net"

# the server's password, one line, 0600. write it with `boxbox-board login`.
password_file = "~/.config/boxbox-board/password"

# the verb grammar, in ms.
# hold_ms = 350
# double_ms = 300
# reject_arm_ms = 5000
# the board away this long earns the briefing when it comes back.
# away_ms = 1800000
# hands-free clears after this long without voice; 0 never.
# hands_free_silence_ms = 45000

# brightness by local hour, 0 to 255, 24 values from midnight.
# night_curve = [60, 50, 45, 45, 50, 70, 110, 160, 200, 230, 250, 255, 255, 255, 255, 255, 250, 240, 220, 200, 170, 140, 110, 80]

# readback: the voice (`say -v ?` lists them; empty for the system's).
# voice = ""
# say_command = "say"

# the mic meter while you talk. off opens no microphone.
# mic_meter = true
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_timings_take_the_defaults() -> Result<(), ConfigError> {
        let config = Config::parse(
            Path::new("board.toml"),
            "origin = \"http://127.0.0.1:3014/\"\npassword_file = \"/tmp/pw\"\nstate_dir = \"/tmp/state\"\nsay_command = \"/tmp/say\"\nnight_curve = [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]\nvoice = \"\"\nmic_meter = true\n",
        )?;
        assert_eq!(config.origin, "http://127.0.0.1:3014");
        assert_eq!(config.timings, Timings::default());
        assert_eq!(config.night_curve, [255; 24]);
        assert_eq!(config.say_command, "/tmp/say");
        Ok(())
    }

    #[test]
    fn the_template_parses() {
        assert!(
            Config::parse(Path::new("board.toml"), TEMPLATE).is_ok()
                || std::env::var_os("HOME").is_none()
        );
    }

    #[test]
    fn a_short_curve_is_refused() {
        let bad = Config::parse(
            Path::new("board.toml"),
            "origin = \"http://x\"\npassword_file = \"/p\"\nstate_dir = \"/s\"\nnight_curve = [1, 2]\n",
        );
        assert!(matches!(bad, Err(ConfigError::Invalid { .. })));
    }
}
