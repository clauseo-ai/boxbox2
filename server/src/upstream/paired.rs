//! hosts paired from the machines screen (cmx2-asks a12), kept in
//! `boxbox.db`'s `paired_hosts`: the name boxbox knows the host by, its
//! address, and the bearer credential the daemon's `POST /pair` traded for
//! a one-time token. the credential never leaves the server; the api says
//! only that a host was paired.

use reqwest::Url;
use rusqlite::{OptionalExtension, params};
use tracing::warn;

use crate::config::{Credential, HostConfig, Origin, Secret};
use crate::store::{Store, StoreError};

/// what the name a paired host is kept under says to its daemon: the
/// client `cmx2 pair --list` shows and `cmx2 pair --revoke boxbox` removes.
pub const CLIENT_NAME: &str = "boxbox";

/// a pairing to keep.
#[derive(Debug)]
pub struct Paired {
    pub name: String,
    pub url: Url,
    pub credential: Secret,
    /// the daemon's id for this client, for its own `cmx2 pair --list`.
    pub pair_id: String,
}

impl Paired {
    #[must_use]
    pub fn host(&self) -> HostConfig {
        HostConfig {
            name: self.name.clone(),
            url: self.url.clone(),
            credential: Some(Credential::Bearer(self.credential.clone())),
            origin: Origin::Paired,
        }
    }
}

/// every paired host, oldest first. a row whose address no longer parses
/// is logged and left out rather than failing the start.
///
/// # Errors
/// the store is not answering.
pub async fn load(store: &Store) -> Result<Vec<HostConfig>, StoreError> {
    let rows: Vec<(String, String, String)> = store
        .call(|c| {
            let mut statement = c.prepare(
                "SELECT name, url, credential FROM paired_hosts ORDER BY paired_at, name",
            )?;
            statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(name, url, credential)| match Url::parse(&url) {
            Ok(url) => Some(HostConfig {
                name,
                url,
                credential: Some(Credential::Bearer(Secret::new(credential))),
                origin: Origin::Paired,
            }),
            Err(error) => {
                warn!(host = %name, %url, %error, "a paired host's address does not parse; it is left out");
                None
            }
        })
        .collect())
}

/// keeps a pairing; false when a paired host already has the name or the address.
///
/// # Errors
/// the store is not answering.
pub async fn insert(store: &Store, paired: &Paired) -> Result<bool, StoreError> {
    let row = (
        paired.name.clone(),
        paired.url.to_string(),
        paired.credential.expose().to_owned(),
        paired.pair_id.clone(),
        crate::now_ms(),
    );
    store
        .call(move |c| {
            let changed = c.execute(
                "INSERT INTO paired_hosts (name, url, credential, pair_id, paired_at)
                 VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
                params![row.0, row.1, row.2, row.3, row.4],
            )?;
            Ok(changed == 1)
        })
        .await
}

/// forgets a pairing; answers the daemon's id for it, or `None` when no
/// paired host had the name.
///
/// # Errors
/// the store is not answering.
pub async fn remove(store: &Store, name: &str) -> Result<Option<String>, StoreError> {
    let name = name.to_owned();
    store
        .call(move |c| {
            c.query_row(
                "DELETE FROM paired_hosts WHERE name = ?1 RETURNING pair_id",
                [name],
                |r| r.get(0),
            )
            .optional()
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_pairing_is_kept_refused_twice_and_forgotten() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let paired = Paired {
            name: "studio".into(),
            url: Url::parse("http://studio.example:4096").unwrap(),
            credential: Secret::new("cmx2c_secret".into()),
            pair_id: "c_1".into(),
        };
        assert!(insert(&store, &paired).await.unwrap());
        assert!(
            !insert(&store, &paired).await.unwrap(),
            "a name is kept once"
        );
        let hosts = load(&store).await.unwrap();
        assert_eq!(hosts, vec![paired.host()]);
        assert_eq!(
            remove(&store, "studio").await.unwrap().as_deref(),
            Some("c_1")
        );
        assert_eq!(remove(&store, "studio").await.unwrap(), None);
        assert!(load(&store).await.unwrap().is_empty());
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
