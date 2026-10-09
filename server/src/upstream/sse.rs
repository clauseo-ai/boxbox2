//! a server-sent-events decoder over raw bytes.
//!
//! written by hand rather than taken from a crate because two limits are
//! the point of it: one frame may not grow past a byte cap (an oversized
//! frame is skipped and counted, and the stream survives), and it does no
//! io of its own, so the caller owns the byte-level stall timer.
//!
//! lines end in `\n` or `\r\n`. a blank line dispatches the frame;
//! `data:` lines join with `\n`; comments (`:`) and fields other than
//! `data` are read and dropped, since cmx2 sends neither `id:` nor
//! `event:` yet (cmx2-asks a1 adds `id:`, and m2 reads it here).

/// what one complete frame came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Item {
    /// the frame's data, `data:` lines joined with `\n`.
    Frame(String),
    /// a frame past the cap, dropped whole; the stream goes on.
    Oversized { bytes: usize },
    /// a frame whose data is not utf-8.
    NotUtf8 { bytes: usize },
}

#[derive(Debug)]
pub struct Decoder {
    cap: usize,
    /// the line being read, without its terminator (empty while discarding).
    line: Vec<u8>,
    /// the line's length as it arrived, kept or not, so a discarded line is
    /// never mistaken for the blank line that ends a frame.
    raw_len: usize,
    /// the line's last byte as it arrived, to see a `\r\n` blank line.
    raw_last: u8,
    /// the current frame's data so far.
    data: Vec<u8>,
    /// the frame had at least one `data` field (an empty one counts).
    has_data: bool,
    /// bytes of the current frame, counted even while discarding.
    frame_bytes: usize,
    /// the current frame passed the cap; discard until the blank line.
    discarding: bool,
}

impl Decoder {
    #[must_use]
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            line: Vec::new(),
            raw_len: 0,
            raw_last: 0,
            data: Vec::new(),
            has_data: false,
            frame_bytes: 0,
            discarding: false,
        }
    }

    /// feeds bytes as they arrived; complete frames are pushed to `out`.
    pub fn push(&mut self, mut chunk: &[u8], out: &mut Vec<Item>) {
        while !chunk.is_empty() {
            let (head, rest, complete) = match chunk.iter().position(|&b| b == b'\n') {
                Some(at) => (&chunk[..at], &chunk[at + 1..], true),
                None => (chunk, &[][..], false),
            };
            chunk = rest;
            self.frame_bytes += head.len() + usize::from(complete);
            if let Some(&last) = head.last() {
                self.raw_len += head.len();
                self.raw_last = last;
            }
            if !self.discarding {
                if self.data.len() + self.line.len() + head.len() > self.cap {
                    self.discard();
                } else {
                    self.line.extend_from_slice(head);
                }
            }
            if complete {
                self.end_line(out);
            }
        }
    }

    fn end_line(&mut self, out: &mut Vec<Item>) {
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        let blank = self.raw_len == 0 || (self.raw_len == 1 && self.raw_last == b'\r');
        self.raw_len = 0;
        if blank {
            self.dispatch(out);
        } else if !self.discarding {
            self.field();
        }
        self.line.clear();
    }

    fn field(&mut self) {
        let line = self.line.as_slice();
        if line.first() == Some(&b':') {
            return;
        }
        let (name, value) = match line.iter().position(|&b| b == b':') {
            Some(at) => {
                let value = &line[at + 1..];
                (&line[..at], value.strip_prefix(b" ").unwrap_or(value))
            }
            None => (line, &[][..]),
        };
        if name == b"data" {
            if self.has_data {
                self.data.push(b'\n');
            }
            self.data.extend_from_slice(value);
            self.has_data = true;
        }
    }

    fn dispatch(&mut self, out: &mut Vec<Item>) {
        let bytes = self.frame_bytes;
        if self.discarding {
            out.push(Item::Oversized { bytes });
        } else if self.has_data {
            let data = std::mem::take(&mut self.data);
            out.push(match String::from_utf8(data) {
                Ok(text) => Item::Frame(text),
                Err(_) => Item::NotUtf8 { bytes },
            });
        }
        self.data.clear();
        self.has_data = false;
        self.frame_bytes = 0;
        self.discarding = false;
    }

    fn discard(&mut self) {
        self.discarding = true;
        self.line = Vec::new();
        self.data = Vec::new();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(cap: usize, chunks: &[&[u8]]) -> Vec<Item> {
        let mut decoder = Decoder::new(cap);
        let mut out = Vec::new();
        for chunk in chunks {
            decoder.push(chunk, &mut out);
        }
        out
    }

    fn frame(text: &str) -> Item {
        Item::Frame(text.into())
    }

    #[test]
    fn frames_survive_every_split_point() {
        let stream = b"data: {\"a\":1}\n\n: keepalive\n\ndata: two\ndata: lines\r\n\r\n";
        for split in 0..=stream.len() {
            let (a, b) = stream.split_at(split);
            assert_eq!(
                decode(1024, &[a, b]),
                [frame("{\"a\":1}"), frame("two\nlines")],
                "split at {split}"
            );
        }
    }

    #[test]
    fn byte_at_a_time_matches_whole() {
        let stream = b"data:x\n\ndata: y\nevent: e\nid: 1\n\n";
        let bytes: Vec<&[u8]> = stream.chunks(1).collect();
        assert_eq!(decode(64, &bytes), [frame("x"), frame("y")]);
    }

    #[test]
    fn comments_and_blank_frames_dispatch_nothing() {
        assert_eq!(decode(64, &[b": ping\n\n\n\nretry: 5\n\n"]), []);
        assert_eq!(
            decode(64, &[b"data\n\n"]),
            [frame("")],
            "an empty data field still counts"
        );
    }

    #[test]
    fn an_oversized_frame_is_skipped_and_the_next_one_arrives() {
        let big = format!("data: {}\n\n", "x".repeat(100));
        let out = decode(32, &[big.as_bytes(), b"data: ok\n\n"]);
        assert_eq!(out, [Item::Oversized { bytes: big.len() }, frame("ok")]);
    }

    #[test]
    fn the_cap_holds_while_a_line_is_still_arriving() {
        let mut decoder = Decoder::new(16);
        let mut out = Vec::new();
        decoder.push(b"data: ", &mut out);
        for _ in 0..1000 {
            decoder.push(b"xxxxxxxx", &mut out);
            assert!(
                decoder.line.len() <= 16,
                "the partial line never passes the cap"
            );
        }
        decoder.push(b"\n\ndata: after\n\n", &mut out);
        assert_eq!(out, [Item::Oversized { bytes: 8008 }, frame("after")]);
    }

    #[test]
    fn the_rest_of_an_oversized_frame_is_not_read_as_a_new_one() {
        let big = format!("data: {}\ndata: tail\nid: 3\n\n", "x".repeat(100));
        let out = decode(32, &[big.as_bytes(), b"data: ok\r\n\r\n"]);
        assert_eq!(out, [Item::Oversized { bytes: big.len() }, frame("ok")]);
    }

    #[test]
    fn invalid_utf8_is_reported_not_fatal() {
        let out = decode(64, &[b"data: \xff\xfe\n\ndata: fine\n\n"]);
        assert_eq!(out, [Item::NotUtf8 { bytes: 10 }, frame("fine")]);
    }
}
