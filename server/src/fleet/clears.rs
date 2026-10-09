//! clear marks: the threads a person cleared off home, and where each
//! stood when they did (decision 16: the order is the server's, so every
//! device agrees on what is on home; `docs/home.md`, clearing).
//!
//! a mark is the session's own `time.updated` at the moment of the clear, on
//! the daemon's clock. the thread comes back by itself the moment it does
//! something new, and each way of that is a comparison on the daemon's
//! clock or a state the model already holds: `updated` moves past the
//! mark, a turn starts, or an ask is raised. no device clock is ever
//! compared with the daemon's.
//!
//! clearing is not destructive. the thread stays in the daemon and in
//! history; only home's membership changes.
//!
//! the model owns the marks in memory and the actor mirrors every move to
//! the `clears` table in `boxbox.db`, loading them back at start. a mark is
//! a session key and two numbers, so the cap below bounds the table and the
//! map at a couple of hundred kb.

use std::collections::HashMap;

use rusqlite::{Connection, params};

/// marks held across every host. past it the oldest clear goes. a mark only
/// matters while its thread would otherwise still have a window (touched in
/// the last 12 hours), so the oldest is the least likely to be missed.
pub const MAX_CLEARS: usize = 2000;

/// one thread's clear.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Clear {
    /// the session's `time.updated` when it was cleared, ms on the daemon's clock.
    pub mark: f64,
    /// when the server took the clear, ms on its own clock: what the cap evicts by.
    pub at: i64,
}

#[derive(Debug, Default)]
pub struct Clears {
    /// by session key.
    marks: HashMap<String, Clear>,
}

impl Clears {
    /// the marks the store kept, as `(session key, clear)`, newest `MAX_CLEARS`
    /// of them, and the keys of the older ones, which the caller deletes from
    /// the store so the table holds no more than the set does.
    #[must_use]
    pub fn restore(mut kept: Vec<(String, Clear)>) -> (Self, Vec<String>) {
        kept.sort_by_key(|(_, clear)| std::cmp::Reverse(clear.at));
        let dropped = if kept.len() > MAX_CLEARS {
            kept.split_off(MAX_CLEARS)
                .into_iter()
                .map(|(key, _)| key)
                .collect()
        } else {
            Vec::new()
        };
        (
            Self {
                marks: kept.into_iter().collect(),
            },
            dropped,
        )
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<Clear> {
        self.marks.get(key).copied()
    }

    /// holds `clear` for `key`, replacing its last one. returns the keys the cap pushed out.
    pub fn put(&mut self, key: &str, clear: Clear) -> Vec<String> {
        self.marks.insert(key.to_owned(), clear);
        let mut evicted = Vec::new();
        while self.marks.len() > MAX_CLEARS {
            let Some(oldest) = self
                .marks
                .iter()
                .min_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| a.0.cmp(b.0)))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.marks.remove(&oldest);
            evicted.push(oldest);
        }
        evicted
    }

    /// true when `key` had a mark.
    pub fn remove(&mut self, key: &str) -> bool {
        self.marks.remove(key).is_some()
    }

    /// drops every mark of `host`'s sessions; returns their keys.
    pub fn forget_host(&mut self, host: &str) -> Vec<String> {
        let prefix = format!("{host}:");
        let gone: Vec<String> = self
            .marks
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        for key in &gone {
            self.marks.remove(key);
        }
        gone
    }

    /// the keys of `host`'s sessions that have a mark.
    pub fn of_host<'a>(&'a self, host: &str) -> impl Iterator<Item = &'a str> {
        let prefix = format!("{host}:");
        self.marks
            .keys()
            .filter(move |key| key.starts_with(&prefix))
            .map(String::as_str)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.marks.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.marks.is_empty()
    }
}

