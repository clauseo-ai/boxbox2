//! the allowlist (`docs/openclaw.md`, section 4): the one enum of what
//! boxbox may ask a gateway, and the one sink every outgoing frame passes
//! through.
//!
//! `Allowed` has one variant per allowlisted method. most hold the
//! generated params struct; `chat.send`, `sessions.patch`,
//! `sessions.create` and `chat.message.get` hold narrowed structs that can
//! only express the fields section 4 lists, and they build the generated
//! struct with every other field written out as absent, so a field the
//! schema adds on a pin move fails the build here instead of slipping
//! through. `Outgoing::send` is the only writer of a request frame: the
//! connection task owns the socket's write half inside it, and `mode =
//! "watch"` is checked at its top.

use futures_util::{Sink, SinkExt};
use serde::Serialize;
use tokio_tungstenite::tungstenite::{self, Message, protocol::CloseFrame};

use super::protocol::{
    ApprovalGetParams, ApprovalResolveParams, ArtifactsDownloadParams, ChatAbortParams,
    ChatHistoryParams, ChatMessageGetParams, ChatSendParams, ChatSendParamsAttachmentsItem,
    ConnectParams, ModelsListParams, QuestionGetParams, QuestionListParams, QuestionResolveParams,
    SessionReactionsListParams, SessionReactionsSetParams, SessionsCreateParams,
    SessionsListParams, SessionsMessagesSubscribeParams, SessionsMessagesUnsubscribeParams,
    SessionsPatchParams,
};
use crate::source::OpenclawMode;

/// the scopes boxbox asks for, sorted: the order they are signed in (3.3).
pub const SCOPES: [&str; 5] = [
    "operator.admin",
    "operator.approvals",
    "operator.questions",
    "operator.read",
    "operator.write",
];

/// the caps boxbox claims, and nothing else (3.5).
pub const CAPS: [&str; 4] = [
    "approvals",
    "chat-only-assistant-text",
    "session-scoped-events",
    "tool-events",
];

/// `chat.message.get`'s one `maxChars` (section 4).
pub const MESSAGE_GET_MAX_CHARS: u64 = 1_000_000;

/// every request boxbox can make of a gateway. there is no other way to
/// put a request on the socket. `Debug` names the method only: `connect`
/// carries the token, and params never belong in a log line.
#[derive(Clone)]
pub enum Allowed {
    Connect(Box<ConnectParams>),
    SessionsList(Box<SessionsListParams>),
    /// the roster subscription; it takes `sessions.list`'s params (5.3).
    SessionsSubscribe(Box<SessionsListParams>),
    SessionsMessagesSubscribe(SessionsMessagesSubscribeParams),
    SessionsMessagesUnsubscribe(SessionsMessagesUnsubscribeParams),
    SessionsCreate(SessionsCreate),
    SessionsPatch(SessionsPatch),
    ChatSend(Box<ChatSend>),
    ChatAbort(ChatAbortParams),
    ChatHistory(ChatHistoryParams),
    /// conditional on the dev gateway proof (section 4; 11.8 kept it).
    ChatMessageGet(MessageGet),
    /// params exactly `{}` (3.8).
    AgentsList,
    /// the per-kind approval lists take `{}` (5.9).
    ExecApprovalList,
    PluginApprovalList,
    OpenclawApprovalList,
    ApprovalGet(ApprovalGetParams),
    ApprovalResolve(ApprovalResolveParams),
    QuestionList(QuestionListParams),
    QuestionGet(QuestionGetParams),
    QuestionResolve(QuestionResolveParams),
    ArtifactsDownload(ArtifactsDownloadParams),
    SessionReactionsSet(SessionReactionsSetParams),
    SessionReactionsList(SessionReactionsListParams),
    ModelsList(ModelsListParams),
}

