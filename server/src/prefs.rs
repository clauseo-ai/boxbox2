//! preferences, in `boxbox.db`'s `prefs` (decision 18): per device, the
//! theme and motion; per repo, the model and effort a new thread there
//! starts with; and one list, shared by every device, of the favourite
//! models. each row is one typed json document, validated here on the
//! way in and read back leniently (a document from a newer build keeps
//! what this build knows), so the app never gets a value it cannot render.
//!
//! the person's own settings are one more document for every device,
//! scope `person`, subject `home` (`HomePrefs`, decisions 93 to 95): when
//! finished work clears itself, whether working windows fold, and whether a
//! job notice counts as a need. the fleet reads it too (`fleet::restore`, and
//! `PUT /api/prefs/home` tells it at once), since the sweep and the badge
//! follow it.
//!
//! a device's push kinds are the one preference kept elsewhere: push
//! decides from the subscription row that carries them (`docs/push.md`),
//! so the settings screen changes them through that subscription.
//!
//! a repo's colour is in this table too, scope `colour`, but it is the
//! fleet's: given, chosen and evicted there (`fleet/colours.rs`) and sent
//! to every client on the stream, so `load` leaves it out.
//!
//! eviction: each scope here keeps its 1,000 most recently changed rows,
//! counted apart, so one scope's churn never pushes out another's rows.

use std::collections::BTreeMap;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tracing::warn;
use utoipa::ToSchema;

use crate::store::{Store, StoreError};

/// rows kept per scope; the least recently changed go first.
const KEEP: u32 = 1_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// follow the system's appearance.
    #[default]
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Motion {
    /// follow the system's reduce motion setting.
    #[default]
    System,
    /// springs become instant, swaps keep a short fade (`design.md`).
    Reduced,
    /// the full motion law, whatever the system says.
    Full,
}

/// one device's appearance.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct DevicePrefs {
    pub theme: Theme,
    pub motion: Motion,
}

/// what a new thread in one repo starts with. absent means the daemon's
/// own default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoPrefs {
    pub host: String,
    /// the repo's directory on that host, as cmx2 names it.
    pub directory: String,
    /// `<provider>/<model>`, as the host's `/config/providers` lists it.
    pub model: Option<String>,
    /// one of the model's variants: an effort, or a named variant.
    pub effort: Option<String>,
}

/// the models a person keeps at the top of every picker, on every device.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(default)]
pub struct ModelPrefs {
    /// `<provider>/<model>` ids, in the order the person put them. an id no
    /// host lists any more stays until they unpin it.
    pub favorites: Vec<String>,
}

/// when a finished thread leaves home by itself (decision 93).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum AutoClear {
    /// an hour after a person's read mark covered its newest finished reply.
    #[default]
    #[serde(rename = "seen1h")]
    Seen1h,
    /// three hours after it settled, seen or not.
    #[serde(rename = "any3h")]
    Any3h,
    /// never: only a person clears.
    #[serde(rename = "never")]
    Never,
}

impl AutoClear {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Seen1h => "seen1h",
            Self::Any3h => "any3h",
            Self::Never => "never",
        }
    }
}

/// the person's home, the same on every device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct HomePrefs {
    pub auto_clear: AutoClear,
    /// working and queued windows with nothing for the person fold into one
    /// capsule above the windows (the app's).
    pub fold_working: bool,
    /// a background job's notice counts as a need: in the badge, in the
    /// order and as unseen (decision 95). off by default.
    pub jobs_as_needs: bool,
}

impl Default for HomePrefs {
    fn default() -> Self {
        Self {
            auto_clear: AutoClear::Seen1h,
            fold_working: true,
            jobs_as_needs: false,
        }
    }
}

#[derive(Debug, Default, Serialize, ToSchema)]
pub struct Prefs {
    /// by device id.
    pub devices: BTreeMap<String, DevicePrefs>,
    /// by host, then directory.
    pub repos: Vec<RepoPrefs>,
    /// shared by every device.
    pub models: ModelPrefs,
    /// the person's home, shared by every device; the defaults until set.
    pub home: HomePrefs,
}

/// the one row of the `models` scope.
const MODELS_SUBJECT: &str = "favorites";
/// the home row of the `person` scope.
const HOME_SUBJECT: &str = "home";

#[derive(Serialize, Deserialize, Default)]
struct RepoValue {
    model: Option<String>,
    effort: Option<String>,
}

