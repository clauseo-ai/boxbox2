//! the schema of `boxbox.db`, as an ordered list of migrations. the
//! database's `user_version` is how many have run; each runs once, in its
//! own transaction, and a migration is never edited after it ships (a
//! change is a new one appended). each table names its owning module.

use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    // 1. push (`src/push`): the server's vapid key, minted once, and one
    // subscription per device. `kinds` is a bitset of the notice kinds the
    // device wants (`push::KindSet`).
    "CREATE TABLE push_vapid (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         private_key BLOB NOT NULL CHECK (length(private_key) = 32),
         created_at INTEGER NOT NULL
     ) STRICT;
     CREATE TABLE push_devices (
         device TEXT PRIMARY KEY,
         device_class TEXT NOT NULL,
         endpoint TEXT NOT NULL UNIQUE,
         p256dh BLOB NOT NULL CHECK (length(p256dh) = 65),
         auth BLOB NOT NULL CHECK (length(auth) = 16),
         kinds INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
     ) STRICT;",
    // 2. hosts paired from the app (`src/upstream/paired.rs`), each with the
    // bearer credential its daemon traded for a one-time token (cmx2-asks
    // a12); and preferences (`src/prefs.rs`), one typed json document per
    // device or repo.
    "CREATE TABLE paired_hosts (
         name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 32),
         url TEXT NOT NULL UNIQUE,
         credential TEXT NOT NULL CHECK (length(credential) > 0),
         pair_id TEXT NOT NULL,
         paired_at INTEGER NOT NULL
     ) STRICT;
     CREATE TABLE prefs (
         scope TEXT NOT NULL CHECK (scope IN ('device', 'repo')),
         subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 1024),
         value TEXT NOT NULL CHECK (json_valid(value)),
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (scope, subject)
     ) STRICT;",
    // 3. the fleet (`src/fleet/read.rs`, `src/fleet/needs.rs`): each
    // device's read mark on each session, on the daemon's clock, and every
    // need raised, open until `served_at` is set. `by_kind` is device,
    // elsewhere or agent; `by_who` the device id or the daemon's `by`.
    "CREATE TABLE read_marks (
         device TEXT NOT NULL,
         session TEXT NOT NULL,
         at REAL NOT NULL,
         message TEXT NOT NULL,
         marked_at INTEGER NOT NULL,
         PRIMARY KEY (device, session)
     ) STRICT;
     CREATE TABLE needs (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         session TEXT NOT NULL,
         raised_at INTEGER NOT NULL,
         title TEXT NOT NULL,
         body TEXT NOT NULL,
         ask TEXT,
         checkout TEXT,
         served_at INTEGER,
         how TEXT,
         by_kind TEXT,
         by_who TEXT,
         by_class TEXT
     ) STRICT;
     CREATE INDEX needs_by_served ON needs (served_at);",
    // 4. the threads cleared off home (`src/fleet/clears.rs`): the session's
    // `time.updated` at the clear, on the daemon's clock (`mark`), and when the
    // server took it (`cleared_at`, what the cap evicts by).
    "CREATE TABLE clears (
         session TEXT PRIMARY KEY,
         mark REAL NOT NULL,
         cleared_at INTEGER NOT NULL
     ) STRICT;",
    // 5. the threads a person opened from history that their host's newest-300
    // listing does not hold (`src/fleet/adopted.rs`): the daemon's session
    // info as it was read, so a restart can hold them again at the next read.
    "CREATE TABLE adopted (
         session TEXT PRIMARY KEY,
         info TEXT NOT NULL,
         adopted_at INTEGER NOT NULL
     ) STRICT;",
    // 6. a third pref scope (`src/prefs.rs`): the favourite models, one
    // document shared by every device. sqlite cannot widen a CHECK in place,
    // so the table is rebuilt around its rows.
    "CREATE TABLE prefs_next (
         scope TEXT NOT NULL CHECK (scope IN ('device', 'repo', 'models')),
         subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 1024),
         value TEXT NOT NULL CHECK (json_valid(value)),
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (scope, subject)
     ) STRICT;
     INSERT INTO prefs_next SELECT scope, subject, value, updated_at FROM prefs;
     DROP TABLE prefs;
     ALTER TABLE prefs_next RENAME TO prefs;",
];

