//! the board's pairings in `boxbox.db` (`store/schema.rs`, migration 10):
//! a digit key holding a thread, so every mac the board meets shows the
//! same pairs. one thread a key and one key a thread: binding a key takes
//! the thread off any other.

use boxbox_board_wire::Binding;
use rusqlite::{Connection, params};

/// the digit keys' wire indices (decision 1's key map: 7 8 9 / 4 5 6 /
/// 1 2 3). every other key is refused.
pub const DIGIT_WIRES: [u8; 9] = [4, 5, 6, 8, 9, 10, 11, 12, 13];

/// the pairings' table, made at start where `[board]` is configured. outside
/// the versioned migrations on purpose (`store/schema.rs`): a database a
/// board touched still opens in the build before the board.
const TABLE: &str = "CREATE TABLE IF NOT EXISTS board_bindings (
         wire INTEGER PRIMARY KEY CHECK (wire IN (4, 5, 6, 8, 9, 10, 11, 12, 13)),
         key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 3 AND 300),
         color INTEGER NOT NULL CHECK (color BETWEEN 0 AND 16777215),
         bound_at INTEGER NOT NULL
     ) STRICT;";

/// makes the pairings' table when it is not there yet.
///
/// # Errors
/// sqlite failed.
pub fn ensure(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(TABLE)
}

#[must_use]
pub fn is_digit_wire(wire: u8) -> bool {
    DIGIT_WIRES.contains(&wire)
}

/// every pairing, by wire.
///
/// # Errors
/// sqlite failed.
pub fn load(connection: &Connection) -> rusqlite::Result<Vec<Binding>> {
    let mut statement =
        connection.prepare("SELECT wire, key, color FROM board_bindings ORDER BY wire")?;
    statement
        .query_map([], |row| {
            let color: i64 = row.get(2)?;
            Ok(Binding {
                wire: row.get(0)?,
                key: row.get(1)?,
                color: unpack(color),
            })
        })?
        .collect()
}

/// pairs `binding.wire` with its thread, replacing what the key held and
/// freeing any other key the thread held; every pairing after.
///
/// # Errors
/// sqlite failed, or the wire is not a digit (the table refuses it).
pub fn bind(
    connection: &mut Connection,
    binding: &Binding,
    at: i64,
) -> rusqlite::Result<Vec<Binding>> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "DELETE FROM board_bindings WHERE key = ?1 OR wire = ?2",
        params![binding.key, binding.wire],
    )?;
    transaction.execute(
        "INSERT INTO board_bindings (wire, key, color, bound_at) VALUES (?1, ?2, ?3, ?4)",
        params![binding.wire, binding.key, pack(binding.color), at],
    )?;
    transaction.commit()?;
    load(connection)
}

/// frees a digit key; every pairing after.
///
/// # Errors
/// sqlite failed.
pub fn unbind(connection: &Connection, wire: u8) -> rusqlite::Result<Vec<Binding>> {
    connection.execute("DELETE FROM board_bindings WHERE wire = ?1", params![wire])?;
    load(connection)
}

fn pack([r, g, b]: [u8; 3]) -> i64 {
    i64::from(r) << 16 | i64::from(g) << 8 | i64::from(b)
}

fn unpack(color: i64) -> [u8; 3] {
    let byte = |shift: u32| u8::try_from((color >> shift) & 0xff).unwrap_or(0);
    [byte(16), byte(8), byte(0)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::store::schema::migrate(&mut connection).unwrap();
        ensure(&connection).unwrap();
        ensure(&connection).unwrap();
        connection
    }

    #[test]
    fn a_database_the_board_touched_still_opens_in_the_build_before_it() {
        let mut connection = db();
        bind(&mut connection, &binding(4, "desk:s1", [1, 2, 3]), 1).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(
            usize::try_from(version).unwrap(),
            crate::store::schema::VERSION,
            "the board bumps no version"
        );
        // the previous build's check: a version it knows runs nothing and opens
        assert_eq!(crate::store::schema::migrate(&mut connection).unwrap(), 0);
    }

    fn binding(wire: u8, key: &str, color: [u8; 3]) -> Binding {
        Binding {
            wire,
            key: key.into(),
            color,
        }
    }

    #[test]
    fn a_pairing_is_kept_with_its_colour() {
        let mut connection = db();
        let after = bind(&mut connection, &binding(4, "desk:s1", [255, 128, 1]), 1).unwrap();
        assert_eq!(after, [binding(4, "desk:s1", [255, 128, 1])]);
        assert_eq!(load(&connection).unwrap(), after);
    }

    #[test]
    fn a_key_holds_one_thread_and_a_thread_one_key() {
        let mut connection = db();
        bind(&mut connection, &binding(4, "desk:s1", [1, 2, 3]), 1).unwrap();
        bind(&mut connection, &binding(5, "desk:s2", [4, 5, 6]), 2).unwrap();
        // the thread moves to another key: the first key is free
        let moved = bind(&mut connection, &binding(6, "desk:s1", [1, 2, 3]), 3).unwrap();
        assert_eq!(
            moved,
            [
                binding(5, "desk:s2", [4, 5, 6]),
                binding(6, "desk:s1", [1, 2, 3])
            ]
        );
        // the key takes another thread: the one it held lets go
        let taken = bind(&mut connection, &binding(5, "vm:s9", [7, 8, 9]), 4).unwrap();
        assert_eq!(
            taken,
            [
                binding(5, "vm:s9", [7, 8, 9]),
                binding(6, "desk:s1", [1, 2, 3])
            ]
        );
        assert_eq!(
            unbind(&connection, 5).unwrap(),
            [binding(6, "desk:s1", [1, 2, 3])]
        );
    }

    #[test]
    fn only_the_digit_keys_pair() {
        let mut connection = db();
        for wire in 0..17 {
            let taken = bind(&mut connection, &binding(wire, "desk:s1", [0, 0, 0]), 1).is_ok();
            assert_eq!(taken, is_digit_wire(wire), "wire {wire}");
        }
    }
}
