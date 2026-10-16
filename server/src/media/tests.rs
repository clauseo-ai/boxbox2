//! the store and its internal ingest against a real `boxbox.db` in the temp
//! dir: dedupe by content, the caps, eviction with its pins and floor, the
//! tombstones, sidecars, and the startup check.

use futures_util::StreamExt as _;
use sha2::Digest;

use super::*;
use crate::store::tests::scratch;

struct Scratch {
    media: Media,
    store: Store,
    dir: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn open(cap: u64) -> Scratch {
    open_timed(cap, Timing::default(), CancellationToken::new()).await
}

async fn open_timed(cap: u64, timing: Timing, shutdown: CancellationToken) -> Scratch {
    let (store, _thread, dir) = scratch();
    let (media, _task) = Media::open_timed(
        &dir,
        store.clone(),
        cap,
        crate::telemetry::Sender::detached(),
        shutdown,
        timing,
    )
    .await
    .unwrap();
    Scratch { media, store, dir }
}

async fn reopen(dir: &Path, store: Store) -> (Media, JoinHandle<()>) {
    Media::open(
        dir,
        store,
        DEFAULT_MAX_BYTES,
        crate::telemetry::Sender::detached(),
        CancellationToken::new(),
    )
    .await
    .unwrap()
}

fn body(bytes: &[u8]) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Unpin + Send {
    futures_util::stream::iter(
        bytes
            .chunks(100 * 1024)
            .map(|c| Ok(Bytes::copy_from_slice(c)))
            .collect::<Vec<_>>(),
    )
}

fn png(size: usize, seed: u8) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(size, seed);
    bytes
}

fn declared(mime: &str) -> Declared {
    Declared {
        mime: mime.into(),
        ..Declared::default()
    }
}

