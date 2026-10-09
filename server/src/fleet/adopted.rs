//! adopted threads: the ones a person opened from history that the fleet
//! does not hold by itself, because their host keeps only its newest 300
//! (`docs/home.md`, history).
//!
//! the model holds at most `MAX_ADOPTED` of them and carries them across
//! every host read, so a reconnect or a new epoch never takes a thread out
//! from under the person reading it. a restart empties the model, so the
//! actor mirrors each adoption to the `adopted` table in `boxbox.db` (the
//! key and the session's info as the daemon wrote it, a few kb each) and
//! the model holds them again at its host's first read.

use rusqlite::{Connection, params};

/// every adopted thread the store kept, as `(session key, info json)`, oldest first.
///
/// # Errors
/// sqlite's.
pub fn load(connection: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut statement =
        connection.prepare("SELECT session, info FROM adopted ORDER BY adopted_at, session")?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

/// writes one adopted thread, replacing the row it had.
///
/// # Errors
/// sqlite's.
pub fn save(connection: &Connection, key: &str, info: &str, at: i64) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO adopted (session, info, adopted_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (session) DO UPDATE SET info = excluded.info, adopted_at = excluded.adopted_at",
        params![key, info, at],
    )?;
    Ok(())
}

/// forgets an adopted thread: the cap took it, it was archived, or its host
/// holds it by itself now.
///
/// # Errors
/// sqlite's.
pub fn remove(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM adopted WHERE session = ?1", [key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adopted_threads_round_trip_oldest_first_and_forget() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::store::migrate_for_tests(&mut connection);
        save(&connection, "d:b", "{\"id\":\"b\"}", 20).unwrap();
        save(&connection, "d:a", "{\"id\":\"a\"}", 10).unwrap();
        save(&connection, "d:a", "{\"id\":\"a2\"}", 30).unwrap();
        let kept = load(&connection).unwrap();
        assert_eq!(
            kept.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            ["d:b", "d:a"],
            "oldest adoption first; a second adoption of one thread moves it last"
        );
        assert_eq!(kept[1].1, "{\"id\":\"a2\"}");
        remove(&connection, "d:b").unwrap();
        assert_eq!(load(&connection).unwrap().len(), 1);
    }
}
