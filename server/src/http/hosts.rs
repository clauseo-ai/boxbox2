//! the machines: `GET /api/hosts` (every host's connection, health,
//! version and memory, read from the watchers without waiting on them),
//! pairing a host and forgetting one, the models a host can run, and the
//! two daemon verbs the machines screen offers: reload, which is safe, and
//! restart, which aborts every running turn. each is proxied with the
//! host's credential, which never leaves the server.

use std::sync::Arc;
use std::time::Instant;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tracing::info;
use utoipa::ToSchema;

use super::AppState;
use super::agents;
use super::error::{ApiError, ErrorBody};
use crate::config::{self, Credential, Origin, Secret};
use crate::source::cmx2::verbs::hosts::{ANSWER_TIMEOUT, message_of, read_capped};
use crate::upstream::paired::{self, CLIENT_NAME, Paired};
use crate::upstream::{HostChange, HostStatus, HostView, plain, route_url};
use crate::wire::Capability;
/// the efforts a model can take, least to most.
const EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/// a one-time token from `cmx2 pair` is 40-odd characters.
const TOKEN_MAX: usize = 512;

/// each host, configured ones in `boxbox.toml` order, then paired ones.
#[utoipa::path(
    get,
    path = "/api/hosts",
    responses(
        (status = 200, description = "every host", body = [HostStatus]),
        (status = 401, description = "not signed in", body = ErrorBody),
    ),
)]
pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<HostStatus>> {
    let hosts = state.upstreams.hosts.borrow().clone();
    Json(hosts.iter().map(HostView::snapshot).collect())
}

/// what `cmx2 pair` printed, and what to call the machine.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Pair {
    /// the daemon's address, the `url` line.
    pub url: String,
    /// the one-time token, the `token` line.
    pub token: String,
    /// lowercase letters, digits and dashes; from the address when absent.
    pub name: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PairedHost {
    pub name: String,
    pub url: String,
    pub version: String,
    pub contract: i64,
    pub contract_matches: bool,
}

#[derive(Deserialize)]
struct PairAnswer {
    id: String,
    credential: String,
    scheme: String,
    version: String,
    contract: i64,
}

/// trades a one-time token for the host's bearer credential, keeps it
/// server-side and starts watching the host.
#[utoipa::path(
    post,
    path = "/api/hosts/pair",
    request_body = Pair,
    responses(
        (status = 201, description = "paired; the host is being watched", body = PairedHost),
        (status = 400, description = "the address, token or name is not usable", body = ErrorBody),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 409, description = "the name or the address is already here", body = ErrorBody),
        (status = 422, description = "the daemon refused the token, or does not pair", body = ErrorBody),
        (status = 502, description = "the daemon did not answer", body = ErrorBody),
    ),
)]
pub async fn pair(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Pair>,
) -> Result<(StatusCode, Json<PairedHost>), ApiError> {
    let url = config::http_url(body.url.trim())
        .map_err(|e| ApiError::BadRequest(format!("{e}. paste the url line cmx2 pair printed")))?;
    let token = body.token.trim();
    if token.is_empty() || token.len() > TOKEN_MAX || token.chars().any(char::is_whitespace) {
        return Err(ApiError::BadRequest(
            "paste the token line cmx2 pair printed".into(),
        ));
    }
    let name = match body.name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => name.to_owned(),
        _ => name_from(&url),
    };
    if !config::is_host_name(&name) {
        return Err(ApiError::BadRequest(
            "name the machine with lowercase letters, digits and dashes, up to 32".into(),
        ));
    }
    refuse_taken(&state, &name, &url)?;
    refuse_reserved(&state, &name).await?;
    let answer = trade(&state.client, &url, token).await?;
    let credential = Secret::new(answer.credential);
    if answer.scheme != "Bearer" || Credential::Bearer(credential.clone()).header().is_none() {
        return Err(ApiError::PairFailed(
            "the daemon's credential is not one boxbox can send".into(),
        ));
    }
    let paired = Paired {
        name: name.clone(),
        url: url.clone(),
        credential,
        pair_id: answer.id,
    };
    if !paired::insert(&state.store, &paired)
        .await
        .map_err(|_| ApiError::StoreDown)?
    {
        return Err(ApiError::HostTaken(name));
    }
    state
        .upstreams
        .reload
        .send(HostChange::Paired(paired.host()))
        .await
        .map_err(|_| ApiError::Stopping)?;
    let contract_matches = answer.contract == crate::cmx2::CONTRACT_VERSION;
    info!(host = %name, %url, pair_id = %paired.pair_id, version = %answer.version, contract = answer.contract, "host paired");
    Ok((
        StatusCode::CREATED,
        Json(PairedHost {
            name,
            url: url.to_string(),
            version: answer.version,
            contract: answer.contract,
            contract_matches,
        }),
    ))
}

