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
//! a mark is taken by hand (`POST /api/clear`) or by the auto-clear sweep
//! (`Model::sweep`, decision 93), which keeps beside it when the thread
//! settled and was seen and whether anyone was looking (the away summary,
//! decision 94). an unclear takes a mark back and keeps the thread from the
//! sweep until it is updated again (`Kept`).
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

/// who took a clear.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Cause {
    /// a person, from a window or the bar.
    #[default]
    Hand,
    /// the server's sweep: the thread settled and the person's rule said it may go.
    Auto,
}

impl Cause {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hand => "hand",
            Self::Auto => "auto",
        }
    }

    fn parse(text: &str) -> Self {
        if text == "auto" {
            Self::Auto
        } else {
            Self::Hand
        }
    }
}

/// one thread's clear.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Clear {
    /// the session's `time.updated` when it was cleared, ms on the daemon's clock.
    pub mark: f64,
    /// when the server took the clear, ms on its own clock: what the cap evicts by.
    pub at: i64,
    pub cause: Cause,
    /// an auto-clear no device was looking at (decision 23): it joins the away
    /// summary until a person acknowledges it.
    pub away: bool,
    /// when the thread settled (its done was raised, or it went quiet), ms on
    /// the server's clock; auto-clears only.
    pub done_at: Option<i64>,
    /// when a person's read mark covered its newest finished reply, ms on the
    /// server's clock; auto-clears only, and only when it was seen.
    pub seen_at: Option<i64>,
    /// a person acknowledged the away summary that held it.
    pub acked: bool,
}

impl Clear {
    /// a clear by hand, as `POST /api/clear` takes it.
    #[must_use]
    pub fn hand(mark: f64, at: i64) -> Self {
        Self {
            mark,
            at,
            ..Self::default()
        }
    }

    /// whether it belongs in the away summary, while it holds.
    #[must_use]
    pub fn in_away(&self) -> bool {
        self.cause == Cause::Auto && self.away && !self.acked
    }
}

/// a thread a person brought back (an undo, or "bring back" from the away
/// summary): the sweep leaves it alone until it is updated past `updated`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Kept {
    /// the session's `time.updated` at the unclear, ms on the daemon's clock.
    pub updated: f64,
    /// when the server took the unclear, ms on its own clock: what the cap evicts by.
    pub at: i64,
}

#[derive(Debug, Default)]
pub struct Clears {
    /// by session key.
    marks: HashMap<String, Clear>,
    /// by session key, at most `MAX_CLEARS`.
    kept: HashMap<String, Kept>,
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
                kept: HashMap::new(),
            },
            dropped,
        )
    }

    /// the same, holding the kept marks the store kept too (newest
    /// `MAX_CLEARS`), and the keys of the older ones to delete.
    #[must_use]
    pub fn with_kept(mut self, mut kept: Vec<(String, Kept)>) -> (Self, Vec<String>) {
        kept.sort_by_key(|(_, k)| std::cmp::Reverse(k.at));
        let dropped = if kept.len() > MAX_CLEARS {
            kept.split_off(MAX_CLEARS)
                .into_iter()
                .map(|(key, _)| key)
                .collect()
        } else {
            Vec::new()
        };
        self.kept = kept.into_iter().collect();
        (self, dropped)
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<Clear> {
        self.marks.get(key).copied()
    }

    /// every mark, in no order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Clear)> {
        self.marks.iter().map(|(key, clear)| (key.as_str(), clear))
    }

    /// acknowledges every auto-clear in the away summary; returns their keys.
    pub fn ack_away(&mut self) -> Vec<String> {
        let mut acked = Vec::new();
        for (key, clear) in &mut self.marks {
            if clear.in_away() {
                clear.acked = true;
                acked.push(key.clone());
            }
        }
        acked
    }

    #[must_use]
    pub fn kept(&self, key: &str) -> Option<Kept> {
        self.kept.get(key).copied()
    }

    /// keeps `key` from the sweep. returns the keys the cap pushed out.
    pub fn keep(&mut self, key: &str, kept: Kept) -> Vec<String> {
        self.kept.insert(key.to_owned(), kept);
        let mut evicted = Vec::new();
        while self.kept.len() > MAX_CLEARS {
            let Some(oldest) = self
                .kept
                .iter()
                .min_by(|a, b| a.1.at.cmp(&b.1.at).then_with(|| a.0.cmp(b.0)))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.kept.remove(&oldest);
            evicted.push(oldest);
        }
        evicted
    }

    /// true when `key` was kept.
    pub fn unkeep(&mut self, key: &str) -> bool {
        self.kept.remove(key).is_some()
    }

    /// the kept threads, in no order.
    pub fn kept_iter(&self) -> impl Iterator<Item = (&str, &Kept)> {
        self.kept.iter().map(|(key, kept)| (key.as_str(), kept))
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

    /// drops every kept mark of `host`'s sessions; returns their keys.
    pub fn forget_host_kept(&mut self, host: &str) -> Vec<String> {
        let prefix = format!("{host}:");
        let gone: Vec<String> = self
            .kept
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        for key in &gone {
            self.kept.remove(key);
        }
        gone
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
    let mut statement = connection.prepare(
        "SELECT session, mark, cleared_at, cause, away, done_at, seen_at, acked FROM clears",
    )?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                Clear {
                    mark: row.get(1)?,
                    at: row.get(2)?,
                    cause: Cause::parse(&row.get::<_, String>(3)?),
                    away: row.get(4)?,
                    done_at: row.get(5)?,
                    seen_at: row.get(6)?,
                    acked: row.get(7)?,
                },
            ))
        })?
        .collect()
}

