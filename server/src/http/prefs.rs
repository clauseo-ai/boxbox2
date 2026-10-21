//! preferences: `GET /api/prefs`, `PUT /api/prefs/devices/{device}`,
//! `PUT /api/prefs/repos`, `PUT /api/prefs/models` and `PUT /api/prefs/colours`. what each
//! holds and how long it is kept is `src/prefs.rs`; a repo's colour is the fleet's
//! (`src/fleet/colours.rs`), and every client hears it on the stream.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use utoipa::ToSchema;

use super::AppState;
use super::error::{ApiError, ErrorBody};
use crate::fleet::Chosen;
use crate::fleet::colours;
use crate::fleet::model::ColourRefused;
use crate::prefs::{self, DevicePrefs, ModelPrefs, Prefs, RepoPrefs};
use crate::wire::RepoColour;

/// a model id or an effort longer than this is not one a daemon lists.
const NAME_MAX: usize = 200;
const DIRECTORY_MAX: usize = 1000;
/// more favourites than this is a list nobody picks from.
const FAVORITES_MAX: usize = 64;

/// every preference: each device's appearance, each repo's defaults, the
/// favourite models.
#[utoipa::path(
    get,
    path = "/api/prefs",
    responses(
        (status = 200, description = "every preference", body = Prefs),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the store is not answering", body = ErrorBody),
    ),
)]
pub async fn all(State(state): State<Arc<AppState>>) -> Result<Json<Prefs>, ApiError> {
    Ok(Json(
        prefs::load(&state.store)
            .await
            .map_err(|_| ApiError::StoreDown)?,
    ))
}

/// sets one device's theme and motion.
#[utoipa::path(
    put,
    path = "/api/prefs/devices/{device}",
    params(("device" = String, Path, description = "the device id the app minted")),
    request_body = DevicePrefs,
    responses(
        (status = 200, description = "saved", body = DevicePrefs),
        (status = 400, description = "not a device id", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the store is not answering", body = ErrorBody),
    ),
)]
pub async fn device(
    State(state): State<Arc<AppState>>,
    Path(device): Path<String>,
    Json(value): Json<DevicePrefs>,
) -> Result<Json<DevicePrefs>, ApiError> {
    let valid = !device.is_empty()
        && device.len() <= 64
        && device
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid {
        return Err(ApiError::BadRequest(format!(
            "\"{device}\" is not a device id"
        )));
    }
    prefs::put_device(&state.store, &device, value)
        .await
        .map_err(|_| ApiError::StoreDown)?;
    tracing::info!(%device, theme = ?value.theme, motion = ?value.motion, "device prefs saved");
    Ok(Json(value))
}

/// sets the model and effort a new thread in one repo starts with; with
/// neither, the daemon's defaults apply again.
#[utoipa::path(
    put,
    path = "/api/prefs/repos",
    request_body = RepoPrefs,
    responses(
        (status = 200, description = "saved", body = RepoPrefs),
        (status = 400, description = "the host is unknown, or a value is not usable", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the store is not answering", body = ErrorBody),
    ),
)]
pub async fn repo(
    State(state): State<Arc<AppState>>,
    Json(value): Json<RepoPrefs>,
) -> Result<Json<RepoPrefs>, ApiError> {
    super::hosts::find(&state, &value.host)
        .map_err(|_| ApiError::BadRequest(format!("no machine named \"{}\"", value.host)))?;
    if !value.directory.starts_with('/') || value.directory.len() > DIRECTORY_MAX {
        return Err(ApiError::BadRequest(
            "the repo's directory must be an absolute path".into(),
        ));
    }
    let usable = |text: &Option<String>| {
        text.as_deref().is_none_or(|t| {
            !t.is_empty() && t.len() <= NAME_MAX && !t.chars().any(char::is_control)
        })
    };
    if !usable(&value.model) || !usable(&value.effort) {
        return Err(ApiError::BadRequest(
            "pick a model and an effort the machine lists".into(),
        ));
    }
    prefs::put_repo(&state.store, &value)
        .await
        .map_err(|_| ApiError::StoreDown)?;
    tracing::info!(host = %value.host, directory = %value.directory, model = value.model.as_deref().unwrap_or("-"), effort = value.effort.as_deref().unwrap_or("-"), "repo prefs saved");
    Ok(Json(value))
}

