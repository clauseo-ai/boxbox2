//! what `GET /api/stream` carries in protocol 3 (`docs/protocol.md`): the
//! journal's entries, each with its `seq`, and the control frames that are
//! not entries. the shapes inside are contract 2's neutral types.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use utoipa::ToSchema;

use super::agent::Agent;
use super::ask::{Ask, AskSettled};
use super::message::{Message, Reaction};
use super::part::Part;
use super::thread::{Activity, Changes, Context, Place, SendState, TailItem, Thread, Tokens, Vcs};
use crate::fleet::needs::Need;
use crate::fleet::read::ReadMark;

/// `hello`'s protocol. a client that does not speak it stops (the web app
/// asks to reload).
pub const PROTOCOL: u32 = 3;

/// the version of the neutral encoding: moves whenever a build would encode
/// the same state as different bytes (`docs/protocol.md`, section 10). it
/// leads every thread read's etag.
pub const ENCODER: u32 = 1;

/// one journal entry at its place in the journal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[schema(as = AgentJournalEntry)]
pub struct JournalEntry {
    /// contiguous in the journal within an epoch; a stream may skip seqs
    /// (entries of threads outside its interest), and a skipped seq is never
    /// a gap.
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
    /// an agent appeared or changed: the whole agent, replacing the last.
    #[serde(rename = "agent")]
    Agent { agent: Agent },
    #[serde(rename = "agent.removed")]
    AgentRemoved { agent: String },
    /// the whole thread, replacing the last: on first sight, after
    /// `thread.removed`, and as the first frame for a key after a crash start.
    #[serde(rename = "thread")]
    Thread { thread: Thread },
    /// only what changed, against the last state of the key in the journal.
    #[serde(rename = "thread.patch")]
    ThreadPatch(ThreadPatch),
    #[serde(rename = "thread.removed")]
    ThreadRemoved { key: String },
    /// boxbox cannot prove its journal holds every row of the thread: drop
    /// its messages and read it again if it is shown.
    #[serde(rename = "thread.reset")]
    ThreadReset { key: String },
    #[serde(rename = "ask")]
    Ask { ask: Ask },
    #[serde(rename = "ask.settled")]
    AskSettled(AskSettled),
    /// the window order, whole: every key, first first, at most 300.
    #[serde(rename = "order")]
    Order { keys: Vec<String> },
    /// the window order as edits of the last one, applied in order.
    #[serde(rename = "order.patch")]
    OrderPatch { ops: Vec<OrderOp> },
    #[serde(rename = "message")]
    Message {
        key: String,
        /// the source's seq for the event; null makes it newer than any read.
        upstream: Option<u64>,
        message: Message,
    },
    /// a part, created or replaced whole. a settled text or reasoning part
    /// may omit `text` and carry `textOf` instead.
    #[serde(rename = "part")]
    Part {
        key: String,
        upstream: Option<u64>,
        part: Part,
    },
    /// streamed text for a part, merged into batches of up to 100 ms.
    #[serde(rename = "delta")]
    Delta {
        key: String,
        #[serde(rename = "messageID")]
        message_id: String,
        #[serde(rename = "partID")]
        part_id: String,
        /// `text`, for text and reasoning parts alike.
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

impl Change {
    /// the thread key of a transcript entry (`message`, `part`, `delta`,
    /// `message.removed`, `reactions`); none for an overview entry.
    #[must_use]
    pub fn transcript_key(&self) -> Option<&str> {
        match self {
            Self::Message { key, .. }
            | Self::Part { key, .. }
            | Self::Delta { key, .. }
            | Self::MessageRemoved { key, .. }
            | Self::Reactions { key, .. } => Some(key),
            _ => None,
        }
    }

    /// the entry's `type`, as the wire spells it.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Agent { .. } => "agent",
            Self::AgentRemoved { .. } => "agent.removed",
            Self::Thread { .. } => "thread",
            Self::ThreadPatch(_) => "thread.patch",
            Self::ThreadRemoved { .. } => "thread.removed",
            Self::ThreadReset { .. } => "thread.reset",
            Self::Ask { .. } => "ask",
            Self::AskSettled(_) => "ask.settled",
            Self::Order { .. } => "order",
            Self::OrderPatch { .. } => "order.patch",
            Self::Message { .. } => "message",
            Self::Part { .. } => "part",
            Self::Delta { .. } => "delta",
            Self::MessageRemoved { .. } => "message.removed",
            Self::Reactions { .. } => "reactions",
        }
    }
}

