//! the store writer: the one owner of `boxbox.db` (decision 18).
//!
//! the connection lives on its own thread, so sqlite never blocks the async
//! runtime. everyone else sends it a job through a bounded channel and
//! awaits the answer; when the channel is full the caller waits its turn,
//! which is the right backpressure for a disk. the thread stops once every
//! handle is dropped, after the job in hand.

pub mod ids;
mod schema;

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

/// jobs waiting for the writer. each is a few statements; a queue this deep
/// means the disk is stalled, and callers wait rather than pile up.
const QUEUE: usize = 256;

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

/// a handle on the writer. cheap to clone; every clone shares the queue.
#[derive(Debug, Clone)]
pub struct Store {
    jobs: mpsc::Sender<Job>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("cannot create {path}: {source}")]
    Create {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("cannot open {path}: {source}")]
    Open {
        path: PathBuf,
        source: rusqlite::Error,
    },
    #[error(
        "{path} is from a newer boxbox (schema {found}, this build knows {known}); run the newer build"
    )]
    Newer {
        path: PathBuf,
        found: i64,
        known: usize,
    },
    #[error("the store writer thread did not start: {0}")]
    Thread(std::io::Error),
    #[error("the store writer has stopped")]
    Stopped,
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

impl Store {
    /// opens (or creates, mode 0600) the database, brings its schema up to
    /// date, and starts the writer thread.
    ///
    /// # Errors
    /// the file cannot be opened, its schema is newer than this build, a
    /// migration failed, or the thread could not be spawned.
    pub fn open(path: &Path) -> Result<(Self, std::thread::JoinHandle<()>), StoreError> {
        let mut connection = open_connection(path)?;
        let applied = schema::migrate(&mut connection).map_err(|e| match e {
            schema::MigrateError::Newer { found, known } => StoreError::Newer {
                path: path.into(),
                found,
                known,
            },
            schema::MigrateError::Sqlite(source) => StoreError::Open {
                path: path.into(),
                source,
            },
        })?;
        info!(path = %path.display(), schema = schema::VERSION, migrated = applied, "store open");
        let (jobs, receiver) = mpsc::channel(QUEUE);
        let thread = std::thread::Builder::new()
            .name("store-writer".into())
            .spawn(move || run(connection, receiver))
            .map_err(StoreError::Thread)?;
        Ok((Self { jobs }, thread))
    }

    /// a handle with no writer behind it: every call answers `Stopped`.
    #[cfg(test)]
    #[must_use]
    pub fn detached() -> Self {
        let (jobs, _) = mpsc::channel(1);
        Self { jobs }
    }

    /// runs `job` on the writer and returns its answer.
    ///
    /// # Errors
    /// the writer has stopped, or the job's own sqlite error.
    pub async fn call<T, F>(&self, job: F) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let (answer, answered) = oneshot::channel();
        let job: Job = Box::new(move |connection| {
            // the caller may have given up (its request was dropped); the
            // work is done either way, so a closed receiver is not an error
            let _ = answer.send(job(connection));
        });
        self.jobs.send(job).await.map_err(|_| StoreError::Stopped)?;
        Ok(answered.await.map_err(|_| StoreError::Stopped)??)
    }
}

/// a source's secrets (`source_secrets`, `docs/agents.md` section 4): a
/// gateway device key, device token, instance id. the values never reach a
/// log or an api answer; callers wrap them in types whose `Debug` hides
/// them.
impl Store {
    /// the secret `name` of `connection`, if one is kept.
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed.
    pub async fn secret(
        &self,
        connection: &str,
        name: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let (connection, name) = (connection.to_owned(), name.to_owned());
        self.call(move |c| {
            use rusqlite::OptionalExtension;
            c.query_row(
                "SELECT value FROM source_secrets WHERE connection = ?1 AND name = ?2",
                (&connection, &name),
                |row| row.get(0),
            )
            .optional()
        })
        .await
    }

    /// keeps `value` as the secret `name` of `connection`, replacing any.
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed (a value over 64 KiB is refused).
    pub async fn put_secret(
        &self,
        connection: &str,
        name: &str,
        value: Vec<u8>,
    ) -> Result<(), StoreError> {
        let (connection, name) = (connection.to_owned(), name.to_owned());
        let now = crate::now_ms();
        self.call(move |c| {
            c.execute(
                "INSERT INTO source_secrets (connection, name, value, updated) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (connection, name) DO UPDATE SET value = excluded.value, updated = excluded.updated",
                (&connection, &name, &value, now),
            )
            .map(drop)
        })
        .await
    }

