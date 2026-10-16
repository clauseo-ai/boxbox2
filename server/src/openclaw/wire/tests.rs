//! the allowlist, proven: `Allowed` names exactly section 4's methods,
//! the narrowed requests can only carry section 4's fields, watch mode
//! refuses every write before it reaches the socket, and every patch and
//! create boxbox can build classifies as `operator.write` under the
//! gateway's own rule.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use futures_util::sink;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{self, Message};

use super::*;

#[allow(
    clippy::needless_pass_by_value,
    reason = "the samples are built inline"
)]
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{value}: {e}"))
}

fn full_send() -> ChatSend {
    ChatSend {
        session_key: "agent:main:main".into(),
        agent_id: "main".into(),
        session_id: Some("s-1".into()),
        expected_leaf_entry_id: Some("leaf-1".into()),
        message: "/config get".into(),
        idempotency_key: "c-1".into(),
        reply_to_id: Some("m-1".into()),
        attachments: vec![decode(
            json!({"type": "image", "mimeType": "image/png", "content": "aGk="}),
        )],
    }
}

fn patches() -> Vec<SessionsPatch> {
    [
        PatchChange::Model("mock-openai/gpt".into()),
        PatchChange::ThinkingLevel("high".into()),
        PatchChange::Unread {
            unread: false,
            expected_marked_unread_at: Some(1.0),
        },
        PatchChange::Unread {
            unread: true,
            expected_marked_unread_at: None,
        },
        PatchChange::Archived(true),
    ]
    .into_iter()
    .map(|change| SessionsPatch {
        key: "agent:main:dashboard:x".into(),
        agent_id: "main".into(),
        expected_session_id: "s-1".into(),
        change,
    })
    .collect()
}

fn full_create() -> SessionsCreate {
    SessionsCreate {
        agent_id: "main".into(),
        idempotency_key: "t-1".into(),
        key: "dashboard:t-1".into(),
        model: Some("mock-openai/gpt".into()),
        thinking_level: Some("low".into()),
    }
}

/// one of every request boxbox can make.
fn every_request() -> Vec<Allowed> {
    let list = || Box::new(decode::<SessionsListParams>(json!({"limit": 100})));
    let mut all = vec![
        Allowed::Connect(Box::new(decode(json!({
            "minProtocol": 4, "maxProtocol": 4,
            "client": {"id": "gateway-client", "mode": "backend", "version": "0", "platform": "darwin"}
        })))),
        Allowed::SessionsList(list()),
        Allowed::SessionsSubscribe(list()),
        Allowed::SessionsMessagesSubscribe(decode(json!({"key": "agent:main:main"}))),
        Allowed::SessionsMessagesUnsubscribe(decode(json!({"key": "agent:main:main"}))),
        Allowed::SessionsCreate(full_create()),
        Allowed::ChatSend(Box::new(full_send())),
        Allowed::ChatAbort(decode(json!({"sessionKey": "agent:main:main"}))),
        Allowed::ChatHistory(decode(json!({"sessionKey": "agent:main:main"}))),
        Allowed::ChatMessageGet(MessageGet {
            session_key: "agent:main:main".into(),
            agent_id: "main".into(),
            message_id: "m-1".into(),
        }),
        Allowed::AgentsList,
        Allowed::ExecApprovalList,
        Allowed::PluginApprovalList,
        Allowed::OpenclawApprovalList,
        Allowed::ApprovalGet(decode(json!({"id": "a-1"}))),
        Allowed::ApprovalResolve(decode(
            json!({"id": "a-1", "kind": "exec", "decision": "allow-once"}),
        )),
        Allowed::QuestionList(decode(json!({}))),
        Allowed::QuestionGet(decode(json!({"id": "q-1"}))),
        Allowed::QuestionResolve(decode(json!({"id": "q-1", "answers": {"answers": {}}}))),
        Allowed::ArtifactsDownload(decode(
            json!({"sessionKey": "agent:main:main", "artifactId": "x"}),
        )),
        Allowed::SessionReactionsSet(decode(
            json!({"sessionKey": "agent:main:main", "messageId": "m", "emoji": "x"}),
        )),
        Allowed::SessionReactionsList(decode(json!({"sessionKey": "agent:main:main"}))),
        Allowed::ModelsList(decode(json!({}))),
    ];
    all.extend(patches().into_iter().map(Allowed::SessionsPatch));
    all
}