/// every method name `Allowed` can put on the wire, in section 4's order.
pub const METHODS: [&str; 24] = [
    "connect",
    "sessions.list",
    "sessions.subscribe",
    "sessions.messages.subscribe",
    "sessions.messages.unsubscribe",
    "sessions.create",
    "sessions.patch",
    "chat.send",
    "chat.abort",
    "chat.history",
    "chat.message.get",
    "agents.list",
    "exec.approval.list",
    "plugin.approval.list",
    "openclaw.approval.list",
    "approval.get",
    "approval.resolve",
    "question.list",
    "question.get",
    "question.resolve",
    "artifacts.download",
    "session.reactions.set",
    "session.reactions.list",
    "models.list",
];

/// the write methods `mode = "watch"` refuses (3.1).
pub const WRITE_METHODS: [&str; 7] = [
    "chat.send",
    "chat.abort",
    "sessions.create",
    "sessions.patch",
    "approval.resolve",
    "question.resolve",
    "session.reactions.set",
];

impl std::fmt::Debug for Allowed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Allowed({})", self.method())
    }
}

/// how long one frame may take to reach the kernel. a half-open link
/// (the gateway's machine suspended) would otherwise hold a write until
/// tcp gives up, and the liveness checks, answers and shutdown with it.
pub const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// a close is best effort: it never holds a stopping server long.
const CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

impl Allowed {
    /// the wire method name.
    #[must_use]
    pub fn method(&self) -> &'static str {
        match self {
            Self::Connect(_) => "connect",
            Self::SessionsList(_) => "sessions.list",
            Self::SessionsSubscribe(_) => "sessions.subscribe",
            Self::SessionsMessagesSubscribe(_) => "sessions.messages.subscribe",
            Self::SessionsMessagesUnsubscribe(_) => "sessions.messages.unsubscribe",
            Self::SessionsCreate(_) => "sessions.create",
            Self::SessionsPatch(_) => "sessions.patch",
            Self::ChatSend(_) => "chat.send",
            Self::ChatAbort(_) => "chat.abort",
            Self::ChatHistory(_) => "chat.history",
            Self::ChatMessageGet(_) => "chat.message.get",
            Self::AgentsList => "agents.list",
            Self::ExecApprovalList => "exec.approval.list",
            Self::PluginApprovalList => "plugin.approval.list",
            Self::OpenclawApprovalList => "openclaw.approval.list",
            Self::ApprovalGet(_) => "approval.get",
            Self::ApprovalResolve(_) => "approval.resolve",
            Self::QuestionList(_) => "question.list",
            Self::QuestionGet(_) => "question.get",
            Self::QuestionResolve(_) => "question.resolve",
            Self::ArtifactsDownload(_) => "artifacts.download",
            Self::SessionReactionsSet(_) => "session.reactions.set",
            Self::SessionReactionsList(_) => "session.reactions.list",
            Self::ModelsList(_) => "models.list",
        }
    }

    /// whether `mode = "watch"` refuses it.
    #[must_use]
    pub fn is_write(&self) -> bool {
        WRITE_METHODS.contains(&self.method())
    }

    /// whether it can start a turn: refused outright without
    /// `operator.admin`, because a send without command suppression is
    /// never built (3.3 step 7).
    #[must_use]
    pub fn starts_turn(&self) -> bool {
        matches!(self, Self::ChatSend(_) | Self::SessionsCreate(_))
    }

    /// the params object as it goes on the wire.
    ///
    /// # Errors
    /// serde could not encode a value (a non-finite float).
    pub fn params(&self) -> Result<serde_json::Value, serde_json::Error> {
        let empty = || Ok(serde_json::Value::Object(serde_json::Map::new()));
        match self {
            Self::Connect(p) => serde_json::to_value(p),
            Self::SessionsList(p) | Self::SessionsSubscribe(p) => serde_json::to_value(p),
            Self::SessionsMessagesSubscribe(p) => serde_json::to_value(p),
            Self::SessionsMessagesUnsubscribe(p) => serde_json::to_value(p),
            Self::SessionsCreate(p) => serde_json::to_value(p.params()),
            Self::SessionsPatch(p) => serde_json::to_value(p.params()),
            Self::ChatSend(p) => serde_json::to_value(p.params()),
            Self::ChatAbort(p) => serde_json::to_value(p),
            Self::ChatHistory(p) => serde_json::to_value(p),
            Self::ChatMessageGet(p) => serde_json::to_value(p.params()),
            Self::AgentsList
            | Self::ExecApprovalList
            | Self::PluginApprovalList
            | Self::OpenclawApprovalList => empty(),
            Self::ApprovalGet(p) => serde_json::to_value(p),
            Self::ApprovalResolve(p) => serde_json::to_value(p),
            Self::QuestionList(p) => serde_json::to_value(p),
            Self::QuestionGet(p) => serde_json::to_value(p),
            Self::QuestionResolve(p) => serde_json::to_value(p),
            Self::ArtifactsDownload(p) => serde_json::to_value(p),
            Self::SessionReactionsSet(p) => serde_json::to_value(p),
            Self::SessionReactionsList(p) => serde_json::to_value(p),
            Self::ModelsList(p) => serde_json::to_value(p),
        }
    }
}

