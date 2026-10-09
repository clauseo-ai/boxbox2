//! the terminal wire, as the relay speaks it to the browser: cmx2's pty
//! websocket passed through, plus two frames of boxbox's own.
//!
//! from cmx2 (`GET /pty/:id/connect`, the vendored contract):
//!
//! - **text frames** are terminal output, verbatim.
//! - **`0x00` + json `{cursor}`**, one binary frame per connection, sent
//!   once the replay is over: where the stream stands, in utf-16 units.
//!
//! from the relay:
//!
//! - **`0x01` + json `{cursor}`**: the relay lost its upstream and is
//!   replaying again from `cursor` (`null`: from everything retained).
//!   output after it, up to the next `0x00`, is that replay; anything the
//!   browser held of an unfinished replay is superseded.
//! - **`0x02`**, alone: a heartbeat, every 15 s each way, so each end's
//!   45 s watchdog finds a dead socket (architecture: liveness). the
//!   browser's heartbeats are the only binary frames it sends; its text
//!   frames are typed into the terminal.
//!
//! cursors count utf-16 code units because cmx2's do (a browser's
//! `.length`); the relay counts what it forwards the same way, so its
//! cursor and the browser's agree without either doing byte math.

use serde::Deserialize;

/// the first byte of cmx2's end-of-replay frame.
pub const META: u8 = 0x00;
/// the first byte of the relay's replay-restarts frame.
pub const REPLAY: u8 = 0x01;
/// the heartbeat frame, whole.
pub const HEARTBEAT: [u8; 1] = [0x02];

/// what a binary frame from cmx2 says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upstream {
    /// the replay is over; the stream stands at `cursor`.
    Meta { cursor: i64 },
    /// a binary frame this contract does not declare.
    Unknown,
}

#[derive(Deserialize)]
struct MetaBody {
    cursor: i64,
}

/// reads a binary frame from cmx2.
#[must_use]
pub fn upstream(frame: &[u8]) -> Upstream {
    match frame.split_first() {
        Some((&META, body)) => serde_json::from_slice::<MetaBody>(body)
            .ok()
            .filter(|meta| meta.cursor >= 0)
            .map_or(Upstream::Unknown, |meta| Upstream::Meta {
                cursor: meta.cursor,
            }),
        _ => Upstream::Unknown,
    }
}

/// the relay's replay-restarts frame for a dial `from` the cursor.
#[must_use]
pub fn replay_frame(from: Option<i64>) -> Vec<u8> {
    let mut frame = vec![REPLAY];
    match from {
        Some(cursor) => frame.extend_from_slice(format!("{{\"cursor\":{cursor}}}").as_bytes()),
        None => frame.extend_from_slice(b"{\"cursor\":null}"),
    }
    frame
}

/// the utf-16 length of `text`: one unit per character, two for those
/// outside the basic plane. counted on the utf-8 bytes, so it is one pass
/// with no decoding: every byte that starts a character counts one, and a
/// four-byte lead (the astral planes) counts one more.
#[must_use]
pub fn utf16_len(text: &str) -> u64 {
    text.bytes()
        .map(|b| u64::from(b & 0xC0 != 0x80) + u64::from(b >= 0xF0))
        .sum()
}

/// where the relay stands in the terminal's output, and what the dial in
/// progress has replayed. the cursor is known exactly only once a
/// connection's meta frame has arrived: until then a replay may have
/// skipped what cmx2 no longer holds, so its length says nothing certain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    /// the cursor after the last output forwarded, when known.
    known: Option<i64>,
    /// the cursor the current connection was dialled with.
    dialled: Option<i64>,
    /// output of the current connection's replay, in utf-16 units.
    replayed: u64,
    /// whether the current connection's meta frame has arrived.
    live: bool,
}

/// what a meta frame settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settled {
    /// output the replay carried, in utf-16 units.
    pub replayed: u64,
    /// output cmx2 no longer held between the dial cursor and the replay,
    /// in utf-16 units. only a dial with a cursor can tell.
    pub dropped: u64,
}

impl Position {
    /// a relay whose browser asked for `cursor` (`None`: everything
    /// retained; `-1`: only what comes next).
    #[must_use]
    pub fn new(cursor: Option<i64>) -> Self {
        Self {
            known: cursor.filter(|c| *c >= 0),
            dialled: cursor,
            replayed: 0,
            live: false,
        }
    }

    /// the cursor the next dial asks for: where the output forwarded so
    /// far ends, or, when that is not known yet, what the last dial asked.
    #[must_use]
    pub fn resume_from(&self) -> Option<i64> {
        self.known.or(self.dialled)
    }

