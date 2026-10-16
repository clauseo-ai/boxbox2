//! what a client sends an agent, and boxbox's own answers to it
//! (`docs/agents.md`, sections 4 and 7).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::capabilities::Capability;
use super::part::AudioTranscript;

/// a prompt, a steer or a queued prompt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AgentSend)]
pub struct Send {
    /// the client's id for this send, kept end to end; a retry carries the same one.
    #[serde(rename = "clientID")]
    pub client_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// the boxbox id of the message this one quotes (the quotes capability).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// the thread's generation as the client last saw it; a stale one
    /// answers 409 `generation-changed` with nothing sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
}

/// an upload, named by its media id, with the device's transcript of a voice note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub media: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<AudioTranscript>,
}

/// a new thread: its first send, and where it starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    #[serde(flatten)]
    pub send: Send,
    /// an absolute directory on the agent's machine (the places capability).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    /// start in a fresh worktree (the worktree capability).
    #[serde(default)]
    pub worktree: bool,
}

/// a send's answer, 202.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = SendAccepted)]
pub struct Accepted {
    pub state: AcceptedState,
    /// the user message's id, when the agent named it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AcceptedState {
    Accepted,
    /// the agent's acknowledgement was lost; the outcome follows on the thread.
    Checking,
}

/// a new thread's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AgentBorn)]
pub struct Born {
    /// `<agent>:<thread>`.
    pub key: String,
    pub thread: String,
}

/// the body of `POST /api/agents/{agent}/asks/{id}`: one of `option`,
/// `answers` or `reject`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnswerBody {
    pub device: String,
    pub device_class: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    /// a permission's option id: once, always or reject.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option: Option<String>,
    /// a question's answers, one list per question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<Vec<String>>>,
    /// dismiss a question.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reject: bool,
}

/// 422: the agent lacks the capability the verb needs. never retried.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Unsupported {
    /// always `unsupported`.
    pub error: String,
    pub capability: Capability,
    /// "<agent label> has no terminal".
    pub message: String,
}

impl Unsupported {
    #[must_use]
    pub fn new(label: &str, capability: Capability) -> Self {
        Self {
            error: "unsupported".to_owned(),
            capability,
            message: format!("{label} has {}", capability.missing()),
        }
    }
}
