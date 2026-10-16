//! transcript message bodies, hand-written because the schema leaves them
//! open (`docs/openclaw.md` 2.3): a delta's `messages`, a `chat` event's
//! `message` and a tail row are all `Unknown` there.
//!
//! decode is deliberately two-tier. a row without a role, or with content of
//! the wrong type, cannot be shown at all, so it is an error naming the
//! field. everything else is optional and read leniently: a missing or
//! wrong-typed optional field is `None`, and a block whose type this code
//! does not know (or whose known type lacks its essentials) becomes
//! [`Block::Unknown`], so an additive gateway release degrades to the
//! fallback row (9.2) instead of failing the thread. only the fields the
//! spec maps (5.1, 5.2, 8.2, 8.3, 9.2, 9.4, 9.6, 9.7) are kept.

#![allow(
    dead_code,
    reason = "the sync phase is the first reader; until it lands only the tests use these"
)]

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

#[cfg(test)]
mod tests;

/// why a row or envelope could not be decoded. only essentials produce one.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    #[error("transcript row is not a json object")]
    NotObject,
    #[error("transcript field `{0}` is missing")]
    Missing(&'static str),
    #[error("transcript field `{field}` should be {expected}")]
    WrongType {
        field: &'static str,
        expected: &'static str,
    },
}

/// who wrote the row. `Other` keeps a role a newer gateway adds, so the row
/// still reaches the fallback instead of failing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    ToolResult,
    System,
    Custom,
    Other(String),
}

impl Role {
    fn parse(s: &str) -> Self {
        match s {
            "user" => Self::User,
            "assistant" => Self::Assistant,
            "toolResult" => Self::ToolResult,
            "system" => Self::System,
            "custom" => Self::Custom,
            other => Self::Other(other.to_owned()),
        }
    }
}

/// one transcript row: a tail row, the `message` of a delta envelope or
/// `session.message`, or a `chat` event's `message`.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub role: Role,
    /// a user row's string content arrives here as one text block, so every
    /// reader walks blocks.
    pub content: Vec<Block>,
    /// milliseconds since the epoch.
    pub timestamp: Option<i64>,
    /// `__openclaw`; all `None` on live `chat` event bodies, which lack it.
    pub meta: Meta,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub stop_reason: Option<String>,
    pub error_message: Option<String>,
    pub usage: Option<Usage>,
    pub delivery: Option<Delivery>,
    /// the boxbox quote (9.4). recorded rows carry it under `__openclaw`;
    /// a top-level copy is read too, which is where 9.4's prose puts it.
    pub reply_to_id: Option<String>,
    pub reply_to_preview: Option<ReplyPreview>,
    /// a `toolResult` row's call, which folds it into its tool part (9.2).
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub is_error: Option<bool>,
}

/// the `__openclaw` sidecar on a history row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Meta {
    /// the transcript entry id: the row's identity on tails (5.1).
    pub id: Option<String>,
    /// the display position on tails (9.2 `position`).
    pub seq: Option<u64>,
    /// `reset` or `compaction` on system rows (9.2 markers).
    pub kind: Option<String>,
    pub idempotency_key: Option<String>,
    /// `false` marks a group member who is not the person (9.6).
    pub sender_is_owner: Option<bool>,
    pub sender_name: Option<String>,
    pub sender_username: Option<String>,
    pub sender_id: Option<String>,
    pub transport: Option<Transport>,
    pub input_provenance: Option<InputProvenance>,
    /// inbound media facts on user rows (8.2, shape 2).
    pub media: Vec<MediaFact>,
    /// set when `truncated: true`; the merge rule (5.2) needs the reason.
    pub truncated: Option<Truncation>,
}

/// `__openclaw.transport`: the channel a turn came over and its stanza ids.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Transport {
    pub channel: Option<String>,
    pub message_id: Option<String>,
    pub reply_to_id: Option<String>,
}

/// how a scheduled or relayed turn entered the session (9.6), as the
/// schema's `inputProvenance` (`kind` is `external_user`, `inter_session`
/// or `internal_system`).
#[derive(Debug, Clone, PartialEq)]
pub struct InputProvenance {
    pub kind: String,
    pub source_channel: Option<String>,
    pub source_tool: Option<String>,
    pub job_id: Option<String>,
}

/// why a row's text is not the whole row (5.1, hole 20).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Truncation {
    /// cut at the display cap; the rest is on the gateway.
    DisplayCap,
    /// replaced by the "message too large" placeholder; never replaces text.
    Oversized,
    /// truncated with a reason this code does not know, or none.
    Other(Option<String>),
}