/// `chat.send`, narrowed (section 4): `sessionKey`, `agentId`,
/// `sessionId`, `expectedLeafEntryId`, `message`, `idempotencyKey`,
/// `replyToId`, `attachments`; `queueMode: "followup"` and
/// `suppressCommandInterpretation: true` are not fields, they are always
/// written (7.2).
#[derive(Debug, Clone)]
pub struct ChatSend {
    pub session_key: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub expected_leaf_entry_id: Option<String>,
    pub message: String,
    pub idempotency_key: String,
    pub reply_to_id: Option<String>,
    pub attachments: Vec<ChatSendParamsAttachmentsItem>,
}

impl ChatSend {
    fn params(&self) -> ChatSendParams {
        ChatSendParams {
            session_key: self.session_key.clone(),
            agent_id: Some(self.agent_id.clone()),
            session_id: self.session_id.clone(),
            expected_leaf_entry_id: self.expected_leaf_entry_id.clone(),
            message: self.message.clone(),
            idempotency_key: self.idempotency_key.clone(),
            reply_to_id: self.reply_to_id.clone(),
            attachments: self.attachments.clone(),
            queue_mode: Some("followup".to_owned()),
            suppress_command_interpretation: Some(true),
            // never sent (section 4): the thinking chip patches the session,
            // and nothing boxbox sends speaks for a channel or a system
            deliver: None,
            expected_permission_mode: None,
            expected_session_routing_contract: None,
            expected_tool_overrides: None,
            fast_auto_on_seconds: None,
            fast_mode: None,
            intent: None,
            mentions: Vec::new(),
            originating_account_id: None,
            originating_channel: None,
            originating_thread_id: None,
            originating_to: None,
            system_input_provenance: None,
            system_provenance_receipt: None,
            thinking: None,
            timeout_ms: None,
            tool_bindings: serde_json::Map::new(),
            work_context: None,
        }
    }
}

/// `sessions.patch`, narrowed (section 4): `key`, `agentId` and
/// `expectedSessionId` always, and exactly one change.
#[derive(Debug, Clone)]
pub struct SessionsPatch {
    pub key: String,
    pub agent_id: String,
    pub expected_session_id: String,
    pub change: PatchChange,
}

/// the one thing a patch changes.
#[derive(Debug, Clone, PartialEq)]
pub enum PatchChange {
    Model(String),
    ThinkingLevel(String),
    /// `expected_marked_unread_at` only on an automatic read (7.6).
    Unread {
        unread: bool,
        expected_marked_unread_at: Option<f64>,
    },
    Archived(bool),
}

