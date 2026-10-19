//! what `GET /api/stream` carries: the journal's entries (`Change`, each
//! with its `seq`) and the two control frames (`hello`, `reset`). these
//! types are boxbox's api, described with utoipa; the app's reducer is
//! generated from them and must handle every variant.
//!
//! daemon objects (a session's info, its status, a message, a part, an
//! ask) travel as the daemon wrote them (`RawValue`), never re-serialized,
//! so a client's transcript can equal the daemon's byte for byte.

use serde::Serialize;
use serde_json::value::RawValue;
use utoipa::ToSchema;

use super::needs::Need;
use super::read::ReadMark;
use crate::upstream::HostStatus;

/// the stream's protocol version, in `hello`. a client that does not speak
/// it asks the person to reload (`design.md`, honesty).
pub const PROTOCOL: u32 = 1;

/// one journal entry: a change to the fleet model, at its place in the
/// journal.
#[derive(Debug, Serialize, ToSchema)]
pub struct JournalEntry<'a> {
    /// contiguous within an epoch; the entry's sse id is `<epoch>:<seq>`.
    pub seq: u64,
    #[serde(flatten)]
    pub change: &'a Change,
}

/// a change to the fleet model, discriminated on `type`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "type")]
pub enum Change {
    /// a host's connection or health changed.
    #[serde(rename = "host")]
    Host { host: HostStatus },
    /// a host left `boxbox.toml`; everything the fleet held for it goes.
    #[serde(rename = "host.removed")]
    HostRemoved { host: String },
    /// the host was read afresh (a cold connect, or the daemon's
    /// `stream.reset`): these replace every session and ask the fleet held
    /// for it. a client re-reads any open transcript on this host.
    #[serde(rename = "host.reset")]
    HostReset {
        host: String,
        sessions: Vec<SessionEntry>,
        asks: Vec<Ask>,
    },
    /// a session appeared or changed: the whole entry, replacing the last.
    #[serde(rename = "session")]
    Session { session: SessionEntry },
    #[serde(rename = "session.removed")]
    SessionRemoved { key: String },
    /// a permission or question now waits on a person.
    #[serde(rename = "ask")]
    Ask { ask: Ask },
    /// an ask was answered, rejected, or dropped with its turn.
    #[serde(rename = "ask.settled")]
    AskSettled { host: String, id: String },
    /// the window order changed: every key, first first.
    #[serde(rename = "order")]
    Order { keys: Vec<String> },
    /// a message was created or changed (cmx2 `message.updated`).
    #[serde(rename = "message")]
    Message {
        key: String,
        /// the daemon's seq for this event; apply it only past the seq of
        /// the transcript read it lands on. null when the daemon did not
        /// log it, which makes it newer than any read.
        upstream: Option<u64>,
        /// cmx2's `MessageInfo`, as the daemon wrote it.
        #[schema(value_type = Object)]
        info: Box<RawValue>,
    },
    /// a part was created or replaced whole (cmx2 `message.part.updated`).
    #[serde(rename = "part")]
    Part {
        key: String,
        /// null on the daemon's resume re-send of a part still streaming,
        /// which carries its full text so far and no seq.
        upstream: Option<u64>,
        /// cmx2's `Part`, as the daemon wrote it.
        #[schema(value_type = Object)]
        part: Box<RawValue>,
    },
    /// streamed text for a part (cmx2 `message.part.delta`, never logged
    /// by the daemon, so it has no seq).
    #[serde(rename = "delta")]
    Delta {
        key: String,
        #[serde(rename = "messageID")]
        message_id: String,
        #[serde(rename = "partID")]
        part_id: String,
        field: String,
        delta: String,
        /// utf-16 units of the part's text before this delta: a client
        /// appends only when it equals what it holds, skips what it
        /// already has, and re-reads the part on a gap.
        offset: u64,
    },
    #[serde(rename = "message.removed")]
    MessageRemoved {
        key: String,
        upstream: Option<u64>,
        #[serde(rename = "messageID")]
        message_id: String,
    },
}

