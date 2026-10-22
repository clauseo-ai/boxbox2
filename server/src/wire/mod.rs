//! contract 2: boxbox's own documented shapes for everything that crosses
//! to a client (`docs/agents.md`, the neutral wire). no source object
//! crosses raw; the one exception is a tool call's `input` and `metadata`,
//! which stay the source's json because the rich rows that read them are
//! keyed by tool name and have nothing neutral to read instead.
//!
//! protocol 3 (`docs/protocol.md`) carries them to devices. every type here
//! is described with utoipa, so the web app's types and the ios app's drift
//! test both come from the one openapi document. where a name collides with
//! another schema of the document the type is renamed in the document only
//! (`#[schema(as = ...)]`).

// the seam's types land before the sources and routes that use them (m9: the
// cmx2 source, the openclaw source, the contract 2 routes).
#![allow(dead_code, unused_imports)]

pub mod agent;
pub mod ask;
pub mod btw;
pub mod capabilities;
pub mod message;
pub mod part;
pub mod patch;
pub mod send;
pub mod stream;
pub mod thread;
pub mod verbs;

pub use agent::{
    Agent, AgentConnection, AgentStatus, Kind, Label, LabelSource, Mark, Refusal, RunItem, Runs,
    Source,
};
pub use ask::{
    Ask, AskKind, AskSettled, Outcome, Permission, PermissionOption, PermissionReply, Question,
    QuestionOption, Risk, SettledBy, SettlerKind, ToolRef,
};
pub use btw::{Btw, BtwPromoted, BtwStatus, MAX_BTW_TEXT};
pub use capabilities::{Attachments, Capabilities, Capability, Reasoning, ReasoningWord, Voice};
pub use message::{Glyph, Message, MessageError, Origin, Quote, Reaction, Role};
pub use part::{
    AudioPart, AudioTranscript, CompactionPart, Family, FilePart, Flavour, ImagePart, Mail,
    MarkerKind, MarkerPart, MediaRef, MediaState, Part, PartAt, PartTime, ReasoningPart, TextPart,
    ToolPart, ToolState, ToolStatus, ToolTime, UnknownPart,
};
pub use send::{Accepted, AcceptedState, AnswerBody, Attachment, Born, Send, Start, Unsupported};
pub use stream::{
    Change, ColourFrame, Control, ENCODER, Fleet, Interest, InterestPost, JournalEntry, OrderOp,
    PROTOCOL, RepoColour, ResetReason, StreamFrame, TailPatch, TextOf, ThreadField, ThreadPatch,
    ThreadSet,
};
pub use thread::{
    Activity, Changes, Context, Place, SendState, SendStateKind, TailItem, TailKind, TailRole,
    Thread, Tokens, Vcs,
};
pub use verbs::{ModelEntry, Models};

#[cfg(test)]
mod tests;