impl SessionsPatch {
    fn params(&self) -> SessionsPatchParams {
        let (
            mut model,
            mut thinking_level,
            mut unread,
            mut expected_marked_unread_at,
            mut archived,
        ) = (None, None, None, None, None);
        match &self.change {
            PatchChange::Model(m) => model = Some(m.clone()),
            PatchChange::ThinkingLevel(t) => thinking_level = Some(t.clone()),
            PatchChange::Unread {
                unread: u,
                expected_marked_unread_at: at,
            } => {
                unread = Some(*u);
                expected_marked_unread_at = *at;
            }
            PatchChange::Archived(a) => archived = Some(*a),
        }
        SessionsPatchParams {
            key: self.key.clone(),
            agent_id: Some(self.agent_id.clone()),
            expected_session_id: Some(self.expected_session_id.clone()),
            model,
            thinking_level,
            unread,
            expected_marked_unread_at,
            archived,
            // never sent: admin passes every one of these (section 4,
            // defence in depth), and boxbox must not be the way they change
            agent_runtime: None,
            attention: None,
            auto_label: None,
            board_face: None,
            board_presentation: None,
            category: None,
            color: None,
            completion_owner_session_key: None,
            context_window: None,
            elevated_level: None,
            exec_ask: None,
            exec_host: None,
            exec_node: None,
            exec_security: None,
            expected_lifecycle_revision: None,
            expected_native_runtime_consent: None,
            expected_permission_mode: None,
            expected_sandbox_mode: None,
            expected_tool_overrides: None,
            fast_mode: None,
            group_activation: None,
            icon: None,
            inherited_tool_allow: None,
            inherited_tool_deny: None,
            inherited_tool_policy_version: None,
            label: None,
            native_runtime_consent: None,
            permission_mode: None,
            pinned: None,
            reasoning_level: None,
            response_usage: None,
            sandbox_mode: None,
            send_policy: None,
            snoozed_until: None,
            status_note: None,
            tool_overrides: None,
            trace_level: None,
            ttl_minutes: None,
            verbose_level: None,
        }
    }
}

/// `sessions.create`, narrowed (section 4, 7.4): `agentId`,
/// `idempotencyKey`, `key`, `model?`, `thinkingLevel?`.
#[derive(Debug, Clone)]
pub struct SessionsCreate {
    pub agent_id: String,
    pub idempotency_key: String,
    pub key: String,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
}

impl SessionsCreate {
    fn params(&self) -> SessionsCreateParams {
        SessionsCreateParams {
            agent_id: Some(self.agent_id.clone()),
            idempotency_key: Some(self.idempotency_key.clone()),
            key: Some(self.key.clone()),
            model: self.model.clone(),
            thinking_level: self.thinking_level.clone(),
            // never sent: a first turn here would skip command suppression,
            // and the rest are admin-only or not boxbox's to choose
            agent_runtime: None,
            attachments: Vec::new(),
            catalog_id: None,
            category: None,
            context_window: None,
            cwd: None,
            display_name: None,
            emit_command_hooks: None,
            exec_node: None,
            fast_mode: None,
            fork: None,
            fork_from: None,
            incognito: None,
            label: None,
            mentions: Vec::new(),
            message: None,
            parent_session_key: None,
            permission_mode: None,
            project_git_url: None,
            project_id: None,
            repository: None,
            spawn_depth: None,
            succeeds_parent: None,
            task: None,
            timeout_ms: None,
            title_source: None,
            tool_overrides: None,
            visibility: None,
            worktree: None,
            worktree_base_ref: None,
            worktree_name: None,
            worktree_source: None,
        }
    }
}

/// `chat.message.get`, narrowed: exactly `{sessionKey, agentId, messageId,
/// maxChars: 1000000}` (section 4).
#[derive(Debug, Clone)]
pub struct MessageGet {
    pub session_key: String,
    pub agent_id: String,
    pub message_id: String,
}

