//! a body streamed to `media/tmp/` while it is hashed. one buffer of
//! `BUFFER` bytes per body, filled from the stream and handed to a blocking
//! thread that writes and hashes it, then handed back: the memory a body
//! costs is that buffer and the chunk in hand, whatever its size.

use std::io::Write;
use std::path::{Path, PathBuf};

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use sha2::{Digest, Sha256};

use super::MediaError;
use super::sniff::HEAD;

/// the one buffer each upload or copy holds (`agents.md`, buffers and caps).
pub const BUFFER: usize = 1024 * 1024;

/// a body written to a temporary file, not yet at its address.
#[derive(Debug)]
pub struct Received {
    pub tmp: Temporary,
    /// the sha256 of the bytes, 64 lowercase hex: the media id.
    pub id: String,
    pub size: u64,
    /// the most the buffer held at once, so a test can prove the cap.
    #[cfg_attr(not(test), allow(dead_code, reason = "read by the tests"))]
    pub peak_buffered: usize,
}

/// a file under `media/tmp/`, removed when dropped unless it was moved to
/// its address.
#[derive(Debug)]
pub struct Temporary {
    path: Option<PathBuf>,
}

impl Temporary {
    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// the file has gone to its address (or was removed): nothing to clean.
    pub fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        let Some(path) = self.path.take() else {
            return;
        };
        // best effort, and off the async threads: the startup sweep empties
        // tmp/ of anything left
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || {
                    let _ = std::fs::remove_file(path);
                });
            }
            Err(_) => {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// what a body is checked against as it arrives.
pub struct Limits<'a> {
    /// the most bytes the body may carry.
    pub max: u64,
    /// called once with the first bytes (at most `sniff::HEAD`), before more
    /// than one buffer is read: a body of the wrong kind is refused early.
    pub head: &'a mut (dyn FnMut(&[u8]) -> Result<(), MediaError> + Send),
    /// the longest the body may send nothing.
    pub idle: std::time::Duration,
    /// when the whole body must have arrived.
    pub deadline: tokio::time::Instant,
    /// the server stopping: the body is dropped at once.
    pub cancel: &'a tokio_util::sync::CancellationToken,
}

/// streams `body` into a new file in `tmp_dir`, hashing as it goes.
///
/// # Errors
/// the body passes `limits.max` (`TooLarge`), is empty, fails its head
/// check, the stream fails (`Source`), or the disk does (`Disk`). nothing is
/// left in `tmp_dir` after an error.
pub async fn receive<S, E>(
    tmp_dir: &Path,
    mut body: S,
    limits: Limits<'_>,
) -> Result<Received, MediaError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin + Send,
    E: std::fmt::Display,
{
    let path = tmp_dir.join(format!("{:016x}", rand::random::<u64>()));
    let mut tmp = Temporary {
        path: Some(path.clone()),
    };
    let file = tokio::task::spawn_blocking(move || create_private(&path))
        .await
        .map_err(|e| MediaError::Disk(std::io::Error::other(e)))?
        .map_err(MediaError::Disk)?;
    let mut sink = Some(Sink {
        file,
        hasher: Sha256::new(),
        buffer: Vec::with_capacity(BUFFER),
    });
    let mut size: u64 = 0;
    let mut peak = 0;
    let mut checked = false;
    loop {
        let wait = limits
            .deadline
            .min(tokio::time::Instant::now() + limits.idle);
        let next = tokio::select! {
            () = limits.cancel.cancelled() => return Err(MediaError::Stopping),
            next = tokio::time::timeout_at(wait, body.next()) => next,
        };
        let Ok(next) = next else {
            return Err(MediaError::Source(
                if tokio::time::Instant::now() >= limits.deadline {
                    "it took longer than the server waits for one file".to_owned()
                } else {
                    format!("no bytes came for {} s", limits.idle.as_secs())
                },
            ));
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| MediaError::Source(e.to_string()))?;
        size = size.saturating_add(chunk.len() as u64);
        if size > limits.max {
            return Err(MediaError::TooLarge {
                limit: limits.max,
                got: Some(size),
            });
        }
        let mut rest: &[u8] = &chunk;
        while !rest.is_empty() {
            let open = sink.as_mut().ok_or(MediaError::Stopped)?;
            let room = BUFFER - open.buffer.len();
            let (now, later) = rest.split_at(room.min(rest.len()));
            open.buffer.extend_from_slice(now);
            peak = peak.max(open.buffer.len());
            rest = later;
            if open.buffer.len() == BUFFER {
                if !checked {
                    (limits.head)(&open.buffer[..HEAD.min(open.buffer.len())])?;
                    checked = true;
                }
                let full = sink.take().ok_or(MediaError::Stopped)?;
                sink = Some(flush(full).await?);
            }
        }
    }
    let mut last = sink.take().ok_or(MediaError::Stopped)?;
    if size == 0 {
        return Err(MediaError::Empty);
    }
    if !checked {
        (limits.head)(&last.buffer[..HEAD.min(last.buffer.len())])?;
    }
    if !last.buffer.is_empty() {
        last = flush(last).await?;
    }
    let digest = tokio::task::spawn_blocking(move || -> std::io::Result<_> {
        last.file.sync_all()?;
        Ok(last.hasher.finalize())
    })
    .await
    .map_err(|e| MediaError::Disk(std::io::Error::other(e)))?
    .map_err(MediaError::Disk)?;
    let id = data_encoding::HEXLOWER.encode(&digest);
    let received = Received {
        tmp: Temporary {
            path: tmp.path.take(),
        },
        id,
        size,
        peak_buffered: peak,
    };
    Ok(received)
}