/// no wildcard: a new variant fails to compile here until section 4's
/// table, `METHODS` and this test change with it.
fn variant_is_known(request: &Allowed) -> bool {
    match request {
        Allowed::Connect(_)
        | Allowed::SessionsList(_)
        | Allowed::SessionsSubscribe(_)
        | Allowed::SessionsMessagesSubscribe(_)
        | Allowed::SessionsMessagesUnsubscribe(_)
        | Allowed::SessionsCreate(_)
        | Allowed::SessionsPatch(_)
        | Allowed::ChatSend(_)
        | Allowed::ChatAbort(_)
        | Allowed::ChatHistory(_)
        | Allowed::ChatMessageGet(_)
        | Allowed::AgentsList
        | Allowed::ExecApprovalList
        | Allowed::PluginApprovalList
        | Allowed::OpenclawApprovalList
        | Allowed::ApprovalGet(_)
        | Allowed::ApprovalResolve(_)
        | Allowed::QuestionList(_)
        | Allowed::QuestionGet(_)
        | Allowed::QuestionResolve(_)
        | Allowed::ArtifactsDownload(_)
        | Allowed::SessionReactionsSet(_)
        | Allowed::SessionReactionsList(_)
        | Allowed::ModelsList(_) => true,
    }
}

fn keys(request: &Allowed) -> BTreeSet<String> {
    request
        .params()
        .expect("params encode")
        .as_object()
        .expect("params are an object")
        .keys()
        .cloned()
        .collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn allowed_names_exactly_the_section_4_methods() {
    let requests = every_request();
    assert!(requests.iter().all(variant_is_known));
    let sent: BTreeSet<&str> = requests.iter().map(Allowed::method).collect();
    let table: BTreeSet<&str> = METHODS.into_iter().collect();
    assert_eq!(sent, table);
    assert_eq!(table.len(), METHODS.len(), "no method is listed twice");
    let never = [
        "config.get",
        "exec.approvals.set",
        "update.run",
        "wizard.start",
        "device.pair.approve",
        "node.invoke",
        "gateway.restart.request",
        "sessions.reset",
        "sessions.delete",
        "sessions.compact",
        "sessions.rewind",
        "sessions.steer",
        "sessions.send",
        "chat.inject",
        "approval.history",
        "question.waitAnswer",
        "agents.create",
        "agent.identity.get",
        "cron.add",
        "tts.speak",
        "talk.start",
    ];
    for method in never {
        assert!(!table.contains(method), "{method} is on the never list");
    }
}

#[test]
fn the_write_methods_are_exactly_the_ones_watch_mode_names() {
    let writes: BTreeSet<&str> = every_request()
        .iter()
        .filter(|r| r.is_write())
        .map(Allowed::method)
        .collect();
    assert_eq!(writes, WRITE_METHODS.into_iter().collect());
}

#[test]
fn chat_send_carries_only_its_fields_with_followup_and_suppression_forced() {
    let full = Allowed::ChatSend(Box::new(full_send()));
    assert_eq!(
        keys(&full),
        set(&[
            "sessionKey",
            "agentId",
            "sessionId",
            "expectedLeafEntryId",
            "message",
            "idempotencyKey",
            "queueMode",
            "replyToId",
            "attachments",
            "suppressCommandInterpretation",
        ])
    );
    let minimal = Allowed::ChatSend(Box::new(ChatSend {
        session_id: None,
        expected_leaf_entry_id: None,
        reply_to_id: None,
        attachments: Vec::new(),
        ..full_send()
    }));
    let params = minimal.params().expect("params encode");
    assert_eq!(params["queueMode"], "followup");
    assert_eq!(params["suppressCommandInterpretation"], true);
    assert_eq!(
        keys(&minimal),
        set(&[
            "sessionKey",
            "agentId",
            "message",
            "idempotencyKey",
            "queueMode",
            "suppressCommandInterpretation",
        ])
    );
}

#[test]
fn a_patch_carries_its_envelope_and_exactly_one_change() {
    let envelope = ["key", "agentId", "expectedSessionId"];
    let expected = [
        vec!["model"],
        vec!["thinkingLevel"],
        vec!["unread", "expectedMarkedUnreadAt"],
        vec!["unread"],
        vec!["archived"],
    ];
    for (patch, change) in patches().into_iter().zip(expected) {
        let mut wanted = set(&envelope);
        wanted.extend(change.iter().map(|s| (*s).to_owned()));
        assert_eq!(keys(&Allowed::SessionsPatch(patch)), wanted);
    }
}

#[test]
fn a_create_carries_only_its_fields() {
    assert_eq!(
        keys(&Allowed::SessionsCreate(full_create())),
        set(&["agentId", "idempotencyKey", "key", "model", "thinkingLevel"])
    );
    let bare = SessionsCreate {
        model: None,
        thinking_level: None,
        ..full_create()
    };
    assert_eq!(
        keys(&Allowed::SessionsCreate(bare)),
        set(&["agentId", "idempotencyKey", "key"])
    );
}

#[test]
fn a_message_get_asks_for_exactly_one_million_characters() {
    let request = every_request()
        .into_iter()
        .find(|r| r.method() == "chat.message.get")
        .expect("one message get");
    assert_eq!(
        keys(&request),
        set(&["sessionKey", "agentId", "messageId", "maxChars"])
    );
    assert_eq!(request.params().expect("encodes")["maxChars"], 1_000_000);
}

#[test]
fn the_empty_param_methods_send_an_empty_object() {
    for request in [
        Allowed::AgentsList,
        Allowed::ExecApprovalList,
        Allowed::PluginApprovalList,
        Allowed::OpenclawApprovalList,
    ] {
        assert_eq!(request.params().expect("encodes"), json!({}));
    }
}

/// `src/shared/session-method-scopes-base.ts:83-163` at the pin, in rust:
/// a patch is `operator.write` only when every key is an envelope field or
/// a write-scope mutation (and it sets no full permission mode or sandbox);
/// a create is `operator.admin` when incognito, or it names `execNode`,
/// `toolOverrides` or a full permission mode.
fn gateway_scope(method: &str, params: &Value) -> &'static str {
    const PATCH_MUTATIONS: [&str; 16] = [
        "label",
        "autoLabel",
        "icon",
        "color",
        "category",
        "boardFace",
        "boardPresentation",
        "pinned",
        "archived",
        "snoozedUntil",
        "unread",
        "model",
        "agentRuntime",
        "thinkingLevel",
        "fastMode",
        "permissionMode",
    ];
    const PATCH_ENVELOPE: [&str; 6] = [
        "key",
        "agentId",
        "expectedSessionId",
        "expectedLifecycleRevision",
        "expectedPermissionMode",
        "expectedMarkedUnreadAt",
    ];
    let object = params.as_object().expect("params are an object");
    match method {
        "sessions.patch" => {
            if object.get("permissionMode") == Some(&json!("full"))
                || object.contains_key("sandboxMode")
            {
                return "operator.admin";
            }
            if object.keys().all(|k| {
                PATCH_ENVELOPE.contains(&k.as_str()) || PATCH_MUTATIONS.contains(&k.as_str())
            }) {
                "operator.write"
            } else {
                "operator.admin"
            }
        }
        "sessions.create" => {
            let incognito_key = |field: &str| {
                object.get(field).and_then(Value::as_str).is_some_and(|k| {
                    // `^agent:[^:]+:(dashboard|subagent|internal-session-effects):incognito-[^:]+$`
                    let parts: Vec<&str> = k.trim().split(':').collect();
                    parts.len() == 4
                        && parts[0] == "agent"
                        && matches!(
                            parts[2],
                            "dashboard" | "subagent" | "internal-session-effects"
                        )
                        && parts[3].starts_with("incognito-")
                })
            };
            if object.get("incognito") == Some(&json!(true))
                || incognito_key("key")
                || incognito_key("parentSessionKey")
                || object.contains_key("execNode")
                || object.contains_key("toolOverrides")
                || object.get("permissionMode") == Some(&json!("full"))
            {
                "operator.admin"
            } else {
                "operator.write"
            }
        }
        other => panic!("{other} is not a dynamic-scope method"),
    }
}

