//! media references (`docs/protocol.md`, section 13): a part that carries
//! its bytes as a `data:` url (a file or image part, or one in a tool's
//! `state.attachments`) is copied into the media store and goes to devices
//! as `media: {id, state: "ready"}` with its `size`, and an image with its
//! `width` and `height` from its header, so a read never carries the bytes
//! again. the copy is awaited before the part goes on; when the store
//! refuses it (full, busy, past a cap), the part keeps its `data:` url and
//! shows as it does today.
//!
//! a source copies at most 2 urls at once and queues 64 more (`IN_FLIGHT`,
//! `QUEUED`), each also waiting its turn for the store's own `COPIES`;
//! one past the queue keeps its url, as a refusal does. a url already
//! copied is not copied again: the source remembers the last 1,024 urls it
//! copied (`REMEMBERED`), by the sha256 of the url, and answers the id the
//! store still holds.
//!
//! off until the app reads references (a3's merge flips
//! `MEDIA_REFERENCES`): until then parts keep their urls, as today.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::{Arc, Mutex, PoisonError};

use axum::body::Bytes;
use base64ct::{Base64, Encoding};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tracing::info;

use crate::media::{Declared, Lookup, Media, normalize_mime};
use crate::source::MessageWithParts;
use crate::wire::{MediaRef, MediaState, Part};

/// whether thread reads send media references instead of `data:` urls.
pub const MEDIA_REFERENCES: bool = false;

/// copies a source runs at once.
pub const IN_FLIGHT: usize = 2;
/// copies a source queues behind those; one more keeps its url.
pub const QUEUED: usize = 64;
/// the urls a source remembers it copied, oldest out. an entry is a 32
/// byte key, the id (64 bytes) and the image's size: about 150 KiB at most.
pub const REMEMBERED: usize = 1024;

/// one source's media references: the store, its turns and what it copied.
/// cheap to clone; every clone shares the same turns and memory.
#[derive(Debug, Clone)]
pub struct Refs {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    media: Media,
    /// `IN_FLIGHT + QUEUED`: a copy holds one from before it waits until it
    /// is done, so past them a url stays inline.
    queue: Semaphore,
    /// `IN_FLIGHT`.
    turns: Semaphore,
    copied: Mutex<Copied>,
}

/// a copied url: the id the store gave its bytes, and an image's size.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Done {
    id: String,
    dims: Option<(u32, u32)>,
}

/// the urls copied, by the sha256 of the url, oldest out past `REMEMBERED`.
/// keyed by the url, not its bytes: a hit then skips the decode and the
/// copy both, and a url whose bytes another url already carries is only a
/// miss, which the store's own content dedupe catches.
#[derive(Debug, Default)]
struct Copied {
    done: HashMap<[u8; 32], Done>,
    order: VecDeque<[u8; 32]>,
}

impl Copied {
    fn get(&self, key: &[u8; 32]) -> Option<Done> {
        self.done.get(key).cloned()
    }

    fn insert(&mut self, key: [u8; 32], done: Done) {
        if self.done.insert(key, done).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > REMEMBERED {
            if let Some(oldest) = self.order.pop_front() {
                self.done.remove(&oldest);
            }
        }
    }

    fn forget(&mut self, key: &[u8; 32]) {
        if self.done.remove(key).is_some() {
            self.order.retain(|k| k != key);
        }
    }
}

/// what a copy answers: the id, the stored size, and an image's size.
struct Reference {
    id: String,
    size: u64,
    dims: Option<(u32, u32)>,
}

impl Refs {
    #[must_use]
    pub fn new(media: Media) -> Self {
        Self {
            inner: Arc::new(Inner {
                media,
                queue: Semaphore::new(IN_FLIGHT + QUEUED),
                turns: Semaphore::new(IN_FLIGHT),
                copied: Mutex::new(Copied::default()),
            }),
        }
    }

