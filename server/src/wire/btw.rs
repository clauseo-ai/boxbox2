//! a btw: a side question about a thread, answered by the agent's model
//! from the thread's context with no tools, and never put into that context
//! (`docs/agents.md`, the btw). the agent keeps it, so every device sees
//! the same cards, dismissals included.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::thread::Tokens;

/// the most a btw's question may be, in bytes.
pub const MAX_BTW_TEXT: usize = 32 * 1024;

/// one btw, whole. its times are flattened as a message's are.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AgentBtw)]
pub struct Btw {
    pub id: String,
    /// what was asked, in the person's words.
    pub question: String,
    /// the answer so far; whole once `status` settles.
    pub answer: String,
    pub status: BtwStatus,
    /// why it failed, in the agent's words, when `status` is `error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// the newest message of the thread when it was asked: the card sits
    /// in the turn that holds it.
    #[serde(
        default,
        rename = "afterMessageID",
        skip_serializing_if = "Option::is_none"
    )]
    pub after_message_id: Option<String>,
    /// ms on the agent's clock.
    pub created: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<f64>,
    /// when a person dismissed it; it stays dismissed on every device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed: Option<f64>,
    /// the user message it was added to the thread as.
    #[serde(
        default,
        rename = "promotedMessageID",
        skip_serializing_if = "Option::is_none"
    )]
    pub promoted_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Tokens>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = AgentBtwStatus)]
pub enum BtwStatus {
    Running,
    Done,
    Error,
}

impl BtwStatus {
    /// done or error: its answer no longer grows.
    #[must_use]
    pub fn settled(self) -> bool {
        !matches!(self, Self::Running)
    }
}

/// what `POST .../btw/{btw}/promote` answers: the user message the btw
/// became.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[schema(as = AgentBtwPromoted)]
pub struct BtwPromoted {
    #[serde(rename = "messageID")]
    pub message_id: String,
}
