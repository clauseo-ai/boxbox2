//! `board.log` in the state dir: one line per event, `<utc time> <level>
//! <event> <fields>`, capped at two files of 1 mib (`board.log` and
//! `board.log.1`). never a thread's title, words or an address at info:
//! fields carry kinds, counts and ids.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// one file's cap; the older half is `board.log.1`.
pub const FILE_CAP: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn word(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug)]
struct Sink {
    path: PathBuf,
    file: Option<File>,
    written: u64,
}

/// cheap to clone; every thread logs through the same file.
#[derive(Clone, Debug)]
pub struct Log {
    sink: Option<Arc<Mutex<Sink>>>,
}

impl Log {
    /// logs to `<dir>/board.log`. a file that cannot be opened leaves a
    /// logger that drops lines: logging never takes the daemon down.
    #[must_use]
    pub fn open(dir: &Path) -> Self {
        let path = dir.join("board.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        let written = file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map_or(0, |m| m.len());
        Self {
            sink: Some(Arc::new(Mutex::new(Sink {
                path,
                file,
                written,
            }))),
        }
    }

    /// drops every line (tests, and the subcommands that print instead).
    #[must_use]
    pub fn null() -> Self {
        Self { sink: None }
    }

    pub fn info(&self, event: &str, fields: &str) {
        self.line(Level::Info, event, fields);
    }

    pub fn warn(&self, event: &str, fields: &str) {
        self.line(Level::Warn, event, fields);
    }

    pub fn error(&self, event: &str, fields: &str) {
        self.line(Level::Error, event, fields);
    }

    pub fn line(&self, level: Level, event: &str, fields: &str) {
        let Some(sink) = &self.sink else { return };
        let mut text = format!("{} {} {event}", stamp(SystemTime::now()), level.word());
        if !fields.is_empty() {
            text.push(' ');
            text.push_str(fields);
        }
        text.push('\n');
        let mut sink = sink.lock().unwrap_or_else(PoisonError::into_inner);
        if sink.written + text.len() as u64 > FILE_CAP {
            sink.rotate();
        }
        let wrote = sink
            .file
            .as_mut()
            .is_some_and(|f| f.write_all(text.as_bytes()).is_ok());
        if wrote {
            sink.written += text.len() as u64;
        }
    }
}

impl Sink {
    fn rotate(&mut self) {
        self.file = None;
        let mut older = self.path.clone().into_os_string();
        older.push(".1");
        let _ = std::fs::rename(&self.path, older);
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .ok();
        self.written = 0;
    }
}

/// `2026-10-18T12:00:00.123Z`, from the civil calendar by hand: the log
/// needs no time zone and no crate.
#[must_use]
pub fn stamp(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    let (y, m, d) = civil(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60,
        since.subsec_millis()
    )
}

/// days since 1970-01-01 to (year, month, day), howard hinnant's algorithm.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let m = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn stamps_read_as_utc() {
        let at = UNIX_EPOCH + Duration::from_millis(1_790_000_000_123);
        assert_eq!(stamp(at), "2026-09-21T14:13:20.123Z");
        assert_eq!(stamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn the_log_rotates_at_its_cap() -> std::io::Result<()> {
        let dir = std::env::temp_dir().join(format!("boxbox-board-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let log = Log::open(&dir);
        let fields = "x".repeat(1000);
        for _ in 0..2100 {
            log.info("test.line", &fields);
        }
        let main = std::fs::metadata(dir.join("board.log"))?.len();
        let older = std::fs::metadata(dir.join("board.log.1"))?.len();
        assert!(main <= FILE_CAP && older <= FILE_CAP);
        assert!(older > FILE_CAP / 2);
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
