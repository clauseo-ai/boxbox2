//! the part union (`docs/agents.md`, the part union): discriminated on
//! `type`, as cmx2's is, so the cmx2 mapping is near identity. every part
//! carries `id`, `messageID` and `at`.
//!
//! a kind this build does not know is kept as `unknown`, carrying the raw
//! object, and so is a known kind whose fields do not fit: a decoder never
//! fails on a part, and a client draws a plain fallback row for it.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;
use utoipa::ToSchema;

/// a part's place in its message: `step` counts the turn's steps, `index`
/// the part's place in its step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PartAt {
    pub step: u32,
    pub index: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PartTime {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<f64>,
}

/// discriminated on `type`.
#[derive(Clone, Debug, ToSchema)]
#[serde(tag = "type")]
#[schema(as = AgentPart)]
pub enum Part {
    #[serde(rename = "text")]
    Text(TextPart),
    #[serde(rename = "reasoning")]
    Reasoning(ReasoningPart),
    #[serde(rename = "tool")]
    Tool(ToolPart),
    #[serde(rename = "file")]
    File(FilePart),
    #[serde(rename = "image")]
    Image(ImagePart),
    #[serde(rename = "audio")]
    Audio(AudioPart),
    #[serde(rename = "compaction")]
    Compaction(CompactionPart),
    #[serde(rename = "marker")]
    Marker(MarkerPart),
    /// a kind this build does not know: its raw object, as it came.
    #[serde(skip)]
    Unknown(UnknownPart),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextPart {
    pub id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub at: Option<PartAt>,
    pub text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub streaming: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<PartTime>,
    /// context the runtime added, never shown as typed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub synthetic: bool,
    /// a runtime or boxbox note (an ask cancelled by a restart, a media copy that failed).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub notice: bool,
    /// another agent's brief, report or note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail: Option<Mail>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Mail {
    /// `task` (a brief), `report`, `message`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, rename = "fromID", skip_serializing_if = "Option::is_none")]
    pub from_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningPart {
    pub id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub at: Option<PartAt>,
    pub text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub streaming: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<PartTime>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolPart {
    pub id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub at: Option<PartAt>,
    #[serde(rename = "callID")]
    pub call_id: String,
    /// the tool's name, as the source calls it.
    pub tool: String,
    /// the server's family for the tool; rich rows read `input` and
    /// `metadata` only when the family and the agent's source match theirs.
    pub family: Family,
    pub state: ToolState,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    pub status: ToolStatus,
    /// the source's json, as it came.
    #[schema(value_type = Object)]
    pub input: Box<RawValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// the source's json, as it came.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<Object>)]
    pub metadata: Option<Box<RawValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<ToolTime>,
    /// files the tool made, as parts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(no_recursion)]
    pub attachments: Option<Vec<Part>>,
    /// attachments left out past a cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments_dropped: Option<u32>,
}

impl PartialEq for ToolState {
    fn eq(&self, other: &Self) -> bool {
        self.status == other.status
            && self.input.get() == other.input.get()
            && self.output == other.output
            && self.title == other.title
            && self.error == other.error
            && self.metadata.as_ref().map(|m| m.get()) == other.metadata.as_ref().map(|m| m.get())
            && self.time == other.time
            && self.attachments == other.attachments
            && self.attachments_dropped == other.attachments_dropped
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Pending,
    Running,
    Completed,
    Error,
}

impl ToolStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolTime {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<f64>,
}

/// what kind of step a tool call is, whatever the source calls the tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Read,
    Search,
    Edit,
    Shell,
    Web,
    Spawn,
    Message,
    Wait,
    Agents,
    Ask,
    Plan,
    Skill,
    Other,
}

/// a part's bytes in boxbox's media store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    /// the sha256 of the bytes, 64 lowercase hex; null while pending.
    pub id: Option<String>,
    pub state: MediaState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MediaState {
    Ready,
    /// boxbox is still copying the agent's bytes; the part comes again ready.
    Pending,
    /// the agent no longer had them, or they were past a cap.
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Flavour {
    /// a file someone sent.
    Attached,
    /// a voice note: yours, or the agent's spoken reply.
    Voice,
    /// made by the agent's tools.
    Generated,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilePart {
    pub id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub at: Option<PartAt>,
    pub mime: String,
    pub filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaRef>,
    /// a `data:` url; only cmx2 parts carry one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub flavour: Flavour,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    pub id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub at: Option<PartAt>,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    pub flavour: Flavour,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AudioPart {
    pub id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub at: Option<PartAt>,
    pub mime: String,
    pub media: MediaRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// at most 64 values from 0 to 255; on your own voice notes only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform: Option<Vec<u8>>,
    pub flavour: Flavour,
    /// what the agent's reply said aloud.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spoken: Option<String>,
    /// your device's transcript of your own voice note, a boxbox sidecar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<AudioTranscript>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AudioTranscript {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompactionPart {
    pub id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub at: Option<PartAt>,
    pub auto: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow: Option<bool>,
}

/// kept so order and accounting survive; never drawn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkerPart {
    pub id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub at: Option<PartAt>,
    pub marker: MarkerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum MarkerKind {
    StepStart,
    StepFinish,
    Patch,
    Subtask,
    /// where the agent cleared its context (openclaw's `/new`).
    Reset,
}

/// a part of a kind this build does not know, or whose fields do not fit
/// its kind: the object as it came.
#[derive(Clone, Debug, ToSchema)]
pub struct UnknownPart {
    /// the object's `id`, empty when it has none.
    pub id: String,
    /// the object's `messageID`, empty when it has none.
    pub message_id: String,
    /// the object's `type`.
    pub kind: String,
    #[schema(value_type = Object)]
    pub raw: Box<RawValue>,
}

impl PartialEq for UnknownPart {
    fn eq(&self, other: &Self) -> bool {
        self.raw.get() == other.raw.get()
    }
}

impl PartialEq for Part {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Text(a), Self::Text(b)) => a == b,
            (Self::Reasoning(a), Self::Reasoning(b)) => a == b,
            (Self::Tool(a), Self::Tool(b)) => a == b,
            (Self::File(a), Self::File(b)) => a == b,
            (Self::Image(a), Self::Image(b)) => a == b,
            (Self::Audio(a), Self::Audio(b)) => a == b,
            (Self::Compaction(a), Self::Compaction(b)) => a == b,
            (Self::Marker(a), Self::Marker(b)) => a == b,
            (Self::Unknown(a), Self::Unknown(b)) => a == b,
            _ => false,
        }
    }
}

impl Part {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Text(p) => &p.id,
            Self::Reasoning(p) => &p.id,
            Self::Tool(p) => &p.id,
            Self::File(p) => &p.id,
            Self::Image(p) => &p.id,
            Self::Audio(p) => &p.id,
            Self::Compaction(p) => &p.id,
            Self::Marker(p) => &p.id,
            Self::Unknown(p) => &p.id,
        }
    }