    fn copied(&self) -> std::sync::MutexGuard<'_, Copied> {
        self.inner
            .copied
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// the store's reference for the url's bytes, none when it refused or
    /// the queue is full.
    async fn copy(&self, url: &str, filename: Option<&str>, mime: &str) -> Option<Reference> {
        let media = &self.inner.media;
        let key: [u8; 32] = Sha256::digest(url.as_bytes()).into();
        let remembered = self.copied().get(&key);
        if let Some(done) = remembered {
            if let Ok(Lookup::Ready(object)) = media.lookup(&done.id).await {
                return Some(Reference {
                    id: object.id,
                    size: object.size,
                    dims: done.dims,
                });
            }
            self.copied().forget(&key);
        }
        let Ok(_queued) = self.inner.queue.try_acquire() else {
            info!("a data url stays inline: this connection's copy queue is full");
            return None;
        };
        let _turn = self.inner.turns.acquire().await.ok()?;
        let (said, bytes) = decode(url)?;
        let dims = dimensions(&bytes);
        let mime = normalize_mime(mime).or_else(|| normalize_mime(&said))?;
        let length = u64::try_from(bytes.len()).ok()?;
        let body = futures_util::stream::iter([Ok::<_, Infallible>(Bytes::from(bytes))]);
        let declared = Declared {
            mime,
            filename: filename.map(str::to_owned),
            length: Some(length),
            ..Declared::default()
        };
        match media.copy_waiting(body, declared).await {
            Ok(stored) => {
                let id = stored.object.id;
                self.copied().insert(
                    key,
                    Done {
                        id: id.clone(),
                        dims,
                    },
                );
                Some(Reference {
                    id,
                    size: stored.object.size,
                    dims,
                })
            }
            Err(error) => {
                info!(%error, "a data url stays inline: the media store did not take it");
                None
            }
        }
    }
}

/// copies every `data:` url in the message and swaps in its reference.
pub async fn reference(refs: &Refs, message: &mut MessageWithParts) {
    for part in &mut message.parts {
        reference_part(refs, part).await;
    }
}

async fn reference_part(refs: &Refs, part: &mut Part) {
    match part {
        Part::File(file) => {
            let Some(url) = file.url.as_deref() else {
                return;
            };
            if let Some(copied) = refs.copy(url, Some(&file.filename), &file.mime).await {
                file.media = Some(ready(copied.id));
                file.size = Some(copied.size);
                file.url = None;
            }
        }
        Part::Image(image) => {
            let Some(url) = image.url.as_deref() else {
                return;
            };
            if let Some(copied) = refs.copy(url, image.filename.as_deref(), &image.mime).await {
                image.media = Some(ready(copied.id));
                image.size = Some(copied.size);
                image.url = None;
                if let Some((w, h)) = copied.dims {
                    image.width = Some(w);
                    image.height = Some(h);
                }
            }
        }
        Part::Tool(tool) => {
            if let Some(attachments) = tool.state.attachments.as_mut() {
                for attachment in attachments {
                    Box::pin(reference_part(refs, attachment)).await;
                }
            }
        }
        _ => {}
    }
}

fn ready(id: String) -> MediaRef {
    MediaRef {
        id: Some(id),
        state: MediaState::Ready,
    }
}

/// a base64 `data:` url's media type and bytes.
#[must_use]
pub fn decode(url: &str) -> Option<(String, Vec<u8>)> {
    let rest = url.strip_prefix("data:")?;
    let (head, data) = rest.split_once(',')?;
    let mime = head.strip_suffix(";base64")?;
    let bytes = Base64::decode_vec(data.trim()).ok()?;
    Some((mime.to_owned(), bytes))
}

