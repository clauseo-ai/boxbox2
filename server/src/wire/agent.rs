//! an agent: someone you talk to (`docs/agents.md`, the agent). a cmx2
//! daemon is one; an openclaw gateway has one per configured agent.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::capabilities::Capabilities;
use crate::config::Origin;
use crate::upstream::{FrameCounts, Memory};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// the agent's name on the wire, `[a-z0-9-]{1,32}`, and the first half
    /// of every thread key. a cmx2 agent's key is its connection's name.
    pub key: String,
    pub label: Label,
    pub kind: Kind,
    pub source: Source,
    pub mark: Mark,
    /// a named assistant slot; null: its threads take the repo palettes.
    pub palette: Option<String>,
    pub status: AgentStatus,
    /// shared by every agent of one connection.
    pub connection: AgentConnection,
    pub capabilities: Capabilities,
    /// the runs window: null when no talking scheduled run is unseen.
    pub runs: Option<Runs>,
}

/// shown joined with " · ": "cmx · vm-a", "assistant · openclaw · vm-b".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    /// the config's name for the agent, else the agent's own display name;
    /// absent on every cmx2 agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub source: LabelSource,
    /// the config's `machine`, else the connection's name.
    pub machine: String,
}

/// the runtime's word people read (`cmx` for cmx2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum LabelSource {
    Cmx,
    Openclaw,
    Hermes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = AgentKind)]
pub enum Kind {
    Coding,
    Assistant,
    Other,
}

/// the runtime's id: a kind of agent runtime boxbox speaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = AgentSource)]
pub enum Source {
    Cmx2,
    Openclaw,
    Hermes,
}

impl Source {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cmx2 => "cmx2",
            Self::Openclaw => "openclaw",
            Self::Hermes => "hermes",
        }
    }
}

/// square for a coding agent, round for an assistant and for other.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Mark {
    Square,
    Round,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    /// dialling, or backing off before the next dial.
    Connecting,
    /// the gateway waits for this device to be approved on its machine.
    Pairing,
    /// connected; not every thread with a window has had its first read.
    Syncing,
    Ready,
    /// the last attempt failed; it is tried again.
    Down,
    /// boxbox will not talk to it; `connection.refused` says why.
    Refused,
}

/// why boxbox will not talk to an agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Refusal {
    /// a wire protocol boxbox was not built for.
    Protocol,
    /// a sync method the runtime does not offer.
    Methods,
    /// the runtime refused boxbox's credential; not retried until the config changes.
    Auth,
    /// its agent key collides with a connection name.
    Key,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnection {
    pub name: String,
    pub url: String,
    #[schema(value_type = String)]
    pub origin: Origin,
    /// when the status last changed, ms; while ready, when it came up.
    pub since: i64,
    /// plain words; for pairing, the command to run on the machine.
    pub last_error: Option<String>,
    pub connects: u64,
    /// the runtime's own version.
    pub version: Option<String>,
    /// the runtime version boxbox is built against (openclaw's pin).
    pub pinned: Option<String>,
    /// `version` differs from `pinned`: boxbox syncs and sends anyway.
    pub untested: bool,
    /// the runtime's wire protocol; on a protocol refusal, the one it speaks.
    pub protocol: Option<u32>,
    /// why, while the status is refused.
    pub refused: Option<Refusal>,
    /// cmx2 only: the daemon's contract, and whether it matches the pin.
    pub contract: Option<i64>,
    pub contract_matches: Option<bool>,
    pub frames: FrameCounts,
    /// cmx2 only (the admin capability).
    pub memory: Option<Memory>,
    pub cursor: Option<String>,
}

/// the runs window's content: talking scheduled runs not yet seen.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Runs {
    pub unseen: u32,
    /// at most 12, newest last.
    pub items: Vec<RunItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunItem {
    /// the run's thread id.
    pub thread: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub at: f64,
    pub preview: String,
}