impl MessageGet {
    fn params(&self) -> ChatMessageGetParams {
        ChatMessageGetParams {
            session_key: self.session_key.clone(),
            agent_id: Some(self.agent_id.clone()),
            message_id: self.message_id.clone(),
            max_chars: std::num::NonZeroU64::new(MESSAGE_GET_MAX_CHARS),
        }
    }
}

/// why a request did not reach the socket, or the socket failed under it.
#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("{method} writes, and this connection is in watch mode")]
    Watch { method: &'static str },
    #[error("{method}'s params did not encode: {source}")]
    Encode {
        method: &'static str,
        source: serde_json::Error,
    },
    #[error("the socket failed: {0}")]
    Socket(#[from] tungstenite::Error),
    #[error("the socket took more than 10 s to take a frame")]
    Stalled,
}

/// one request frame, `{type: "req", id, method, params}`.
#[derive(Serialize)]
struct RequestFrame<'a> {
    r#type: &'static str,
    id: &'a str,
    method: &'static str,
    params: serde_json::Value,
}

/// what `Outgoing` records of each request it writes, for the allowlist
/// tests (section 4, the test): the method and the params' top-level keys.
#[cfg(test)]
pub type Tap = std::sync::Arc<std::sync::Mutex<Vec<(String, Vec<String>)>>>;

/// the write half of the socket, owned by the connection task. `send` is
/// the only way a request reaches the gateway.
pub struct Outgoing<S> {
    sink: S,
    mode: OpenclawMode,
    #[cfg(test)]
    tap: Option<Tap>,
}

impl<S> std::fmt::Debug for Outgoing<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Outgoing")
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

impl<S> Outgoing<S>
where
    S: Sink<Message, Error = tungstenite::Error> + Unpin,
{
    pub fn new(sink: S, mode: OpenclawMode) -> Self {
        Self {
            sink,
            mode,
            #[cfg(test)]
            tap: None,
        }
    }

    #[cfg(test)]
    pub fn tapped(mut self, tap: Tap) -> Self {
        self.tap = Some(tap);
        self
    }

    /// writes one request. watch mode refuses every write before anything
    /// is encoded.
    ///
    /// # Errors
    /// watch mode, params that do not encode, or a failed socket.
    pub async fn send(&mut self, id: &str, request: &Allowed) -> Result<(), SendError> {
        let method = request.method();
        if self.mode == OpenclawMode::Watch && request.is_write() {
            return Err(SendError::Watch { method });
        }
        let params = request
            .params()
            .map_err(|source| SendError::Encode { method, source })?;
        #[cfg(test)]
        if let Some(tap) = &self.tap {
            let keys = params
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            if let Ok(mut taps) = tap.lock() {
                taps.push((method.to_owned(), keys));
            }
        }
        let frame = serde_json::to_string(&RequestFrame {
            r#type: "req",
            id,
            method,
            params,
        })
        .map_err(|source| SendError::Encode { method, source })?;
        tokio::time::timeout(WRITE_TIMEOUT, self.sink.send(Message::text(frame)))
            .await
            .map_err(|_| SendError::Stalled)??;
        Ok(())
    }

    /// a websocket ping (3.7); a control frame, not a request.
    ///
    /// # Errors
    /// the socket failed.
    pub async fn ping(&mut self, payload: &[u8]) -> Result<(), SendError> {
        tokio::time::timeout(
            WRITE_TIMEOUT,
            self.sink.send(Message::Ping(payload.to_vec().into())),
        )
        .await
        .map_err(|_| SendError::Stalled)??;
        Ok(())
    }

    /// closes with `code` and `reason` (4000 for a dead socket, 3.7); best
    /// effort, since the socket may already be gone.
    pub async fn close(&mut self, code: u16, reason: &str) {
        let frame = CloseFrame {
            code: code.into(),
            reason: reason.to_owned().into(),
        };
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
            let _ = self.sink.send(Message::Close(Some(frame))).await;
            let _ = self.sink.close().await;
        })
        .await;
    }
}

#[cfg(test)]
mod tests;
