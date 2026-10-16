//! the media store (`agents.md`, media; decision 31): files named by the
//! sha256 of their bytes under `<data dir>/media/`, indexed in `boxbox.db`,
//! capped by `[media] max_bytes`, least recently used evicted past the cap.
//!
//! one owner: the media task holds the byte count and runs every commit
//! (a new file taking its address, the evictions that make room for it) one
//! at a time, through the store writer. uploads and copies stream their
//! bodies to `media/tmp/` on their own tasks, each with one 1 MiB buffer,
//! and hand the finished file to the task. the route reads files directly
//! by id; an evicted id answers 410.

pub mod evict;
pub mod index;
pub mod range;
pub mod receive;
pub mod sniff;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::Stream;
use serde::Serialize;
use serde_json::json;
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use utoipa::ToSchema;

use crate::store::{Store, StoreError};
use index::{Arrival, Committed};
pub use index::{Lookup, Sidecar, SidecarKept};
use receive::{Limits, Received};

const MIB: u64 = 1024 * 1024;
/// the type of a file nobody said anything specific about.
const GENERIC: &str = "application/octet-stream";
/// the largest file boxbox takes from a device or copies from an agent.
pub const MEDIA_BODY: u64 = 64 * MIB;
/// the cap when `[media] max_bytes` is unset.
pub const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * MIB;
/// the smallest cap the config takes: below it nothing useful fits.
pub const MIN_MAX_BYTES: u64 = MIB;
/// uploads at once; a fifth answers 503 `media-busy`.
pub const UPLOADS: usize = 4;
/// agent copies at once across every source. each source keeps its own 2 in
/// flight; this bounds the buffers if many connect, and a copy past it is
/// deferred by its source, never marked missing.
pub const COPIES: usize = 8;
/// how long an upload stays pinned when its send never settles it.
pub const UPLOAD_PIN_MS: i64 = 10 * 60 * 1000;
/// what a `retry-after` says to a fifth upload.
pub const BUSY_RETRY_S: u64 = 5;
/// commits waiting for the media task. each is one finished file; a sender
/// past this waits its turn, which is the disk's own pace.
const COMMITS: usize = 16;
/// the longest transcript a sidecar keeps, in bytes: minutes of speech.
#[allow(
    dead_code,
    reason = "put_sidecar's cap; the send routes call it (the seam lane)"
)]
pub const TRANSCRIPT_BYTES: usize = 64 * 1024;
/// a sidecar's language tag, at most (a bcp 47 tag).
pub const LANG_BYTES: usize = 35;
/// a sidecar's device id, at most.
pub const DEVICE_BYTES: usize = 64;
/// a sidecar's thread key (`<agent>:<thread>`), at most.
pub const THREAD_BYTES: usize = 256;
/// how long a body may send nothing before it is dropped: a phone that
/// changed networks mid upload leaves a connection that never ends, and it
/// must not hold an upload's place (or the server's shutdown) for good.
pub const IDLE: Duration = Duration::from_secs(30);
/// the longest a whole take may run: 64 MiB at about 110 KiB/s.
pub const DEADLINE: Duration = Duration::from_secs(10 * 60);
/// orphan files (no row) younger than this survive the startup check: a
/// power cut can lose a committed row (`synchronous=normal`) whose fsynced
/// file is still there, and the same bytes arriving again take it back.
pub const ORPHAN_GRACE: Duration = Duration::from_secs(60 * 60);
/// a waveform: at most 64 loudness values.
pub const WAVEFORM_BYTES: usize = 64;
/// the longest filename kept, in bytes.
pub const FILENAME_BYTES: usize = 255;

/// one stored file, as the upload answers it and parts carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MediaObject {
    /// the sha256 of the bytes, 64 lowercase hex.
    pub id: String,
    pub mime: String,
    pub size: u64,
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// at most 64 values from 0 to 255, the loudness of equal slices.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waveform: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// who brought the bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Upload,
    Agent,
}

impl Origin {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Agent => "agent",
        }
    }
}

