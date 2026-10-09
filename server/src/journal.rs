//! the journal: a ring of the fleet's changes, each already written as the
//! exact sse frame every client receives.
//!
//! it is boxbox's own cursor (architecture: a cursor at every hop). the
//! fleet actor appends; client streams replay from it by seq and then go
//! live. an entry is serialized once, here, and shared by reference with
//! every listener (`Bytes`), so a hundred phones cost one serialization.
//! seq is contiguous within an epoch, and the epoch is minted fresh at each
//! server start, so a cursor from before a restart can never be mistaken
//! for one into this ring.

use std::collections::VecDeque;
use std::fmt;

use bytes::{BufMut, Bytes, BytesMut};

/// the ring's byte cap (architecture: memory caps).
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
/// the ring's entry cap; whichever cap is reached first evicts.
pub const MAX_ENTRIES: usize = 100_000;

/// a position in a stream: `<epoch>:<seq>`, the sse `id` of an entry. cmx2
/// cursors have the same shape, so the upstream watcher uses it too.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub epoch: String,
    pub seq: u64,
}

impl Cursor {
    /// reads `<epoch>:<seq>`; the epoch is everything before the last colon.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let (epoch, seq) = text.trim().rsplit_once(':')?;
        if epoch.is_empty() || seq.is_empty() || !seq.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(Self {
            epoch: epoch.to_owned(),
            seq: seq.parse().ok()?,
        })
    }
}

impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.epoch, self.seq)
    }
}

/// why a replay cannot start where it was asked to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gap {
    /// the entries after the cursor have been evicted.
    Evicted,
    /// the cursor is past the head: it was never issued by this ring.
    Ahead,
}

/// some consecutive entries, in order.
#[derive(Debug, Default)]
pub struct Page {
    pub frames: Vec<Bytes>,
    /// the seq of the last frame, or the cursor itself when the page is empty.
    pub last: u64,
}

#[derive(Debug)]
struct Entry {
    seq: u64,
    frame: Bytes,
}

#[derive(Debug)]
pub struct Journal {
    epoch: String,
    head: u64,
    entries: VecDeque<Entry>,
    bytes: usize,
    max_bytes: usize,
    max_entries: usize,
}

impl Journal {
    #[must_use]
    pub fn new(epoch: String) -> Self {
        Self::with_caps(epoch, MAX_BYTES, MAX_ENTRIES)
    }

    #[must_use]
    pub fn with_caps(epoch: String, max_bytes: usize, max_entries: usize) -> Self {
        Self {
            epoch,
            head: 0,
            entries: VecDeque::new(),
            bytes: 0,
            max_bytes,
            max_entries,
        }
    }

    #[must_use]
    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// the seq of the newest entry; 0 before the first.
    #[must_use]
    pub fn head(&self) -> u64 {
        self.head
    }

    /// the seq of the oldest entry still held; `head + 1` when none is.
    #[must_use]
    pub fn floor(&self) -> u64 {
        self.entries.front().map_or(self.head + 1, |e| e.seq)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// appends the next entry. `body` gets the entry's seq and returns its
    /// json (a single object); `None` appends nothing and uses no seq.
    pub fn append(&mut self, body: impl FnOnce(u64) -> Option<Vec<u8>>) -> Option<Bytes> {
        let seq = self.head + 1;
        let json = body(seq)?;
        let frame = sse_frame(Some(&format!("{}:{seq}", self.epoch)), &json);
        self.head = seq;
        self.bytes += frame.len();
        self.entries.push_back(Entry {
            seq,
            frame: frame.clone(),
        });
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            match self.entries.pop_front() {
                Some(evicted) => self.bytes -= evicted.frame.len(),
                None => break,
            }
        }
        Some(frame)
    }

    /// the entries after `after`, at most `max_bytes` of them (always at
    /// least one when any follow).
    ///
    /// # Errors
    /// `after` is past the head, or entries after it were evicted.
    pub fn page(&self, after: u64, max_bytes: usize) -> Result<Page, Gap> {
        if after > self.head {
            return Err(Gap::Ahead);
        }
        if after + 1 < self.floor() {
            return Err(Gap::Evicted);
        }
        let mut page = Page {
            frames: Vec::new(),
            last: after,
        };
        let start = usize::try_from(after + 1 - self.floor()).unwrap_or(usize::MAX);
        let mut bytes = 0;
        for entry in self.entries.iter().skip(start) {
            if !page.frames.is_empty() && bytes + entry.frame.len() > max_bytes {
                break;
            }
            bytes += entry.frame.len();
            page.last = entry.seq;
            page.frames.push(entry.frame.clone());
        }
        Ok(page)
    }
}