/// the temporary files go on blocking threads: wait for them, a second at most.
async fn tmp_is_empty(dir: &Path) -> bool {
    for _ in 0..100 {
        if std::fs::read_dir(dir.join("media/tmp")).unwrap().count() == 0 {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    false
}

/// makes every row old enough to evict and unpinned, as if a day had passed.
async fn age_everything(store: &Store) {
    store
        .call(|c| {
            c.execute(
                "UPDATE media SET created = created - 2 * ?1, pinned_until = NULL",
                [index::FLOOR_MS],
            )
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn a_copy_lands_at_its_content_address_and_the_same_bytes_again_are_one_object() {
    let s = open(DEFAULT_MAX_BYTES).await;
    let bytes = png(300 * 1024, 1);
    let first = s
        .media
        .copy(body(&bytes), declared("image/png"))
        .await
        .unwrap();
    assert!(!first.duplicate);
    assert!(is_id(&first.object.id));
    let path = s.media.path_of(&first.object.id).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(path.starts_with(s.dir.join("media").join(&first.object.id[..2])));
    // the same bytes, from an upload this time: the same object, kept once
    let again = s
        .media
        .upload(body(&bytes), declared("image/png"))
        .await
        .unwrap();
    assert!(again.duplicate);
    assert_eq!(again.object.id, first.object.id);
    let rows: i64 = s
        .store
        .call(|c| c.query_row("SELECT count(*) FROM media", [], |r| r.get(0)))
        .await
        .unwrap();
    assert_eq!(rows, 1);
    assert!(tmp_is_empty(&s.dir).await);
}

#[tokio::test]
async fn a_copy_past_64_mib_is_refused_by_its_announced_length_and_by_its_bytes() {
    let s = open(DEFAULT_MAX_BYTES).await;
    let announced = Declared {
        length: Some(MEDIA_BODY + 1),
        ..declared("video/mp4")
    };
    let refused = s.media.copy(body(&[0; 10]), announced).await.unwrap_err();
    assert!(
        matches!(refused, MediaError::TooLarge { .. }),
        "{refused:?}"
    );
    // a sender that announced nothing is stopped as the bytes pass the limit
    let size = usize::try_from(MEDIA_BODY).unwrap() + 1;
    let mut big = png(size, 2);
    big.truncate(size);
    let refused = s
        .media
        .copy(body(&big), declared("image/png"))
        .await
        .unwrap_err();
    assert!(
        matches!(refused, MediaError::TooLarge { .. }),
        "{refused:?}"
    );
    assert!(refused.to_string().contains("65 MiB"), "{refused}");
    assert!(tmp_is_empty(&s.dir).await);
}

#[tokio::test]
async fn a_mislabelled_agent_file_is_kept_as_its_bytes_and_a_device_one_is_refused() {
    let s = open(DEFAULT_MAX_BYTES).await;
    let copied = s
        .media
        .copy(body(&png(2048, 3)), declared("image/jpeg"))
        .await
        .unwrap();
    assert_eq!(copied.object.mime, "image/png");
    let refused = s
        .media
        .upload(body(&png(2048, 4)), declared("audio/mp4"))
        .await
        .unwrap_err();
    assert!(
        matches!(
            refused,
            MediaError::Kind {
                found: Some("image/png"),
                ..
            }
        ),
        "{refused:?}"
    );
    assert!(
        refused.to_string().contains("its bytes are image/png"),
        "{refused}"
    );
    // a document is kept as declared
    let doc = s
        .media
        .upload(body(b"plain words"), declared("text/plain"))
        .await
        .unwrap();
    assert_eq!(doc.object.mime, "text/plain");
}

#[tokio::test]
async fn a_failed_agent_stream_leaves_no_file_and_no_row() {
    let s = open(DEFAULT_MAX_BYTES).await;
    let failing = futures_util::stream::iter(vec![
        Ok(Bytes::from_static(b"\x89PNG\r\n\x1a\npartial")),
        Err(std::io::Error::other("ticket expired")),
    ]);
    let refused = s
        .media
        .copy(failing, declared("image/png"))
        .await
        .unwrap_err();
    assert!(matches!(refused, MediaError::Source(_)), "{refused:?}");
    let rows: i64 = s
        .store
        .call(|c| c.query_row("SELECT count(*) FROM media", [], |r| r.get(0)))
        .await
        .unwrap();
    assert_eq!(rows, 0);
    assert!(tmp_is_empty(&s.dir).await);
}

#[tokio::test]
#[allow(
    clippy::many_single_char_names,
    reason = "files a to d, in the order they arrive"
)]
async fn past_the_cap_the_least_recently_used_go_first_and_answer_evicted() {
    let s = open(4 * MIB).await;
    let mib = usize::try_from(MIB).unwrap();
    let a = s
        .media
        .copy(body(&png(mib, 10)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    let b = s
        .media
        .copy(body(&png(mib, 11)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    let c = s
        .media
        .copy(body(&png(mib, 12)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    age_everything(&s.store).await;
    // a is used after b and c, so b is now the least recently used, then c
    s.store
        .call({
            let (a, b, c) = (a.clone(), b.clone(), c.clone());
            move |conn| {
                conn.execute("UPDATE media SET last_used = 3 WHERE id = ?1", [a])?;
                conn.execute("UPDATE media SET last_used = 1 WHERE id = ?1", [b])?;
                conn.execute("UPDATE media SET last_used = 2 WHERE id = ?1", [c])
            }
        })
        .await
        .unwrap();
    // 3 MiB kept + 2 MiB new = 5 over a 4 MiB cap: down to 3.6 MiB, so b and c go
    let d = s
        .media
        .copy(body(&png(2 * mib, 13)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    assert_eq!(s.media.lookup(&b).await.unwrap(), Lookup::Evicted);
    assert_eq!(s.media.lookup(&c).await.unwrap(), Lookup::Evicted);
    assert!(matches!(
        s.media.lookup(&a).await.unwrap(),
        Lookup::Ready(_)
    ));
    assert!(matches!(
        s.media.lookup(&d).await.unwrap(),
        Lookup::Ready(_)
    ));
    assert!(!s.media.path_of(&b).unwrap().exists());
    assert_eq!(
        s.media.lookup(&"0".repeat(64)).await.unwrap(),
        Lookup::Unknown
    );
    // the bytes of an evicted id, copied again, bring it back
    let back = s
        .media
        .copy(body(&png(mib, 11)), declared("image/png"))
        .await;
    // a and d hold 3 MiB, so 1 MiB more fits the cap with nothing evicted
    assert_eq!(back.unwrap().object.id, b);
    assert!(matches!(
        s.media.lookup(&b).await.unwrap(),
        Lookup::Ready(_)
    ));
}

#[tokio::test]
async fn pinned_media_and_media_under_a_day_old_never_go_and_then_the_write_is_refused() {
    let s = open(2 * MIB).await;
    let mib = usize::try_from(MIB).unwrap();
    // an upload is pinned; a fresh copy is under the floor
    let pinned = s
        .media
        .upload(body(&png(mib, 20)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    let fresh = s
        .media
        .copy(body(&png(mib / 2, 21)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    let refused = s
        .media
        .copy(body(&png(mib, 22)), declared("image/png"))
        .await
        .unwrap_err();
    assert!(matches!(refused, MediaError::Full), "{refused:?}");
    assert!(refused.to_string().contains("max_bytes"));
    // nothing was evicted for a write that could not fit
    assert!(matches!(
        s.media.lookup(&pinned).await.unwrap(),
        Lookup::Ready(_)
    ));
    assert!(matches!(
        s.media.lookup(&fresh).await.unwrap(),
        Lookup::Ready(_)
    ));
    // a day later, with the pin still held, only the copy may go
    s.store
        .call(|c| {
            c.execute(
                "UPDATE media SET created = created - 2 * ?1",
                [index::FLOOR_MS],
            )
        })
        .await
        .unwrap();
    s.media
        .copy(body(&png(mib, 22)), declared("image/png"))
        .await
        .unwrap();
    assert!(matches!(
        s.media.lookup(&pinned).await.unwrap(),
        Lookup::Ready(_)
    ));
    assert_eq!(s.media.lookup(&fresh).await.unwrap(), Lookup::Evicted);
    // its send settled: released, the upload may go too
    let until: i64 = s
        .store
        .call({
            let pinned = pinned.clone();
            move |c| {
                c.query_row(
                    "SELECT pinned_until FROM media WHERE id = ?1",
                    [pinned],
                    |r| r.get(0),
                )
            }
        })
        .await
        .unwrap();
    assert!(s.media.release(&pinned, until).await.unwrap());
    s.media
        .copy(body(&png(mib, 23)), declared("image/png"))
        .await
        .unwrap();
    assert_eq!(s.media.lookup(&pinned).await.unwrap(), Lookup::Evicted);
    assert!(tmp_is_empty(&s.dir).await);
}

#[tokio::test]
async fn a_sidecar_is_kept_by_media_and_thread_and_replaced_by_a_later_one() {
    let s = open(DEFAULT_MAX_BYTES).await;
    let mut note = b"\0\0\0\x20ftypM4A \0\0\0\0".to_vec();
    note.resize(4096, 7);
    let id = s
        .media
        .upload(
            body(&note),
            Declared {
                duration_ms: Some(4200),
                waveform: Some(vec![0, 128, 255]),
                ..declared("audio/mp4")
            },
        )
        .await
        .unwrap()
        .object;
    assert_eq!(id.duration_ms, Some(4200));
    assert_eq!(id.waveform.as_deref(), Some(&[0, 128, 255][..]));
    let id = id.id;
    s.media
        .put_sidecar(
            &id,
            "oc-main:oc_aaaa",
            "first try",
            Some("en"),
            Some("phone-1"),
        )
        .await
        .unwrap();
    s.media
        .put_sidecar(
            &id,
            "oc-main:oc_aaaa",
            "pick up the keys",
            Some("en"),
            Some("phone-1"),
        )
        .await
        .unwrap();
    s.media
        .put_sidecar(&id, "oc-main:oc_bbbb", "another thread", None, None)
        .await
        .unwrap();
    let kept = s
        .media
        .sidecars(std::slice::from_ref(&id), "oc-main:oc_aaaa")
        .await
        .unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].transcript, "pick up the keys");
    assert_eq!(kept[0].lang.as_deref(), Some("en"));
    // an unknown id, an id that is not audio, and fields past their caps are refused, each in its own words
    assert!(matches!(
        s.media
            .put_sidecar(&"f".repeat(64), "t", "x", None, None)
            .await,
        Err(MediaError::NoSuchMedia)
    ));
    let picture = s
        .media
        .upload(body(&png(512, 9)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    assert!(matches!(
        s.media.put_sidecar(&picture, "t", "x", None, None).await,
        Err(MediaError::NotAudio)
    ));
    for (thread, lang, device) in [
        ("", None, None),
        ("t", Some("x".repeat(LANG_BYTES + 1)), None),
        ("t", None, Some("d".repeat(DEVICE_BYTES + 1))),
    ] {
        assert!(matches!(
            s.media
                .put_sidecar(&id, thread, "x", lang.as_deref(), device.as_deref())
                .await,
            Err(MediaError::Sidecar(_))
        ));
    }
    let long_thread = "t".repeat(THREAD_BYTES + 1);
    assert!(matches!(
        s.media
            .put_sidecar(&id, &long_thread, "x", None, None)
            .await,
        Err(MediaError::Sidecar(_))
    ));
    let long = "a".repeat(TRANSCRIPT_BYTES + 1);
    assert!(matches!(
        s.media.put_sidecar(&id, "t", &long, None, None).await,
        Err(MediaError::TooLarge { .. })
    ));
}

#[tokio::test]
async fn the_startup_check_tombstones_rows_without_files_and_removes_files_without_rows() {
    let (store, _thread, dir) = scratch();
    let (media, task) = reopen(&dir, store.clone()).await;
    let kept = media
        .copy(body(&png(1000, 30)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    let lost = media
        .copy(body(&png(1000, 31)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    drop(media);
    task.await.unwrap();
    let root = dir.join("media");
    std::fs::remove_file(address(&root, &lost).unwrap()).unwrap();
    let hours_ago = std::time::SystemTime::now() - 2 * ORPHAN_GRACE;
    // an old orphan goes; a young one stays (its row may be the one a power cut lost)
    let stray = address(&root, &"ab".repeat(32)).unwrap();
    std::fs::create_dir_all(stray.parent().unwrap()).unwrap();
    std::fs::write(&stray, b"left by a crash").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&stray)
        .unwrap()
        .set_modified(hours_ago)
        .unwrap();
    let young = address(&root, &"cd".repeat(32)).unwrap();
    std::fs::create_dir_all(young.parent().unwrap()).unwrap();
    std::fs::write(&young, b"a row lost to a power cut").unwrap();
    // an old entry that cannot be removed as a file is skipped, never fatal
    let stuck = root.join("ef").join("ef".repeat(32));
    std::fs::create_dir_all(&stuck).unwrap();
    std::fs::File::open(&stuck)
        .unwrap()
        .set_modified(hours_ago)
        .unwrap();
    std::fs::write(dir.join("media/tmp/half"), b"half an upload").unwrap();
    let (media, _task) = reopen(&dir, store).await;
    assert!(matches!(
        media.lookup(&kept).await.unwrap(),
        Lookup::Ready(_)
    ));
    assert_eq!(media.lookup(&lost).await.unwrap(), Lookup::Evicted);
    assert!(!stray.exists());
    assert!(young.exists());
    assert!(stuck.exists());
    assert!(tmp_is_empty(&dir).await);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_fifth_upload_at_once_is_turned_away_busy() {
    let s = open(DEFAULT_MAX_BYTES).await;
    // four uploads whose bodies never end hold every place
    let mut held = Vec::new();
    for _ in 0..UPLOADS {
        let media = s.media.clone();
        held.push(tokio::spawn(async move {
            let endless = futures_util::stream::pending::<Result<Bytes, std::io::Error>>();
            media.upload(endless, declared("image/png")).await
        }));
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let fifth = s
        .media
        .upload(body(&png(100, 40)), declared("image/png"))
        .await
        .unwrap_err();
    assert!(matches!(fifth, MediaError::Busy), "{fifth:?}");
    for upload in held {
        upload.abort();
    }
}

#[test]
fn ids_types_and_names_are_checked_as_the_index_keeps_them() {
    assert!(is_id(&"a1".repeat(32)));
    assert!(!is_id(&"A1".repeat(32)));
    assert!(!is_id("abc"));
    assert_eq!(
        normalize_mime("Audio/WebM; codecs=opus").as_deref(),
        Some("audio/webm")
    );
    assert_eq!(normalize_mime("nonsense"), None);
    assert_eq!(normalize_mime("text/ plain"), None);
    assert_eq!(
        clean_filename("../../etc/passwd").as_deref(),
        Some("passwd")
    );
    assert_eq!(clean_filename("a\u{0}b\nc.pdf").as_deref(), Some("abc.pdf"));
    assert_eq!(clean_filename("..").as_deref(), None);
    assert_eq!(clean_filename(&"é".repeat(200)).map(|n| n.len()), Some(254));
}

#[tokio::test]
async fn a_copy_with_no_type_or_a_long_name_is_kept_under_what_the_index_can_hold() {
    // the probe that broke the store: an agent with no mime and a 300 character name
    let s = open(DEFAULT_MAX_BYTES).await;
    let blank = s
        .media
        .copy(body(&png(4096, 50)), declared(""))
        .await
        .unwrap();
    assert_eq!(
        blank.object.mime, "image/png",
        "the bytes name what the agent did not"
    );
    let unknown = s
        .media
        .copy(body(b"just some words"), declared("not a type"))
        .await
        .unwrap();
    assert_eq!(unknown.object.mime, "application/octet-stream");
    let named = s
        .media
        .copy(
            body(&png(4096, 51)),
            Declared {
                filename: Some(format!("{}.png", "n".repeat(300))),
                waveform: Some(vec![1; 65]),
                ..declared("image/png")
            },
        )
        .await
        .unwrap();
    assert_eq!(
        named.object.filename.as_deref().map(str::len),
        Some(FILENAME_BYTES)
    );
    assert_eq!(
        named.object.waveform, None,
        "a waveform past 64 values is dropped"
    );
}

#[tokio::test]
async fn a_commit_that_fails_its_row_write_loses_no_victim_and_leaves_no_file() {
    let s = open(3 * MIB).await;
    let half = usize::try_from(MIB).unwrap() * 3 / 2;
    let a = s
        .media
        .copy(body(&png(half, 60)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    let b = s
        .media
        .copy(body(&png(half, 61)), declared("image/png"))
        .await
        .unwrap()
        .object
        .id;
    age_everything(&s.store).await;
    // a row the index refuses (an empty type, past the take's own cleaning), at a size that must evict both
    let root = s.dir.join("media");
    let tmp = root.join("tmp").join("arriving");
    let bytes = png(half, 62);
    std::fs::write(&tmp, &bytes).unwrap();
    let id = data_encoding::HEXLOWER.encode(&sha2::Sha256::digest(&bytes));
    let address = address(&root, &id).unwrap();
    let failed = s
        .store
        .call({
            let (tmp, address, root, id) = (tmp.clone(), address.clone(), root.clone(), id.clone());
            move |c| {
                let object = MediaObject {
                    id,
                    mime: String::new(),
                    size: bytes.len() as u64,
                    filename: None,
                    duration_ms: None,
                    waveform: None,
                    width: None,
                    height: None,
                };
                index::commit(
                    c,
                    &index::Arrival {
                        object: &object,
                        origin: Origin::Agent,
                        tmp: &tmp,
                        address: &address,
                        root: &root,
                        pinned_until: None,
                        now: crate::now_ms(),
                    },
                    3 * u64::try_from(half).unwrap() - u64::try_from(half).unwrap(),
                    3 * MIB,
                )
            }
        })
        .await;
    assert!(failed.is_err(), "the row write failed: {failed:?}");
    // both victims are still live and readable, and the new file is gone with its row
    for victim in [&a, &b] {
        assert!(matches!(
            s.media.lookup(victim).await.unwrap(),
            Lookup::Ready(_)
        ));
        assert!(s.media.path_of(victim).unwrap().is_file());
    }
    assert!(!address.exists());
    assert_eq!(s.media.lookup(&id).await.unwrap(), Lookup::Unknown);
}

#[tokio::test]
async fn a_stalled_upload_gives_its_place_back_after_its_idle_time() {
    let timing = Timing {
        idle: std::time::Duration::from_millis(200),
        deadline: std::time::Duration::from_secs(60),
    };
    let s = open_timed(DEFAULT_MAX_BYTES, timing, CancellationToken::new()).await;
    let mut held = Vec::new();
    for n in 0..UPLOADS {
        let media = s.media.clone();
        held.push(tokio::spawn(async move {
            let first = Bytes::from(png(1000, u8::try_from(n).unwrap()));
            let stalled = Box::pin(
                futures_util::stream::iter(vec![Ok::<_, std::io::Error>(first)])
                    .chain(futures_util::stream::pending()),
            );
            media.upload(stalled, declared("image/png")).await
        }));
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let fifth = s
        .media
        .upload(body(&png(100, 70)), declared("image/png"))
        .await;
    assert!(matches!(fifth, Err(MediaError::Busy)), "{fifth:?}");
    for upload in held {
        let ended = upload.await.unwrap();
        assert!(matches!(ended, Err(MediaError::Source(_))), "{ended:?}");
    }
    s.media
        .upload(body(&png(100, 70)), declared("image/png"))
        .await
        .unwrap();
    assert!(tmp_is_empty(&s.dir).await);
}

#[tokio::test]
async fn shutdown_ends_every_stalled_upload() {
    let shutdown = CancellationToken::new();
    let s = open_timed(DEFAULT_MAX_BYTES, Timing::default(), shutdown.clone()).await;
    let media = s.media.clone();
    let stalled = tokio::spawn(async move {
        let endless = futures_util::stream::pending::<Result<Bytes, std::io::Error>>();
        media.upload(endless, declared("image/png")).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    shutdown.cancel();
    let ended = tokio::time::timeout(std::time::Duration::from_secs(2), stalled)
        .await
        .expect("the upload ended with the server")
        .unwrap();
    assert!(matches!(ended, Err(MediaError::Stopping)), "{ended:?}");
}

#[tokio::test]
async fn an_id_that_is_not_an_id_never_becomes_a_path() {
    let s = open(DEFAULT_MAX_BYTES).await;
    for bad in [
        "../../../../etc/passwd",
        "ab/../../x",
        &"A".repeat(64),
        &"a".repeat(63),
        &"a".repeat(65),
        "",
    ] {
        assert_eq!(s.media.path_of(bad), None, "{bad}");
        assert_eq!(address(Path::new("/data/media"), bad), None, "{bad}");
    }
    let good = "a".repeat(64);
    assert_eq!(
        address(Path::new("/data/media"), &good),
        Some(PathBuf::from(format!("/data/media/aa/{good}")))
    );
}

#[tokio::test]
async fn a_file_nobody_typed_is_kept_under_the_type_its_bytes_show() {
    let s = open(DEFAULT_MAX_BYTES).await;
    let mut note = b"\0\0\0\x20ftypM4A \0\0\0\0".to_vec();
    note.resize(2048, 3);
    let copied = s
        .media
        .copy(body(&note), declared("application/octet-stream"))
        .await
        .unwrap();
    assert_eq!(copied.object.mime, "audio/mp4");
    let uploaded = s
        .media
        .upload(body(&png(700, 80)), declared("application/octet-stream"))
        .await
        .unwrap();
    assert_eq!(uploaded.object.mime, "image/png");
    // a duplicate may upgrade a generic type it was first kept under
    let first = s
        .media
        .upload(
            body(b"%PDF? not really"),
            declared("application/octet-stream"),
        )
        .await
        .unwrap();
    assert_eq!(first.object.mime, "application/octet-stream");
    let again = s
        .media
        .upload(body(b"%PDF? not really"), declared("text/plain"))
        .await
        .unwrap();
    assert!(again.duplicate);
    assert_eq!(again.object.mime, "text/plain");
    // but never a specific one
    let third = s
        .media
        .upload(body(b"%PDF? not really"), declared("application/x-other"))
        .await
        .unwrap();
    assert_eq!(third.object.mime, "text/plain");
}

#[tokio::test]
async fn a_pin_only_lengthens_and_only_its_own_holder_releases_it() {
    let s = open(DEFAULT_MAX_BYTES).await;
    let first = s
        .media
        .upload(body(&png(900, 90)), declared("image/png"))
        .await
        .unwrap();
    let id = first.object.id.clone();
    let mine = first.pinned_until.unwrap();
    // a second send of the same bytes holds it longer
    let later = mine + 60_000;
    assert!(s.media.pin(&id, later).await.unwrap());
    assert!(
        s.media.pin(&id, mine - 1).await.unwrap(),
        "a shorter pin is a no-op, not an error"
    );
    // the first send settling does not cut the second's pin
    assert!(!s.media.release(&id, mine).await.unwrap());
    assert!(s.media.release(&id, later).await.unwrap());
}