#[test]
fn every_patch_and_create_boxbox_builds_is_operator_write() {
    for request in every_request()
        .iter()
        .filter(|r| matches!(r.method(), "sessions.patch" | "sessions.create"))
    {
        let params = request.params().expect("encodes");
        assert_eq!(
            gateway_scope(request.method(), &params),
            "operator.write",
            "{} {params}",
            request.method()
        );
    }
    // the rule itself bites: one admin-only field makes a patch admin
    assert_eq!(
        gateway_scope("sessions.patch", &json!({"key": "k", "execHost": "node"})),
        "operator.admin"
    );
}

type Written = Arc<Mutex<Vec<String>>>;

fn capturing_sink(written: Written) -> impl Sink<Message, Error = tungstenite::Error> + Unpin {
    Box::pin(sink::unfold(
        written,
        |written, message: Message| async move {
            if let Message::Text(text) = message
                && let Ok(mut frames) = written.lock()
            {
                frames.push(text.to_string());
            }
            Ok::<_, tungstenite::Error>(written)
        },
    ))
}

#[tokio::test]
async fn every_frame_on_the_wire_is_an_allowlisted_method_with_its_listed_keys() {
    let written: Written = Arc::default();
    let tap: Tap = Arc::default();
    let mut outgoing = Outgoing::new(capturing_sink(Arc::clone(&written)), OpenclawMode::Full)
        .tapped(Arc::clone(&tap));
    for (n, request) in every_request().iter().enumerate() {
        outgoing
            .send(&n.to_string(), request)
            .await
            .expect("a full connection sends it");
    }
    let frames = written.lock().expect("frames").clone();
    assert_eq!(frames.len(), every_request().len());
    for (n, frame) in frames.iter().enumerate() {
        let frame: Value = serde_json::from_str(frame).expect("a frame is json");
        assert_eq!(frame["type"], "req");
        assert_eq!(frame["id"], n.to_string());
        let method = frame["method"].as_str().expect("a method");
        assert!(METHODS.contains(&method), "{method} is allowlisted");
        let sent: BTreeSet<String> = frame["params"]
            .as_object()
            .expect("params")
            .keys()
            .cloned()
            .collect();
        let narrowed: Option<&[&str]> = match method {
            "chat.send" => Some(&[
                "sessionKey",
                "agentId",
                "sessionId",
                "expectedLeafEntryId",
                "message",
                "idempotencyKey",
                "queueMode",
                "replyToId",
                "attachments",
                "suppressCommandInterpretation",
            ]),
            "sessions.patch" => Some(&[
                "key",
                "agentId",
                "expectedSessionId",
                "model",
                "thinkingLevel",
                "unread",
                "expectedMarkedUnreadAt",
                "archived",
            ]),
            "sessions.create" => {
                Some(&["agentId", "idempotencyKey", "key", "model", "thinkingLevel"])
            }
            "chat.message.get" => Some(&["sessionKey", "agentId", "messageId", "maxChars"]),
            _ => None,
        };
        if let Some(allowed) = narrowed {
            assert!(sent.is_subset(&set(allowed)), "{method} sent {sent:?}");
        }
        if method == "chat.send" {
            assert_eq!(frame["params"]["queueMode"], "followup");
            assert_eq!(frame["params"]["suppressCommandInterpretation"], true);
        }
    }
    let tapped = tap.lock().expect("tap").clone();
    assert_eq!(tapped.len(), frames.len(), "the tap sees every frame");
}