/// the exchange itself: the one-time token for the daemon's answer.
async fn trade(client: &reqwest::Client, url: &Url, token: &str) -> Result<PairAnswer, ApiError> {
    let started = Instant::now();
    let sent = tokio::time::timeout(
        ANSWER_TIMEOUT,
        client
            .post(route_url(url, "/pair"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::json!({ "token": token, "name": CLIENT_NAME }).to_string())
            .send(),
    )
    .await;
    let response = match sent {
        Err(_) => {
            return Err(ApiError::PairUnreachable {
                url: url.to_string(),
                reason: format!("no answer within {}s", ANSWER_TIMEOUT.as_secs()),
            });
        }
        Ok(Err(error)) => {
            return Err(ApiError::PairUnreachable {
                url: url.to_string(),
                reason: plain(&error),
            });
        }
        Ok(Ok(response)) => response,
    };
    let status = response.status();
    info!(%url, route = "/pair", status = status.as_u16(), latency_ms = started.elapsed().as_millis(), "pair answered");
    match status {
        StatusCode::UNAUTHORIZED => return Err(ApiError::PairRefused),
        StatusCode::NOT_FOUND => return Err(ApiError::PairUnsupported(url.to_string())),
        status if !status.is_success() => {
            return Err(ApiError::PairFailed(format!(
                "the daemon answered {status}: {}",
                message_of(&read_capped(response).await.unwrap_or_default())
            )));
        }
        _ => {}
    }
    let bytes = read_capped(response)
        .await
        .map_err(|reason| ApiError::PairUnreachable {
            url: url.to_string(),
            reason,
        })?;
    serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::PairFailed(format!("the daemon's answer did not read ({e})")))
}

/// forgets a paired host: its credential is deleted and its watcher stops.
/// the daemon keeps its record until `cmx2 pair --revoke boxbox` there.
#[utoipa::path(
    delete,
    path = "/api/hosts/{host}",
    params(("host" = String, Path, description = "the host's name")),
    responses(
        (status = 204, description = "forgotten"),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 409, description = "the host is set in boxbox.toml", body = ErrorBody),
    ),
)]
pub async fn forget(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
) -> Result<StatusCode, ApiError> {
    let view = find(&state, &host)?;
    if view.config.origin == Origin::Config {
        return Err(ApiError::ConfiguredHost(host));
    }
    let pair_id = paired::remove(&state.store, &host)
        .await
        .map_err(|_| ApiError::StoreDown)?
        .ok_or_else(|| ApiError::UnknownHost(host.clone()))?;
    state
        .upstreams
        .reload
        .send(HostChange::Forgotten(host.clone()))
        .await
        .map_err(|_| ApiError::Stopping)?;
    info!(%host, %pair_id, "host forgotten");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Reloaded {
    /// config files that changed since the daemon last read them.
    pub changed: Vec<String>,
    /// what the daemon flushed: skills, agents, commands, models.
    pub flushed: Vec<String>,
    pub mcp: Vec<McpServer>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct McpServer {
    pub name: String,
    /// `connecting`, `connected`, `failed`, `disabled` or `needs_auth`.
    pub status: String,
}

/// the daemon re-reads its config and flushes skills, agents, commands,
/// the model list and language servers, and reconnects mcp servers.
/// sessions are untouched.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/reload",
    params(("host" = String, Path, description = "the host's name")),
    responses(
        (status = 200, description = "reloaded", body = Reloaded),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer, refused the credential or failed", body = ErrorBody),
    ),
)]
pub async fn reload(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
) -> Result<Json<Reloaded>, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Admin))?;
    Ok(Json(source.reload_global().await?))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Restarting {
    pub host: String,
}

/// the daemon aborts every running turn, closes its streams and exits for
/// its supervisor to start a fresh one. the host's watcher sees the stream
/// end and reconnects to the new daemon from its cursor.
#[utoipa::path(
    post,
    path = "/api/hosts/{host}/restart",
    params(("host" = String, Path, description = "the host's name")),
    responses(
        (status = 202, description = "the daemon is restarting", body = Restarting),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer, refused the credential or failed", body = ErrorBody),
    ),
)]
pub async fn restart(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
) -> Result<(StatusCode, Json<Restarting>), ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Admin))?;
    source.restart_global().await?;
    info!(%host, "host restarting on request");
    Ok((StatusCode::ACCEPTED, Json(Restarting { host })))
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostModels {
    pub models: Vec<ModelChoice>,
    /// `<provider>/<model>` the daemon starts a thread with, when it says.
    pub default: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ModelChoice {
    /// `<provider>/<model>`.
    pub id: String,
    pub name: String,
    pub provider: String,
    /// the model's variants: its efforts, then the profile's named ones.
    pub efforts: Vec<String>,
}

/// the models a host can run, for the per-repo defaults.
#[utoipa::path(
    get,
    path = "/api/hosts/{host}/models",
    params(("host" = String, Path, description = "the host's name")),
    responses(
        (status = 200, description = "the host's models", body = HostModels),
        (status = 401, description = "not signed in", body = ErrorBody),
        (status = 404, description = "no such host", body = ErrorBody),
        (status = 502, description = "the host did not answer, refused the credential or failed", body = ErrorBody),
    ),
)]
pub async fn models(
    State(state): State<Arc<AppState>>,
    Path(host): Path<String>,
) -> Result<Json<HostModels>, ApiError> {
    let source = agents::cmx2(&state, &host, Some(Capability::Model))?;
    let answer = source.provider_models().await?;
    Ok(Json(read_models(&answer)))
}