/// every preference.
///
/// # Errors
/// the store is not answering.
pub async fn load(store: &Store) -> Result<Prefs, StoreError> {
    let rows: Vec<(String, String, String)> = store
        .call(|c| {
            let mut statement =
                c.prepare("SELECT scope, subject, value FROM prefs ORDER BY scope, subject")?;
            statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .await?;
    let mut prefs = Prefs::default();
    for (scope, subject, value) in rows {
        match scope.as_str() {
            "device" => match serde_json::from_str::<DevicePrefs>(&value) {
                Ok(device) => {
                    prefs.devices.insert(subject, device);
                }
                Err(error) => {
                    warn!(device = %subject, %error, "a device's prefs do not read; it gets the defaults");
                }
            },
            "repo" => {
                let Some((host, directory)) = subject.split_once(':') else {
                    warn!(%subject, "a repo pref has no host; left out");
                    continue;
                };
                match serde_json::from_str::<RepoValue>(&value) {
                    Ok(repo) => prefs.repos.push(RepoPrefs {
                        host: host.to_owned(),
                        directory: directory.to_owned(),
                        model: repo.model,
                        effort: repo.effort,
                    }),
                    Err(error) => warn!(%subject, %error, "a repo's prefs do not read; left out"),
                }
            }
            "person" if subject == HOME_SUBJECT => prefs.home = read_home(&value),
            "models" if subject == MODELS_SUBJECT => {
                match serde_json::from_str::<ModelPrefs>(&value) {
                    Ok(models) => prefs.models = models,
                    Err(error) => warn!(%error, "the favourite models do not read; there are none"),
                }
            }
            _ => {}
        }
    }
    Ok(prefs)
}

/// the home document as stored, each field on its own: a value this build
/// does not know (a newer build's rule) is that field's default, and the
/// others keep what was saved.
fn read_home(value: &str) -> HomePrefs {
    let mut home = HomePrefs::default();
    let fields = match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(value) {
        Ok(fields) => fields,
        Err(error) => {
            warn!(%error, "the home prefs do not read; they are the defaults");
            return home;
        }
    };
    let field = |name: &str| fields.get(name).cloned();
    if let Some(value) = field("autoClear") {
        match serde_json::from_value(value) {
            Ok(rule) => home.auto_clear = rule,
            Err(error) => {
                warn!(%error, "the home prefs' auto-clear does not read; it is the default");
            }
        }
    }
    for (name, slot) in [
        ("foldWorking", &mut home.fold_working),
        ("jobsAsNeeds", &mut home.jobs_as_needs),
    ] {
        if let Some(value) = field(name) {
            match serde_json::from_value(value) {
                Ok(flag) => *slot = flag,
                Err(error) => {
                    warn!(%error, field = name, "a home pref does not read; it is the default");
                }
            }
        }
    }
    home
}

/// the home prefs, from the fleet's own start (`fleet::restore`), on the
/// store's thread.
///
/// # Errors
/// sqlite's.
pub fn load_home(connection: &rusqlite::Connection) -> rusqlite::Result<HomePrefs> {
    use rusqlite::OptionalExtension;
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM prefs WHERE scope = 'person' AND subject = ?1",
            [HOME_SUBJECT],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.as_deref().map(read_home).unwrap_or_default())
}

/// writes the person's home prefs, on the store's thread: the fleet's writer
/// does, in the order the saves reached the fleet (`PUT /api/prefs/home`).
///
/// # Errors
/// sqlite's.
pub fn save_home(connection: &rusqlite::Connection, value: HomePrefs) -> rusqlite::Result<()> {
    let json = serde_json::to_string(&value).unwrap_or_default();
    connection.execute(
        "INSERT INTO prefs (scope, subject, value, updated_at) VALUES ('person', ?1, ?2, ?3)
         ON CONFLICT (scope, subject) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![HOME_SUBJECT, json, crate::now_ms()],
    )?;
    Ok(())
}

/// sets one device's appearance.
///
/// # Errors
/// the store is not answering.
pub async fn put_device(store: &Store, device: &str, value: DevicePrefs) -> Result<(), StoreError> {
    let json = serde_json::to_string(&value).unwrap_or_default();
    upsert(store, "device", device.to_owned(), Some(json)).await
}

/// sets one repo's defaults; with neither a model nor an effort, the row
/// goes and the daemon's defaults apply again.
///
/// # Errors
/// the store is not answering.
pub async fn put_repo(store: &Store, repo: &RepoPrefs) -> Result<(), StoreError> {
    let subject = format!("{}:{}", repo.host, repo.directory);
    let json = (repo.model.is_some() || repo.effort.is_some()).then(|| {
        serde_json::to_string(&RepoValue {
            model: repo.model.clone(),
            effort: repo.effort.clone(),
        })
        .unwrap_or_default()
    });
    upsert(store, "repo", subject, json).await
}

/// sets the favourite models; an empty list removes the row.
///
/// # Errors
/// the store is not answering.
pub async fn put_models(store: &Store, value: &ModelPrefs) -> Result<(), StoreError> {
    let json =
        (!value.favorites.is_empty()).then(|| serde_json::to_string(value).unwrap_or_default());
    upsert(store, "models", MODELS_SUBJECT.to_owned(), json).await
}

async fn upsert(
    store: &Store,
    scope: &'static str,
    subject: String,
    value: Option<String>,
) -> Result<(), StoreError> {
    let now = crate::now_ms();
    store
        .call(move |c| {
            let transaction = c.transaction()?;
            match value {
                Some(value) => {
                    transaction.execute(
                        "INSERT INTO prefs (scope, subject, value, updated_at) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (scope, subject) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        params![scope, subject, value, now],
                    )?;
                    transaction.execute(
                        "DELETE FROM prefs WHERE scope = ?1 AND subject NOT IN
                         (SELECT subject FROM prefs WHERE scope = ?1 ORDER BY updated_at DESC, subject LIMIT ?2)",
                        params![scope, KEEP],
                    )?;
                }
                None => {
                    transaction.execute(
                        "DELETE FROM prefs WHERE scope = ?1 AND subject = ?2",
                        params![scope, subject],
                    )?;
                }
            }
            transaction.commit()
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn prefs_round_trip_and_an_empty_repo_pref_is_removed() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let dark = DevicePrefs {
            theme: Theme::Dark,
            motion: Motion::Reduced,
        };
        put_device(&store, "phone-1", dark).await.unwrap();
        let repo = RepoPrefs {
            host: "bench".into(),
            directory: "/work/api".into(),
            model: Some("anthropic/claude-opus-5-5".into()),
            effort: Some("high".into()),
        };
        put_repo(&store, &repo).await.unwrap();
        let prefs = load(&store).await.unwrap();
        assert_eq!(prefs.devices.get("phone-1"), Some(&dark));
        assert_eq!(prefs.repos, vec![repo.clone()]);

        put_repo(
            &store,
            &RepoPrefs {
                model: None,
                effort: None,
                ..repo
            },
        )
        .await
        .unwrap();
        assert!(load(&store).await.unwrap().repos.is_empty());
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn favourite_models_round_trip_in_order_and_an_empty_list_removes_them() {
        let (store, thread, dir) = crate::store::tests::scratch();
        assert_eq!(load(&store).await.unwrap().models, ModelPrefs::default());
        let favorites = ModelPrefs {
            favorites: vec!["openai/gpt-5".into(), "anthropic/claude-opus-5-5".into()],
        };
        put_models(&store, &favorites).await.unwrap();
        assert_eq!(load(&store).await.unwrap().models, favorites);

        put_models(&store, &ModelPrefs::default()).await.unwrap();
        assert_eq!(load(&store).await.unwrap().models, ModelPrefs::default());
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn home_prefs_default_until_set_and_read_back_leniently() {
        let (store, thread, dir) = crate::store::tests::scratch();
        assert_eq!(load(&store).await.unwrap().home, HomePrefs::default());
        let set = HomePrefs {
            auto_clear: AutoClear::Any3h,
            fold_working: false,
            jobs_as_needs: true,
        };
        store.call(move |c| save_home(c, set)).await.unwrap();
        assert_eq!(load(&store).await.unwrap().home, set);
        assert_eq!(store.call(|c| load_home(c)).await.unwrap(), set);
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();

        let partial: HomePrefs =
            serde_json::from_str(r#"{"autoClear":"never","later":1}"#).unwrap();
        assert_eq!(
            partial,
            HomePrefs {
                auto_clear: AutoClear::Never,
                ..HomePrefs::default()
            }
        );
        assert_eq!(
            read_home("{\"autoClear\":\"weekly\"}"),
            HomePrefs::default()
        );
        // one value this build does not know keeps the others as saved
        assert_eq!(
            read_home(r#"{"autoClear":"weekly","foldWorking":false,"jobsAsNeeds":true}"#),
            HomePrefs {
                auto_clear: AutoClear::Seen1h,
                fold_working: false,
                jobs_as_needs: true,
            }
        );
        assert_eq!(
            read_home(r#"{"autoClear":"any3h","foldWorking":"maybe"}"#),
            HomePrefs {
                auto_clear: AutoClear::Any3h,
                ..HomePrefs::default()
            }
        );
        assert_eq!(read_home("not json"), HomePrefs::default());
        assert_eq!(
            serde_json::to_string(&HomePrefs::default()).unwrap(),
            r#"{"autoClear":"seen1h","foldWorking":true,"jobsAsNeeds":false}"#
        );
    }

    #[test]
    fn a_models_document_without_favorites_reads_as_none() {
        let read: ModelPrefs = serde_json::from_str("{}").unwrap();
        assert!(read.favorites.is_empty());
    }

    #[test]
    fn a_device_document_from_a_newer_build_keeps_what_this_one_knows() {
        let read: DevicePrefs =
            serde_json::from_str(r#"{"theme":"light","density":"tight"}"#).unwrap();
        assert_eq!(
            read,
            DevicePrefs {
                theme: Theme::Light,
                motion: Motion::System
            }
        );
    }

    #[tokio::test]
    async fn each_scope_keeps_its_most_recent_rows() {
        let (store, thread, dir) = crate::store::tests::scratch();
        for n in 0..=KEEP {
            put_device(&store, &format!("d{n}"), DevicePrefs::default())
                .await
                .unwrap();
        }
        let prefs = load(&store).await.unwrap();
        assert_eq!(prefs.devices.len(), KEEP as usize);
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