/// a person's choice of colour for one repo.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, ToSchema)]
pub struct ColourChoice {
    pub host: String,
    /// the repo's root on that host, as the stream's `colour` frames name it.
    pub root: String,
    /// one of the ten repo colours by name; null for automatic, which shows the
    /// colour boxbox gave the repo again.
    pub chosen: Option<String>,
}

/// sets the colour a repo wears on every device, or automatic. the change
/// reaches every client that asked for colours as a `colour` frame on the stream.
#[utoipa::path(
    put,
    path = "/api/prefs/colours",
    request_body = ColourChoice,
    responses(
        (status = 200, description = "saved: the repo's colour as it stands", body = RepoColour),
        (status = 400, description = "the host is unknown, the root is not an absolute path or holds no thread boxbox knows, or the colour is not a repo colour", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the store did not keep it (every device shows it until the server restarts), or the server is stopping", body = ErrorBody),
    ),
)]
pub async fn colour(
    State(state): State<Arc<AppState>>,
    Json(value): Json<ColourChoice>,
) -> Result<Json<RepoColour>, ApiError> {
    super::hosts::find(&state, &value.host)
        .map_err(|_| ApiError::BadRequest(format!("no machine named \"{}\"", value.host)))?;
    let chosen = checked_colour(&value)?;
    let Chosen { colour, written } = state
        .fleet
        .choose_colour(value.host.clone(), value.root.clone(), chosen)
        .await
        .map_err(|_| ApiError::Stopping)?
        .map_err(|ColourRefused::UnknownRepo| {
            ApiError::BadRequest(format!(
                "boxbox has no thread in {} on {}; a repo gets a colour once a thread works there",
                value.root, value.host
            ))
        })?;
    // every stream has heard the choice; the answer waits for the row to be kept
    if written.await != Ok(true) {
        tracing::warn!(host = %colour.host, root = %colour.root, "a repo colour was chosen but not kept; it holds until the server restarts");
        return Err(ApiError::StoreDown);
    }
    tracing::info!(host = %colour.host, root = %colour.root, auto = %colour.auto, chosen = colour.chosen.as_deref().unwrap_or("-"), "repo colour chosen");
    Ok(Json(colour))
}

/// the choice's slot, once its root and its colour are usable.
fn checked_colour(value: &ColourChoice) -> Result<Option<u8>, ApiError> {
    if !value.root.starts_with('/')
        || value.root.len() > DIRECTORY_MAX
        || !colours::keepable(&value.host, &value.root)
        || value.root.chars().any(char::is_control)
    {
        return Err(ApiError::BadRequest(
            "the repo's root must be an absolute path".into(),
        ));
    }
    match value.chosen.as_deref() {
        None => Ok(None),
        Some(name) => colours::slot(name).map(Some).ok_or_else(|| {
            ApiError::BadRequest(format!(
                "\"{name}\" is not a repo colour. pick one of {}, or automatic",
                colours::NAMES.join(", ")
            ))
        }),
    }
}

/// sets the favourite models, in order. repeats are dropped, keeping the
/// first; the answer is the list as saved.
#[utoipa::path(
    put,
    path = "/api/prefs/models",
    request_body = ModelPrefs,
    responses(
        (status = 200, description = "saved, without repeats", body = ModelPrefs),
        (status = 400, description = "an id is empty, too long or has control characters, or there are more than 64", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 503, description = "the store is not answering", body = ErrorBody),
    ),
)]
pub async fn favorite_models(
    State(state): State<Arc<AppState>>,
    Json(value): Json<ModelPrefs>,
) -> Result<Json<ModelPrefs>, ApiError> {
    let value = checked_favorites(value)?;
    prefs::put_models(&state.store, &value)
        .await
        .map_err(|_| ApiError::StoreDown)?;
    tracing::info!(favorites = value.favorites.len(), "favourite models saved");
    Ok(Json(value))
}

