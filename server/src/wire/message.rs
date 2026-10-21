//! a message: one turn's row in a thread (`docs/agents.md`, the message).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AgentMessage)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "each flag is its own field on the wire, as the runtime sends it"
)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub created: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<f64>,
    /// its place in the thread's transcript, from the agent; clients place
    /// by it when present, by arrival otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<u64>,
    /// on a user message boxbox sent: the send's client id.
    #[serde(default, rename = "clientID", skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// the queue capability: a prompt still waiting behind the running turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub queued: bool,
    /// the steer capability: a prompt that joined the running turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub steer: bool,
    /// an assistant compaction summary: not a turn's answer.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub summary: bool,
    /// a runtime or boxbox note rather than a prompt.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub notice: bool,
    /// why the turn ended ("aborted", ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MessageError>,
    /// what this message ran with or asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// a user message from someone who is not you (a group chat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<Quote>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reactions: Option<Vec<Reaction>>,
    /// the message came from another agent (a report, a note) or started
    /// this one (its brief): the source's mail envelope, as parts carry it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail: Option<super::part::Mail>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageError {
    /// the runtime's words, absent when it gave none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// the runtime's error name (`MessageAbortedError` for a stopped turn).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// where a turn came from or went to: absent means boxbox or the agent's
/// own runtime.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[schema(as = MessageOrigin)]
pub enum Origin {
    /// `whatsapp`, `telegram`, `control-ui`.
    Channel { name: String },
    /// a timer or cron run; a heartbeat's name is `heartbeat`.
    Scheduled {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    /// the boxbox id of the quoted message; null when the source cannot resolve it.
    pub message: Option<String>,
    /// "you", the agent's name, or a person's label.
    pub sender: String,
    /// one line, at most 140 characters, cut at a word; null when the source kept none.
    pub preview: Option<String>,
    pub glyph: Glyph,
    /// the quoted voice note's length, when the glyph is audio and the source knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// the kind of the quoted message's first part that is not text, else text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Glyph {
    Text,
    Audio,
    Image,
    File,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub emoji: String,
    /// `you` (the person), `agent` (this thread's agent), or a person's label.
    pub by: String,
}