/// what a device or an agent says about a file it hands over.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Declared {
    /// the media type, lowercase, no parameters (`normalize_mime`).
    pub mime: String,
    pub filename: Option<String>,
    pub duration_ms: Option<u64>,
    pub waveform: Option<Vec<u8>>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// the length the sender announced, when it did: a body announced past
    /// the limit is refused before a byte is read.
    pub length: Option<u64>,
}

/// a file the store took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub object: MediaObject,
    /// the store already held these bytes.
    pub duplicate: bool,
    /// the pin this take set (uploads: now plus 10 minutes), the value to
    /// hand `release` when its send settles; `None` for a copy.
    pub pinned_until: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("{UPLOADS} uploads are running; send this one again in a moment")]
    Busy,
    #[error("{} is more than boxbox keeps; the limit is {} MiB", got.map_or_else(|| "this file".to_owned(), |b| format!("{} MiB", b.div_ceil(MIB))), limit / MIB)]
    TooLarge { limit: u64, got: Option<u64> },
    #[error("the upload is empty; attach the file again")]
    Empty,
    #[error("{}", contradiction(declared, *found))]
    Kind {
        declared: String,
        found: Option<&'static str>,
    },
    #[error(
        "the media store is full of files from the last day or files waiting to send; raise [media] max_bytes in boxbox.toml"
    )]
    Full,
    #[error("the file stopped arriving: {0}")]
    Source(String),
    #[error("the server could not write the file: {0}")]
    Disk(std::io::Error),
    #[error("the server's store is not answering: {0}")]
    Store(#[from] StoreError),
    #[error("the media store has stopped")]
    Stopped,
    #[error("the server is stopping; send the file again in a moment")]
    Stopping,
    #[error("{0}")]
    Sidecar(String),
    #[error("boxbox holds no file with that id")]
    NoSuchMedia,
    #[error("a transcript belongs to a voice note, and that file is not audio")]
    NotAudio,
}

fn contradiction(declared: &str, found: Option<&str>) -> String {
    match found {
        Some(found) => format!("this file says it is {declared}, but its bytes are {found}"),
        None => format!("this file says it is {declared}, but its bytes are not"),
    }
}

impl MediaError {
    /// the outcome label telemetry carries.
    fn outcome(&self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::TooLarge { .. } => "too-large",
            Self::Empty => "empty",
            Self::Kind { .. } => "refused-kind",
            Self::Full => "full",
            Self::Source(_) => "source-failed",
            Self::Disk(_)
            | Self::Store(_)
            | Self::Stopped
            | Self::Stopping
            | Self::Sidecar(_)
            | Self::NoSuchMedia
            | Self::NotAudio => "failed",
        }
    }
}

/// the handle every route and source holds. cheap to clone.
#[derive(Debug, Clone)]
pub struct Media {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    root: PathBuf,
    store: Store,
    telemetry: crate::telemetry::Sender,
    uploads: Arc<Semaphore>,
    #[allow(
        dead_code,
        reason = "the agent sources' copies take it (the seam and openclaw lanes)"
    )]
    copies: Arc<Semaphore>,
    commits: mpsc::Sender<Commit>,
    timing: Timing,
    /// fired at shutdown: every take in flight ends, so a stalled body never
    /// holds the server open.
    shutdown: CancellationToken,
}

/// how long a body may idle and a take may run.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub idle: Duration,
    pub deadline: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            idle: IDLE,
            deadline: DEADLINE,
        }
    }
}

struct Commit {
    received: Received,
    object: MediaObject,
    origin: Origin,
    pinned_until: Option<i64>,
    answer: oneshot::Sender<Result<Committed, MediaError>>,
}

/// `<root>/<first 2 hex>/<64 hex>`, or `None` when `id` is not a media id:
/// nothing that is not 64 lowercase hex ever becomes a path.
#[must_use]
pub fn address(root: &Path, id: &str) -> Option<PathBuf> {
    is_id(id).then(|| root.join(&id[..2]).join(id))
}

/// whether `id` is a media id: 64 lowercase hex.
#[must_use]
pub fn is_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// a declared content type as the index keeps it: lowercase, no parameters,
/// `type/subtype` of token characters. `None` when it is not one.
#[must_use]
pub fn normalize_mime(raw: &str) -> Option<String> {
    let bare = raw.split(';').next()?.trim().to_ascii_lowercase();
    let (kind, sub) = bare.split_once('/')?;
    let token = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&b))
    };
    (token(kind) && token(sub) && bare.len() <= 127).then_some(bare)
}