/// the schema version this build writes.
pub const VERSION: usize = MIGRATIONS.len();

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error("the database is at schema {found}; this build knows {known}")]
    Newer { found: i64, known: usize },
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// runs every migration the database has not seen; returns how many ran.
///
/// all of them run in one transaction, so one that fails leaves the database
/// exactly as it was: still at the version it had, which the build that wrote
/// it can still open (a rollback after a failed upgrade needs no restore).
///
/// # Errors
/// the database is newer than this build, or a migration failed.
pub fn migrate(connection: &mut Connection) -> Result<usize, MigrateError> {
    migrate_with(connection, MIGRATIONS)
}

fn migrate_with(connection: &mut Connection, migrations: &[&str]) -> Result<usize, MigrateError> {
    let found: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let done = usize::try_from(found).unwrap_or(usize::MAX);
    if done > migrations.len() {
        return Err(MigrateError::Newer {
            found,
            known: migrations.len(),
        });
    }
    if done == migrations.len() {
        return Ok(0);
    }
    let transaction = connection.transaction()?;
    for sql in &migrations[done..] {
        transaction.execute_batch(sql)?;
    }
    let version = i64::try_from(migrations.len()).unwrap_or(i64::MAX);
    transaction.pragma_update(None, "user_version", version)?;
    transaction.commit()?;
    Ok(migrations.len() - done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_database_runs_every_migration_once() {
        let mut connection = Connection::open_in_memory().unwrap();
        assert_eq!(migrate(&mut connection).unwrap(), VERSION);
        assert_eq!(migrate(&mut connection).unwrap(), 0);
    }

    #[test]
    fn a_failing_migration_leaves_the_database_at_the_version_it_had() {
        let mut connection = Connection::open_in_memory().unwrap();
        // an older build's database: its first migrations, run
        migrate_with(&mut connection, &MIGRATIONS[..2]).unwrap();
        let before: i64 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        // the rest, then one broken after the others succeeded
        let mut broken: Vec<&str> = MIGRATIONS.to_vec();
        broken.push("CREATE TABLE half (a INTEGER); THIS IS NOT SQL;");
        assert!(migrate_with(&mut connection, &broken).is_err());
        let after: i64 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(after, before, "still the old version");
        let tables: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name IN ('clears', 'adopted', 'half')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0, "none of the later migrations stayed");
        // and the build that can run them still can
        assert_eq!(migrate(&mut connection).unwrap(), VERSION - 2);
    }

    #[test]
    fn widening_the_pref_scopes_keeps_the_rows_already_there() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_with(&mut connection, &MIGRATIONS[..5]).unwrap();
        connection
            .execute(
                "INSERT INTO prefs (scope, subject, value, updated_at) VALUES ('device', 'phone-1', '{}', 7)",
                [],
            )
            .unwrap();
        assert_eq!(migrate(&mut connection).unwrap(), 1);
        connection
            .execute(
                "INSERT INTO prefs (scope, subject, value, updated_at) VALUES ('models', 'favorites', '{}', 8)",
                [],
            )
            .unwrap();
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM prefs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
        assert!(
            connection
                .execute(
                    "INSERT INTO prefs (scope, subject, value, updated_at) VALUES ('other', 'x', '{}', 9)",
                    [],
                )
                .is_err(),
            "the scopes are still a closed list"
        );
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused_untouched() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "user_version", i64::try_from(VERSION + 1).unwrap())
            .unwrap();
        assert!(matches!(
            migrate(&mut connection),
            Err(MigrateError::Newer { .. })
        ));
    }
}
