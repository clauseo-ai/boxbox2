//! where a route finds the agent it acts on, and the capability check
//! that comes before any call to it (`docs/agents.md`, section 4: a verb an
//! agent cannot do; decision 29).
//!
//! contract 1's `/api/hosts/{host}/...` routes act on cmx2 agents only:
//! the host is the cmx2 connection, its one agent keyed by its name.
//! contract 2's `/api/agents/{agent}/...` routes (`routes.rs`) act on any
//! agent through the `AgentSource` trait. each route names the capability
//! its verb needs; an agent without it answers 422 `unsupported` and
//! nothing reaches the source.

pub mod btw;
pub mod page;
pub mod read;
pub mod routes;
pub mod summary;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;

use super::AppState;
use super::error::ApiError;
use crate::source::cmx2::Cmx2Source;
use crate::source::{AgentFacts, AgentSource, VerbError, identity};
use crate::wire::{Capability, Source, Unsupported};

/// the cmx2 source of `host`, once its agent is shown to have `needs`.
///
/// # Errors
/// no cmx2 connection is named `host` (404 `unknown-host`), or its agent
/// lacks the capability (422 `unsupported`).
pub fn cmx2(
    state: &AppState,
    host: &str,
    needs: Option<Capability>,
) -> Result<Arc<Cmx2Source>, ApiError> {
    let source = state
        .upstreams
        .hosts
        .borrow()
        .iter()
        .find(|h| h.config.name == host)
        .map(|h| Arc::clone(&h.source))
        .ok_or_else(|| ApiError::UnknownHost(host.to_owned()))?;
    if let Some(capability) = needs {
        check(source.as_ref(), host, capability)?;
    }
    Ok(source)
}

/// whether `agent` of `source` can do `capability`, as it publishes.
///
/// # Errors
/// it cannot, or the source publishes no such agent.
pub fn check(
    source: &dyn AgentSource,
    agent: &str,
    capability: Capability,
) -> Result<(), ApiError> {
    let agents = source.agents();
    let agents = agents.borrow();
    let facts = agents
        .iter()
        .find(|a| a.key == agent)
        .ok_or_else(|| ApiError::UnknownHost(agent.to_owned()))?;
    if facts.capabilities.has(capability) {
        return Ok(());
    }
    Err(ApiError::Unsupported(Unsupported::new(
        &identity::words(&facts.label),
        capability,
    )))
}

/// an agent a contract 2 route acts on: its source and its facts as
/// published when the request arrived.
#[derive(Clone)]
pub struct Found {
    pub source: Arc<dyn AgentSource>,
    pub facts: AgentFacts,
}

impl std::fmt::Debug for Found {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Found")
            .field("agent", &self.facts.key)
            .finish_non_exhaustive()
    }
}

/// the agent keyed `agent`, from any running source.
///
/// # Errors
/// no source publishes it: 404 `no-such-agent`.
pub fn find(state: &AppState, agent: &str) -> Result<Found, ApiError> {
    for source in state.upstreams.sources() {
        let facts = source
            .agents()
            .borrow()
            .iter()
            .find(|a| a.key == agent)
            .cloned();
        if let Some(facts) = facts {
            return Ok(Found { source, facts });
        }
    }
    Err(ApiError::NoSuchAgent(agent.to_owned()))
}

impl Found {
    /// how copy names the agent: its name, else its label's words.
    #[must_use]
    pub fn name(&self) -> String {
        self.facts
            .label
            .name
            .clone()
            .unwrap_or_else(|| identity::words(&self.facts.label))
    }

    #[must_use]
    pub fn key(&self) -> &str {
        &self.facts.key
    }

    #[must_use]
    pub fn connection(&self) -> Arc<str> {
        Arc::from(self.source.connection().name())
    }

    /// whether the runtime dedupes a retried send by its client id (cmx2's
    /// repeat key): a route then waits for its answer however long it takes
    /// and never answers `checking`.
    #[must_use]
    pub fn dedupes(&self) -> bool {
        self.facts.source == Source::Cmx2
    }

    /// 422 `unsupported` unless the agent can do `capability`.
    ///
    /// # Errors
    /// it cannot.
    pub fn needs(&self, capability: Capability) -> Result<(), ApiError> {
        if self.facts.capabilities.has(capability) {
            Ok(())
        } else {
            Err(ApiError::Unsupported(Unsupported::new(
                &identity::words(&self.facts.label),
                capability,
            )))
        }
    }

    /// a source's refusal of a verb on `thread` (an id), as the route answers it.
    #[must_use]
    pub fn refusal(&self, thread: Option<&str>, error: VerbError) -> ApiError {
        match error {
            VerbError::Unsupported(capability) => ApiError::Unsupported(Unsupported::new(
                &identity::words(&self.facts.label),
                capability,
            )),
            VerbError::Missing { what: "agent" } => ApiError::NoSuchAgent(self.facts.key.clone()),
            VerbError::Missing { what: "thread" } => ApiError::NoSuchSession(format!(
                "{}:{}",
                self.facts.key,
                thread.unwrap_or_default()
            )),
            VerbError::Missing { what: "turn" } => ApiError::NoSuchTurn,
            VerbError::Missing { .. } | VerbError::Gone => ApiError::Gone,
            VerbError::Bad(words) => ApiError::BadRequest(words),
            VerbError::Unreachable { reason } => ApiError::AgentUnreachable {
                agent: self.name(),
                reason,
            },
            VerbError::Busy => ApiError::AgentBusy(self.name()),
            VerbError::Refused { status, words } => ApiError::HostSaid {
                host: self.facts.key.clone(),
                status,
                message: words,
            },
            VerbError::GenerationChanged => ApiError::GenerationChanged(self.name()),
            VerbError::NotBuilt(what) => ApiError::NotBuilt(what),
            VerbError::BrowseOnly(words) => ApiError::BrowseOnly(words),
            VerbError::Uncertain { reason } => ApiError::AgentUncertain {
                agent: self.name(),
                reason,
            },
            VerbError::Settled { by, at } => ApiError::Settled { by, at },
            VerbError::AlreadySent => ApiError::AlreadySent,
            VerbError::NotConfirmed => ApiError::NotConfirmed(self.name()),
        }
    }
}

/// the capability check for the contract 2 routes that serve a cmx2-only
/// capability through contract 1's handler (the same shapes as today:
/// terminals, branch review, places, files, shell lines, slash commands,
/// admin). the agent comes from the path, `/api/agents/{agent}/...`; one
/// without the capability answers 422 before the handler runs, and one that
/// has it on a source that is not cmx2 answers 501 `not-built`.
///
/// # Errors
/// no such agent (404), the capability is missing (422), or no cmx2 source
/// serves it (501).
pub async fn guard(
    State((state, capability)): State<(Arc<AppState>, Capability)>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let agent = request.uri().path().split('/').nth(3).unwrap_or_default();
    let found = find(&state, agent)?;
    found.needs(capability)?;
    if !matches!(
        found.source.connection(),
        crate::source::ConnectionConfig::Cmx2(_)
    ) {
        return Err(ApiError::NotBuilt(
            "this verb on an agent that is not a cmx2 daemon",
        ));
    }
    Ok(next.run(request).await)
}
