//! what the model has seen of each session's transcript, so a transcript
//! read the device already holds can be answered "unchanged" (304) without
//! asking the daemon (`http/transcript.rs`).
//!
//! a read is stamped with the daemon's `x-cmx2-seq`, `<epoch>:<seq>`, and
//! that stamp is its etag. a later read with the same etag is unchanged when
//! the host is still in that epoch, the stamp is at or past where the model
//! began seeing the host's events (the floor: the stream resumes from the
//! oldest list a host read reflects), and no transcript event for the
//! session came after the stamp. an event still on its way has a seq past
//! the stamp, so the device applies it from the stream as it would after a
//! full read. a delta carries no seq: it marks the session one past the last
//! seq seen, which a stamp reaches only once a later sequenced event shows
//! the read came after it. a session that is not plain idle never answers
//! unchanged (the model's caller checks that).
//!
//! only while the host's stream flows: a host answers unchanged from the
//! moment its stream is connected (`connected`, from its resume cursor, or
//! after a read) until it leaves connected, when its marks are forgotten. a
//! read made while the stream is down can not be held to anything, since the
//! changes it would miss reach the device by nothing else. a frame the
//! source skipped (`skipped`) raises the floor past it: to its seq, or, when
//! it had none to read, to the next seq seen, refusing everything until then.
//!
//! "plain idle" stands for "nothing changes without an event": a running
//! tool keeps its session busy, so its output growing in the daemon's memory
//! never meets a stamp here.
//!
//! bounded: at most `MAX_MARKED` sessions per host. when one more comes, the
//! session with the oldest mark is forgotten and the floor rises to its mark,
//! so a stamp before it no longer answers unchanged for any session.

use std::collections::HashMap;

use crate::journal::Cursor;

/// sessions marked per host; past it the oldest mark is folded into the floor.
const MAX_MARKED: usize = 2048;

#[derive(Debug, Default)]
pub struct Marks {
    hosts: HashMap<String, HostMarks>,
}

#[derive(Debug, Default)]
struct HostMarks {
    /// the epoch of the host's last read; none until one is read.
    epoch: Option<String>,
    /// a stamp below this can not be answered unchanged.
    floor: u64,
    /// the highest seq seen from the host.
    seen: u64,
    /// by session id: the seq of its last transcript event.
    sessions: HashMap<String, u64>,
    /// the host's event stream is open: until then nothing is unchanged.
    live: bool,
    /// a frame without a readable seq was skipped: the floor rises to the
    /// next seq seen, and nothing is unchanged until it does.
    skipped: bool,
}

impl Marks {
    /// the host was read afresh: its events are seen from `floor` on, in
    /// `epoch`. what was marked before says nothing about the new read.
    pub fn read(&mut self, host: &str, epoch: Option<&str>, floor: u64) {
        // a read comes before its stream opens: it is live once connected says so
        self.hosts.insert(
            host.to_owned(),
            HostMarks {
                epoch: epoch.map(str::to_owned),
                floor,
                seen: floor,
                ..HostMarks::default()
            },
        );
    }

    /// the host's event stream opened, resuming from `from` (its cursor): a
    /// host read before it keeps what it marked; one not read since it last
    /// left connected starts from the cursor.
    pub fn connected(&mut self, host: &str, from: Option<&Cursor>) {
        if let Some(marks) = self.hosts.get_mut(host) {
            marks.live = true;
            return;
        }
        if let Some(from) = from {
            self.hosts.insert(
                host.to_owned(),
                HostMarks {
                    epoch: Some(from.epoch.clone()),
                    floor: from.seq,
                    seen: from.seq,
                    live: true,
                    ..HostMarks::default()
                },
            );
        }
    }

    /// any event from the host with a seq.
    pub fn seen(&mut self, host: &str, seq: u64) {
        if let Some(marks) = self.hosts.get_mut(host) {
            marks.seen = marks.seen.max(seq);
            if marks.skipped {
                marks.skipped = false;
                marks.floor = marks.floor.max(seq);
            }
        }
    }

    /// the source skipped a frame, at `seq` when it could read one.
    pub fn skipped(&mut self, host: &str, seq: Option<u64>) {
        if let Some(marks) = self.hosts.get_mut(host) {
            match seq {
                Some(seq) => marks.floor = marks.floor.max(seq),
                None => marks.skipped = true,
            }
        }
    }

