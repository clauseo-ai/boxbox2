//! foreign agents' keys and thread ids (`docs/agents.md`, section 3): the
//! `agents` and `thread_ids` tables of migration 8. each call is one job on
//! the writer, and each that decides on what it reads does so in one
//! transaction, so two sightings of one agent or thread cannot both win.

// the foreign sources that call these land after them (m9)
#![allow(dead_code)]

use rusqlite::{OptionalExtension, params};

use super::{Store, StoreError};

/// what claiming an agent key did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyClaim {
    /// the agent already had a key: this one, whatever was asked for now,
    /// because a key never changes once written.
    Kept(String),
    /// the key belongs to another agent; nothing was written.
    Taken {
        connection: String,
        foreign_id: String,
    },
    /// the key is now this agent's.
    Claimed,
}

/// what recording a thread id did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    New,
    /// the same row was already there.
    Known,
    /// refused, nothing written: another foreign key holds the id, or
    /// (which a deterministic hash cannot do unless it changed) this
    /// foreign key holds another id.
    Collision,
}

impl Store {
    /// gives the foreign agent `(connection, foreign_id)` the key `key`,
    /// unless it has one already or another agent holds `key`.
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed.
    pub async fn claim_agent_key(
        &self,
        connection: &str,
        foreign_id: &str,
        key: &str,
    ) -> Result<KeyClaim, StoreError> {
        let (connection, foreign_id, key) =
            (connection.to_owned(), foreign_id.to_owned(), key.to_owned());
        self.call(move |c| {
            let transaction = c.transaction()?;
            let kept: Option<String> = transaction
                .query_row(
                    "SELECT key FROM agents WHERE connection = ?1 AND foreign_id = ?2",
                    params![connection, foreign_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(kept) = kept {
                return Ok(KeyClaim::Kept(kept));
            }
            let owner: Option<(String, String)> = transaction
                .query_row(
                    "SELECT connection, foreign_id FROM agents WHERE key = ?1",
                    params![key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((connection, foreign_id)) = owner {
                return Ok(KeyClaim::Taken {
                    connection,
                    foreign_id,
                });
            }
            transaction.execute(
                "INSERT INTO agents (connection, foreign_id, key, first_seen) VALUES (?1, ?2, ?3, ?4)",
                params![connection, foreign_id, key, crate::now_ms()],
            )?;
            transaction.commit()?;
            Ok(KeyClaim::Claimed)
        })
        .await
    }

    /// the key the foreign agent `(connection, foreign_id)` holds, if any.
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed.
    pub async fn agent_key(
        &self,
        connection: &str,
        foreign_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let (connection, foreign_id) = (connection.to_owned(), foreign_id.to_owned());
        self.call(move |c| {
            c.query_row(
                "SELECT key FROM agents WHERE connection = ?1 AND foreign_id = ?2",
                params![connection, foreign_id],
                |row| row.get(0),
            )
            .optional()
        })
        .await
    }

    /// who holds `key`: (connection, foreign id).
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed.
    pub async fn agent_key_owner(&self, key: &str) -> Result<Option<(String, String)>, StoreError> {
        let key = key.to_owned();
        self.call(move |c| {
            c.query_row(
                "SELECT connection, foreign_id FROM agents WHERE key = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })
        .await
    }

    /// writes that thread `id` of `agent` is the foreign session
    /// `foreign_key`, unless either is already taken by another.
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed.
    pub async fn record_thread_id(
        &self,
        agent: &str,
        id: &str,
        foreign_key: &str,
    ) -> Result<Recorded, StoreError> {
        let (agent, id, foreign_key) = (agent.to_owned(), id.to_owned(), foreign_key.to_owned());
        self.call(move |c| {
            let transaction = c.transaction()?;
            // no conflict target: a clash on either unique index is skipped,
            // and the read below says which
            let inserted = transaction.execute(
                "INSERT INTO thread_ids (agent, id, foreign_key, first_seen) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT DO NOTHING",
                params![agent, id, foreign_key, crate::now_ms()],
            )?;
            let recorded = if inserted == 1 {
                Recorded::New
            } else {
                let held: Option<String> = transaction
                    .query_row(
                        "SELECT foreign_key FROM thread_ids WHERE agent = ?1 AND id = ?2",
                        params![agent, id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if held.as_deref() == Some(foreign_key.as_str()) {
                    Recorded::Known
                } else {
                    Recorded::Collision
                }
            };
            transaction.commit()?;
            Ok(recorded)
        })
        .await
    }

    /// the foreign session key thread `id` of `agent` hashes, if recorded.
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed.
    pub async fn foreign_key_of(
        &self,
        agent: &str,
        id: &str,
    ) -> Result<Option<String>, StoreError> {
        let (agent, id) = (agent.to_owned(), id.to_owned());
        self.call(move |c| {
            c.query_row(
                "SELECT foreign_key FROM thread_ids WHERE agent = ?1 AND id = ?2",
                params![agent, id],
                |row| row.get(0),
            )
            .optional()
        })
        .await
    }

    /// deletes the thread ids `ids` of `agent`, except those whose thread
    /// (`<agent>:<id>`) still has a read mark, an open need, a clear or an
    /// adoption: those rows key off the id, and a re-derived id is the same
    /// anyway, so keeping them costs one row. which threads are old enough
    /// to go is the caller's call. returns how many rows went.
    ///
    /// # Errors
    /// the writer has stopped, or sqlite failed.
    pub async fn prune_thread_ids(
        &self,
        agent: &str,
        ids: Vec<String>,
    ) -> Result<usize, StoreError> {
        let agent = agent.to_owned();
        self.call(move |c| {
            let transaction = c.transaction()?;
            let mut gone = 0;
            {
                let mut delete = transaction.prepare(
                    "DELETE FROM thread_ids WHERE agent = ?1 AND id = ?2
                     AND NOT EXISTS (SELECT 1 FROM read_marks WHERE session = ?3)
                     AND NOT EXISTS (SELECT 1 FROM needs WHERE session = ?3 AND served_at IS NULL)
                     AND NOT EXISTS (SELECT 1 FROM clears WHERE session = ?3)
                     AND NOT EXISTS (SELECT 1 FROM adopted WHERE session = ?3)",
                )?;
                for id in &ids {
                    let session = format!("{agent}:{id}");
                    gone += delete.execute(params![agent, id, session])?;
                }
            }
            transaction.commit()?;
            Ok(gone)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::scratch;

    #[tokio::test]
    async fn an_agent_keeps_its_first_key_and_a_taken_key_names_its_owner() {
        let (store, thread, dir) = scratch();
        assert_eq!(
            store
                .claim_agent_key("vm-a", "main", "vm-a-main")
                .await
                .unwrap(),
            KeyClaim::Claimed
        );
        assert_eq!(
            store
                .claim_agent_key("vm-a", "main", "pinned")
                .await
                .unwrap(),
            KeyClaim::Kept("vm-a-main".into()),
            "a key never changes once written"
        );
        assert_eq!(
            store
                .claim_agent_key("vm-b", "other", "vm-a-main")
                .await
                .unwrap(),
            KeyClaim::Taken {
                connection: "vm-a".into(),
                foreign_id: "main".into()
            }
        );
        assert_eq!(
            store.agent_key("vm-b", "other").await.unwrap(),
            None,
            "nothing written"
        );
        assert_eq!(
            store.agent_key("vm-a", "main").await.unwrap().as_deref(),
            Some("vm-a-main")
        );
        assert_eq!(
            store.agent_key_owner("vm-a-main").await.unwrap(),
            Some(("vm-a".into(), "main".into()))
        );
        assert_eq!(store.agent_key_owner("nobody").await.unwrap(), None);
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn thread_ids_are_new_then_known_and_a_collision_writes_nothing() {
        let (store, thread, dir) = scratch();
        assert_eq!(
            store
                .record_thread_id("vm-a-main", "oc_1", "agent:main:main")
                .await
                .unwrap(),
            Recorded::New
        );
        assert_eq!(
            store
                .record_thread_id("vm-a-main", "oc_1", "agent:main:main")
                .await
                .unwrap(),
            Recorded::Known
        );
        // another key on the same id
        assert_eq!(
            store
                .record_thread_id("vm-a-main", "oc_1", "agent:main:other")
                .await
                .unwrap(),
            Recorded::Collision
        );
        // the same key on another id
        assert_eq!(
            store
                .record_thread_id("vm-a-main", "oc_2", "agent:main:main")
                .await
                .unwrap(),
            Recorded::Collision
        );
        assert_eq!(
            store
                .foreign_key_of("vm-a-main", "oc_1")
                .await
                .unwrap()
                .as_deref(),
            Some("agent:main:main")
        );
        assert_eq!(
            store.foreign_key_of("vm-a-main", "oc_2").await.unwrap(),
            None
        );
        // ids are per agent
        assert_eq!(
            store
                .record_thread_id("vm-b-main", "oc_1", "agent:main:other")
                .await
                .unwrap(),
            Recorded::New
        );
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn pruning_keeps_threads_that_marks_needs_clears_or_adoptions_name() {
        let (store, thread, dir) = scratch();
        let agent = "vm-a-main";
        for n in 0..7 {
            store
                .record_thread_id(agent, &format!("oc_{n}"), &format!("k{n}"))
                .await
                .unwrap();
        }
        store
            .call(|c| {
                c.execute_batch(
                    "INSERT INTO read_marks VALUES ('phone', 'vm-a-main:oc_1', 1.0, 'm', 1);
                     INSERT INTO needs (id, kind, session, raised_at, title, body)
                         VALUES ('n1', 'ask', 'vm-a-main:oc_2', 1, 't', 'b');
                     INSERT INTO needs (id, kind, session, raised_at, title, body, served_at)
                         VALUES ('n2', 'ask', 'vm-a-main:oc_3', 1, 't', 'b', 2);
                     INSERT INTO clears (session, mark, cleared_at) VALUES ('vm-a-main:oc_4', 1.0, 1);
                     INSERT INTO adopted VALUES ('vm-a-main:oc_5', '{}', 1);
                     INSERT INTO read_marks VALUES ('phone', 'vm-b-main:oc_6', 1.0, 'm', 1);",
                )
            })
            .await
            .unwrap();
        let ids = (0..7)
            .map(|n| format!("oc_{n}"))
            .chain(["oc_missing".into()])
            .collect();
        // oc_0 (nothing), oc_3 (its need is served) and oc_6 (another
        // agent's mark) go
        assert_eq!(store.prune_thread_ids(agent, ids).await.unwrap(), 3);
        for (n, kept) in [
            (0, false),
            (1, true),
            (2, true),
            (3, false),
            (4, true),
            (5, true),
            (6, false),
        ] {
            assert_eq!(
                store
                    .foreign_key_of(agent, &format!("oc_{n}"))
                    .await
                    .unwrap()
                    .is_some(),
                kept,
                "oc_{n}"
            );
        }
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