    /// forgets the secret `name` of `connection`; forgetting one that is
    /// not kept is not an error.
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed.
    pub async fn forget_secret(&self, connection: &str, name: &str) -> Result<(), StoreError> {
        let (connection, name) = (connection.to_owned(), name.to_owned());
        self.call(move |c| {
            c.execute(
                "DELETE FROM source_secrets WHERE connection = ?1 AND name = ?2",
                (&connection, &name),
            )
            .map(drop)
        })
        .await
    }
}

fn open_connection(path: &Path) -> Result<Connection, StoreError> {
    create_private_file(path).map_err(|source| StoreError::Create {
        path: path.into(),
        source,
    })?;
    let opened = (|| {
        let connection = Connection::open(path)?;
        // wal: readers never block the writer; normal sync is durable across
        // a process crash, and loses at most the last commit on power loss
        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "synchronous", "normal")?;
        connection.pragma_update(None, "foreign_keys", "on")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(connection)
    })();
    opened.map_err(|source| StoreError::Open {
        path: path.into(),
        source,
    })
}

/// the database holds push keys and subscriptions: its owner only.
fn create_private_file(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map(drop)
}

fn run(mut connection: Connection, mut jobs: mpsc::Receiver<Job>) {
    while let Some(job) = jobs.blocking_recv() {
        job(&mut connection);
    }
    // every handle is gone: fold the wal back so the file stands alone
    if let Err(error) = connection.pragma_update(None, "wal_checkpoint", "truncate") {
        warn!(%error, "the store's final checkpoint failed; the wal is replayed at the next open");
    }
    info!("store writer stopped");
}

/// brings an in-memory test database to this build's schema.
#[cfg(test)]
pub(crate) fn migrate_for_tests(connection: &mut Connection) {
    schema::migrate(connection).expect("the schema migrates");
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// a fresh database in the temp dir, removed by the caller.
    pub(crate) fn scratch() -> (Store, std::thread::JoinHandle<()>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("boxbox-store-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let (store, thread) = Store::open(&dir.join("boxbox.db")).unwrap();
        (store, thread, dir)
    }

    #[tokio::test]
    async fn a_secret_is_kept_per_connection_replaced_and_forgotten() {
        let (store, thread, dir) = scratch();
        assert_eq!(store.secret("vm-b", "device_token").await.unwrap(), None);
        store
            .put_secret("vm-b", "device_token", b"one".to_vec())
            .await
            .unwrap();
        store
            .put_secret("vm-c", "device_token", b"other".to_vec())
            .await
            .unwrap();
        store
            .put_secret("vm-b", "device_token", b"two".to_vec())
            .await
            .unwrap();
        assert_eq!(
            store
                .secret("vm-b", "device_token")
                .await
                .unwrap()
                .as_deref(),
            Some(&b"two"[..])
        );
        store.forget_secret("vm-b", "device_token").await.unwrap();
        store.forget_secret("vm-b", "device_token").await.unwrap();
        assert_eq!(store.secret("vm-b", "device_token").await.unwrap(), None);
        assert_eq!(
            store
                .secret("vm-c", "device_token")
                .await
                .unwrap()
                .as_deref(),
            Some(&b"other"[..])
        );
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn jobs_run_in_order_on_one_connection_and_the_thread_stops_with_the_last_handle() {
        let (store, thread, dir) = scratch();
        store
            .call(|c| c.execute_batch("CREATE TABLE t (n INTEGER)"))
            .await
            .unwrap();
        for n in 0..10 {
            store
                .call(move |c| c.execute("INSERT INTO t VALUES (?1)", [n]))
                .await
                .unwrap();
        }
        let listed: Vec<i64> = store
            .call(|c| {
                let mut statement = c.prepare("SELECT n FROM t ORDER BY rowid")?;
                statement.query_map([], |row| row.get(0))?.collect()
            })
            .await
            .unwrap();
        assert_eq!(listed, (0..10).collect::<Vec<_>>());
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn reopening_keeps_the_schema_and_the_file_is_private() {
        let (store, thread, dir) = scratch();
        drop(store);
        thread.join().unwrap();
        let path = dir.join("boxbox.db");
        let (store, thread) = Store::open(&path).unwrap();
        let version: i64 = store
            .call(|c| c.pragma_query_value(None, "user_version", |row| row.get(0)))
            .await
            .unwrap();
        assert_eq!(version, i64::try_from(schema::VERSION).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
