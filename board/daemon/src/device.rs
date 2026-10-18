//! the keypad's transport: macos's hid notifications find it, and one thread
//! reads its reports. with no board one thread waits on the notification and
//! nothing else runs. the harness seam (`BOXBOX_BOARD_HID=unix:<path>`)
//! swaps the hid device for a unix socket carrying the same 32-byte reports
//! each way, and the socket's connect and close for the notification.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_hid::{AsyncHidRead, AsyncHidWrite, DeviceEvent, DeviceId, DeviceWriter, HidBackend};
use futures_lite::{StreamExt, future::block_on};

use crate::daemon::Msg;
use crate::log::Log;
use crate::protocol::{REPORT_LEN, Report};

pub const HID_ENV: &str = "BOXBOX_BOARD_HID";
pub const VENDOR_ID: u16 = 0x3a54;
pub const PRODUCT_ID: u16 = 0x4f5d;
pub const USAGE_PAGE: u16 = 0xff60;

/// in the socket seam only: how often the harness's socket is looked for.
const SEAM_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("hid write failed: {0}")]
    Hid(String),
    #[error("socket write failed: {0}")]
    Socket(#[from] std::io::Error),
}

/// the host's half of the keypad: what the main loop writes through.
pub enum Link {
    Hid {
        writer: DeviceWriter,
        generation: u64,
        hid: Arc<Hid>,
    },
    Socket(UnixStream),
}

impl std::fmt::Debug for Link {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Hid { .. } => "Link::Hid",
            Self::Socket(_) => "Link::Socket",
        })
    }
}

impl Link {
    /// one report. hid takes the report id byte (0) first; the socket
    /// carries the 32 protocol bytes alone.
    ///
    /// # Errors
    /// the device or the socket refused it: the board is going away.
    pub fn write(&mut self, report: &Report) -> Result<(), WireError> {
        match self {
            Self::Hid { writer, .. } => block_on(writer.write_output_report(report))
                .map_err(|e| WireError::Hid(e.to_string())),
            Self::Socket(stream) => Ok(stream.write_all(&report[1..])?),
        }
    }

    /// the main loop gave up on this link (a write failed): the watcher
    /// drops the keypad and, if it is still plugged in, opens it again after
    /// a back-off. a socket's close is its own unplug.
    pub fn failed(&self) {
        if let Self::Hid {
            generation, hid, ..
        } = self
        {
            hid.lost(*generation);
        }
    }
}

/// where the board comes from.
#[derive(Clone, Debug)]
pub enum Source {
    Hid,
    Socket(PathBuf),
}

impl Source {
    /// the seam when set, else the keypad.
    #[must_use]
    pub fn from_env() -> Self {
        match std::env::var(HID_ENV) {
            Ok(v) => match v.strip_prefix("unix:") {
                Some(path) if !path.is_empty() => Self::Socket(PathBuf::from(path)),
                _ => Self::Hid,
            },
            Err(_) => Self::Hid,
        }
    }
}

/// starts the watcher thread. it sends [`Msg::Plugged`] with the link and a
/// generation, every report as [`Msg::Report`], and [`Msg::Unplugged`].
///
/// # Errors
/// the thread could not start.
pub fn watch(source: Source, tx: SyncSender<Msg>, log: Log) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("board-watch".into())
        .spawn(move || match source {
            Source::Hid => watch_hid(&tx, &log),
            Source::Socket(path) => watch_socket(&path, &tx, &log),
        })
        .map(|_| ())
}

fn watch_socket(path: &std::path::Path, tx: &SyncSender<Msg>, log: &Log) {
    let mut generation = 0u64;
    loop {
        let stream = loop {
            match UnixStream::connect(path) {
                Ok(s) => break s,
                Err(_) => std::thread::sleep(SEAM_POLL),
            }
        };
        let Ok(writer) = stream.try_clone() else {
            log.warn("board.socket_clone_failed", "");
            std::thread::sleep(SEAM_POLL);
            continue;
        };
        generation += 1;
        if tx
            .send(Msg::Plugged {
                generation,
                link: Link::Socket(writer),
            })
            .is_err()
        {
            return;
        }
        let mut reader = stream;
        let mut buf = [0u8; REPORT_LEN];
        while reader.read_exact(&mut buf).is_ok() {
            if tx
                .send(Msg::Report {
                    generation,
                    report: buf,
                })
                .is_err()
            {
                return;
            }
        }
        if tx.send(Msg::Unplugged { generation }).is_err() {
            return;
        }
    }
}

/// a lost keypad that is still plugged in is looked for again after this,
/// doubling to [`RETRY_CAP_MS`] while it keeps failing (the hello's rule).
pub const RETRY_FIRST_MS: u64 = 2_000;
pub const RETRY_CAP_MS: u64 = 64_000;

/// the hid side, shared by the watcher, the reader and a retry.
pub struct Hid {
    backend: HidBackend,
    state: Mutex<HidState>,
    tx: SyncSender<Msg>,
    log: Log,
}

impl std::fmt::Debug for Hid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Hid")
    }
}

#[derive(Debug)]
struct HidState {
    /// the open keypad and its generation.
    current: Option<(DeviceId, u64)>,
    generation: u64,
    retry_ms: u64,
    retrying: bool,
}