/// one sse frame: an optional `id:` line, then the json on `data:` lines.
/// the json is compact in practice, but a raw daemon object could carry a
/// newline between tokens, and a bare newline would end the frame early,
/// so every line of it gets its own `data:` prefix, as the spec reassembles.
#[must_use]
pub fn sse_frame(id: Option<&str>, json: &[u8]) -> Bytes {
    let mut frame = BytesMut::with_capacity(json.len() + 48);
    if let Some(id) = id {
        frame.put_slice(b"id: ");
        frame.put_slice(id.as_bytes());
        frame.put_u8(b'\n');
    }
    for line in json.split(|&b| b == b'\n') {
        frame.put_slice(b"data: ");
        frame.put_slice(line.strip_suffix(b"\r").unwrap_or(line));
        frame.put_u8(b'\n');
    }
    frame.put_u8(b'\n');
    frame.freeze()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(n: usize) -> impl FnOnce(u64) -> Option<Vec<u8>> {
        move |seq| Some(format!("{{\"seq\":{seq},\"pad\":\"{}\"}}", "x".repeat(n)).into_bytes())
    }

    #[test]
    fn a_cursor_reads_its_own_display_and_refuses_junk() {
        let cursor = Cursor::parse("a1b2c3:42").unwrap();
        assert_eq!((cursor.epoch.as_str(), cursor.seq), ("a1b2c3", 42));
        assert_eq!(cursor.to_string(), "a1b2c3:42");
        // an epoch may itself hold a colon; the seq is after the last one
        assert_eq!(Cursor::parse("x:y:7").unwrap().epoch, "x:y");
        for junk in [
            "",
            "42",
            ":42",
            "abc:",
            "abc:-1",
            "abc:1e3",
            "abc:99999999999999999999",
        ] {
            assert_eq!(Cursor::parse(junk), None, "{junk:?}");
        }
    }

    #[test]
    fn entries_are_numbered_from_one_and_framed_with_their_cursor() {
        let mut journal = Journal::new("ep".into());
        assert_eq!((journal.head(), journal.floor()), (0, 1));
        let frame = journal
            .append(|seq| Some(format!("{{\"seq\":{seq}}}").into_bytes()))
            .unwrap();
        assert_eq!(&frame[..], b"id: ep:1\ndata: {\"seq\":1}\n\n");
        assert_eq!((journal.head(), journal.floor(), journal.len()), (1, 1, 1));
    }

    #[test]
    fn a_body_that_declines_uses_no_seq() {
        let mut journal = Journal::new("ep".into());
        assert!(journal.append(|_| None).is_none());
        journal.append(body(1));
        assert_eq!(journal.head(), 1);
    }

    #[test]
    fn a_newline_inside_the_json_cannot_end_the_frame() {
        let frame = sse_frame(None, b"{\"a\":\n1}");
        assert_eq!(&frame[..], b"data: {\"a\":\ndata: 1}\n\n");
    }

    #[test]
    fn the_entry_cap_evicts_the_oldest() {
        let mut journal = Journal::with_caps("ep".into(), usize::MAX, 3);
        for _ in 0..5 {
            journal.append(body(1));
        }
        assert_eq!((journal.floor(), journal.head(), journal.len()), (3, 5, 3));
    }

    #[test]
    fn the_byte_cap_evicts_the_oldest_and_counts_what_it_holds() {
        let mut journal = Journal::with_caps("ep".into(), 1000, usize::MAX);
        for _ in 0..20 {
            journal.append(body(100));
        }
        assert!(journal.bytes() <= 1000, "{}", journal.bytes());
        let held: usize = journal
            .page(journal.floor() - 1, usize::MAX)
            .unwrap()
            .frames
            .iter()
            .map(Bytes::len)
            .sum();
        assert_eq!(held, journal.bytes());
        assert_eq!(journal.head(), 20);
        assert!(journal.floor() > 1);
    }

    #[test]
    fn a_replay_starts_right_after_the_cursor_and_pages_by_bytes() {
        let mut journal = Journal::new("ep".into());
        for _ in 0..10 {
            journal.append(body(10));
        }
        let one = journal.page(0, usize::MAX).unwrap();
        assert_eq!((one.frames.len(), one.last), (10, 10));
        assert!(one.frames[0].starts_with(b"id: ep:1\n"));

        let frame_len = one.frames[0].len();
        let paged = journal.page(3, frame_len * 2).unwrap();
        assert_eq!((paged.frames.len(), paged.last), (2, 5));
        assert!(paged.frames[0].starts_with(b"id: ep:4\n"));

        // a page always carries at least one entry, however small the budget
        assert_eq!(journal.page(3, 1).unwrap().frames.len(), 1);
        // at the head: nothing to send, and the cursor stays where it was
        let empty = journal.page(10, usize::MAX).unwrap();
        assert_eq!((empty.frames.len(), empty.last), (0, 10));
    }

    #[test]
    fn a_cursor_behind_the_floor_or_past_the_head_is_a_gap() {
        let mut journal = Journal::with_caps("ep".into(), usize::MAX, 3);
        for _ in 0..5 {
            journal.append(body(1));
        }
        // floor is 3: a cursor at 2 still replays from 3, one at 1 lost seq 2
        assert!(journal.page(2, usize::MAX).is_ok());
        assert_eq!(journal.page(1, usize::MAX).unwrap_err(), Gap::Evicted);
        assert_eq!(journal.page(6, usize::MAX).unwrap_err(), Gap::Ahead);
    }
}