#[tokio::test]
async fn watch_mode_refuses_every_write_before_it_reaches_the_socket() {
    let written: Written = Arc::default();
    let mut outgoing = Outgoing::new(capturing_sink(Arc::clone(&written)), OpenclawMode::Watch);
    let mut refused = BTreeSet::new();
    let mut reads = 0;
    for request in every_request() {
        match outgoing.send("1", &request).await {
            Err(SendError::Watch { method }) => {
                refused.insert(method);
            }
            Ok(()) => reads += 1,
            Err(other) => panic!("unexpected {other}"),
        }
    }
    assert_eq!(refused, WRITE_METHODS.into_iter().collect());
    assert_eq!(written.lock().expect("frames").len(), reads);
    let frames = written.lock().expect("frames").clone();
    for frame in frames {
        let frame: Value = serde_json::from_str(&frame).expect("json");
        let method = frame["method"].as_str().expect("method");
        assert!(
            !WRITE_METHODS.contains(&method),
            "{method} was written in watch mode"
        );
    }
}

/// the vendored schema, for the drift checks (2.4).
fn schema() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../vendor/openclaw/protocol.schema.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vendored schema is readable"))
        .expect("the vendored schema is json")
}

#[test]
fn openclaw_contract_every_allowlisted_method_has_the_scope_section_4_expects() {
    let schema = schema();
    let expected = [
        ("connect", "operator.admin"),
        ("sessions.list", "operator.read"),
        ("sessions.subscribe", "operator.read"),
        ("sessions.messages.subscribe", "operator.read"),
        ("sessions.messages.unsubscribe", "operator.read"),
        ("sessions.create", "dynamic"),
        ("sessions.patch", "dynamic"),
        ("chat.send", "operator.write"),
        ("chat.abort", "operator.write"),
        ("chat.history", "operator.read"),
        ("chat.message.get", "operator.read"),
        ("agents.list", "operator.read"),
        ("exec.approval.list", "operator.approvals"),
        ("plugin.approval.list", "operator.approvals"),
        ("openclaw.approval.list", "operator.approvals"),
        ("approval.get", "operator.approvals"),
        ("approval.resolve", "operator.approvals"),
        ("question.list", "operator.questions"),
        ("question.get", "operator.questions"),
        ("question.resolve", "operator.questions"),
        ("artifacts.download", "operator.read"),
        ("session.reactions.set", "operator.write"),
        ("session.reactions.list", "operator.read"),
        ("models.list", "operator.read"),
    ];
    assert_eq!(expected.len(), METHODS.len());
    for (method, scope) in expected {
        assert!(METHODS.contains(&method));
        assert_eq!(
            schema["methods"][method]["scope"], scope,
            "{method}'s scope in the vendored schema"
        );
    }
}

