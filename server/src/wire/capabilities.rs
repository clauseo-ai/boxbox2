//! what an agent can do (`docs/agents.md`, section 5). published live on
//! the agent; a surface shows a control only when its capability is set,
//! and the server refuses the verb with 422 `unsupported` when it is not.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// the efforts cmx2 takes (`http/compose.rs`, `EFFORTS`).
const CMX2_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
/// what a cmx2 prompt may attach: the photo kinds its composer clamps.
const CMX2_ATTACHMENT_KINDS: [&str; 6] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
];
const CMX2_ATTACHMENT_BYTES: u64 = 24 * 1024 * 1024;
const CMX2_ATTACHMENT_COUNT: u32 = 4;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the wire publishes each capability as a flag"
)]
pub struct Capabilities {
    /// threads start in a repo or folder on the agent's machine.
    pub places: bool,
    /// a new thread may start in a fresh worktree.
    pub worktree: bool,
    /// terminals on the agent's machine.
    pub terminal: bool,
    /// branch review of a thread's checkout, and review needs.
    pub review: bool,
    pub compact: bool,
    /// a prompt sent during a turn waits behind it; run now; unsend.
    pub queue: bool,
    /// a prompt can join the running turn at its next tool boundary.
    pub steer: bool,
    /// a model picker from the agent's catalog.
    pub model: bool,
    /// the effort or thinking chip; null without one.
    pub reasoning: Option<Reasoning>,
    pub approvals: bool,
    pub questions: bool,
    /// what the composer may attach; null when nothing.
    pub attachments: Option<Attachments>,
    pub voice: Voice,
    pub quotes: bool,
    pub reactions: bool,
    /// more than one thread; start one with no place.
    pub threads: bool,
    pub archive: bool,
    /// slash commands.
    pub commands: bool,
    /// `@` file mentions.
    pub files: bool,
    /// `!` lines.
    pub shell: bool,
    /// past threads, paged; adopt.
    pub history: bool,
    /// threads have parent threads.
    pub subagents: bool,
    /// cost and context fill mean something.
    pub spend: bool,
    /// messages arrive from channels or schedules.
    pub origins: bool,
    /// reload, restart and memory for the runtime.
    pub admin: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reasoning {
    pub word: ReasoningWord,
    pub levels: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningWord {
    Effort,
    Thinking,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attachments {
    /// mime patterns, `image/png` or `image/*`.
    pub kinds: Vec<String>,
    pub max_bytes: u64,
    pub max_count: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    /// you can record a voice note and the agent hears it (the mic key).
    pub notes: bool,
    /// the agent may answer with audio; gates nothing.
    pub replies: bool,
}

/// one capability, by the name the wire gives it: what a 422 names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Places,
    Worktree,
    Terminal,
    Review,
    Compact,
    Queue,
    Steer,
    Model,
    Reasoning,
    Approvals,
    Questions,
    Attachments,
    Voice,
    Quotes,
    Reactions,
    Threads,
    Archive,
    Commands,
    Files,
    Shell,
    History,
    Subagents,
    Spend,
    Origins,
    Admin,
}

impl Capability {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Places => "places",
            Self::Worktree => "worktree",
            Self::Terminal => "terminal",
            Self::Review => "review",
            Self::Compact => "compact",
            Self::Queue => "queue",
            Self::Steer => "steer",
            Self::Model => "model",
            Self::Reasoning => "reasoning",
            Self::Approvals => "approvals",
            Self::Questions => "questions",
            Self::Attachments => "attachments",
            Self::Voice => "voice",
            Self::Quotes => "quotes",
            Self::Reactions => "reactions",
            Self::Threads => "threads",
            Self::Archive => "archive",
            Self::Commands => "commands",
            Self::Files => "files",
            Self::Shell => "shell",
            Self::History => "history",
            Self::Subagents => "subagents",
            Self::Spend => "spend",
            Self::Origins => "origins",
            Self::Admin => "admin",
        }
    }

    /// what a person reads after the agent's label: "<label> has no terminal".
    #[must_use]
    pub fn missing(self) -> &'static str {
        match self {
            Self::Places => "no places to start a thread in",
            Self::Worktree => "no fresh worktrees",
            Self::Terminal => "no terminal",
            Self::Review => "no branch review",
            Self::Compact => "no compaction",
            Self::Queue => "no queue",
            Self::Steer => "no steering",
            Self::Model => "no model picker",
            Self::Reasoning => "no reasoning levels",
            Self::Approvals => "no approvals",
            Self::Questions => "no questions",
            Self::Attachments => "no attachments",
            Self::Voice => "no voice notes",
            Self::Quotes => "no quote replies",
            Self::Reactions => "no reactions",
            Self::Threads => "no new threads",
            Self::Archive => "no archive",
            Self::Commands => "no slash commands",
            Self::Files => "no file mentions",
            Self::Shell => "no shell lines",
            Self::History => "no history",
            Self::Subagents => "no subagents",
            Self::Spend => "no spend",
            Self::Origins => "no origins",
            Self::Admin => "no admin verbs",
        }
    }
}

impl Capabilities {
    /// everything cmx2 does today, so no cmx2 surface changes.
    #[must_use]
    pub fn cmx2() -> Self {
        Self {
            places: true,
            worktree: true,
            terminal: true,
            review: true,
            compact: true,
            queue: true,
            steer: true,
            model: true,
            reasoning: Some(Reasoning {
                word: ReasoningWord::Effort,
                levels: CMX2_EFFORTS.iter().map(|e| (*e).to_owned()).collect(),
            }),
            approvals: true,
            questions: true,
            attachments: Some(Attachments {
                kinds: CMX2_ATTACHMENT_KINDS
                    .iter()
                    .map(|k| (*k).to_owned())
                    .collect(),
                max_bytes: CMX2_ATTACHMENT_BYTES,
                max_count: CMX2_ATTACHMENT_COUNT,
            }),
            voice: Voice::default(),
            quotes: false,
            reactions: false,
            threads: true,
            archive: true,
            commands: true,
            files: true,
            shell: true,
            history: true,
            subagents: true,
            spend: true,
            origins: false,
            admin: true,
        }
    }

    /// whether the agent can do `capability`.
    #[must_use]
    pub fn has(&self, capability: Capability) -> bool {
        match capability {
            Capability::Places => self.places,
            Capability::Worktree => self.worktree,
            Capability::Terminal => self.terminal,
            Capability::Review => self.review,
            Capability::Compact => self.compact,
            Capability::Queue => self.queue,
            Capability::Steer => self.steer,
            Capability::Model => self.model,
            Capability::Reasoning => self.reasoning.is_some(),
            Capability::Approvals => self.approvals,
            Capability::Questions => self.questions,
            Capability::Attachments => self.attachments.is_some(),
            Capability::Voice => self.voice.notes,
            Capability::Quotes => self.quotes,
            Capability::Reactions => self.reactions,
            Capability::Threads => self.threads,
            Capability::Archive => self.archive,
            Capability::Commands => self.commands,
            Capability::Files => self.files,
            Capability::Shell => self.shell,
            Capability::History => self.history,
            Capability::Subagents => self.subagents,
            Capability::Spend => self.spend,
            Capability::Origins => self.origins,
            Capability::Admin => self.admin,
        }
    }
}