/// `/config/providers` read loosely: past `id`, `providerID` and `name` the
/// contract leaves a model open, and variants arrive as a map by name.
pub(crate) fn read_models(answer: &serde_json::Value) -> HostModels {
    let mut models = Vec::new();
    let mut default = None;
    for provider in answer["providers"].as_array().into_iter().flatten() {
        let provider_id = provider["id"].as_str().unwrap_or_default();
        if let Some(chosen) = answer["default"][provider_id].as_str()
            && default.is_none()
        {
            default = Some(format!("{provider_id}/{chosen}"));
        }
        for model in provider["models"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.values())
        {
            let (Some(id), Some(name)) = (model["id"].as_str(), model["name"].as_str()) else {
                continue;
            };
            let mut efforts: Vec<String> = match &model["variants"] {
                serde_json::Value::Object(named) => named.keys().cloned().collect(),
                serde_json::Value::Array(list) => list
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            };
            // a json map carries no order, so the efforts go least to most, then named variants by name
            efforts.sort_by_key(|effort| {
                let rank = EFFORTS
                    .iter()
                    .position(|e| e == effort)
                    .unwrap_or(EFFORTS.len());
                (rank, effort.clone())
            });
            models.push(ModelChoice {
                id: format!("{provider_id}/{id}"),
                name: name.to_owned(),
                provider: provider["name"].as_str().unwrap_or(provider_id).to_owned(),
                efforts,
            });
        }
    }
    HostModels { models, default }
}

pub(super) fn find(state: &AppState, host: &str) -> Result<HostView, ApiError> {
    state
        .upstreams
        .hosts
        .borrow()
        .iter()
        .find(|view| view.config.name == host)
        .cloned()
        .ok_or_else(|| ApiError::UnknownHost(host.to_owned()))
}

fn refuse_taken(state: &AppState, name: &str, url: &Url) -> Result<(), ApiError> {
    let hosts = state.upstreams.hosts.borrow();
    if hosts.iter().any(|view| view.config.name == name) {
        return Err(ApiError::HostTaken(name.to_owned()));
    }
    let same = |a: &Url| a.as_str().trim_end_matches('/') == url.as_str().trim_end_matches('/');
    if let Some(view) = hosts.iter().find(|view| same(&view.config.url)) {
        return Err(ApiError::AddressTaken(view.config.name.clone()));
    }
    Ok(())
}

/// connection names and agent keys are one namespace (`agents.md`, section
/// 3, collisions): a paired host never takes the name of an `[[openclaw]]`
/// or `[[hermes]]` connection, a key one of them pins, or a key an agent
/// already holds, since read marks, needs and clears are keyed by it.
async fn refuse_reserved(state: &AppState, name: &str) -> Result<(), ApiError> {
    if let Some(taken) = state.upstreams.reservation(name) {
        return Err(ApiError::NameReserved {
            name: name.to_owned(),
            holder: taken.holder,
            agent_key: false,
        });
    }
    let owner = state
        .store
        .agent_key_owner(name)
        .await
        .map_err(|_| ApiError::StoreDown)?;
    if let Some((connection, _)) = owner {
        return Err(ApiError::NameReserved {
            name: name.to_owned(),
            holder: format!("the key of an agent on {connection}"),
            agent_key: true,
        });
    }
    Ok(())
}

/// a name from the address: its first label, lowercased, anything else a
/// dash. `http://studio.tail1234.ts.net:4096` is `studio`.
fn name_from(url: &Url) -> String {
    let label = url
        .host_str()
        .unwrap_or("machine")
        .split('.')
        .next()
        .unwrap_or("machine");
    let name: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(32)
        .collect();
    let name = name.trim_matches('-');
    if name.is_empty() || name.chars().all(|c| c.is_ascii_digit() || c == '-') {
        "machine".into()
    } else {
        name.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_comes_from_the_first_label_of_the_address() {
        let name = |url: &str| name_from(&Url::parse(url).unwrap());
        assert_eq!(name("http://studio.tail1234.ts.net:4096"), "studio");
        assert_eq!(name("http://Build_Box:4096"), "build-box");
        assert_eq!(name("http://127.0.0.1:4950"), "machine");
    }

    #[test]
    fn the_model_list_reads_variants_as_efforts() {
        let answer = serde_json::json!({
            "providers": [{"id": "anthropic", "name": "Anthropic", "models": {
                "m": {"id": "m", "providerID": "anthropic", "name": "model m", "variants": {"max": {}, "low": {}, "fast": {}, "high": {}}}
            }}],
            "default": {"anthropic": "m"}
        });
        let read = read_models(&answer);
        assert_eq!(read.default.as_deref(), Some("anthropic/m"));
        assert_eq!(read.models[0].id, "anthropic/m");
        assert_eq!(read.models[0].efforts, ["low", "high", "max", "fast"]);
    }
}