/// a filename as it is kept: no path, no control characters, at most
/// `FILENAME_BYTES`. `None` when nothing is left.
#[must_use]
pub fn clean_filename(raw: &str) -> Option<String> {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let mut kept = String::new();
    for c in base.chars().filter(|c| !c.is_control()) {
        if kept.len() + c.len_utf8() > FILENAME_BYTES {
            break;
        }
        kept.push(c);
    }
    let kept = kept.trim().to_owned();
    (!kept.is_empty() && kept != "." && kept != "..").then_some(kept)
}

pub(crate) fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("cannot prepare the media store at {path}: {source}")]
    Dir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("cannot read the media index: {0}")]
    Index(#[from] StoreError),
}

impl Media {
    /// prepares `<data_dir>/media/`, mends it against the index (an empty
    /// `tmp/`, rows whose file is gone become tombstones, files with no row
    /// are removed), counts its bytes, and starts the media task. the task
    /// stops once every handle is dropped.
    ///
    /// # Errors
    /// the directory cannot be made or read, or the index cannot be read.
    pub async fn open(
        data_dir: &Path,
        store: Store,
        cap: u64,
        telemetry: crate::telemetry::Sender,
        shutdown: CancellationToken,
    ) -> Result<(Self, JoinHandle<()>), OpenError> {
        Self::open_timed(data_dir, store, cap, telemetry, shutdown, Timing::default()).await
    }

    /// `open`, with the idle and deadline limits given (the tests make them
    /// short).
    ///
    /// # Errors
    /// as `open`.
    pub async fn open_timed(
        data_dir: &Path,
        store: Store,
        cap: u64,
        telemetry: crate::telemetry::Sender,
        shutdown: CancellationToken,
        timing: Timing,
    ) -> Result<(Self, JoinHandle<()>), OpenError> {
        let root = data_dir.join("media");
        let live = store.call(|c| index::live(c)).await?;
        let mended = {
            let root = root.clone();
            tokio::task::spawn_blocking(move || mend(&root, live))
                .await
                .map_err(|e| OpenError::Dir {
                    path: data_dir.join("media"),
                    source: std::io::Error::other(e),
                })?
                .map_err(|source| OpenError::Dir {
                    path: data_dir.join("media"),
                    source,
                })?
        };
        if !mended.gone.is_empty() {
            warn!(
                files = mended.gone.len(),
                "media rows whose file is gone are now tombstones"
            );
            let now = crate::now_ms();
            let gone = mended.gone;
            store.call(move |c| index::tombstone(c, &gone, now)).await?;
        }
        if mended.removed + mended.young + mended.stuck > 0 {
            info!(
                removed = mended.removed,
                kept_young = mended.young,
                unremovable = mended.stuck,
                "media files the index does not hold"
            );
        }
        let total = store.call(|c| index::total(c)).await?;
        info!(root = %root.display(), total, cap, "media store open");
        let (commits, receiver) = mpsc::channel(COMMITS);
        let task = tokio::spawn(
            Task {
                root: root.clone(),
                store: store.clone(),
                telemetry: telemetry.clone(),
                total,
                cap,
            }
            .run(receiver),
        );
        Ok((
            Self {
                inner: Arc::new(Inner {
                    root,
                    store,
                    telemetry,
                    uploads: Arc::new(Semaphore::new(UPLOADS)),
                    copies: Arc::new(Semaphore::new(COPIES)),
                    commits,
                    timing,
                    shutdown,
                }),
            },
            task,
        ))
    }

    /// a handle with no task or store behind it: every call answers
    /// `Stopped` or the store's own refusal.
    #[cfg(test)]
    #[must_use]
    pub fn detached() -> Self {
        Self {
            inner: Arc::new(Inner {
                root: std::env::temp_dir().join("boxbox-media-detached"),
                store: Store::detached(),
                telemetry: crate::telemetry::Sender::detached(),
                uploads: Arc::new(Semaphore::new(UPLOADS)),
                copies: Arc::new(Semaphore::new(COPIES)),
                commits: mpsc::channel(1).0,
                timing: Timing::default(),
                shutdown: CancellationToken::new(),
            }),
        }
    }