    /// a transcript event for `session`: a message, a part, a delta or a
    /// removal. one without a seq counts as one past the last seen.
    pub fn transcript(&mut self, host: &str, session: &str, seq: Option<u64>) {
        let Some(marks) = self.hosts.get_mut(host) else {
            return;
        };
        let mark = seq.unwrap_or(marks.seen.saturating_add(1));
        if let Some(held) = marks.sessions.get_mut(session) {
            *held = (*held).max(mark);
            return;
        }
        if marks.sessions.len() >= MAX_MARKED
            && let Some((oldest, at)) = marks
                .sessions
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(id, at)| (id.clone(), *at))
        {
            marks.sessions.remove(&oldest);
            marks.floor = marks.floor.max(at);
        }
        marks.sessions.insert(session.to_owned(), mark);
    }

    /// the host left the config, or its stream stopped flowing.
    pub fn forget(&mut self, host: &str) {
        self.hosts.remove(host);
    }

    /// whether `session`'s transcript is what a read stamped `stamp` returned.
    #[must_use]
    pub fn unchanged(&self, host: &str, session: &str, stamp: &Cursor) -> bool {
        let Some(marks) = self.hosts.get(host) else {
            return false;
        };
        marks.live
            && !marks.skipped
            && marks.epoch.as_deref() == Some(stamp.epoch.as_str())
            && stamp.seq >= marks.floor
            && marks
                .sessions
                .get(session)
                .is_none_or(|at| *at <= stamp.seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seq: u64) -> Cursor {
        Cursor {
            epoch: "e1".into(),
            seq,
        }
    }

    #[test]
    fn a_read_is_unchanged_until_a_transcript_event_for_its_session_comes_after_it() {
        let mut marks = Marks::default();
        assert!(!marks.unchanged("desk", "s1", &at(10)), "a host never read");
        marks.read("desk", Some("e1"), 5);
        assert!(
            !marks.unchanged("desk", "s1", &at(10)),
            "read, but its stream not open"
        );
        marks.connected("desk", None);
        assert!(marks.unchanged("desk", "s1", &at(10)));
        assert!(!marks.unchanged("desk", "s1", &at(4)), "before the floor");
        assert!(
            !marks.unchanged(
                "desk",
                "s1",
                &Cursor {
                    epoch: "e0".into(),
                    seq: 10
                }
            ),
            "another epoch"
        );
        marks.transcript("desk", "s1", Some(12));
        marks.seen("desk", 12);
        assert!(!marks.unchanged("desk", "s1", &at(10)));
        assert!(marks.unchanged("desk", "s1", &at(12)));
        assert!(marks.unchanged("desk", "s2", &at(10)), "another session");
        // a delta lands after seq 12: only a read stamped past 12 holds it
        marks.transcript("desk", "s2", None);
        assert!(!marks.unchanged("desk", "s2", &at(12)));
        assert!(marks.unchanged("desk", "s2", &at(13)));
        // a fresh read forgets the marks and starts from its floor
        marks.read("desk", Some("e2"), 40);
        marks.connected("desk", None);
        assert!(!marks.unchanged("desk", "s1", &at(50)), "the old epoch");
        assert!(marks.unchanged(
            "desk",
            "s1",
            &Cursor {
                epoch: "e2".into(),
                seq: 40
            }
        ));
        marks.forget("desk");
        assert!(!marks.unchanged(
            "desk",
            "s1",
            &Cursor {
                epoch: "e2".into(),
                seq: 40
            }
        ));
    }

    #[test]
    fn a_host_whose_stream_stops_answers_nothing_unchanged_until_it_flows_again() {
        let mut marks = Marks::default();
        marks.read("desk", Some("e1"), 5);
        marks.connected("desk", None);
        marks.transcript("desk", "s1", Some(8));
        assert!(marks.unchanged("desk", "s1", &at(10)));
        // down, backing off, or failing its fresh read: nothing is known
        marks.forget("desk");
        assert!(!marks.unchanged("desk", "s1", &at(10)));
        // resumed from its cursor without a read: from the cursor on
        marks.connected("desk", Some(&at(12)));
        assert!(!marks.unchanged("desk", "s1", &at(10)), "before the cursor");
        assert!(marks.unchanged("desk", "s1", &at(12)));
        // a status while connected changes nothing
        marks.connected("desk", Some(&at(99)));
        assert!(marks.unchanged("desk", "s1", &at(12)));
    }

    #[test]
    fn a_skipped_frame_raises_the_floor_past_it() {
        let mut marks = Marks::default();
        marks.read("desk", Some("e1"), 5);
        marks.connected("desk", None);
        marks.seen("desk", 9);
        // skipped with its seq: a stamp before it no longer holds
        marks.skipped("desk", Some(11));
        assert!(!marks.unchanged("desk", "s1", &at(10)));
        assert!(marks.unchanged("desk", "s1", &at(11)));
        // skipped without one: nothing holds until the next seq, which becomes the floor
        marks.skipped("desk", None);
        assert!(!marks.unchanged("desk", "s1", &at(50)));
        marks.seen("desk", 14);
        assert!(!marks.unchanged("desk", "s1", &at(13)));
        assert!(marks.unchanged("desk", "s1", &at(14)));
    }

    #[test]
    fn past_the_cap_the_oldest_mark_is_folded_into_the_floor() {
        let mut marks = Marks::default();
        marks.read("desk", Some("e1"), 0);
        marks.connected("desk", None);
        for n in 0..MAX_MARKED as u64 {
            marks.transcript("desk", &format!("s{n}"), Some(n + 1));
        }
        assert_eq!(marks.hosts["desk"].floor, 0);
        marks.transcript("desk", "late", Some(10_000));
        let host = &marks.hosts["desk"];
        assert_eq!(host.sessions.len(), MAX_MARKED);
        assert_eq!(host.floor, 1, "s0's mark");
        assert!(!host.sessions.contains_key("s0"));
        // s0 forgotten: a stamp before its mark no longer answers unchanged
        assert!(!marks.unchanged("desk", "s0", &at(0)));
        assert!(marks.unchanged("desk", "s0", &at(1)));
    }
}