/// the colour of one repo: a host plus its root, which the repo's
/// worktrees share. the colour shown is `chosen`, else `auto`; a name the
/// client does not know shows the repo's hash colour.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct RepoColour {
    pub host: String,
    /// the project's root on that host, as cmx2 names it: its `projectID`
    /// when that is a path, else the session's directory.
    pub root: String,
    /// the repo colour boxbox gave the repo when it first saw it; it keeps it.
    pub auto: String,
    /// the repo colour a person chose; null for automatic, which shows `auto`.
    pub chosen: Option<String>,
}

/// one session in the fleet, identity `host:session` (repos never merge
/// across hosts).
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct SessionEntry {
    /// `<host>:<sessionID>`.
    pub key: String,
    pub host: String,
    pub id: String,
    /// cmx2's `SessionInfo`, as the daemon wrote it.
    #[schema(value_type = Object)]
    pub info: Box<RawValue>,
    /// cmx2's `SessionStatus`; null when idle and not parked.
    #[schema(value_type = Option<Object>)]
    pub status: Option<Box<RawValue>>,
    /// child sessions with a turn running now.
    pub agents: u32,
    /// background jobs a parked session waits on.
    pub processes: u32,
    /// the window's tail: the last parts, oldest first, at most 12.
    pub tail: Vec<TailItem>,
    /// what waits on a person here, most pressing first (`needs.rs`).
    pub needs: Vec<Need>,
    /// how far the person has seen, on the daemon's clock; null before
    /// any device has looked (`read.rs`).
    pub read: Option<ReadMark>,
    /// set while the person has this thread cleared off home: the session's
    /// `time.updated` when they cleared it. absent otherwise, and the moment
    /// the thread does something new (`clears.rs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleared: Option<f64>,
}