/// an image's width and height from its header: png, gif, jpeg, webp.
#[must_use]
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let be16 = |i: usize| {
        Some(u32::from(u16::from_be_bytes([
            *bytes.get(i)?,
            *bytes.get(i + 1)?,
        ])))
    };
    let le16 = |i: usize| {
        Some(u32::from(u16::from_le_bytes([
            *bytes.get(i)?,
            *bytes.get(i + 1)?,
        ])))
    };
    let be32 = |i: usize| Some(u32::from_be_bytes(bytes.get(i..i + 4)?.try_into().ok()?));
    let le24 = |i: usize| {
        let b = bytes.get(i..i + 3)?;
        Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
    };
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") {
        return Some((be32(16)?, be32(20)?));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some((le16(6)?, le16(8)?));
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return match bytes.get(12..16)? {
            b"VP8 " => Some((le16(26)? & 0x3fff, le16(28)? & 0x3fff)),
            b"VP8L" => {
                let b = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                Some(((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1))
            }
            b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
            _ => None,
        };
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut i = 2;
        while i + 4 <= bytes.len() {
            if bytes[i] != 0xff {
                return None;
            }
            let marker = bytes[i + 1];
            if marker == 0xff {
                i += 1;
                continue;
            }
            let len = usize::try_from(be16(i + 2)?).ok()?;
            let frame = matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
            if frame {
                return Some((be16(i + 7)?, be16(i + 5)?));
            }
            i += 2 + len;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_says_its_size() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(dimensions(&png), Some((640, 480)));
        let gif = [b"GIF89a".as_slice(), &[0x20, 0x01, 0x10, 0x00]].concat();
        assert_eq!(dimensions(&gif), Some((288, 16)));
        // a jpeg: an app0 segment, then a baseline frame of 300 by 200.
        let jpeg = [
            &[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00][..],
            &[0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c],
        ]
        .concat();
        assert_eq!(dimensions(&jpeg), Some((300, 200)));
        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        vp8x.extend_from_slice(&[0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
        assert_eq!(dimensions(&vp8x), Some((640, 480)));
        assert_eq!(dimensions(b"not an image"), None);
    }

    #[test]
    fn only_a_base64_data_url_decodes() {
        assert_eq!(
            decode("data:image/png;base64,aGk="),
            Some(("image/png".to_owned(), b"hi".to_vec()))
        );
        assert_eq!(decode("data:text/plain,hi"), None);
        assert_eq!(decode("https://example.com/a.png"), None);
    }

    #[test]
    fn references_are_off_until_the_app_reads_them() {
        const { assert!(!MEDIA_REFERENCES) };
    }
    fn message_with(url: &str) -> MessageWithParts {
        let raw = serde_json::json!({
            "info": {"id": "msg_1", "role": "user", "time": {"created": 1}},
            "parts": [{"id": "prt_1", "messageID": "msg_1", "type": "file", "mime": "image/gif", "filename": "dot.gif", "url": url}]
        });
        crate::source::cmx2::verbs::read::element(&serde_json::to_vec(&raw).unwrap()).unwrap()
    }

    /// a 1 by 1 gif.
    const GIF: &str =
        "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

    #[tokio::test]
    async fn a_data_url_becomes_a_reference_to_the_same_bytes() {
        let (store, _thread, dir) = crate::store::tests::scratch();
        let (media, _task) = Media::open(
            &dir,
            store,
            crate::media::DEFAULT_MAX_BYTES,
            crate::telemetry::Sender::detached(),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        let mut message = message_with(GIF);
        let before = serde_json::to_value(&message.parts[0]).unwrap();
        reference(&Refs::new(media.clone()), &mut message).await;
        let after = serde_json::to_value(&message.parts[0]).unwrap();
        assert_ne!(before, after, "{after}");
        assert!(after.get("url").is_none(), "{after}");
        let id = after["media"]["id"].as_str().unwrap().to_owned();
        assert_eq!(after["media"]["state"], "ready");
        // an image part takes its size from the one decode
        assert_eq!(
            (after["width"].as_u64(), after["height"].as_u64()),
            (Some(1), Some(1)),
            "{after}"
        );
        let (_, bytes) = decode(GIF).unwrap();
        assert_eq!(after["size"], bytes.len() as u64);
        // the store holds the url's bytes, byte for byte.
        let path = media.path_of(&id).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[tokio::test]
    async fn a_store_that_refuses_leaves_the_url() {
        let mut message = message_with(GIF);
        let before = serde_json::to_value(&message.parts[0]).unwrap();
        reference(&Refs::new(Media::detached()), &mut message).await;
        assert_eq!(serde_json::to_value(&message.parts[0]).unwrap(), before);
    }

    async fn media() -> (Media, std::path::PathBuf) {
        let (store, _thread, dir) = crate::store::tests::scratch();
        let (media, _task) = Media::open(
            &dir,
            store,
            crate::media::DEFAULT_MAX_BYTES,
            crate::telemetry::Sender::detached(),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        (media, dir)
    }

    fn referenced(message: &MessageWithParts) -> Option<String> {
        let part = serde_json::to_value(&message.parts[0]).unwrap();
        part["media"]["id"].as_str().map(str::to_owned)
    }

    /// a 1 by 1 png, so a second url with other bytes.
    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[tokio::test]
    async fn a_url_copied_once_is_referenced_again_without_a_copy() {
        let (media, _dir) = media().await;
        let refs = Refs::new(media);
        let mut first = message_with(GIF);
        reference(&refs, &mut first).await;
        let id = referenced(&first).unwrap();
        // every queue place taken: any copy now would keep its url
        let _full = refs
            .inner
            .queue
            .try_acquire_many(u32::try_from(IN_FLIGHT + QUEUED).unwrap())
            .unwrap();
        let mut again = message_with(GIF);
        reference(&refs, &mut again).await;
        assert_eq!(referenced(&again), Some(id), "remembered, not copied");
        let part = serde_json::to_value(&again.parts[0]).unwrap();
        assert_eq!(
            part["width"], 1,
            "a remembered image keeps its size: {part}"
        );
        let mut other = message_with(PNG);
        reference(&refs, &mut other).await;
        assert_eq!(referenced(&other), None, "past the queue, the url stays");
    }

    #[tokio::test]
    async fn a_remembered_id_the_store_no_longer_holds_is_copied_again() {
        let (media, _dir) = media().await;
        let refs = Refs::new(media);
        let key: [u8; 32] = Sha256::digest(GIF.as_bytes()).into();
        let gone = "0".repeat(64);
        refs.copied().insert(
            key,
            Done {
                id: gone.clone(),
                dims: None,
            },
        );
        let mut message = message_with(GIF);
        reference(&refs, &mut message).await;
        let id = referenced(&message).unwrap();
        assert_ne!(id, gone);
        assert_eq!(refs.copied().get(&key).map(|d| d.id), Some(id));
    }

    #[tokio::test]
    async fn a_copy_waits_for_its_connections_turn() {
        let (media, _dir) = media().await;
        let refs = Refs::new(media);
        let turns = refs
            .inner
            .turns
            .try_acquire_many(u32::try_from(IN_FLIGHT).unwrap())
            .unwrap();
        let waiting = {
            let refs = refs.clone();
            tokio::spawn(async move {
                let mut message = message_with(GIF);
                reference(&refs, &mut message).await;
                referenced(&message)
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "queued behind the two in flight");
        drop(turns);
        assert!(
            waiting.await.unwrap().is_some(),
            "copied once its turn came"
        );
    }

    #[test]
    fn the_oldest_url_goes_past_the_cap() {
        let mut copied = Copied::default();
        let key = |i: usize| -> [u8; 32] { Sha256::digest(i.to_be_bytes()).into() };
        for i in 0..=REMEMBERED {
            copied.insert(
                key(i),
                Done {
                    id: i.to_string(),
                    dims: None,
                },
            );
        }
        assert_eq!(copied.done.len(), REMEMBERED);
        assert_eq!(copied.order.len(), REMEMBERED);
        assert!(copied.get(&key(0)).is_none());
        assert!(copied.get(&key(1)).is_some() && copied.get(&key(REMEMBERED)).is_some());
    }
}
