//! telemetry: the ingest's normalization, and the task that owns the day
//! files. storage is v1's: `<data dir>/telemetry/YYYY-MM-DD.jsonl`, one
//! event per line, the day in local time, append only, so the carried query
//! tool reads v1's days and v2's side by side.

pub mod dictionary;
pub mod normalize;

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use jiff::tz::TimeZone;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::{debug, info, warn};

pub use normalize::{Dropped, MAX_BATCH, Origin, Row, mint_id};

/// rows wait at most this long before they are written...
const FLUSH_AFTER: Duration = Duration::from_millis(500);
/// ...or until this many are waiting (architecture: memory caps).
const FLUSH_ROWS: usize = 1000;
/// batches queued for the writer. each is at most `MAX_BATCH` rows, so the
/// queue is bounded; when it is full the ingest answers 503 and the client
/// sends the batch again.
const QUEUE: usize = 64;
/// distinct drop reasons logged once each; past this they log at debug.
const WARN_ONCE_CAP: usize = 1024;
/// ids written most recently, so a row that arrives twice is stored once: a
/// page on its way out beacons what its worker had not yet flushed, and the
/// worker, when it survives, flushes the same rows. an id is at most 40
/// characters (normalize), so this holds under 400 KiB.
const RECENT_IDS: usize = 4096;

/// one ingest post, normalized.
#[derive(Debug)]
pub struct Batch {
    pub rows: Vec<Row>,
    pub dropped: Vec<Dropped>,
}

/// the ingest's handle on the writer.
#[derive(Debug, Clone)]
pub struct Sender(mpsc::Sender<Batch>);

#[derive(Debug, thiserror::Error)]
#[error("the telemetry writer is backed up")]
pub struct Full;

impl Sender {
    /// a sender with no writer behind it: every row is dropped.
    #[cfg(test)]
    #[must_use]
    pub fn detached() -> Self {
        let (sender, _) = mpsc::channel(1);
        Self(sender)
    }

    /// hands a batch to the writer without waiting.
    ///
    /// # Errors
    /// the queue is full (or the writer has stopped); the batch was not taken.
    pub fn send(&self, batch: Batch) -> Result<(), Full> {
        self.0.try_send(batch).map_err(|_| Full)
    }
}

impl Sender {
    /// records an event the server itself produced (`push.decided`,
    /// `push.sent`), checked against the dictionary like any producer's.
    /// telemetry never holds up the caller: when the writer is backed up
    /// the row is dropped and logged.
    pub fn record(&self, raw: &serde_json::Value) {
        let received_at = crate::now_ms();
        let origin = Origin {
            device: "server",
            device_class: "server",
            received_at,
            server: true,
        };
        let mut dropped = Vec::new();
        let rows = normalize::normalize(raw, origin, &mut || mint_id(received_at), &mut dropped)
            .into_iter()
            .collect();
        if self.send(Batch { rows, dropped }).is_err() {
            debug!("telemetry writer backed up; a server event was dropped");
        }
    }
}

/// starts the writer. it stops, after writing everything it was given,
/// once every `Sender` is dropped.
///
/// # Errors
/// the telemetry directory cannot be created.
pub fn spawn(dir: PathBuf) -> std::io::Result<(Sender, JoinHandle<()>)> {
    std::fs::create_dir_all(&dir)?;
    let (sender, receiver) = mpsc::channel(QUEUE);
    let writer = Writer {
        dir,
        zone: TimeZone::system(),
        warned: HashSet::new(),
        recent: HashSet::with_capacity(RECENT_IDS),
        recent_order: VecDeque::with_capacity(RECENT_IDS),
    };
    Ok((Sender(sender), tokio::spawn(writer.run(receiver))))
}

struct Writer {
    dir: PathBuf,
    zone: TimeZone,
    warned: HashSet<Dropped>,
    recent: HashSet<Arc<str>>,
    /// the same ids oldest first, so the set forgets in arrival order
    recent_order: VecDeque<Arc<str>>,
}

impl Writer {
    async fn run(mut self, mut receiver: mpsc::Receiver<Batch>) {
        let mut pending: Vec<Row> = Vec::new();
        let mut deadline: Option<Instant> = None;
        loop {
            let batch = tokio::select! {
                batch = receiver.recv() => batch,
                () = sleep_until(deadline) => {
                    self.flush(&mut pending).await;
                    deadline = None;
                    continue;
                }
            };
            let Some(batch) = batch else { break };
            for reason in batch.dropped {
                self.warn_once(reason);
            }
            let mut repeated = 0_usize;
            for row in batch.rows {
                if self.seen_before(&row.id) {
                    repeated += 1;
                } else {
                    pending.push(row);
                }
            }
            if repeated > 0 {
                debug!(repeated, "telemetry rows already stored; not written twice");
            }
            if pending.len() >= FLUSH_ROWS {
                self.flush(&mut pending).await;
                deadline = None;
            } else if deadline.is_none() && !pending.is_empty() {
                deadline = Some(Instant::now() + FLUSH_AFTER);
            }
        }
        self.flush(&mut pending).await;
        info!("telemetry writer stopped");
    }