/// a thread's change as only what changed (`docs/protocol.md`, section 6).
/// a client that holds no thread for `key` has a protocol error.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ThreadPatch {
    pub key: String,
    /// each top-level field whose value changed, with its new value whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<ThreadSet>,
    /// fields that became absent (or null, for `read`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unset: Vec<ThreadField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<TailPatch>,
}

/// the fields of a thread that changed, each whole. `key`, `agent` and `id`
/// never change; `tail` changes through `tail`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub said: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<super::thread::ForkedFrom>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<super::message::Origin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sends: Option<Vec<SendState>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Tokens>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vcs: Option<Vcs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Changes>,
    /// only ever `true` here; it becoming false is in `unset`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browse_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs: Option<Vec<Need>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<ReadMark>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleared: Option<f64>,
}

/// a field of a thread that can become absent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadField {
    Said,
    Generation,
    Parent,
    ForkedFrom,
    Place,
    Origin,
    Sends,
    Model,
    Effort,
    Context,
    Cost,
    Tokens,
    Vcs,
    Changes,
    BrowseOnly,
    /// `read` became null.
    Read,
    Cleared,
}

/// a tail's change: drop `drop` items from the front, then put each item at
/// its index (replacing; the index equal to the length appends). the result
/// is at most 12 items and equals the server's tail exactly.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct TailPatch {
    pub drop: u32,
    pub put: Vec<(u32, TailItem)>,
}

/// one edit of the window order. `["-", i, n]` removes `n` keys at index
/// `i`; `["+", i, [keys]]` inserts the keys at index `i`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderOp {
    Remove { at: u32, count: u32 },
    Insert { at: u32, keys: Vec<String> },
}

impl Serialize for OrderOp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Remove { at, count } => ("-", at, count).serialize(serializer),
            Self::Insert { at, keys } => ("+", at, keys).serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for OrderOp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let (sign, at, rest): (String, u32, serde_json::Value) =
            Deserialize::deserialize(deserializer)?;
        match sign.as_str() {
            "-" => Ok(Self::Remove {
                at,
                count: serde_json::from_value(rest).map_err(D::Error::custom)?,
            }),
            "+" => Ok(Self::Insert {
                at,
                keys: serde_json::from_value(rest).map_err(D::Error::custom)?,
            }),
            other => Err(D::Error::custom(format!(
                "an order op is - or +, not {other}"
            ))),
        }
    }
}

impl utoipa::PartialSchema for OrderOp {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        use utoipa::openapi::schema::{
            ArrayBuilder, ObjectBuilder, OneOfBuilder, Schema, SchemaType, Type,
        };
        let sign = |s: &str| {
            Schema::Object(
                ObjectBuilder::new()
                    .schema_type(SchemaType::Type(Type::String))
                    .enum_values(Some([s.to_owned()]))
                    .build(),
            )
        };
        let index = || {
            Schema::Object(
                ObjectBuilder::new()
                    .schema_type(SchemaType::Type(Type::Integer))
                    .minimum(Some(0))
                    .build(),
            )
        };
        let keys = Schema::Array(
            ArrayBuilder::new()
                .items(
                    ObjectBuilder::new()
                        .schema_type(SchemaType::Type(Type::String))
                        .build(),
                )
                .build(),
        );
        let op = |items: Vec<Schema>| {
            Schema::Array(
                ArrayBuilder::new()
                    .prefix_items(items)
                    .items(utoipa::openapi::schema::ArrayItems::False)
                    .min_items(Some(3))
                    .max_items(Some(3))
                    .build(),
            )
        };
        utoipa::openapi::RefOr::T(Schema::OneOf(
            OneOfBuilder::new()
                .item(op(vec![sign("-"), index(), index()]))
                .item(op(vec![sign("+"), index(), keys]))
                .description(Some(
                    "[\"-\", i, n] removes n keys at index i; [\"+\", i, keys] inserts keys at index i",
                ))
                .build(),
        ))
    }
}

impl ToSchema for OrderOp {}

/// a settled text's length and hash (`docs/protocol.md`, section 8): the
/// client keeps the text it holds when both match, and re-reads the
/// message when they do not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct TextOf {
    /// utf-16 units.
    pub length: u64,
    /// fnv-1a 32 over the utf-16 code units, 8 lowercase hex.
    pub hash: String,
}