/// `usage` on assistant rows; only the cost is mapped (9.7 spend).
#[derive(Debug, Clone, PartialEq)]
pub struct Usage {
    /// `usage.cost.total`, in usd.
    pub cost_usd: Option<f64>,
}

/// `openclawDelivery` on assistant rows (8.3, 9.4).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Delivery {
    pub tts: Option<Tts>,
    pub audio_as_voice: Option<bool>,
    /// the agent quoting a row.
    pub reply_to_id: Option<String>,
    /// the agent quoting the user message that started the turn.
    pub reply_to_current: Option<bool>,
}

/// `openclawDelivery.tts`: `text` is what was spoken (8.3).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tts {
    pub tagged: Option<bool>,
    pub text: Option<String>,
}

/// `replyToPreview` on a user row that quotes another.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReplyPreview {
    pub text: Option<String>,
    pub sender_label: Option<String>,
}

/// a media fact on a user row (8.2, shape 2).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaFact {
    /// `url`, else `path`: the `source` for the assistant-media fetch.
    pub source: Option<String>,
    pub content_type: Option<String>,
    /// `image`, `audio`, `video` or `document`.
    pub kind: Option<String>,
    pub file_name: Option<String>,
    pub size_bytes: Option<u64>,
    pub duration_ms: Option<u64>,
    pub transcribed: Option<bool>,
}

/// a content block (9.2).
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
        /// set on nested calls (`ask_user` inside a `custom` row), so the
        /// nested call can fold under its parent.
        parent_tool_call_id: Option<String>,
    },
    /// a result nested inside a `custom` row, beside its call.
    ToolResult {
        tool_call_id: String,
        tool_name: Option<String>,
        is_error: Option<bool>,
        content: Vec<Block>,
    },
    Image(MediaBlock),
    Audio(MediaBlock),
    Video(MediaBlock),
    /// a document: `{type: "attachment", attachment: {...}}` (8.2).
    Attachment(AttachmentBlock),
    /// media the gateway could not keep (8.2, shape 3). the spec gives no
    /// field list, so the body rides along whole for the notice.
    AttachmentError {
        raw: Value,
    },
    /// a type this code does not know, or a known type missing its
    /// essentials. never an error (9.2: the fallback row).
    Unknown {
        kind: String,
        raw: Value,
    },
}

/// a managed `image`, `audio` or `video` block (8.2, shape 1).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaBlock {
    pub artifact_id: Option<String>,
    pub url: Option<String>,
    pub open_url: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub alt: Option<String>,
    pub file_name: Option<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub playback: Option<String>,
    /// audio from an `audioAsVoice` reply: flavour `voice` (8.3).
    pub is_voice_note: Option<bool>,
}

/// the inner `attachment` of a document block (8.2).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AttachmentBlock {
    pub artifact_id: Option<String>,
    pub url: Option<String>,
    pub kind: Option<String>,
    pub label: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
}

/// a `session.message`-shaped delta row (5.1): the row plus its identity
/// and display position, which bare tail rows carry in `__openclaw`.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub message: Row,
    /// the transcript entry id; the message's identity.
    pub message_id: String,
    pub message_seq: Option<u64>,
    pub session_key: Option<String>,
    pub agent_id: Option<String>,
    /// only `session.message` carries it (5.1).
    pub run_id: Option<String>,
}