    /// where an id's file lives; `None` for anything that is not a media id
    /// (64 lowercase hex), so an id from a request body can never name a
    /// path outside the store.
    #[must_use]
    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        address(&self.inner.root, id)
    }

    /// `POST /api/media`: a device's file, streamed to the store. pinned
    /// until its send settles (`pin`) or 10 minutes pass.
    ///
    /// # Errors
    /// `Busy` past `UPLOADS`, `TooLarge` past `MEDIA_BODY`, `Kind` when the
    /// bytes contradict a declared media type, `Full`, `Empty`, or the
    /// stream, disk or store failing.
    pub async fn upload<S, E>(&self, body: S, declared: Declared) -> Result<Stored, MediaError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin + Send,
        E: std::fmt::Display,
    {
        let started = Instant::now();
        let family = family(&declared.mime);
        let bytes = declared.length;
        let result = match Arc::clone(&self.inner.uploads).try_acquire_owned() {
            Ok(_permit) => {
                let pin = crate::now_ms() + UPLOAD_PIN_MS;
                self.take(body, declared, Origin::Upload, Some(pin)).await
            }
            Err(_) => Err(MediaError::Busy),
        };
        self.record(Origin::Upload, family, bytes, started, &result);
        result
    }

    #[allow(
        dead_code,
        reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
    )]
    /// the internal ingest the agent sources call to copy an agent's file
    /// on first sight (`agents.md`, agent-supplied media): streamed in under
    /// the same 64 MiB cap and 1 MiB buffer as an upload, deduplicated by
    /// content, never pinned. a mislabelled agent file is kept under the
    /// type its bytes show, since the agent cannot be asked to fix it.
    ///
    /// # Errors
    /// `Busy` when `COPIES` are running (the source defers the copy, never
    /// marks it missing), `TooLarge` (the part is missing, "too large to
    /// keep"), `Full` (missing, with the store-full notice), `Source` when the
    /// agent's stream failed (counts toward the source's 6 tries), or the
    /// disk or store failing.
    pub async fn copy<S, E>(&self, body: S, declared: Declared) -> Result<Stored, MediaError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin + Send,
        E: std::fmt::Display,
    {
        let started = Instant::now();
        let family = family(&declared.mime);
        let bytes = declared.length;
        let result = match Arc::clone(&self.inner.copies).try_acquire_owned() {
            Ok(_permit) => self.take(body, declared, Origin::Agent, None).await,
            Err(_) => Err(MediaError::Busy),
        };
        self.record(Origin::Agent, family, bytes, started, &result);
        result
    }

    async fn take<S, E>(
        &self,
        body: S,
        declared: Declared,
        origin: Origin,
        pinned_until: Option<i64>,
    ) -> Result<Stored, MediaError>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin + Send,
        E: std::fmt::Display,
    {
        if let Some(length) = declared.length
            && length > MEDIA_BODY
        {
            return Err(MediaError::TooLarge {
                limit: MEDIA_BODY,
                got: Some(length),
            });
        }
        // whoever calls, the index only ever sees what it can keep
        let declared_mime = normalize_mime(&declared.mime);
        let checked_mime = declared_mime.clone().unwrap_or_else(|| GENERIC.to_owned());
        let mut sniffed: Option<&'static str> = None;
        let mut contradicted = false;
        let mut head = |first: &[u8]| -> Result<(), MediaError> {
            sniffed = sniff::sniff(first).map(|s| s.mime);
            match sniff::check(&checked_mime, first) {
                Ok(()) => Ok(()),
                // an agent's label loses to its bytes, since it cannot be asked to fix it
                Err(_) if origin == Origin::Agent => {
                    contradicted = true;
                    Ok(())
                }
                Err(refused) => Err(MediaError::Kind {
                    declared: refused.declared,
                    found: refused.found,
                }),
            }
        };
        let timing = self.inner.timing;
        let received = receive::receive(
            &self.inner.root.join("tmp"),
            body,
            Limits {
                max: MEDIA_BODY,
                head: &mut head,
                idle: timing.idle,
                deadline: tokio::time::Instant::now() + timing.deadline,
                cancel: &self.inner.shutdown,
            },
        )
        .await?;
        let generic = checked_mime == GENERIC;
        let mime = match sniffed {
            Some(found) if generic || contradicted => found.to_owned(),
            _ => checked_mime.clone(),
        };
        let object = MediaObject {
            id: received.id.clone(),
            mime,
            size: received.size,
            filename: declared.filename.as_deref().and_then(clean_filename),
            duration_ms: declared.duration_ms,
            waveform: declared.waveform.filter(|w| w.len() <= WAVEFORM_BYTES),
            width: declared.width,
            height: declared.height,
        };
        let (answer, answered) = oneshot::channel();
        self.inner
            .commits
            .send(Commit {
                received,
                object,
                origin,
                pinned_until,
                answer,
            })
            .await
            .map_err(|_| MediaError::Stopped)?;
        match answered.await.map_err(|_| MediaError::Stopped)?? {
            Committed::Stored { object, .. } => Ok(Stored {
                object,
                duplicate: false,
                pinned_until,
            }),
            Committed::Duplicate { object } => Ok(Stored {
                object,
                duplicate: true,
                pinned_until,
            }),
            Committed::Full => Err(MediaError::Full),
        }
    }

    fn record(
        &self,
        origin: Origin,
        family: &'static str,
        announced: Option<u64>,
        started: Instant,
        result: &Result<Stored, MediaError>,
    ) {
        let (outcome, bytes, ok) = match result {
            Ok(stored) if stored.duplicate => ("duplicate", Some(stored.object.size), 1),
            Ok(stored) => ("stored", Some(stored.object.size), 1),
            Err(e) => (e.outcome(), announced, 0),
        };
        self.inner.telemetry.record(&json!({
            "kind": "media.stored",
            "ok": ok,
            "ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "props": { "origin": origin.as_str(), "outcome": outcome, "family": family, "bytes": bytes },
        }));
    }

    /// what an id names, moving its `last_used` (once a minute at most).
    ///
    /// # Errors
    /// the store is not answering.
    pub async fn lookup(&self, id: &str) -> Result<Lookup, MediaError> {
        let id = id.to_owned();
        let now = crate::now_ms();
        Ok(self
            .inner
            .store
            .call(move |c| index::lookup(c, &id, now))
            .await?)
    }

    #[allow(
        dead_code,
        reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
    )]
    /// pins a live id until at least `until` (ms since the epoch); a pin only
    /// lengthens, so one send never cuts another's short. answers whether
    /// the id is live.
    ///
    /// # Errors
    /// the store is not answering.
    pub async fn pin(&self, id: &str, until: i64) -> Result<bool, MediaError> {
        let id = id.to_owned();
        Ok(self
            .inner
            .store
            .call(move |c| index::pin(c, &id, until))
            .await?)
    }

    #[allow(
        dead_code,
        reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
    )]
    /// lets the pin this holder set (`until`, from `Stored::pinned_until` or
    /// its own `pin`) go when its send settles. a pin another holder
    /// lengthened since is left alone. answers whether the pin went.
    ///
    /// # Errors
    /// the store is not answering.
    pub async fn release(&self, id: &str, until: i64) -> Result<bool, MediaError> {
        let id = id.to_owned();
        Ok(self
            .inner
            .store
            .call(move |c| index::release(c, &id, until))
            .await?)
    }

    #[allow(
        dead_code,
        reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
    )]
    /// records that a message holds a media id. answers false for an id the
    /// index does not know.
    ///
    /// # Errors
    /// the store is not answering.
    pub async fn add_ref(
        &self,
        id: &str,
        agent: &str,
        thread: &str,
        message: &str,
    ) -> Result<bool, MediaError> {
        let (id, agent, thread, message) = (
            id.to_owned(),
            agent.to_owned(),
            thread.to_owned(),
            message.to_owned(),
        );
        Ok(self
            .inner
            .store
            .call(move |c| index::add_ref(c, &id, &agent, &thread, &message))
            .await?)
    }

    #[allow(
        dead_code,
        reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
    )]
    /// keeps your device's transcript of your voice note (`agents.md`,
    /// sidecars), keyed by media id and thread, replacing an earlier one.
    /// the send routes call it before the agent is called; it is never sent
    /// to the agent.
    ///
    /// # Errors
    /// `TooLarge` for a transcript past `TRANSCRIPT_BYTES`; `Sidecar` for a
    /// thread, lang or device past its cap (or an empty thread);
    /// `NoSuchMedia` for an id the index does not hold; `NotAudio` for a file
    /// that is not audio; or the store not answering.
    pub async fn put_sidecar(
        &self,
        media: &str,
        thread: &str,
        transcript: &str,
        lang: Option<&str>,
        device: Option<&str>,
    ) -> Result<(), MediaError> {
        if transcript.len() > TRANSCRIPT_BYTES {
            return Err(MediaError::TooLarge {
                limit: TRANSCRIPT_BYTES as u64,
                got: Some(transcript.len() as u64),
            });
        }
        if !is_id(media) {
            return Err(MediaError::NoSuchMedia);
        }
        if thread.is_empty() || thread.len() > THREAD_BYTES {
            return Err(MediaError::Sidecar(format!(
                "a sidecar's thread is 1 to {THREAD_BYTES} bytes"
            )));
        }
        if lang.is_some_and(|l| l.is_empty() || l.len() > LANG_BYTES) {
            return Err(MediaError::Sidecar(format!(
                "a sidecar's lang is a language tag of 1 to {LANG_BYTES} bytes"
            )));
        }
        if device.is_some_and(|d| d.is_empty() || d.len() > DEVICE_BYTES) {
            return Err(MediaError::Sidecar(format!(
                "a sidecar's device is 1 to {DEVICE_BYTES} bytes"
            )));
        }
        let sidecar = Sidecar {
            media: media.to_owned(),
            thread: thread.to_owned(),
            transcript: transcript.to_owned(),
            lang: lang.map(str::to_owned),
            device: device.map(str::to_owned),
            created: crate::now_ms(),
        };
        match self
            .inner
            .store
            .call(move |c| index::put_sidecar(c, &sidecar))
            .await?
        {
            SidecarKept::Kept => Ok(()),
            SidecarKept::Unknown => Err(MediaError::NoSuchMedia),
            SidecarKept::NotAudio => Err(MediaError::NotAudio),
        }
    }

    #[allow(
        dead_code,
        reason = "the agent sources and the send routes call it (the seam lane wires them); unit-tested in media/tests.rs"
    )]
    /// the transcripts kept for these media ids in `thread`, for a source to
    /// attach to the audio parts whose `media.id` matches.
    ///
    /// # Errors
    /// the store is not answering.
    pub async fn sidecars(&self, ids: &[String], thread: &str) -> Result<Vec<Sidecar>, MediaError> {
        let (ids, thread) = (ids.to_vec(), thread.to_owned());
        Ok(self
            .inner
            .store
            .call(move |c| index::sidecars(c, &ids, &thread))
            .await?)
    }

    /// records a serve's time to its answer's head (`perf.media`, `serve`).
    pub fn record_serve(&self, ms: u64, status: u16, bytes: u64) {
        self.inner.telemetry.record(&json!({
            "kind": "perf.media",
            "ok": i32::from((200..400).contains(&status)),
            "ms": ms,
            "props": { "what": "serve", "status": status, "bytes": bytes },
        }));
    }
}

