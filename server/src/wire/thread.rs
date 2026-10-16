//! a thread: one conversation with one agent, keyed `<agent>:<thread>`
//! (`docs/agents.md`, the thread). replaces contract 1's `SessionEntry`
//! with its raw `info` and `status`.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::message::Origin;
use crate::fleet::needs::Need;
use crate::fleet::read::ReadMark;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// `<agent>:<thread>`.
    pub key: String,
    pub agent: String,
    pub id: String,
    pub title: String,
    /// ms on the agent's clock.
    pub created: f64,
    pub updated: f64,
    /// ms of the last turn that wrote text for you or raised an ask; set by
    /// sources whose agent runs on its own, absent on cmx2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub said: Option<f64>,
    /// opaque; changes when the agent swaps the conversation behind the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    /// the parent thread's id (the subagents capability).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// the places capability only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    pub activity: Activity,
    pub queued: u32,
    /// sends boxbox could not confirm, at most 32.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sends: Option<Vec<SendState>>,
    /// what the thread runs with now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// the spend capability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vcs: Option<Vcs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Changes>,
    /// imported history: read, never send. present only when true.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub browse_only: bool,
    /// child threads with a turn running now.
    pub agents: u32,
    /// background jobs a parked thread waits on.
    pub processes: u32,
    /// the window's tail, oldest first, at most 12.
    pub tail: Vec<TailItem>,
    pub needs: Vec<Need>,
    pub read: Option<ReadMark>,
    /// set while the person has this thread cleared off home.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleared: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = ThreadPlace)]
pub struct Place {
    /// the repo or folder the thread belongs to.
    pub root: String,
    /// where it works: a checkout's path for a thread in a worktree.
    pub directory: String,
    /// the repo word windows and push titles use.
    pub name: String,
}

/// what the thread is doing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Activity {
    Idle,
    Busy {
        since: f64,
    },
    Retry {
        attempt: u32,
        message: String,
        next: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<f64>,
    },
    /// idle, but waiting on agents under it still working and background jobs.
    Parked {
        agents: u32,
        jobs: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<f64>,
    },
    /// the last run ended in an error the agent reports on the thread; it
    /// holds until the next run starts. cmx2 never sends it.
    Failed {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<f64>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub used: u64,
    pub limit: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Vcs {
    pub branch: String,
    pub dirty: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub additions: u64,
    pub deletions: u64,
    pub files: u64,
}

/// a send whose outcome boxbox could not confirm. gone 30 minutes after
/// `at`, or when the user message with its client id arrives.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendState {
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub state: SendStateKind,
    pub at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SendStateKind {
    /// the acknowledgement was lost; boxbox is reading the agent's receipts.
    Checking,
    /// no receipt: shown as not confirmed, never sent again by boxbox.
    Uncertain,
    Cancelled,
}

/// one part as a window shows it. contract 2's kinds add `image` and
/// `audio`; contract 1's encoder maps both to `file`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[schema(as = ThreadTailItem)]
pub struct TailItem {
    #[serde(rename = "partID")]
    pub part_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub kind: TailKind,
    #[schema(value_type = String)]
    pub role: crate::fleet::change::TailRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = ThreadTailKind)]
pub enum TailKind {
    Text,
    Reasoning,
    Tool,
    File,
    Image,
    Audio,
}