#[test]
fn openclaw_contract_the_narrowed_fields_and_forced_values_exist_in_the_schema() {
    let schema = schema();
    let definitions = &schema["definitions"];
    let narrowed: [(&str, &[&str]); 4] = [
        (
            "ChatSendParams",
            &[
                "sessionKey",
                "agentId",
                "sessionId",
                "expectedLeafEntryId",
                "message",
                "idempotencyKey",
                "queueMode",
                "replyToId",
                "attachments",
                "suppressCommandInterpretation",
            ],
        ),
        (
            "SessionsPatchParams",
            &[
                "key",
                "agentId",
                "expectedSessionId",
                "model",
                "thinkingLevel",
                "unread",
                "expectedMarkedUnreadAt",
                "archived",
            ],
        ),
        (
            "SessionsCreateParams",
            &["agentId", "idempotencyKey", "key", "model", "thinkingLevel"],
        ),
        (
            "ChatMessageGetParams",
            &["sessionKey", "agentId", "messageId", "maxChars"],
        ),
    ];
    for (definition, fields) in narrowed {
        let properties = definitions[definition]["properties"]
            .as_object()
            .unwrap_or_else(|| panic!("{definition} has properties"));
        for field in fields {
            assert!(properties.contains_key(*field), "{definition}.{field}");
        }
        // what boxbox drops is real: the schema offers more than the list
        // (chat.message.get is narrowed by value, its maxChars, not by field)
        if definition != "ChatMessageGetParams" {
            assert!(
                properties.len() > fields.len(),
                "{definition} offers fields boxbox never sends"
            );
        }
    }
    let queue_modes = &definitions["ChatSendParams"]["properties"]["queueMode"]["enum"];
    assert!(
        queue_modes
            .as_array()
            .is_some_and(|m| m.contains(&json!("followup"))),
        "queueMode still holds followup: {queue_modes}"
    );
    assert_eq!(
        definitions["ChatSendParams"]["properties"]["suppressCommandInterpretation"]["type"],
        "boolean"
    );
    let max = definitions["ChatMessageGetParams"]["properties"]["maxChars"]["maximum"]
        .as_u64()
        .expect("maxChars has a maximum");
    assert!(MESSAGE_GET_MAX_CHARS <= max);
    let hello = &definitions["HelloOk"]["properties"];
    for pointer in [
        "/policy/properties/attachments",
        "/server/properties/bootId",
        "/auth/properties/deviceToken",
    ] {
        assert!(hello.pointer(pointer).is_some(), "HelloOk{pointer}");
    }
}

#[test]
fn a_request_prints_its_method_and_never_its_params() {
    let connect = Allowed::Connect(Box::new(decode(json!({
        "minProtocol": 4, "maxProtocol": 4,
        "client": {"id": "gateway-client", "mode": "backend", "version": "0", "platform": "darwin"},
        "auth": {"token": "shared-secret-token", "deviceToken": "device-secret-token"}
    }))));
    let shown = format!("{connect:?}");
    assert_eq!(shown, "Allowed(connect)");
    assert!(!shown.contains("secret"));
}