/// the coarse kind a type belongs to, for telemetry.
#[must_use]
pub fn family(mime: &str) -> &'static str {
    match mime.split('/').next() {
        Some("image") => "image",
        Some("audio") => "audio",
        Some("video") => "video",
        Some("text") => "document",
        Some("application") if mime == "application/pdf" || mime.contains("document") => "document",
        _ => "other",
    }
}

/// what the startup check found.
struct Mended {
    /// live ids whose file is gone.
    gone: Vec<String>,
    /// orphan files removed.
    removed: usize,
    /// orphan files kept, younger than `ORPHAN_GRACE`.
    young: usize,
    /// entries that could not be read or removed, skipped.
    stuck: usize,
}

/// the startup check: empties `tmp/`, answers the live ids whose file is
/// gone, and removes files the index does not name once they are older
/// than `ORPHAN_GRACE`. an entry it cannot read or remove is logged and
/// skipped: one stray file never keeps the server from starting.
fn mend(root: &Path, live: Vec<String>) -> std::io::Result<Mended> {
    create_private_dir(root)?;
    let tmp = root.join("tmp");
    if tmp.exists()
        && let Err(error) = std::fs::remove_dir_all(&tmp)
    {
        warn!(%error, "media/tmp could not be emptied; its files are skipped");
    }
    create_private_dir(&tmp)?;
    let mut live: std::collections::HashSet<String> = live.into_iter().collect();
    let mut gone = Vec::new();
    live.retain(|id| {
        let there = address(root, id).is_some_and(|path| path.is_file());
        if !there {
            gone.push(id.clone());
        }
        there
    });
    let mut mended = Mended {
        gone,
        removed: 0,
        young: 0,
        stuck: 0,
    };
    let now = std::time::SystemTime::now();
    for shard in std::fs::read_dir(root)?.flatten() {
        let name = shard.file_name();
        if name.to_str() == Some("tmp") || !shard.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(shard.path()) else {
            mended.stuck += 1;
            continue;
        };
        for file in files.flatten() {
            if file
                .file_name()
                .to_str()
                .is_some_and(|id| live.contains(id))
            {
                continue;
            }
            let age = file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok());
            if age.is_some_and(|age| age < ORPHAN_GRACE) {
                mended.young += 1;
                continue;
            }
            match std::fs::remove_file(file.path()) {
                Ok(()) => mended.removed += 1,
                Err(error) => {
                    warn!(path = %file.path().display(), %error, "a media file the index does not hold could not be removed; skipped");
                    mended.stuck += 1;
                }
            }
        }
    }
    Ok(mended)
}