impl Hid {
    fn state(&self) -> std::sync::MutexGuard<'_, HidState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_current(&self, generation: u64) -> bool {
        self.state()
            .current
            .as_ref()
            .is_some_and(|(_, g)| *g == generation)
    }

    /// a keypad appeared (or is there at start): open it unless one is open.
    fn plug(self: &Arc<Self>, id: &DeviceId) -> bool {
        let generation = {
            let mut s = self.state();
            if s.current.is_some() {
                return false;
            }
            s.generation += 1;
            s.current = Some((id.clone(), s.generation));
            s.generation
        };
        if open(self, id, generation) {
            true
        } else {
            self.state().current = None;
            false
        }
    }

    /// the keypad went away: forget it, and send the unplug if it was open.
    fn unplugged(&self, id: &DeviceId) -> bool {
        let lost = {
            let mut s = self.state();
            match &s.current {
                Some((current, g)) if current == id => {
                    let g = *g;
                    s.current = None;
                    Some(g)
                }
                _ => None,
            }
        };
        match lost {
            Some(generation) => self.tx.send(Msg::Unplugged { generation }).is_ok(),
            None => true,
        }
    }

    /// this generation failed (a read or a write): drop it, and look for the
    /// keypad again after the back-off.
    fn lost(self: &Arc<Self>, generation: u64) {
        let wait = {
            let mut s = self.state();
            if s.current.as_ref().is_none_or(|(_, g)| *g != generation) {
                return;
            }
            s.current = None;
            if s.retrying {
                return;
            }
            s.retrying = true;
            let wait = s.retry_ms;
            s.retry_ms = (s.retry_ms * 2).min(RETRY_CAP_MS);
            wait
        };
        self.log.warn("board.lost", &format!("retry_ms={wait}"));
        let hid = self.clone();
        let spawned = std::thread::Builder::new()
            .name("board-retry".into())
            .spawn(move || {
                std::thread::sleep(Duration::from_millis(wait));
                hid.state().retrying = false;
                if let Some(id) = find_board(&hid.backend, None) {
                    hid.plug(&id);
                }
            });
        if spawned.is_err() {
            self.state().retrying = false;
        }
    }
}

fn watch_hid(tx: &SyncSender<Msg>, log: &Log) {
    let backend = HidBackend::default();
    let mut events = match backend.watch() {
        Ok(events) => events,
        Err(e) => {
            log.error("board.watch_failed", &format!("error={e:?}"));
            let _ = tx.send(Msg::Fatal { what: "hid_watch" });
            return;
        }
    };
    let hid = Arc::new(Hid {
        backend,
        state: Mutex::new(HidState {
            current: None,
            generation: 0,
            retry_ms: RETRY_FIRST_MS,
            retrying: false,
        }),
        tx: tx.clone(),
        log: log.clone(),
    });
    // a board already plugged in when the daemon starts.
    if let Some(id) = find_board(&hid.backend, None) {
        hid.plug(&id);
    }
    while let Some(event) = block_on(events.next()) {
        match event {
            DeviceEvent::Connected(id) => {
                if let Some(id) = find_board(&hid.backend, Some(&id)) {
                    // a fresh plug starts the back-off over.
                    hid.state().retry_ms = RETRY_FIRST_MS;
                    hid.plug(&id);
                }
            }
            DeviceEvent::Disconnected(id) => {
                if !hid.unplugged(&id) {
                    return;
                }
            }
        }
    }
    let _ = tx.send(Msg::Fatal {
        what: "hid_watch_ended",
    });
}

/// the keypad's raw hid interface, by vendor, product and usage page (never
/// by path or name: paths do not survive a replug). `only` narrows it to a
/// device that just appeared.
fn find_board(backend: &HidBackend, only: Option<&DeviceId>) -> Option<DeviceId> {
    let matches = |d: &async_hid::DeviceInfo| {
        d.vendor_id == VENDOR_ID && d.product_id == PRODUCT_ID && d.usage_page == USAGE_PAGE
    };
    block_on(async {
        if let Some(id) = only {
            return backend
                .query_devices(id)
                .await
                .ok()?
                .find(|d| matches(d))
                .map(|d| d.id.clone());
        }
        let mut all = backend.enumerate().await.ok()?;
        while let Some(d) = all.next().await {
            if matches(&d) {
                return Some(d.id.clone());
            }
        }
        None
    })
}

/// opens the keypad (non-exclusively: the firmware's keyboard keeps typing)
/// and starts its reader thread. the reader ends when its generation is no
/// longer the open one, or on an error, which counts as lost.
fn open(hid: &Arc<Hid>, id: &DeviceId, generation: u64) -> bool {
    let device = block_on(async {
        let mut found = hid.backend.query_devices(id).await.ok()?;
        found.find(|d| d.usage_page == USAGE_PAGE)
    });
    let Some(device) = device else {
        hid.log.warn("board.open_failed", "why=gone");
        return false;
    };
    let (mut reader, writer) = match block_on(device.open()) {
        Ok(rw) => rw,
        Err(e) => {
            hid.log.warn("board.open_failed", &format!("error={e:?}"));
            return false;
        }
    };
    if hid
        .tx
        .send(Msg::Plugged {
            generation,
            link: Link::Hid {
                writer,
                generation,
                hid: hid.clone(),
            },
        })
        .is_err()
    {
        return false;
    }
    let reader_hid = hid.clone();
    let spawned = std::thread::Builder::new()
        .name("board-hid".into())
        .spawn(move || {
            let hid = reader_hid;
            let mut buf = [0u8; 64];
            loop {
                let read = block_on(reader.read_input_report(&mut buf));
                if !hid.is_current(generation) {
                    return;
                }
                match read {
                    Ok(n) if n > 0 => {
                        let mut report = [0u8; REPORT_LEN];
                        let n = n.min(REPORT_LEN);
                        report[..n].copy_from_slice(&buf[..n]);
                        if hid.tx.send(Msg::Report { generation, report }).is_err() {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => {
                        let _ = hid.tx.send(Msg::Unplugged { generation });
                        hid.lost(generation);
                        return;
                    }
                }
            }
        });
    if spawned.is_err() {
        hid.log.error("board.reader_failed", "");
        return false;
    }
    hid.log.info("board.opened", "");
    true
}