/// every kept mark in the store, as `(session key, kept)`.
///
/// # Errors
/// sqlite's.
pub fn load_kept(connection: &Connection) -> rusqlite::Result<Vec<(String, Kept)>> {
    let mut statement = connection.prepare("SELECT session, updated, kept_at FROM kept")?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                Kept {
                    updated: row.get(1)?,
                    at: row.get(2)?,
                },
            ))
        })?
        .collect()
}

/// writes one session's kept mark, replacing the one it had.
///
/// # Errors
/// sqlite's.
pub fn save_kept(connection: &Connection, key: &str, kept: Kept) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO kept (session, updated, kept_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (session) DO UPDATE SET updated = excluded.updated, kept_at = excluded.kept_at",
        params![key, kept.updated, kept.at],
    )?;
    Ok(())
}

/// forgets a session's kept mark: it was updated, went away or was evicted.
///
/// # Errors
/// sqlite's.
pub fn remove_kept(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM kept WHERE session = ?1", [key])?;
    Ok(())
}

/// acknowledges every auto-clear the away summary holds, in one statement.
///
/// # Errors
/// sqlite's.
pub fn ack_away(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE clears SET acked = 1 WHERE cause = 'auto' AND away = 1 AND acked = 0",
        [],
    )?;
    Ok(())
}

/// writes one session's mark, replacing the one it had.
///
/// # Errors
/// sqlite's.
pub fn save(connection: &Connection, key: &str, clear: Clear) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO clears (session, mark, cleared_at, cause, away, done_at, seen_at, acked)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (session) DO UPDATE SET mark = excluded.mark, cleared_at = excluded.cleared_at,
           cause = excluded.cause, away = excluded.away, done_at = excluded.done_at,
           seen_at = excluded.seen_at, acked = excluded.acked",
        params![
            key,
            clear.mark,
            clear.at,
            clear.cause.as_str(),
            clear.away,
            clear.done_at,
            clear.seen_at,
            clear.acked
        ],
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
        Clear::hand(mark, at)
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

    #[test]
    fn an_auto_clear_keeps_its_cause_times_and_away_flag_through_the_store() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::store::migrate_for_tests(&mut connection);
        let auto = Clear {
            mark: 7.0,
            at: 100,
            cause: Cause::Auto,
            away: true,
            done_at: Some(40),
            seen_at: None,
            acked: false,
        };
        save(&connection, "d:a", auto).unwrap();
        save(&connection, "d:h", clear(3.0, 50)).unwrap();
        let (mut clears, _) = Clears::restore(load(&connection).unwrap());
        assert_eq!(clears.get("d:a"), Some(auto));
        assert_eq!(clears.get("d:h"), Some(clear(3.0, 50)));

        assert_eq!(clears.ack_away(), ["d:a"]);
        ack_away(&connection).unwrap();
        let (again, _) = Clears::restore(load(&connection).unwrap());
        assert!(again.get("d:a").unwrap().acked, "the ack is kept");
        assert!(!clears.get("d:a").unwrap().in_away());
        assert!(clears.ack_away().is_empty(), "nothing left to acknowledge");
    }

    #[test]
    fn kept_marks_round_trip_and_honour_the_cap() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::store::migrate_for_tests(&mut connection);
        let kept = Kept {
            updated: 9.0,
            at: 5,
        };
        save_kept(&connection, "d:k", kept).unwrap();
        let (clears, dropped) = Clears::default().with_kept(load_kept(&connection).unwrap());
        assert!(dropped.is_empty());
        assert_eq!(clears.kept("d:k"), Some(kept));
        remove_kept(&connection, "d:k").unwrap();
        assert!(load_kept(&connection).unwrap().is_empty());

        let mut clears = Clears::default();
        for n in 0..i64::try_from(MAX_CLEARS).unwrap() {
            assert!(
                clears
                    .keep(
                        &format!("d:k{n}"),
                        Kept {
                            updated: 1.0,
                            at: n + 1
                        }
                    )
                    .is_empty()
            );
        }
        assert_eq!(
            clears.keep(
                "d:new",
                Kept {
                    updated: 1.0,
                    at: 1_000_000
                }
            ),
            ["d:k0"]
        );
        assert!(clears.unkeep("d:new"));
        assert!(!clears.unkeep("d:new"));
    }
}