    /// a new connection is being dialled from `resume_from()`.
    pub fn dial(&mut self) {
        self.dialled = self.resume_from();
        self.replayed = 0;
        self.live = false;
    }

    /// whether the current connection is past its replay.
    #[must_use]
    pub fn live(&self) -> bool {
        self.live
    }

    /// output was forwarded.
    pub fn output(&mut self, units: u64) {
        if self.live {
            let units = i64::try_from(units).unwrap_or(i64::MAX);
            self.known = self.known.map(|c| c.saturating_add(units));
        } else {
            self.replayed = self.replayed.saturating_add(units);
        }
    }

    /// the connection's meta frame: the stream stands at `cursor`.
    pub fn meta(&mut self, cursor: i64) -> Settled {
        let dropped = match self.dialled {
            Some(from) if from >= 0 => {
                let replayed = i64::try_from(self.replayed).unwrap_or(i64::MAX);
                u64::try_from(cursor - from.saturating_add(replayed)).unwrap_or(0)
            }
            _ => 0,
        };
        self.known = Some(cursor);
        self.live = true;
        Settled {
            replayed: self.replayed,
            dropped,
        }
    }

    /// the cursor after the last output forwarded, when known.
    #[cfg(test)]
    fn cursor(&self) -> Option<i64> {
        self.known
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_length_matches_what_a_browser_counts() {
        assert_eq!(utf16_len(""), 0);
        assert_eq!(utf16_len("ls -la\r\n"), 8);
        // two bytes, one unit; three bytes (box drawing), one unit
        assert_eq!(utf16_len("é─"), 2);
        // four bytes, a surrogate pair
        assert_eq!(utf16_len("🦀"), 2);
        let mixed = "a é ─ 🦀 \u{1b}[31mred\u{1b}[0m";
        assert_eq!(utf16_len(mixed), mixed.encode_utf16().count() as u64);
    }

    #[test]
    fn a_meta_frame_is_byte_zero_then_a_cursor() {
        assert_eq!(
            upstream(b"\x00{\"cursor\":4096}"),
            Upstream::Meta { cursor: 4096 }
        );
        assert_eq!(upstream(b"\x00{\"cursor\":-1}"), Upstream::Unknown);
        assert_eq!(upstream(b"\x00not json"), Upstream::Unknown);
        assert_eq!(upstream(b"\x07{\"cursor\":1}"), Upstream::Unknown);
        assert_eq!(upstream(b""), Upstream::Unknown);
    }

    #[test]
    fn the_replay_frame_names_its_cursor_or_null() {
        assert_eq!(replay_frame(Some(12)), b"\x01{\"cursor\":12}");
        assert_eq!(replay_frame(None), b"\x01{\"cursor\":null}");
    }

    #[test]
    fn a_first_dial_knows_nothing_until_its_meta() {
        let mut at = Position::new(None);
        at.dial();
        at.output(100);
        assert_eq!(at.cursor(), None);
        assert_eq!(
            at.resume_from(),
            None,
            "a drop mid-replay replays it all again"
        );
        let settled = at.meta(100);
        assert_eq!(
            settled,
            Settled {
                replayed: 100,
                dropped: 0
            }
        );
        at.output(20);
        assert_eq!(at.cursor(), Some(120));
        assert_eq!(at.resume_from(), Some(120));
    }

    #[test]
    fn a_resume_counts_what_cmx2_no_longer_held() {
        let mut at = Position::new(Some(1_000));
        at.dial();
        // cmx2 kept only from 600_000; the replay starts there
        at.output(50_000);
        let settled = at.meta(650_000);
        assert_eq!(settled.dropped, 650_000 - 1_000 - 50_000);
        assert_eq!(at.cursor(), Some(650_000));
    }

    #[test]
    fn a_drop_before_the_meta_redials_from_the_same_cursor() {
        let mut at = Position::new(Some(500));
        at.dial();
        at.meta(800);
        at.output(10);
        at.dial();
        assert_eq!(at.resume_from(), Some(810));
        at.output(4); // replayed, then the connection dropped
        at.dial();
        assert_eq!(
            at.resume_from(),
            Some(810),
            "the unfinished replay does not count"
        );
        assert!(!at.live());
    }

    #[test]
    fn from_now_on_dials_minus_one_and_then_follows_the_meta() {
        let mut at = Position::new(Some(-1));
        assert_eq!(at.resume_from(), Some(-1));
        at.dial();
        assert_eq!(at.meta(9_000).dropped, 0, "-1 asks for no replay");
        assert_eq!(at.resume_from(), Some(9_000));
    }
}