    /// writes the pending rows, grouped by the local day of each stamp, so
    /// a batch that spans midnight lands in both files.
    async fn flush(&self, pending: &mut Vec<Row>) {
        if pending.is_empty() {
            return;
        }
        let mut days: BTreeMap<String, String> = BTreeMap::new();
        let count = pending.len();
        for row in pending.drain(..) {
            let text = days.entry(self.day_of(row.at)).or_default();
            text.push_str(&row.line);
            text.push('\n');
        }
        let dir = self.dir.clone();
        let written = tokio::task::spawn_blocking(move || append(&dir, &days)).await;
        match written {
            Ok(Ok(())) => debug!(rows = count, "telemetry flushed"),
            Ok(Err(error)) => warn!(rows = count, %error, "telemetry append failed; rows dropped"),
            Err(error) => warn!(rows = count, %error, "telemetry append task failed; rows dropped"),
        }
    }

    fn day_of(&self, at: i64) -> String {
        match jiff::Timestamp::from_millisecond(at) {
            Ok(stamp) => stamp.to_zoned(self.zone.clone()).date().to_string(),
            // normalize bounds stamps to six hours from arrival, so this is
            // only reachable with a broken clock
            Err(_) => "invalid-stamp".into(),
        }
    }

    /// remembers the id and says whether it was already remembered. the
    /// oldest id is forgotten once `RECENT_IDS` are held.
    fn seen_before(&mut self, id: &str) -> bool {
        if self.recent.contains(id) {
            return true;
        }
        if self.recent_order.len() >= RECENT_IDS
            && let Some(oldest) = self.recent_order.pop_front()
        {
            self.recent.remove(&oldest);
        }
        let id: Arc<str> = Arc::from(id);
        self.recent_order.push_back(Arc::clone(&id));
        self.recent.insert(id);
        false
    }

    fn warn_once(&mut self, reason: Dropped) {
        if self.warned.contains(&reason) {
            return;
        }
        if self.warned.len() >= WARN_ONCE_CAP {
            debug!(%reason, "telemetry dropped");
            return;
        }
        warn!(%reason, "telemetry dropped (logged once)");
        self.warned.insert(reason);
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn append(dir: &std::path::Path, days: &BTreeMap<String, String>) -> std::io::Result<()> {
    for (day, text) in days {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options
            .open(dir.join(format!("{day}.jsonl")))?
            .write_all(text.as_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rows_land_in_their_local_day_file_and_nothing_is_lost_on_stop() {
        let dir = std::env::temp_dir().join(format!("boxbox-telemetry-{}", rand::random::<u64>()));
        let (sender, writer) = spawn(dir.clone()).unwrap();
        let noon = jiff::civil::date(2026, 9, 30)
            .at(12, 0, 0, 0)
            .to_zoned(TimeZone::system())
            .unwrap();
        let at = noon.timestamp().as_millisecond();
        let rows = (0..3)
            .map(|n| Row {
                id: format!("row-{n}"),
                at: at + n,
                line: format!("{{\"n\":{n}}}"),
            })
            .collect();
        sender
            .send(Batch {
                rows,
                dropped: vec![],
            })
            .unwrap();
        drop(sender);
        writer.await.unwrap();
        let text = std::fs::read_to_string(dir.join("2026-09-30.jsonl")).unwrap();
        assert_eq!(text, "{\"n\":0}\n{\"n\":1}\n{\"n\":2}\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_row_that_arrives_twice_is_written_once() {
        let dir = std::env::temp_dir().join(format!("boxbox-telemetry-{}", rand::random::<u64>()));
        let (sender, writer) = spawn(dir.clone()).unwrap();
        let at = jiff::civil::date(2026, 9, 30)
            .at(12, 0, 0, 0)
            .to_zoned(TimeZone::system())
            .unwrap()
            .timestamp()
            .as_millisecond();
        let row = |id: &str, n: u8| Row {
            id: id.into(),
            at,
            line: format!("{{\"n\":{n}}}"),
        };
        // the page's beacon, then the worker's flush of the same rows plus a new one
        for rows in [
            vec![row("a", 0), row("b", 1)],
            vec![row("a", 0), row("b", 1), row("c", 2)],
        ] {
            sender
                .send(Batch {
                    rows,
                    dropped: vec![],
                })
                .unwrap();
        }
        drop(sender);
        writer.await.unwrap();
        let text = std::fs::read_to_string(dir.join("2026-09-30.jsonl")).unwrap();
        assert_eq!(text, "{\"n\":0}\n{\"n\":1}\n{\"n\":2}\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_recent_ids_forget_the_oldest_first() {
        let mut writer = Writer {
            dir: PathBuf::new(),
            zone: TimeZone::UTC,
            warned: HashSet::new(),
            recent: HashSet::new(),
            recent_order: VecDeque::new(),
        };
        for n in 0..RECENT_IDS {
            assert!(!writer.seen_before(&n.to_string()));
        }
        assert!(writer.seen_before("0"), "a held id is a repeat");
        assert!(
            !writer.seen_before("fresh"),
            "a new id past the cap is taken"
        );
        assert!(
            !writer.seen_before("0"),
            "and the oldest was forgotten for it"
        );
        assert!(writer.seen_before("2"), "the ones after it are still held");
        assert_eq!(writer.recent.len(), RECENT_IDS);
        assert_eq!(writer.recent_order.len(), RECENT_IDS);
    }
}
