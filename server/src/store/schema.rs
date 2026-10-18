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
    // 7. the media store's index (`src/media`, `agents.md` section 6): one row
    // per file by the sha256 of its bytes, kept as a tombstone once evicted
    // (`evicted_at`); what holds each file; and a device's transcript of its
    // own voice note, by media id and thread.
    "CREATE TABLE media (
         id TEXT PRIMARY KEY CHECK (length(id) = 64),
         mime TEXT NOT NULL CHECK (length(mime) BETWEEN 3 AND 127),
         size INTEGER NOT NULL CHECK (size >= 0),
         filename TEXT CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 255),
         duration_ms INTEGER,
         width INTEGER,
         height INTEGER,
         waveform BLOB CHECK (waveform IS NULL OR length(waveform) <= 64),
         origin TEXT NOT NULL CHECK (origin IN ('upload', 'agent')),
         created INTEGER NOT NULL,
         last_used INTEGER NOT NULL,
         pinned_until INTEGER,
         evicted_at INTEGER
     ) STRICT;
     CREATE INDEX media_live_by_use ON media (last_used) WHERE evicted_at IS NULL;
     CREATE INDEX media_tombstones ON media (evicted_at) WHERE evicted_at IS NOT NULL;
     CREATE TABLE media_refs (
         media TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
         agent TEXT NOT NULL,
         thread TEXT NOT NULL,
         message TEXT NOT NULL,
         PRIMARY KEY (media, agent, thread, message)
     ) STRICT;
     CREATE TABLE media_sidecars (
         media TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
         thread TEXT NOT NULL,
         transcript TEXT NOT NULL,
         lang TEXT,
         device TEXT,
         created INTEGER NOT NULL,
         PRIMARY KEY (media, thread)
     ) STRICT;",
    // 8. foreign agents' keys and thread ids (`src/store/ids.rs`,
    // `src/source/agent_keys.rs`, `src/source/thread_ids.rs`, `agents.md`
    // section 3): the key each foreign agent got at first sight, never
    // changed after; and each thread id with the foreign session key it
    // hashes, unique both ways so verbs map back and a hash collision is
    // refused instead of merging two threads. the session indexes serve the
    // prune, which keeps any thread a read mark or open need still names.
    "CREATE TABLE agents (
         connection TEXT NOT NULL CHECK (length(connection) BETWEEN 1 AND 32),
         foreign_id TEXT NOT NULL CHECK (length(foreign_id) BETWEEN 1 AND 1024),
         key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 32),
         first_seen INTEGER NOT NULL,
         PRIMARY KEY (connection, foreign_id)
     ) STRICT;
     CREATE TABLE thread_ids (
         agent TEXT NOT NULL CHECK (length(agent) BETWEEN 1 AND 32),
         id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
         foreign_key TEXT NOT NULL CHECK (length(foreign_key) BETWEEN 1 AND 4096),
         first_seen INTEGER NOT NULL,
         PRIMARY KEY (agent, id),
         UNIQUE (agent, foreign_key)
     ) STRICT;
     CREATE INDEX read_marks_by_session ON read_marks (session);
     CREATE INDEX needs_open_by_session ON needs (session) WHERE served_at IS NULL;",
    // 9. a source's secrets (`agents.md` section 4, `openclaw.md` 3.2 and
    // 5.2): an openclaw connection's device key (pkcs#8 der), its device
    // token and its instance id, one row per name. never logged, never in an
    // api answer; the file is 0600.
    "CREATE TABLE source_secrets (
         connection TEXT NOT NULL CHECK (length(connection) BETWEEN 1 AND 64),
         name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
         value BLOB NOT NULL CHECK (length(value) <= 65536),
         updated INTEGER NOT NULL,
         PRIMARY KEY (connection, name)
     ) STRICT;",
];

// the board's pairings (`src/board/store.rs`) are not a migration: the
// board is an add-on, and a migration would bump `user_version` on every
// install, so a rollback to the build before it would refuse the database
// (`MigrateError::Newer`). `board::store::ensure` creates its table with
// `IF NOT EXISTS` at start, only where `[board]` is configured, and the
// version stays what the rest of the schema says.

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
        // the widening, and every migration after it
        assert_eq!(migrate(&mut connection).unwrap(), VERSION - 5);
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
    fn agent_keys_and_thread_ids_are_unique_both_ways() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&mut connection).unwrap();
        let agent = |c: &Connection, connection: &str, foreign: &str, key: &str| {
            c.execute(
                "INSERT INTO agents (connection, foreign_id, key, first_seen) VALUES (?1, ?2, ?3, 1)",
                [connection, foreign, key],
            )
        };
        agent(&connection, "vm-a", "main", "vm-a-main").unwrap();
        assert!(
            agent(&connection, "vm-a", "main", "vm-a-other").is_err(),
            "one key an agent"
        );
        assert!(
            agent(&connection, "vm-b", "main", "vm-a-main").is_err(),
            "one agent a key"
        );
        assert!(
            agent(&connection, "vm-b", "x", "").is_err(),
            "a key is not empty"
        );
        assert!(
            agent(&connection, "vm-b", "x", &"k".repeat(33)).is_err(),
            "a key fits 32"
        );
        agent(&connection, "vm-b", "main", "vm-b-main").unwrap();

        let thread = |c: &Connection, agent: &str, id: &str, key: &str| {
            c.execute(
                "INSERT INTO thread_ids (agent, id, foreign_key, first_seen) VALUES (?1, ?2, ?3, 1)",
                [agent, id, key],
            )
        };
        thread(&connection, "vm-a-main", "oc_1", "agent:main:main").unwrap();
        assert!(thread(&connection, "vm-a-main", "oc_1", "agent:main:other").is_err());
        assert!(thread(&connection, "vm-a-main", "oc_2", "agent:main:main").is_err());
        assert!(thread(&connection, "vm-a-main", &"i".repeat(129), "k").is_err());
        // another agent may hold the same id and the same key
        thread(&connection, "vm-b-main", "oc_1", "agent:main:main").unwrap();
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