impl Row {
    /// decodes one row. errors only when `role` is missing or not a string,
    /// or `content` is neither a string, an array nor absent.
    pub fn decode(value: &Value) -> Result<Self, DecodeError> {
        let obj = value.as_object().ok_or(DecodeError::NotObject)?;
        let role = match obj.get("role") {
            None | Some(Value::Null) => return Err(DecodeError::Missing("role")),
            Some(Value::String(s)) => Role::parse(s),
            Some(_) => {
                return Err(DecodeError::WrongType {
                    field: "role",
                    expected: "a string",
                });
            }
        };
        let content = match obj.get("content") {
            // an assistant error row can have no content; it still shows its
            // error, so absence is not fatal.
            None | Some(Value::Null) => Vec::new(),
            Some(Value::String(s)) => vec![Block::Text { text: s.clone() }],
            Some(Value::Array(items)) => items.iter().map(Block::decode).collect(),
            Some(_) => {
                return Err(DecodeError::WrongType {
                    field: "content",
                    expected: "a string or an array of blocks",
                });
            }
        };
        let oc = obj.get("__openclaw").and_then(Value::as_object);
        let from_meta_or_row = |key: &str| oc.and_then(|m| m.get(key)).or_else(|| obj.get(key));

        Ok(Self {
            role,
            content,
            timestamp: i64_at(obj, "timestamp"),
            meta: oc.map(Meta::decode).unwrap_or_default(),
            model: str_at(obj, "model"),
            provider: str_at(obj, "provider"),
            stop_reason: str_at(obj, "stopReason"),
            error_message: str_at(obj, "errorMessage"),
            usage: obj.get("usage").and_then(Value::as_object).map(|u| Usage {
                cost_usd: u
                    .get("cost")
                    .and_then(Value::as_object)
                    .and_then(|c| c.get("total"))
                    .and_then(Value::as_f64),
            }),
            delivery: obj
                .get("openclawDelivery")
                .and_then(Value::as_object)
                .map(Delivery::decode),
            reply_to_id: from_meta_or_row("replyToId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            reply_to_preview: from_meta_or_row("replyToPreview")
                .and_then(Value::as_object)
                .map(|p| ReplyPreview {
                    text: str_at(p, "text"),
                    sender_label: str_at(p, "senderLabel"),
                }),
            tool_call_id: str_at(obj, "toolCallId"),
            tool_name: str_at(obj, "toolName"),
            is_error: bool_at(obj, "isError"),
        })
    }

    /// whether any block fell back to [`Block::Unknown`], nested results
    /// included; the drift test (2.4) asserts this is false on fixtures.
    pub fn has_unknown(&self) -> bool {
        self.content.iter().any(Block::has_unknown)
    }
}

impl std::str::FromStr for Row {
    type Err = DecodeError;

    /// json text that does not parse is [`DecodeError::NotObject`]: no row
    /// could be read from it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let value: Value = serde_json::from_str(text).map_err(|_| DecodeError::NotObject)?;
        Self::decode(&value)
    }
}

impl<'de> Deserialize<'de> for Row {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::decode(&value).map_err(serde::de::Error::custom)
    }
}

impl Envelope {
    /// decodes a delta or `session.message` envelope. `message` and
    /// `messageId` are essential: without the id the row has no identity.
    pub fn decode(value: &Value) -> Result<Self, DecodeError> {
        let obj = value.as_object().ok_or(DecodeError::NotObject)?;
        let message = match obj.get("message") {
            None | Some(Value::Null) => return Err(DecodeError::Missing("message")),
            Some(m) => Row::decode(m)?,
        };
        let message_id = match obj.get("messageId") {
            None | Some(Value::Null) => return Err(DecodeError::Missing("messageId")),
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                return Err(DecodeError::WrongType {
                    field: "messageId",
                    expected: "a string",
                });
            }
        };
        Ok(Self {
            message,
            message_id,
            message_seq: u64_at(obj, "messageSeq"),
            session_key: str_at(obj, "sessionKey"),
            agent_id: str_at(obj, "agentId"),
            run_id: str_at(obj, "runId"),
        })
    }
}

impl<'de> Deserialize<'de> for Envelope {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::decode(&value).map_err(serde::de::Error::custom)
    }
}

impl Meta {
    fn decode(m: &Map<String, Value>) -> Self {
        let truncated = if bool_at(m, "truncated") == Some(true) {
            Some(match str_at(m, "reason").as_deref() {
                Some("display-cap") => Truncation::DisplayCap,
                Some("oversized") => Truncation::Oversized,
                other => Truncation::Other(other.map(str::to_owned)),
            })
        } else {
            None
        };
        Self {
            id: str_at(m, "id"),
            seq: u64_at(m, "seq"),
            kind: str_at(m, "kind"),
            idempotency_key: str_at(m, "idempotencyKey"),
            sender_is_owner: bool_at(m, "senderIsOwner"),
            sender_name: str_at(m, "senderName"),
            sender_username: str_at(m, "senderUsername"),
            sender_id: str_at(m, "senderId"),
            transport: m
                .get("transport")
                .and_then(Value::as_object)
                .map(|t| Transport {
                    channel: str_at(t, "channel"),
                    message_id: str_at(t, "messageId"),
                    reply_to_id: str_at(t, "replyToId"),
                }),
            input_provenance: m
                .get("inputProvenance")
                .and_then(Value::as_object)
                .and_then(|p| {
                    Some(InputProvenance {
                        kind: str_at(p, "kind")?,
                        source_channel: str_at(p, "sourceChannel"),
                        source_tool: str_at(p, "sourceTool"),
                        job_id: str_at(p, "jobId"),
                    })
                }),
            media: m
                .get("media")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_object)
                        .map(MediaFact::decode)
                        .collect()
                })
                .unwrap_or_default(),
            truncated,
        }
    }
}