    #[must_use]
    pub fn message_id(&self) -> &str {
        match self {
            Self::Text(p) => &p.message_id,
            Self::Reasoning(p) => &p.message_id,
            Self::Tool(p) => &p.message_id,
            Self::File(p) => &p.message_id,
            Self::Image(p) => &p.message_id,
            Self::Audio(p) => &p.message_id,
            Self::Compaction(p) => &p.message_id,
            Self::Marker(p) => &p.message_id,
            Self::Unknown(p) => &p.message_id,
        }
    }

    /// the wire's `type`.
    #[must_use]
    pub fn kind(&self) -> &str {
        match self {
            Self::Text(_) => "text",
            Self::Reasoning(_) => "reasoning",
            Self::Tool(_) => "tool",
            Self::File(_) => "file",
            Self::Image(_) => "image",
            Self::Audio(_) => "audio",
            Self::Compaction(_) => "compaction",
            Self::Marker(_) => "marker",
            Self::Unknown(p) => &p.kind,
        }
    }

    /// keeps `raw` as an unknown part, reading what identity it has loosely.
    #[must_use]
    pub fn unknown(raw: Box<RawValue>) -> Self {
        #[derive(Deserialize, Default)]
        struct Identity {
            #[serde(default)]
            id: Option<String>,
            #[serde(default, rename = "messageID")]
            message_id: Option<String>,
            #[serde(default, rename = "type")]
            kind: Option<String>,
        }
        let identity: Identity = serde_json::from_str(raw.get()).unwrap_or_default();
        Self::Unknown(UnknownPart {
            id: identity.id.unwrap_or_default(),
            message_id: identity.message_id.unwrap_or_default(),
            kind: identity.kind.unwrap_or_default(),
            raw,
        })
    }