/// the media task: the byte count and every commit.
struct Task {
    root: PathBuf,
    store: Store,
    telemetry: crate::telemetry::Sender,
    total: u64,
    cap: u64,
}

impl Task {
    async fn run(mut self, mut commits: mpsc::Receiver<Commit>) {
        while let Some(commit) = commits.recv().await {
            let answer = self
                .commit(
                    commit.received,
                    commit.object,
                    commit.origin,
                    commit.pinned_until,
                )
                .await;
            let _ = commit.answer.send(answer);
        }
        info!("media task stopped");
    }

    async fn commit(
        &mut self,
        mut received: Received,
        object: MediaObject,
        origin: Origin,
        pinned_until: Option<i64>,
    ) -> Result<Committed, MediaError> {
        let Some(tmp) = received.tmp.path().map(Path::to_path_buf) else {
            return Err(MediaError::Stopped);
        };
        let Some(address) = address(&self.root, &object.id) else {
            return Err(MediaError::Stopped);
        };
        let root = self.root.clone();
        let (total, cap) = (self.total, self.cap);
        let now = crate::now_ms();
        let committed = self
            .store
            .call(move |c| {
                index::commit(
                    c,
                    &Arrival {
                        object: &object,
                        origin,
                        tmp: &tmp,
                        address: &address,
                        root: &root,
                        pinned_until,
                        now,
                    },
                    total,
                    cap,
                )
            })
            .await?
            .map_err(MediaError::Disk)?;
        if let Committed::Stored { added, evicted, .. } = &committed {
            received.tmp.disarm();
            let freed: u64 = evicted.iter().map(|c| c.size).sum();
            self.total = self.total.saturating_add(*added).saturating_sub(freed);
            if !evicted.is_empty() {
                info!(
                    files = evicted.len(),
                    freed,
                    total = self.total,
                    cap = self.cap,
                    "media evicted to make room"
                );
                self.telemetry.record(&json!({
                    "kind": "media.evicted",
                    "props": { "files": evicted.len(), "bytes": freed, "total": self.total, "cap": self.cap },
                }));
            }
        }
        if matches!(committed, Committed::Full) {
            warn!(
                total = self.total,
                cap = self.cap,
                size = received.size,
                "media store full: nothing old enough to evict"
            );
        }
        Ok(committed)
    }
}

#[cfg(test)]
mod tests;
