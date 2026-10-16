//! what `GET /api/stream?protocol=2` carries: contract 2's journal
//! entries and control frames (`docs/agents.md`, the stream). contract 2
//! has its own journal, epoch and seq beside contract 1's.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::agent::Agent;
use super::ask::{Ask, AskSettled};
use super::message::{Message, Reaction};
use super::part::Part;
use super::thread::Thread;
use crate::fleet::change::ResetReason;

/// `hello`'s protocol for contract 2.
pub const PROTOCOL: u32 = 2;

/// one journal entry at its place in contract 2's journal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[schema(as = AgentJournalEntry)]
pub struct JournalEntry {
    pub seq: u64,
    #[serde(flatten)]
    pub change: Change,
}

/// a change, discriminated on `type`. a client advances its cursor past a
/// type it does not know and ignores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type")]
#[schema(as = AgentChange)]
pub enum Change {
    #[serde(rename = "agent")]
    Agent { agent: Agent },
    #[serde(rename = "agent.removed")]
    AgentRemoved { agent: String },
    /// the agent was read afresh: these replace every thread and ask held for it.
    #[serde(rename = "agent.reset")]
    AgentReset {
        agent: String,
        threads: Vec<Thread>,
        asks: Vec<Ask>,
    },
    /// the whole thread, replacing the last.
    #[serde(rename = "thread")]
    Thread { thread: Thread },
    #[serde(rename = "thread.removed")]
    ThreadRemoved { key: String },
    /// boxbox could not prove every row of the thread reached the journal:
    /// drop its cached messages and hydrate again.
    #[serde(rename = "thread.reset")]
    ThreadReset { key: String },
    #[serde(rename = "ask")]
    Ask { ask: Ask },
    #[serde(rename = "ask.settled")]
    AskSettled(AskSettled),
    #[serde(rename = "order")]
    Order { keys: Vec<String> },
    #[serde(rename = "message")]
    Message {
        key: String,
        /// the source's seq for the event; null makes it newer than any read.
        upstream: Option<u64>,
        message: Message,
    },
    #[serde(rename = "part")]
    Part {
        key: String,
        upstream: Option<u64>,
        part: Part,
    },
    #[serde(rename = "delta")]
    Delta {
        key: String,
        #[serde(rename = "messageID")]
        message_id: String,
        #[serde(rename = "partID")]
        part_id: String,
        field: String,
        delta: String,
        /// utf-16 units of the part's text before this delta.
        offset: u64,
    },
    #[serde(rename = "message.removed")]
    MessageRemoved {
        key: String,
        upstream: Option<u64>,
        #[serde(rename = "messageID")]
        message_id: String,
    },
    /// a message's reactions, whole.
    #[serde(rename = "reactions")]
    Reactions {
        key: String,
        #[serde(rename = "messageID")]
        message_id: String,
        reactions: Vec<Reaction>,
    },
}

/// everything contract 2 holds, as `reset` and `GET /api/fleet?protocol=2` carry it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Fleet {
    pub agents: Vec<Agent>,
    pub threads: Vec<Thread>,
    pub asks: Vec<Ask>,
    /// window keys, first first, at most 300; a runs window is `<agent>:runs`.
    pub order: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type")]
#[schema(as = AgentControl)]
pub enum Control {
    #[serde(rename = "hello")]
    Hello {
        epoch: String,
        head: u64,
        build: String,
        protocol: u32,
    },
    #[serde(rename = "reset")]
    Reset {
        seq: u64,
        epoch: String,
        #[schema(value_type = String)]
        reason: ResetReason,
        fleet: Fleet,
    },
}