/// one part as a window shows it, reduced to what the window needs. parts
/// a window does not show (step markers, snapshots, the context the daemon
/// adds to a prompt, a prompt still queued) never enter a tail. streamed
/// text grows the part as it arrives (`message.part.delta`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ToSchema)]
pub struct TailItem {
    #[serde(rename = "partID")]
    pub part_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub kind: TailKind,
    /// who wrote the part's message: your prompt sits on the right.
    pub role: TailRole,
    /// the tool's name, on tool parts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// the tool's state (`pending`, `running`, `completed`, `error`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// at most 280 characters: the end of the agent's text, the start of
    /// your prompt, or the tool's title.
    pub text: String,
    /// the whole text's length in utf-16 units, where the next streamed
    /// delta lands (cmx2's `offset`). the server's own bookkeeping.
    #[serde(skip)]
    pub streamed: u64,
    /// the agent that sent the part, when it is another agent's report or
    /// note (cmx2's mail envelope): the window says who, not "you".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

impl TailItem {
    /// whether a window renders anything for this item: thinking never,
    /// text once it has words, a tool or a file always. an item that does
    /// not show can change without an entry (the next one carries it).
    #[must_use]
    pub fn shows(&self) -> bool {
        match self.kind {
            TailKind::Reasoning => false,
            TailKind::Text => !self.text.trim().is_empty(),
            TailKind::Tool | TailKind::File => true,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum TailKind {
    Text,
    Reasoning,
    Tool,
    File,
}

/// cmx2's message roles, as the daemon names them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum TailRole {
    User,
    Assistant,
}

/// a permission or a question waiting on a person.
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct Ask {
    /// the session's key, `<host>:<sessionID>`.
    pub key: String,
    pub host: String,
    pub id: String,
    pub kind: AskKind,
    /// cmx2's `PermissionRequest` or `QuestionRequest`, as the daemon wrote it.
    #[schema(value_type = Object)]
    pub request: Box<RawValue>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AskKind {
    Permission,
    Question,
}

/// the whole fleet model, as `reset` and `GET /api/fleet` carry it.
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct FleetSnapshot {
    pub hosts: Vec<HostStatus>,
    pub sessions: Vec<SessionEntry>,
    pub asks: Vec<Ask>,
    /// the window order: session keys, first first.
    pub order: Vec<String>,
}

/// repo colours on `GET /api/stream?colours=1` (`colours.rs`): id-less data
/// lines outside the journal, so contract 1 gains no change type and a
/// stream that does not ask sees none of them. the whole map comes first,
/// after `hello` (and again before a replay page if it moved meanwhile);
/// then each change, ahead of the journal entry that first shows its repo.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "type")]
pub enum ColourFrame {
    /// every repo's colour, by host, then root: replaces what the client holds.
    #[serde(rename = "colours")]
    Colours { colours: Vec<RepoColour> },
    /// one repo was given a colour, or a person chose one.
    #[serde(rename = "colour")]
    Colour { colour: RepoColour },
}

/// the stream's frames that are not journal entries.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "type")]
pub enum Control {
    /// the first frame of every connection; it carries no id.
    #[serde(rename = "hello")]
    Hello {
        /// the journal this server holds; a restart mints a new one.
        epoch: String,
        /// the journal's newest seq.
        head: u64,
        /// the server's build; a newer one lights "update ready".
        build: String,
        protocol: u32,
    },
    /// the client's cursor cannot be replayed: this snapshot replaces
    /// everything it holds, and live entries follow from `seq`.
    #[serde(rename = "reset")]
    Reset {
        seq: u64,
        epoch: String,
        reason: ResetReason,
        fleet: FleetSnapshot,
    },
}

/// why a stream began with `reset`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ResetReason {
    /// no cursor was given: a first connection.
    None,
    /// the cursor is from another journal (the server restarted).
    Epoch,
    /// the entries after the cursor have left the ring.
    Expired,
    /// the cursor is malformed or past the head.
    Invalid,
}

impl ResetReason {
    /// the reason as the wire spells it, for the log.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Epoch => "epoch",
            Self::Expired => "expired",
            Self::Invalid => "invalid",
        }
    }
}

/// one frame's data on `GET /api/stream`: a control frame or a journal
/// entry, discriminated on `type` across both.
#[derive(Debug, Serialize, ToSchema)]
#[serde(untagged)]
#[allow(
    dead_code,
    reason = "describes the stream in the api document; frames are written by their own types"
)]
pub enum StreamFrame<'a> {
    Control(Control),
    Entry(JournalEntry<'a>),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_puts_its_seq_first_and_passes_daemon_json_through_untouched() {
        // key order and spacing inside a daemon object are the daemon's
        let part =
            RawValue::from_string(r#"{"text":"hi","id":"prt_1", "type":"text"}"#.into()).unwrap();
        let change = Change::Part {
            key: "desk:ses_1".into(),
            upstream: None,
            part,
        };
        let json = serde_json::to_string(&JournalEntry {
            seq: 7,
            change: &change,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"seq":7,"type":"part","key":"desk:ses_1","upstream":null,"part":{"text":"hi","id":"prt_1", "type":"text"}}"#
        );
    }

    #[test]
    fn a_delta_names_its_fields_as_cmx2_does() {
        let change = Change::Delta {
            key: "desk:ses_1".into(),
            message_id: "msg_1".into(),
            part_id: "prt_1".into(),
            field: "text".into(),
            delta: "lo".into(),
            offset: 2,
        };
        let json = serde_json::to_string(&JournalEntry {
            seq: 1,
            change: &change,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"seq":1,"type":"delta","key":"desk:ses_1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"lo","offset":2}"#
        );
    }

    #[test]
    fn control_frames_are_tagged_like_entries() {
        let hello = Control::Hello {
            epoch: "e".into(),
            head: 3,
            build: "0.1.0".into(),
            protocol: PROTOCOL,
        };
        assert_eq!(
            serde_json::to_string(&hello).unwrap(),
            r#"{"type":"hello","epoch":"e","head":3,"build":"0.1.0","protocol":1}"#
        );
    }
}
