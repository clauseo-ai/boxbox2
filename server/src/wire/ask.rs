//! asks: a permission or a question waiting on a person, and how one ended
//! (`docs/agents.md`, asks).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AgentAsk)]
pub struct Ask {
    /// the thread's key, `<agent>:<thread>`.
    pub key: String,
    pub agent: String,
    pub id: String,
    /// the thread's key, as on every ask.
    pub thread: String,
    pub kind: AskKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<f64>,
    /// drives the "answer by" line; a client blocks an answer in its last 5 seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    /// the tool call that raised it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<Permission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<Question>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = AgentAskKind)]
pub enum AskKind {
    Permission,
    Question,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolRef {
    #[serde(rename = "messageID")]
    pub message_id: String,
    #[serde(rename = "callID")]
    pub call_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    /// what the agent wants: a tool or permission name (`bash`, `edit`).
    pub title: String,
    pub patterns: Vec<String>,
    /// the patterns an "always" answer would grant.
    pub always: Vec<String>,
    /// drawn as the server labels them.
    pub options: Vec<PermissionOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<Risk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// the recipients, payment, visibility or grant it reaches, plain lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub id: PermissionReply,
    pub label: String,
    /// an answer that leaves a standing grant.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lasting: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = AgentPermissionReply)]
pub enum PermissionReply {
    Once,
    Always,
    Reject,
}

impl PermissionReply {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Normal,
    High,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_field_names, reason = "the wire names the field")]
pub struct Question {
    pub question: String,
    pub header: String,
    pub multiple: bool,
    /// a free text answer is allowed.
    pub custom: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// how an ask ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskSettled {
    pub agent: String,
    pub id: String,
    pub outcome: Outcome,
    /// the option id or answer that won, when answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option: Option<String>,
    /// plain words, for cancelled and unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<SettledBy>,
    /// ms, when boxbox saw it.
    pub at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Answered,
    /// the agent's deadline passed.
    Expired,
    /// the run ended or the runtime restarted.
    Cancelled,
    /// boxbox lost track of it and the agent no longer knows it.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = AskSettledBy)]
pub struct SettledBy {
    pub kind: SettlerKind,
    /// "whatsapp", a device's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// the boxbox device id, when the answer went through boxbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SettlerKind {
    /// an operator surface: a boxbox device, or another operator client.
    Device,
    /// a channel reply.
    Channel,
    /// the agent's own policy.
    Runtime,
    /// expiry, no route, a restart or an abort.
    System,
}