/// every mark in the store, as `(session key, clear)`.
///
/// # Errors
/// sqlite's.
pub fn load(connection: &Connection) -> rusqlite::Result<Vec<(String, Clear)>> {
    let mut statement = connection.prepare("SELECT session, mark, cleared_at FROM clears")?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                Clear {
                    mark: row.get(1)?,
                    at: row.get(2)?,
                },
            ))
        })?
        .collect()
}

/// writes one session's mark, replacing the one it had.
///
/// # Errors
/// sqlite's.
pub fn save(connection: &Connection, key: &str, clear: Clear) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO clears (session, mark, cleared_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (session) DO UPDATE SET mark = excluded.mark, cleared_at = excluded.cleared_at",
        params![key, clear.mark, clear.at],
    )?;
    Ok(())
}

/// forgets a session's mark: it came back, went away or was evicted.
///
/// # Errors
/// sqlite's.
pub fn remove(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM clears WHERE session = ?1", [key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clear(mark: f64, at: i64) -> Clear {
        Clear { mark, at }
    }

    #[test]
    fn a_second_clear_of_a_thread_replaces_its_mark() {
        let mut clears = Clears::default();
        clears.put("d:s", clear(10.0, 1));
        clears.put("d:s", clear(20.0, 2));
        assert_eq!(clears.get("d:s"), Some(clear(20.0, 2)));
        assert_eq!(clears.len(), 1);
    }

    #[test]
    fn past_the_cap_the_oldest_clear_goes_and_is_named() {
        let mut clears = Clears::default();
        for n in 0..i64::try_from(MAX_CLEARS).unwrap() {
            assert!(
                clears
                    .put(&format!("d:s{n}"), clear(1.0, n + 10))
                    .is_empty()
            );
        }
        let evicted = clears.put("d:fresh", clear(1.0, 1_000_000));
        assert_eq!(evicted, ["d:s0"]);
        assert_eq!(clears.len(), MAX_CLEARS);
        assert!(clears.get("d:fresh").is_some());
    }

    #[test]
    fn a_host_leaving_takes_only_its_own_marks() {
        let mut clears = Clears::default();
        clears.put("desk:a", clear(1.0, 1));
        clears.put("desk:b", clear(1.0, 2));
        clears.put("vm:a", clear(1.0, 3));
        let mut gone = clears.forget_host("desk");
        gone.sort();
        assert_eq!(gone, ["desk:a", "desk:b"]);
        assert_eq!(clears.len(), 1);
    }

    #[test]
    fn a_prefix_of_a_host_name_is_not_the_host() {
        let mut clears = Clears::default();
        clears.put("desk:a", clear(1.0, 1));
        clears.put("desk2:a", clear(1.0, 2));
        assert!(clears.forget_host("desk").contains(&"desk:a".to_owned()));
        assert!(clears.get("desk2:a").is_some());
    }

    #[test]
    fn marks_round_trip_through_the_store_and_restore_honours_the_cap() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::store::migrate_for_tests(&mut connection);
        save(&connection, "d:s", clear(5.0, 1)).unwrap();
        save(&connection, "d:s", clear(9.0, 2)).unwrap();
        save(&connection, "d:t", clear(3.0, 3)).unwrap();
        let (clears, dropped) = Clears::restore(load(&connection).unwrap());
        assert!(dropped.is_empty());
        assert_eq!(clears.get("d:s"), Some(clear(9.0, 2)));
        remove(&connection, "d:s").unwrap();
        assert_eq!(load(&connection).unwrap().len(), 1);

        let too_many = (0..MAX_CLEARS + 5)
            .map(|n| (format!("d:s{n}"), clear(1.0, i64::try_from(n).unwrap())))
            .collect();
        let (restored, dropped) = Clears::restore(too_many);
        assert_eq!(restored.len(), MAX_CLEARS);
        assert_eq!(
            dropped.len(),
            5,
            "the rows past the cap are named, to be deleted"
        );
        assert!(dropped.contains(&"d:s0".to_owned()));
        assert!(
            restored.get("d:s0").is_none(),
            "the oldest five are dropped"
        );
    }
}
