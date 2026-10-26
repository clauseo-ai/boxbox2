//! the tape: every input the fleet actor took, in the order it took them,
//! each with the clock (`crate::now_ms`) it took it at. `record.rs` writes
//! it from a live server built with the `record` feature; `replay.rs` feeds
//! it back through the actor and proves the journal comes out byte for byte
//! the same (docs/plan.md, m9's gate: contract 1 frozen).
//!
//! upstream inputs keep the wire: an event is its frame's `directory` and raw
//! `payload` exactly as cmx2 sent them, a host read its four raw answers with
//! their seqs, a tail read the raw body of `GET /session/:id/message`. so the
//! tape is a recording of what cmx2 said, and the same tape can be fed to
//! whatever takes cmx2's frames in (today `fleet::Upstream`, after the seam
//! the cmx2 source).
//!
//! commands keep what the actor needs of them, without their reply
//! channels. queries (a page of the stream, a snapshot, the needs) are on
//! the tape too: they change nothing, but they set the model's clock, and
//! replaying them gives back the bytes the live server answered with.
//!
//! one line of json per step: `{"at": ms, "input": {...}}`.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::upstream::HostStatus;

/// one input and when the actor took it.
#[derive(Debug, Serialize, Deserialize)]
pub struct Step {
    /// `crate::now_ms()` as the actor read it for this input.
    pub at: i64,
    pub input: Input,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Input {
    /// a host's status, as the cmx2 source read it (`SourceEvent::Connection`).
    Host(Box<HostStatus>),
    /// `Upstream::HostRemoved`
    HostRemoved(String),
    /// a host read (`SourceEvent::Snapshot`), with each read's raw answer.
    HostRead(Box<HostRead>),
    /// a tail read (`SourceEvent::TailRead`): the raw answer and the
    /// `x-cmx2-seq` it came with.
    TailRead {
        key: String,
        cursor: String,
        body: Box<RawValue>,
    },
    /// `SourceEvent::TailUnread`
    TailUnread { key: String, reason: String },
    /// one event frame as cmx2 framed it, which the source translated.
    Event {
        host: String,
        seq: Option<u64>,
        directory: Option<String>,
        payload: Box<RawValue>,
    },
    /// the actor's clock fired for a held window tail.
    FlushTails,
    /// the actor's clock fired for the auto-clear sweep.
    Sweep,
    /// push told the actor who is looking.
    Looking(Vec<Looking>),
    /// a command from a route or a client stream.
    Command(Command),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRead {
    pub host: String,
    pub epoch: String,
    pub sessions: Stamped<Vec<Box<RawValue>>>,
    pub statuses: Stamped<Vec<(String, Box<RawValue>)>>,
    pub permissions: Stamped<Vec<Box<RawValue>>>,
    pub questions: Stamped<Vec<Box<RawValue>>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Stamped<T> {
    pub seq: u64,
    pub data: T,
}

/// `push::presence::Looking`
#[derive(Debug, Serialize, Deserialize)]
pub struct Looking {
    pub device: String,
    pub class: String,
    pub thread: Option<String>,
    pub until: i64,
}

/// `model::Device`
#[derive(Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub class: String,
}

/// where a stream asked to start: `fleet::From`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum From {
    Start,
    Malformed,
    /// a cursor, `<epoch>:<seq>`.
    At(String),
}

/// the actor's commands, without their reply channels.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Command {
    Read {
        from: From,
        first: bool,
        stream: u32,
    },
    Snapshot,
    Needs,
    Arm {
        key: String,
        client_id: String,
        device: Device,
    },
    Answering {
        host: String,
        ask: String,
        device: Device,
    },
    OwnAction {
        key: String,
    },
    MarkRead {
        key: String,
        device: Device,
        message: String,
        at: f64,
    },
    Clear {
        keys: Vec<String>,
        device: Device,
    },
    ClearedAmong {
        rows: Vec<(String, f64)>,
    },
    Unclear {
        keys: Vec<String>,
    },
    AwaySeen,
    /// `prefs::HomePrefs`, as its json.
    Home {
        home: Box<RawValue>,
    },
    Adopt {
        host: String,
        info: Box<RawValue>,
    },
    AdoptedKeys,
    Places {
        host: String,
    },
    Unadopt {
        key: String,
    },
    ReviewTarget {
        key: String,
    },
    ReviewAnswered {
        key: String,
        device: Device,
    },
    ReviewGone {
        key: String,
    },
}