    /// decodes one part from json: a known kind whose fields fit becomes
    /// its variant, anything else `unknown` with the object kept.
    ///
    /// # Errors
    /// the text is not a json object.
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        let raw = RawValue::from_string(text.to_owned())?;
        Self::from_raw(raw)
    }

    /// as `from_json`, from a raw value already held.
    ///
    /// # Errors
    /// the value is not a json object.
    pub fn from_raw(raw: Box<RawValue>) -> Result<Self, serde_json::Error> {
        #[derive(Deserialize)]
        struct Tag<'a> {
            #[serde(rename = "type", borrow)]
            kind: Option<std::borrow::Cow<'a, str>>,
        }
        let tag: Tag<'_> = serde_json::from_str(raw.get())?;
        let text = raw.get();
        let known = match tag.kind.as_deref() {
            Some("text") => serde_json::from_str(text).map(Self::Text).ok(),
            Some("reasoning") => serde_json::from_str(text).map(Self::Reasoning).ok(),
            Some("tool") => serde_json::from_str(text).map(Self::Tool).ok(),
            Some("file") => serde_json::from_str(text).map(Self::File).ok(),
            Some("image") => serde_json::from_str(text).map(Self::Image).ok(),
            Some("audio") => serde_json::from_str(text).map(Self::Audio).ok(),
            Some("compaction") => serde_json::from_str(text).map(Self::Compaction).ok(),
            Some("marker") => serde_json::from_str(text).map(Self::Marker).ok(),
            _ => None,
        };
        Ok(known.unwrap_or_else(|| Self::unknown(raw)))
    }
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Tagged<'a> {
    #[serde(rename = "text")]
    Text(&'a TextPart),
    #[serde(rename = "reasoning")]
    Reasoning(&'a ReasoningPart),
    #[serde(rename = "tool")]
    Tool(&'a ToolPart),
    #[serde(rename = "file")]
    File(&'a FilePart),
    #[serde(rename = "image")]
    Image(&'a ImagePart),
    #[serde(rename = "audio")]
    Audio(&'a AudioPart),
    #[serde(rename = "compaction")]
    Compaction(&'a CompactionPart),
    #[serde(rename = "marker")]
    Marker(&'a MarkerPart),
}

impl Serialize for Part {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(p) => Tagged::Text(p).serialize(serializer),
            Self::Reasoning(p) => Tagged::Reasoning(p).serialize(serializer),
            Self::Tool(p) => Tagged::Tool(p).serialize(serializer),
            Self::File(p) => Tagged::File(p).serialize(serializer),
            Self::Image(p) => Tagged::Image(p).serialize(serializer),
            Self::Audio(p) => Tagged::Audio(p).serialize(serializer),
            Self::Compaction(p) => Tagged::Compaction(p).serialize(serializer),
            Self::Marker(p) => Tagged::Marker(p).serialize(serializer),
            Self::Unknown(p) => p.raw.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Part {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // through a value, not a raw value: inside a tagged or flattened
        // shape serde buffers the object, and a raw value needs the json
        // reader itself. `from_raw` keeps the bytes where a source has them.
        let value = serde_json::Value::deserialize(deserializer)?;
        let raw = serde_json::value::to_raw_value(&value).map_err(D::Error::custom)?;
        Self::from_raw(raw).map_err(D::Error::custom)
    }
}