struct Sink {
    file: std::fs::File,
    hasher: Sha256,
    buffer: Vec<u8>,
}

/// writes and hashes the buffer on a blocking thread and hands it back empty.
async fn flush(mut sink: Sink) -> Result<Sink, MediaError> {
    tokio::task::spawn_blocking(move || -> std::io::Result<Sink> {
        sink.file.write_all(&sink.buffer)?;
        sink.hasher.update(&sink.buffer);
        sink.buffer.clear();
        Ok(sink)
    })
    .await
    .map_err(|e| MediaError::Disk(std::io::Error::other(e)))?
    .map_err(MediaError::Disk)
}

fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("boxbox-receive-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn chunks(total: usize, each: usize) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
        let mut left = total;
        let mut n: u8 = 0;
        futures_util::stream::iter(std::iter::from_fn(move || {
            if left == 0 {
                return None;
            }
            let take = left.min(each);
            left -= take;
            n = n.wrapping_add(1);
            Some(Ok(Bytes::from(vec![n; take])))
        }))
    }

    /// the temporary file goes on a blocking thread: wait for it, a second at most.
    async fn emptied(dir: &std::path::Path) -> bool {
        for _ in 0..100 {
            if std::fs::read_dir(dir).unwrap().count() == 0 {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        false
    }

    fn any_head() -> impl FnMut(&[u8]) -> Result<(), MediaError> + Send {
        |_| Ok(())
    }

    #[tokio::test]
    async fn a_body_three_times_the_buffer_never_holds_more_than_the_buffer_and_hashes_like_its_bytes()
     {
        let dir = scratch();
        let mut head = any_head();
        let received = receive(
            &dir,
            Box::pin(chunks(3 * BUFFER + 17, 300 * 1024)),
            Limits {
                max: 64 * 1024 * 1024,
                head: &mut head,
                idle: std::time::Duration::from_secs(5),
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(60),
                cancel: &tokio_util::sync::CancellationToken::new(),
            },
        )
        .await
        .unwrap();
        assert!(
            received.peak_buffered <= BUFFER,
            "{}",
            received.peak_buffered
        );
        assert_eq!(received.size, 3 * BUFFER as u64 + 17);
        let written = std::fs::read(received.tmp.path().unwrap()).unwrap();
        assert_eq!(
            received.id,
            data_encoding::HEXLOWER.encode(&Sha256::digest(&written))
        );
        drop(received);
        assert!(emptied(&dir).await, "tmp left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_body_past_its_limit_is_refused_and_leaves_nothing_behind() {
        let dir = scratch();
        let mut head = any_head();
        let refused = receive(
            &dir,
            Box::pin(chunks(2 * BUFFER, 64 * 1024)),
            Limits {
                max: BUFFER as u64,
                head: &mut head,
                idle: std::time::Duration::from_secs(5),
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(60),
                cancel: &tokio_util::sync::CancellationToken::new(),
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(refused, MediaError::TooLarge { .. }),
            "{refused:?}"
        );
        assert!(emptied(&dir).await, "tmp left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn the_head_check_runs_once_on_the_first_bytes_and_its_refusal_stops_the_body() {
        let dir = scratch();
        let mut seen = Vec::new();
        let mut head = |first: &[u8]| {
            seen.push(first.len());
            Err(MediaError::Empty)
        };
        let refused = receive(
            &dir,
            Box::pin(chunks(5 * BUFFER, BUFFER)),
            Limits {
                max: u64::MAX,
                head: &mut head,
                idle: std::time::Duration::from_secs(5),
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(60),
                cancel: &tokio_util::sync::CancellationToken::new(),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(refused, MediaError::Empty));
        assert_eq!(seen, [HEAD]);
        assert!(emptied(&dir).await, "tmp left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn limits<'a>(
        head: &'a mut (dyn FnMut(&[u8]) -> Result<(), MediaError> + Send),
        cancel: &'a tokio_util::sync::CancellationToken,
        idle_ms: u64,
        deadline_ms: u64,
    ) -> Limits<'a> {
        Limits {
            max: u64::MAX,
            head,
            idle: std::time::Duration::from_millis(idle_ms),
            deadline: tokio::time::Instant::now() + std::time::Duration::from_millis(deadline_ms),
            cancel,
        }
    }

    /// one chunk, then a sender that never sends again and never hangs up:
    /// a phone that changed networks mid upload.
    fn stalled() -> impl Stream<Item = Result<Bytes, std::io::Error>> + Unpin + Send {
        Box::pin(
            futures_util::stream::iter(vec![Ok(Bytes::from_static(b"\x89PNG\r\n\x1a\nsome"))])
                .chain(futures_util::stream::pending()),
        )
    }

    #[tokio::test]
    async fn a_body_that_stops_sending_is_dropped_after_its_idle_time_and_leaves_nothing() {
        let dir = scratch();
        let mut head = any_head();
        let cancel = tokio_util::sync::CancellationToken::new();
        let started = std::time::Instant::now();
        let refused = receive(&dir, stalled(), limits(&mut head, &cancel, 150, 60_000))
            .await
            .unwrap_err();
        assert!(
            matches!(&refused, MediaError::Source(why) if why.contains("no bytes came")),
            "{refused:?}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(emptied(&dir).await, "tmp left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_body_that_trickles_past_its_deadline_is_dropped() {
        let dir = scratch();
        let mut head = any_head();
        let cancel = tokio_util::sync::CancellationToken::new();
        // a byte every 50 ms never trips the idle limit, but the deadline ends it
        let trickle = Box::pin(futures_util::stream::unfold((), |()| async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            Some((Ok::<_, std::io::Error>(Bytes::from_static(b"x")), ()))
        }));
        let refused = receive(&dir, trickle, limits(&mut head, &cancel, 1_000, 400))
            .await
            .unwrap_err();
        assert!(
            matches!(&refused, MediaError::Source(why) if why.contains("longer")),
            "{refused:?}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn shutdown_ends_a_stalled_body_at_once() {
        let dir = scratch();
        let mut head = any_head();
        let cancel = tokio_util::sync::CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            stop.cancel();
        });
        let refused = receive(&dir, stalled(), limits(&mut head, &cancel, 60_000, 60_000))
            .await
            .unwrap_err();
        assert!(matches!(refused, MediaError::Stopping), "{refused:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_failing_stream_leaves_nothing_behind() {
        let dir = scratch();
        let mut head = any_head();
        let body = futures_util::stream::iter(vec![
            Ok(Bytes::from_static(b"partial")),
            Err(std::io::Error::other("the agent hung up")),
        ]);
        let refused = receive(
            &dir,
            body,
            Limits {
                max: u64::MAX,
                head: &mut head,
                idle: std::time::Duration::from_secs(5),
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(60),
                cancel: &tokio_util::sync::CancellationToken::new(),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(refused, MediaError::Source(_)), "{refused:?}");
        assert!(emptied(&dir).await, "tmp left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