/// everything a reset carries, and `GET /api/fleet`'s body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Fleet {
    pub agents: Vec<Agent>,
    pub threads: Vec<Thread>,
    pub asks: Vec<Ask>,
    /// window keys, first first, at most 300; a runs window is `<agent>:runs`.
    pub order: Vec<String>,
}

/// what a stream shows: the open thread, the layers under it and the
/// children held for them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Interest {
    /// the open thread; null for the overview only.
    pub thread: Option<String>,
    /// at most 8.
    #[serde(default)]
    pub under: Vec<String>,
    /// at most 16.
    #[serde(default)]
    pub holds: Vec<String>,
}

/// `POST /api/stream/{stream}/interest`'s body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InterestPost {
    /// increases per stream; an older one than the last applied is answered
    /// with no confirm.
    pub ask: u64,
    pub thread: Option<String>,
    #[serde(default)]
    pub under: Vec<String>,
    #[serde(default)]
    pub holds: Vec<String>,
    /// per key the client already holds, the seq after which it lacks that
    /// thread's transcript entries (its `left`). a key without one is read.
    #[serde(default)]
    pub since: BTreeMap<String, u64>,
}

/// why a stream began with `reset`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = StreamResetReason)]
pub enum ResetReason {
    /// no cursor was given: a first connection.
    None,
    /// the cursor is from another epoch.
    Epoch,
    /// the cursor is older than what the server can catch up from.
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

/// the stream's frames that are not journal entries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type")]
#[schema(as = AgentControl)]
pub enum Control {
    /// the first frame of every stream; it carries no id.
    #[serde(rename = "hello")]
    Hello {
        protocol: u32,
        /// outlives server restarts; changes only when the persisted state is lost.
        epoch: String,
        /// the journal's newest seq.
        head: u64,
        /// the server's build; a newer one lights "update ready".
        build: String,
        /// this stream's id, 128-bit hex, for interest posts.
        stream: String,
        /// the interest the stream opened with.
        interest: Interest,
    },
    /// the cursor cannot be caught up: this replaces everything the client
    /// holds, and live entries follow from `seq`. id `epoch:seq`.
    #[serde(rename = "reset")]
    Reset {
        seq: u64,
        epoch: String,
        reason: ResetReason,
        fleet: Fleet,
    },
    /// the end of a catch-up; the stream is live after it. id `epoch:seq`.
    #[serde(rename = "caught")]
    Caught { seq: u64 },
    /// transcript entries, each with its own seq, applied by the transcript
    /// rules alone; they never move the cursor. id-less.
    #[serde(rename = "catchup")]
    Catchup { entries: Vec<JournalEntry> },
    /// the confirm of an interest post, at journal head `seq`. id `epoch:seq`.
    #[serde(rename = "interest")]
    Interest {
        ask: u64,
        thread: Option<String>,
        under: Vec<String>,
        holds: Vec<String>,
        seq: u64,
        /// keys whose missed entries this stream cannot give: read them.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        stale: Vec<String>,
        /// keys reset since their `since`: drop their messages and read them.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        reset: Vec<String>,
    },
    /// in a reconnect catch-up: a thread in interest whose missed entries
    /// the server no longer holds. id-less.
    #[serde(rename = "thread.stale")]
    ThreadStale { key: String },
}

/// the colour of one repo: a host plus its root, which the repo's
/// worktrees share. the colour shown is `chosen`, else `auto`; a name the
/// client does not know shows the repo's hash colour.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
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

/// repo colours: id-less frames outside the journal. the whole map comes
/// first, after `hello`; then each change, ahead of the journal entry that
/// first shows its repo.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type")]
pub enum ColourFrame {
    /// every repo's colour, by host, then root: replaces what the client holds.
    #[serde(rename = "colours")]
    Colours { colours: Vec<RepoColour> },
    /// one repo was given a colour, or a person chose one.
    #[serde(rename = "colour")]
    Colour { colour: RepoColour },
}

/// one frame's data on `GET /api/stream`, discriminated on `type` across
/// every kind. the board's own frames (`view`, `pin`, `replaced`) reach
/// only a stream that declared the board view.
#[derive(Debug, Serialize, ToSchema)]
#[serde(untagged)]
#[schema(as = AgentStreamFrame)]
#[allow(
    dead_code,
    clippy::large_enum_variant,
    reason = "describes the stream in the api document; frames are written by their own types"
)]
pub enum StreamFrame {
    Control(Control),
    Colour(ColourFrame),
    Board(boxbox_board_wire::AppFrame),
    Entry(JournalEntry),
}