impl MediaFact {
    fn decode(m: &Map<String, Value>) -> Self {
        Self {
            source: str_at(m, "url").or_else(|| str_at(m, "path")),
            content_type: str_at(m, "contentType"),
            kind: str_at(m, "kind"),
            file_name: str_at(m, "fileName"),
            size_bytes: u64_at(m, "sizeBytes"),
            duration_ms: u64_at(m, "durationMs"),
            transcribed: bool_at(m, "transcribed"),
        }
    }
}

impl Delivery {
    fn decode(d: &Map<String, Value>) -> Self {
        Self {
            tts: d.get("tts").and_then(Value::as_object).map(|t| Tts {
                tagged: bool_at(t, "tagged"),
                text: str_at(t, "text"),
            }),
            audio_as_voice: bool_at(d, "audioAsVoice"),
            reply_to_id: str_at(d, "replyToId"),
            reply_to_current: bool_at(d, "replyToCurrent"),
        }
    }
}

impl Block {
    /// never fails: anything unreadable becomes [`Block::Unknown`].
    pub fn decode(value: &Value) -> Self {
        let Some(obj) = value.as_object() else {
            return Self::Unknown {
                kind: String::new(),
                raw: value.clone(),
            };
        };
        let kind = str_at(obj, "type").unwrap_or_default();
        Self::decode_known(&kind, obj).unwrap_or_else(|| Self::Unknown {
            kind,
            raw: value.clone(),
        })
    }

    fn decode_known(kind: &str, obj: &Map<String, Value>) -> Option<Self> {
        Some(match kind {
            "text" => Self::Text {
                text: str_at(obj, "text")?,
            },
            "thinking" => Self::Thinking {
                thinking: str_at(obj, "thinking")?,
            },
            "toolCall" => Self::ToolCall {
                id: str_at(obj, "id")?,
                name: str_at(obj, "name")?,
                arguments: obj.get("arguments").cloned().unwrap_or(Value::Null),
                parent_tool_call_id: str_at(obj, "parentToolCallId"),
            },
            "toolResult" => Self::ToolResult {
                tool_call_id: str_at(obj, "toolCallId")?,
                tool_name: str_at(obj, "toolName"),
                is_error: bool_at(obj, "isError"),
                content: match obj.get("content") {
                    Some(Value::String(s)) => vec![Self::Text { text: s.clone() }],
                    Some(Value::Array(items)) => items.iter().map(Self::decode).collect(),
                    _ => Vec::new(),
                },
            },
            "image" => Self::Image(MediaBlock::decode(obj)),
            "audio" => Self::Audio(MediaBlock::decode(obj)),
            "video" => Self::Video(MediaBlock::decode(obj)),
            "attachment" => {
                let a = obj.get("attachment").and_then(Value::as_object)?;
                Self::Attachment(AttachmentBlock {
                    artifact_id: str_at(a, "artifactId"),
                    url: str_at(a, "url"),
                    kind: str_at(a, "kind"),
                    label: str_at(a, "label"),
                    mime_type: str_at(a, "mimeType"),
                    size_bytes: u64_at(a, "sizeBytes"),
                })
            }
            "attachment_error" => Self::AttachmentError {
                raw: Value::Object(obj.clone()),
            },
            _ => return None,
        })
    }

    fn has_unknown(&self) -> bool {
        match self {
            Self::Unknown { .. } => true,
            Self::ToolResult { content, .. } => content.iter().any(Self::has_unknown),
            _ => false,
        }
    }
}

impl MediaBlock {
    fn decode(m: &Map<String, Value>) -> Self {
        Self {
            artifact_id: str_at(m, "artifactId"),
            url: str_at(m, "url"),
            open_url: str_at(m, "openUrl"),
            mime_type: str_at(m, "mimeType"),
            size_bytes: u64_at(m, "sizeBytes"),
            alt: str_at(m, "alt"),
            file_name: str_at(m, "fileName"),
            width: u64_at(m, "width"),
            height: u64_at(m, "height"),
            playback: str_at(m, "playback"),
            is_voice_note: bool_at(m, "isVoiceNote"),
        }
    }
}

fn str_at(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn bool_at(m: &Map<String, Value>, key: &str) -> Option<bool> {
    m.get(key).and_then(Value::as_bool)
}

fn u64_at(m: &Map<String, Value>, key: &str) -> Option<u64> {
    m.get(key).and_then(Value::as_u64)
}

fn i64_at(m: &Map<String, Value>, key: &str) -> Option<i64> {
    m.get(key).and_then(Value::as_i64)
}
