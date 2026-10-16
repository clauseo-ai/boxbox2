//! contract 2's answers to the verbs that read or change one thing on an
//! agent (`docs/agents.md`, section 4, the routes): the model catalog and an
//! archive. sends answer `Accepted` and `Born` (`send.rs`).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// what `GET /api/agents/{agent}/models` answers (the model capability).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AgentModels)]
pub struct Models {
    pub models: Vec<ModelEntry>,
    /// the model a thread runs with when none is picked, when the agent says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AgentModel)]
pub struct ModelEntry {
    /// what a send's `model` names.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// the reasoning levels this model takes, when they differ from the
    /// agent's `capabilities.reasoning.levels`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub levels: Option<Vec<String>>,
}

/// what `POST .../archive` answers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AgentArchived)]
pub struct Archived {
    /// `<agent>:<thread>`.
    pub key: String,
    /// when the agent archived it, ms on its clock; null when it did not say.
    pub at: Option<f64>,
}