/// the list as it will be kept: every id usable, at most 64 of them once
/// the repeats go.
fn checked_favorites(value: ModelPrefs) -> Result<ModelPrefs, ApiError> {
    let mut seen = std::collections::HashSet::new();
    let mut favorites = Vec::with_capacity(value.favorites.len().min(FAVORITES_MAX));
    for id in value.favorites {
        if id.is_empty() || id.len() > NAME_MAX || id.chars().any(char::is_control) {
            return Err(ApiError::BadRequest(
                "a favourite is a model the machine lists, as provider/model".into(),
            ));
        }
        if seen.insert(id.clone()) {
            favorites.push(id);
        }
    }
    if favorites.len() > FAVORITES_MAX {
        return Err(ApiError::BadRequest(format!(
            "keep at most {FAVORITES_MAX} favourite models"
        )));
    }
    Ok(ModelPrefs { favorites })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(ids: &[&str]) -> ModelPrefs {
        ModelPrefs {
            favorites: ids.iter().map(|id| (*id).to_owned()).collect(),
        }
    }

    fn choice(root: &str, chosen: Option<&str>) -> ColourChoice {
        ColourChoice {
            host: "desk".into(),
            root: root.into(),
            chosen: chosen.map(str::to_owned),
        }
    }

    #[test]
    fn a_colour_choice_takes_a_repo_colour_or_automatic_for_an_absolute_root() {
        assert_eq!(
            checked_colour(&choice("/work/api", Some("sunset"))).unwrap(),
            Some(6)
        );
        assert_eq!(checked_colour(&choice("/work/api", None)).unwrap(), None);
        assert_eq!(
            checked_colour(&choice("/", Some("green"))).unwrap(),
            Some(0)
        );
        for name in colours::NAMES {
            assert!(checked_colour(&choice("/w", Some(name))).is_ok(), "{name}");
        }
    }

    #[test]
    fn a_colour_choice_refuses_a_relative_root_and_anything_but_the_ten() {
        for (root, chosen) in [
            ("work/api", Some("green")),
            ("", None),
            ("/work/a\nb", None),
            (&*format!("/{}", "d".repeat(DIRECTORY_MAX)), None),
            ("/work/api", Some("coral")),
            ("/work/api", Some("Green")),
            ("/work/api", Some("")),
            ("/work/api", Some("#ff0000")),
        ] {
            assert!(
                matches!(
                    checked_colour(&choice(root, chosen)),
                    Err(ApiError::BadRequest(_))
                ),
                "{root:?} {chosen:?}"
            );
        }
    }

    #[test]
    fn favourites_keep_their_order_and_the_first_of_a_repeat() {
        let kept = checked_favorites(list(&["b/x", "a/y", "b/x", "c/z", "a/y"])).unwrap();
        assert_eq!(kept, list(&["b/x", "a/y", "c/z"]));
    }

    #[test]
    fn an_empty_list_is_a_valid_clear() {
        assert_eq!(checked_favorites(list(&[])).unwrap(), list(&[]));
    }

    #[test]
    fn a_favourite_that_is_empty_long_or_has_control_characters_is_refused() {
        for bad in ["", "a/b\nc", "a/b\u{0}", &"m".repeat(NAME_MAX + 1)] {
            assert!(
                matches!(
                    checked_favorites(list(&["ok/one", bad])),
                    Err(ApiError::BadRequest(_))
                ),
                "{bad:?}"
            );
        }
        assert!(checked_favorites(list(&[&"m".repeat(NAME_MAX)])).is_ok());
    }

    #[test]
    fn at_most_64_favourites_once_repeats_are_dropped() {
        let ids: Vec<String> = (0..FAVORITES_MAX).map(|n| format!("p/m{n}")).collect();
        let full = ModelPrefs { favorites: ids };
        assert_eq!(checked_favorites(full.clone()).unwrap(), full);

        let mut over = full.clone();
        over.favorites.push("p/one-more".into());
        assert!(matches!(
            checked_favorites(over),
            Err(ApiError::BadRequest(_))
        ));

        // repeats do not count toward the cap
        let mut repeated = full.clone();
        repeated.favorites.extend(full.favorites.iter().cloned());
        assert_eq!(checked_favorites(repeated).unwrap(), full);
    }
}
