//! read state: how far each device has seen each session, and the one
//! mark every surface renders (decision 16; `scars.md`, lines 1180 and
//! 1185: read marks on mixed clocks, read state per device).
//!
//! a mark is a point in the session's own transcript: the newest message a
//! device had in front of it, by id and by the daemon's `time.created`.
//! both come from the daemon, so marks from a phone and a mac compare on
//! one clock, never on the devices'. the session's mark is the furthest of
//! its devices' marks (max-merged): read on the mac means read on the
//! phone. the rule that uses it is `design.md`, "unread from here".
//!
//! the fleet model owns the marks in memory; the actor mirrors every move
//! to `read_marks` in `boxbox.db` and loads them back at start.

use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde::Serialize;
use utoipa::ToSchema;

/// devices remembered per session; past it the stalest mark goes. one
/// person has a handful of devices.
const DEVICES_PER_SESSION: usize = 16;

/// one device's mark on one session.
#[derive(Clone, Debug, PartialEq)]
pub struct Mark {
    pub device: String,
    /// the daemon's `time.created` of the newest message seen, ms.
    pub at: f64,
    /// that message's id.
    pub message: String,
    /// when the server took the mark, ms on its own clock.
    pub marked_at: i64,
}

/// a session's read mark as every surface gets it: the furthest any
/// device has seen.
#[derive(Clone, Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadMark {
    /// the daemon's `time.created` of the newest message seen, ms: a
    /// message created after it is unread.
    pub at: f64,
    /// that message's id.
    pub message: String,
    /// the device that saw furthest.
    pub device: String,
    /// when it was marked, ms since the epoch on the server's clock.
    pub marked_at: i64,
}

impl From<&Mark> for ReadMark {
    fn from(mark: &Mark) -> Self {
        Self {
            at: mark.at,
            message: mark.message.clone(),
            device: mark.device.clone(),
            marked_at: mark.marked_at,
        }
    }
}

#[derive(Debug, Default)]
pub struct Reads {
    /// by session key; each session's marks, one per device.
    sessions: HashMap<String, Vec<Mark>>,
}

impl Reads {
    /// the marks the store kept, as `(session key, mark)`.
    #[must_use]
    pub fn restore(marks: Vec<(String, Mark)>) -> Self {
        let mut reads = Self::default();
        for (key, mark) in marks {
            reads.put(&key, mark);
        }
        reads
    }

    /// moves `mark.device`'s mark on `key` forward to `mark`. a mark never
    /// moves back: a device showing an older page does not unread what it
    /// saw. returns the device's mark when it moved, for the store.
    pub fn mark(&mut self, key: &str, mark: Mark) -> Option<Mark> {
        let marks = self.sessions.entry(key.to_owned()).or_default();
        if let Some(held) = marks.iter_mut().find(|m| m.device == mark.device) {
            if mark.at <= held.at {
                return None;
            }
            *held = mark.clone();
            return Some(mark);
        }
        self.put(key, mark.clone());
        Some(mark)
    }

    /// the session's merged mark: the furthest of its devices'.
    #[must_use]
    pub fn merged(&self, key: &str) -> Option<ReadMark> {
        self.sessions
            .get(key)?
            .iter()
            .max_by(|a, b| a.at.total_cmp(&b.at).then(a.marked_at.cmp(&b.marked_at)))
            .map(ReadMark::from)
    }

    /// has any device seen the message created at `at`?
    #[must_use]
    pub fn seen(&self, key: &str, at: f64) -> bool {
        self.merged(key).is_some_and(|mark| mark.at >= at)
    }

    pub fn forget(&mut self, key: &str) {
        self.sessions.remove(key);
    }

    pub fn forget_host(&mut self, host: &str) {
        let prefix = format!("{host}:");
        self.sessions.retain(|key, _| !key.starts_with(&prefix));
    }

    fn put(&mut self, key: &str, mark: Mark) {
        let marks = self.sessions.entry(key.to_owned()).or_default();
        marks.retain(|m| m.device != mark.device);
        if marks.len() >= DEVICES_PER_SESSION
            && let Some(stalest) = marks
                .iter()
                .enumerate()
                .min_by_key(|(_, m)| m.marked_at)
                .map(|(at, _)| at)
        {
            marks.remove(stalest);
        }
        marks.push(mark);
    }
}

/// every mark in the store, as `(session key, mark)`.
///
/// # Errors
/// sqlite's.
pub fn load(connection: &Connection) -> rusqlite::Result<Vec<(String, Mark)>> {
    let mut statement =
        connection.prepare("SELECT session, device, at, message, marked_at FROM read_marks")?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                Mark {
                    device: row.get(1)?,
                    at: row.get(2)?,
                    message: row.get(3)?,
                    marked_at: row.get(4)?,
                },
            ))
        })?
        .collect()
}

/// writes one device's mark on one session, replacing the one it had.
///
/// # Errors
/// sqlite's.
pub fn save(connection: &Connection, key: &str, mark: &Mark) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO read_marks (device, session, at, message, marked_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (device, session) DO UPDATE SET
             at = excluded.at, message = excluded.message, marked_at = excluded.marked_at",
        params![mark.device, key, mark.at, mark.message, mark.marked_at],
    )?;
    Ok(())
}

/// forgets a session's marks: the daemon deleted it.
///
/// # Errors
/// sqlite's.
pub fn remove(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM read_marks WHERE session = ?1", [key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(device: &str, at: f64, marked_at: i64) -> Mark {
        Mark {
            device: device.into(),
            at,
            message: format!("msg_{at}"),
            marked_at,
        }
    }

    #[test]
    fn the_session_mark_is_the_furthest_any_device_has_seen() {
        let mut reads = Reads::default();
        reads.mark("d:s", mark("phone", 100.0, 1));
        reads.mark("d:s", mark("mac", 300.0, 2));
        assert_eq!(reads.merged("d:s").unwrap().device, "mac");
        assert!(reads.seen("d:s", 300.0));
        assert!(!reads.seen("d:s", 301.0));
    }

    #[test]
    fn a_mark_never_moves_back() {
        let mut reads = Reads::default();
        assert!(reads.mark("d:s", mark("phone", 200.0, 1)).is_some());
        assert!(reads.mark("d:s", mark("phone", 150.0, 2)).is_none());
        assert!((reads.merged("d:s").unwrap().at - 200.0).abs() < f64::EPSILON);
    }

    #[test]
    fn past_the_cap_the_stalest_device_is_forgotten() {
        let mut reads = Reads::default();
        for n in 0..=DEVICES_PER_SESSION {
            let n64 = i64::try_from(n).unwrap();
            reads.mark("d:s", mark(&format!("dev{n}"), 1.0, n64));
        }
        assert_eq!(reads.sessions["d:s"].len(), DEVICES_PER_SESSION);
        assert!(reads.sessions["d:s"].iter().all(|m| m.device != "dev0"));
    }

    #[test]
    fn marks_round_trip_through_the_store() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::store::migrate_for_tests(&mut connection);
        save(&connection, "d:s", &mark("phone", 5.0, 1)).unwrap();
        save(&connection, "d:s", &mark("phone", 9.0, 2)).unwrap();
        save(&connection, "d:t", &mark("mac", 3.0, 3)).unwrap();
        let reads = Reads::restore(load(&connection).unwrap());
        assert!((reads.merged("d:s").unwrap().at - 9.0).abs() < f64::EPSILON);
        remove(&connection, "d:s").unwrap();
        assert_eq!(load(&connection).unwrap().len(), 1);
    }
}
