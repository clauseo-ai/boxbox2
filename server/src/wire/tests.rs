//! round trips: each contract 2 shape read from the json the spec gives it
//! and written back to the same json, so the names on the wire are the
//! ones `docs/agents.md` documents.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::*;

/// `value` decodes as `T`, encodes back to the same json, and decodes
/// again to an equal value.
fn round_trip<T>(value: &Value) -> T
where
    T: DeserializeOwned + Serialize + PartialEq + std::fmt::Debug,
{
    let typed: T = serde_json::from_value(value.clone()).unwrap();
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(&back, value, "re-encoded differently");
    let again: T = serde_json::from_value(back).unwrap();
    assert_eq!(again, typed);
    typed
}

fn connection() -> Value {
    json!({
        "name": "vm-b", "url": "wss://vm-b.example:18789", "origin": "config",
        "since": 1_700_000_000_000_i64, "lastError": null, "connects": 2,
        "version": "2026.10.1", "pinned": "2026.10.1", "untested": false,
        "protocol": 3, "refused": null, "contract": null, "contractMatches": null,
        "frames": {"decoded": 10, "undecodable": 0, "duplicates": 1},
        "memory": null, "cursor": null
    })
}

#[test]
fn an_agent_carries_its_label_mark_connection_capabilities_and_runs() {
    let agent = round_trip::<Agent>(&json!({
        "key": "vm-b-main",
        "label": {"name": "assistant", "source": "openclaw", "machine": "vm-b"},
        "kind": "assistant", "source": "openclaw", "mark": "round", "palette": "coral",
        "status": "syncing",
        "connection": connection(),
        "capabilities": serde_json::to_value(Capabilities::default()).unwrap(),
        "runs": {"unseen": 2, "items": [
            {"thread": "oc_abc", "name": "heartbeat", "at": 5.0, "preview": "all good"},
            {"thread": "oc_def", "at": 6.0, "preview": "the report is ready"}
        ]}
    }));
    assert_eq!(agent.mark, Mark::Round);
    assert_eq!(agent.label.source, LabelSource::Openclaw);
}

#[test]
fn a_cmx2_agent_has_no_label_name_and_a_refused_one_says_why() {
    let mut refused = connection();
    refused["refused"] = json!("protocol");
    refused["lastError"] = json!("this gateway speaks protocol 4; boxbox speaks 3");
    let agent = round_trip::<Agent>(&json!({
        "key": "vm-a",
        "label": {"source": "cmx", "machine": "vm-a"},
        "kind": "coding", "source": "cmx2", "mark": "square", "palette": null,
        "status": "refused",
        "connection": refused,
        "capabilities": serde_json::to_value(Capabilities::cmx2()).unwrap(),
        "runs": null
    }));
    assert_eq!(agent.connection.refused, Some(Refusal::Protocol));
    assert!(agent.label.name.is_none());
}

#[test]
fn cmx2_capabilities_are_everything_cmx2_does_today() {
    let caps = round_trip::<Capabilities>(&json!({
        "places": true, "worktree": true, "terminal": true, "review": true,
        "compact": true, "queue": true, "steer": true, "model": true,
        "reasoning": {"word": "effort", "levels": ["low", "medium", "high", "xhigh", "max"]},
        "approvals": true, "questions": true,
        "attachments": {
            "kinds": [
                "image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif",
                "application/pdf", "text/*", "application/json"
            ],
            "maxBytes": 9_437_184, "maxCount": 4
        },
        "voice": {"notes": false, "replies": false},
        "quotes": false, "reactions": false, "threads": true, "archive": true, "fork": true,
        "commands": true, "files": true, "shell": true, "history": true,
        "subagents": true, "spend": true, "origins": false, "admin": true, "btw": true
    }));
    assert_eq!(caps, Capabilities::cmx2());
    assert!(caps.has(Capability::Btw));
    assert!(caps.has(Capability::Terminal));
    assert!(!caps.has(Capability::Reactions));
    assert!(!caps.has(Capability::Voice));
}

#[test]
fn btw_is_left_out_when_false_so_a_row_persisted_before_it_reads_and_writes_the_same() {
    let before = serde_json::to_value(Capabilities::default()).unwrap();
    assert!(before.get("btw").is_none());
    let read: Capabilities = serde_json::from_value(before.clone()).unwrap();
    assert!(!read.btw && !read.has(Capability::Btw));
    assert_eq!(serde_json::to_value(read).unwrap(), before);
    assert_eq!(json!(Capability::Btw), json!("btw"));
}

#[test]
fn a_btw_round_trips_with_its_times_flat_and_absent_fields_left_out() {
    let full = round_trip::<Btw>(&json!({
        "id": "btw_1", "question": "why?", "answer": "because", "status": "done",
        "afterMessageID": "msg_1", "created": 1.0, "completed": 2.0, "dismissed": 3.0,
        "promotedMessageID": "msg_2", "model": "anthropic/opus",
        "tokens": {"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4}, "cost": 0.5
    }));
    assert!(full.status.settled());
    let bare = round_trip::<Btw>(&json!({
        "id": "btw_2", "question": "q", "answer": "", "status": "running", "created": 1.0
    }));
    assert!(!bare.status.settled());
    round_trip::<Btw>(&json!({
        "id": "btw_3", "question": "q", "answer": "par", "status": "error",
        "error": "the daemon restarted before it answered", "created": 1.0
    }));
    round_trip::<BtwPromoted>(&json!({"messageID": "msg_2"}));
}

#[test]
fn the_btw_changes_are_transcript_entries_named_as_the_spec_names_them() {
    let btw =
        json!({"id": "btw_1", "question": "q", "answer": "", "status": "running", "created": 1.0});
    let whole = round_trip::<JournalEntry>(&json!({
        "seq": 7, "type": "btw", "key": "vm-a:ses_1", "upstream": 3, "btw": btw
    }));
    assert_eq!(whole.change.kind(), "btw");
    assert_eq!(whole.change.transcript_key(), Some("vm-a:ses_1"));
    let delta = round_trip::<JournalEntry>(&json!({
        "seq": 8, "type": "btw.delta", "key": "vm-a:ses_1", "btwID": "btw_1", "delta": "he", "offset": 0
    }));
    assert_eq!(delta.change.kind(), "btw.delta");
    assert_eq!(delta.change.transcript_key(), Some("vm-a:ses_1"));
    // an offset boxbox does not know is absent, never null
    round_trip::<JournalEntry>(&json!({
        "seq": 9, "type": "btw.delta", "key": "vm-a:ses_1", "btwID": "btw_1", "delta": "llo"
    }));
}

#[test]
fn a_capability_is_named_on_the_wire_as_the_spec_names_it() {
    assert_eq!(json!(Capability::Terminal), json!("terminal"));
    assert_eq!(json!(Capability::Subagents), json!("subagents"));
    let refusal = Unsupported::new("cmx · vm-a", Capability::Terminal);
    assert_eq!(
        json!(refusal),
        json!({"error": "unsupported", "capability": "terminal", "message": "cmx · vm-a has no terminal"})
    );
}

fn thread_json() -> Value {
    json!({
        "key": "vm-a:ses_1", "agent": "vm-a", "id": "ses_1",
        "title": "fix the build", "created": 1.0, "updated": 2.0,
        "parent": "ses_0",
        "place": {"root": "/w/app", "directory": "/w/app-wt", "name": "app"},
        "activity": {"state": "parked", "agents": 1, "jobs": 2, "since": 3.0},
        "queued": 1,
        "model": "anthropic/opus", "effort": "high",
        "context": {"used": 1000, "limit": 200_000, "compactAt": 180_000},
        "cost": 0.5,
        "vcs": {"branch": "main", "dirty": true},
        "changes": {"additions": 3, "deletions": 1, "files": 2},
        "agents": 1, "processes": 2,
        "tail": [{"partID": "prt_1", "messageID": "msg_1", "kind": "image", "role": "user", "text": "photo.png"}],
        "needs": [],
        "read": null
    })
}

#[test]
fn a_cmx2_thread_has_a_place_and_no_said_generation_sends_or_origin() {
    let thread = round_trip::<Thread>(&thread_json());
    assert_eq!(thread.tail[0].kind, TailKind::Image);
    assert!(thread.said.is_none() && thread.generation.is_none() && thread.sends.is_none());
}

#[test]
fn an_assistant_thread_carries_said_generation_origin_sends_and_a_failed_run() {
    let mut value = thread_json();
    let object = value.as_object_mut().unwrap();
    object.remove("place");
    object.remove("parent");
    object.insert("said".into(), json!(9.0));
    object.insert("generation".into(), json!("g1"));
    object.insert(
        "origin".into(),
        json!({"kind": "channel", "name": "whatsapp"}),
    );
    object.insert(
        "activity".into(),
        json!({"state": "failed", "message": "the model timed out"}),
    );
    object.insert(
        "sends".into(),
        json!([{"clientID": "c1", "state": "uncertain", "at": 4.0}]),
    );
    object.insert("browseOnly".into(), json!(true));
    object.insert("cleared".into(), json!(2.0));
    let thread = round_trip::<Thread>(&value);
    assert_eq!(
        thread.origin,
        Some(Origin::Channel {
            name: "whatsapp".into()
        })
    );
    assert!(thread.browse_only);
}

#[test]
fn every_activity_state_is_tagged_on_state() {
    for value in [
        json!({"state": "idle"}),
        json!({"state": "busy", "since": 1.0}),
        json!({"state": "retry", "attempt": 2, "message": "rate limited", "next": 5.0, "since": 1.0}),
        json!({"state": "parked", "agents": 0, "jobs": 1}),
        json!({"state": "failed", "message": "boom", "since": 2.0}),
    ] {
        round_trip::<Activity>(&value);
    }
}

#[test]
fn a_message_carries_its_client_id_quote_reactions_and_origin() {
    let message = round_trip::<Message>(&json!({
        "id": "mAbc", "role": "user", "created": 1.0, "completed": 2.0, "position": 7,
        "clientID": "c1", "queued": true, "steer": true, "finish": "aborted",
        "error": {"message": "cut off"}, "model": "m", "effort": "low", "cost": 0.1,
        "sender": "a friend",
        "origin": {"kind": "scheduled", "name": "heartbeat"},
        "quote": {"message": null, "sender": "you", "preview": null, "glyph": "audio", "durationMs": 4200},
        "reactions": [{"emoji": "x", "by": "you"}, {"emoji": "y", "by": "agent"}]
    }));
    assert_eq!(message.role, Role::User);
    assert_eq!(message.quote.unwrap().glyph, Glyph::Audio);
    round_trip::<Message>(&json!({"id": "msg_1", "role": "assistant", "created": 1.0}));
}

#[test]
fn every_part_kind_round_trips_with_its_type() {
    let parts = [
        json!({"type": "text", "id": "p1", "messageID": "m1", "at": {"step": 0, "index": 1},
               "text": "hi", "streaming": true, "time": {"start": 1.0}, "synthetic": true,
               "notice": true, "mail": {"kind": "report", "from": "/root/a", "fromID": "ses_2"}}),
        json!({"type": "reasoning", "id": "p2", "messageID": "m1", "at": null, "text": "hmm"}),
        json!({"type": "tool", "id": "p3", "messageID": "m1", "at": null, "callID": "call_1",
               "tool": "bash", "family": "shell",
               "state": {"status": "completed", "input": {"command": "ls"}, "output": "a",
                         "title": "ls", "metadata": {"exit": 0}, "time": {"start": 1.0, "end": 2.0},
                         "attachments": [{"type": "file", "id": "p9", "messageID": "m1", "at": null,
                                          "mime": "text/plain", "filename": "a.txt",
                                          "url": "data:text/plain;base64,YQ==", "flavour": "generated"}],
                         "attachmentsDropped": 1}}),
        json!({"type": "file", "id": "p4", "messageID": "m1", "at": null, "mime": "application/pdf",
               "filename": "a.pdf", "size": 10, "media": {"id": null, "state": "pending"},
               "flavour": "attached"}),
        json!({"type": "image", "id": "p5", "messageID": "m1", "at": null, "mime": "image/png",
               "filename": "a.png", "url": "data:image/png;base64,AA==", "width": 2, "height": 3,
               "alt": "a dot", "flavour": "attached"}),
        json!({"type": "audio", "id": "p6", "messageID": "m1", "at": null, "mime": "audio/mp4",
               "media": {"id": "ab", "state": "ready"}, "durationMs": 3000, "waveform": [0, 128, 255],
               "flavour": "voice", "spoken": "hello", "transcript": {"text": "hello", "lang": "en"}}),
        json!({"type": "compaction", "id": "p7", "messageID": "m1", "at": null, "auto": true, "overflow": false}),
        json!({"type": "marker", "id": "p8", "messageID": "m1", "at": null, "marker": "step-finish", "cost": 0.2}),
    ];
    let kinds: Vec<String> = parts
        .iter()
        .map(|p| round_trip::<Part>(p).kind().to_owned())
        .collect();
    assert_eq!(
        kinds,
        [
            "text",
            "reasoning",
            "tool",
            "file",
            "image",
            "audio",
            "compaction",
            "marker"
        ]
    );
}

#[test]
fn a_part_of_a_kind_this_build_does_not_know_is_kept_whole() {
    let value = json!({"type": "hologram", "id": "p1", "messageID": "m1", "depth": 3});
    let part = round_trip::<Part>(&value);
    let Part::Unknown(unknown) = &part else {
        panic!("not unknown: {part:?}");
    };
    assert_eq!(
        (
            unknown.kind.as_str(),
            unknown.id.as_str(),
            unknown.message_id.as_str()
        ),
        ("hologram", "p1", "m1")
    );
}

#[test]
fn a_known_kind_whose_fields_do_not_fit_is_kept_as_unknown() {
    let value = json!({"type": "tool", "id": "p1", "messageID": "m1", "tool": "bash"});
    let part = round_trip::<Part>(&value);
    assert!(matches!(part, Part::Unknown(_)));
    assert_eq!(part.kind(), "tool");
}

#[test]
fn an_ask_carries_its_options_and_the_blast_radius_it_was_told() {
    let ask = round_trip::<Ask>(&json!({
        "key": "vm-b-main:oc_1", "agent": "vm-b-main", "id": "a1", "thread": "vm-b-main:oc_1",
        "kind": "permission", "created": 1.0, "expires": 60.0,
        "tool": {"messageID": "m1", "callID": "c1"},
        "permission": {
            "title": "send", "patterns": ["a friend"], "always": [],
            "options": [
                {"id": "once", "label": "allow once"},
                {"id": "always", "label": "always allow", "lasting": true},
                {"id": "reject", "label": "reject"}
            ],
            "risk": "high", "warning": "this sends a message", "detail": "to a friend",
            "scope": ["recipients: 1"]
        }
    }));
    assert!(ask.permission.unwrap().options[1].lasting);
    round_trip::<Ask>(&json!({
        "key": "vm-a:ses_1", "agent": "vm-a", "id": "q1", "thread": "vm-a:ses_1",
        "kind": "question",
        "questions": [{"question": "which?", "header": "pick", "multiple": false, "custom": true,
                       "options": [{"label": "a", "description": "the first"}, {"label": "b"}]}]
    }));
}

#[test]
fn a_settle_says_how_and_by_whom() {
    round_trip::<AskSettled>(&json!({
        "agent": "vm-a", "id": "a1", "outcome": "answered", "option": "once",
        "by": {"kind": "device", "name": "phone", "device": "d1"}, "at": 5.0
    }));
    round_trip::<AskSettled>(&json!({
        "agent": "vm-a", "id": "a1", "outcome": "cancelled", "reason": "the gateway restarted",
        "by": {"kind": "system"}, "at": 5.0
    }));
}

#[test]
fn sends_starts_answers_and_their_answers_round_trip() {
    round_trip::<Send>(&json!({
        "clientID": "c1", "text": "hi",
        "attachments": [{"media": "ab", "transcript": {"text": "hi"}}],
        "quote": "mAbc", "model": "m", "effort": "high", "generation": "g1"
    }));
    let start = round_trip::<Start>(&json!({
        "clientID": "c2", "text": "start", "attachments": [], "place": "/w/app", "worktree": true
    }));
    assert!(start.worktree);
    round_trip::<Accepted>(&json!({"state": "checking"}));
    round_trip::<Accepted>(&json!({"state": "accepted", "message": "msg_1"}));
    round_trip::<Born>(&json!({"key": "vm-a:ses_9", "thread": "ses_9"}));
    round_trip::<AnswerBody>(&json!({
        "device": "d1", "deviceClass": "iphone", "clientID": "c3", "answers": [["a"], ["b", "c"]]
    }));
    round_trip::<AnswerBody>(&json!({
        "device": "d1", "deviceClass": "iphone", "clientID": "c4", "reject": true
    }));
}

#[test]
fn every_contract_2_change_is_tagged_with_its_seq_first() {
    let changes = [
        json!({"seq": 1, "type": "agent.removed", "agent": "vm-b-main"}),
        json!({"seq": 2, "type": "thread", "thread": thread_json()}),
        json!({"seq": 3, "type": "thread.removed", "key": "vm-a:ses_1"}),
        json!({"seq": 4, "type": "thread.reset", "key": "vm-a:ses_1"}),
        json!({"seq": 5, "type": "ask.settled", "agent": "vm-a", "id": "a1", "outcome": "expired", "at": 1.0}),
        json!({"seq": 6, "type": "order", "keys": ["vm-a:ses_1", "vm-b-main:runs"]}),
        json!({"seq": 7, "type": "message", "key": "vm-a:ses_1", "upstream": 4,
               "message": {"id": "msg_1", "role": "user", "created": 1.0}}),
        json!({"seq": 8, "type": "part", "key": "vm-a:ses_1", "upstream": null,
               "part": {"type": "text", "id": "p1", "messageID": "msg_1", "at": null, "text": "hi"}}),
        json!({"seq": 9, "type": "delta", "key": "vm-a:ses_1", "messageID": "msg_1", "partID": "p1",
               "field": "text", "delta": " there", "offset": 2}),
        json!({"seq": 10, "type": "message.removed", "key": "vm-a:ses_1", "upstream": 5, "messageID": "msg_1"}),
        json!({"seq": 11, "type": "reactions", "key": "vm-a:ses_1", "messageID": "msg_1",
               "reactions": [{"emoji": "x", "by": "agent"}]}),
        json!({"seq": 12, "type": "thread.patch", "key": "vm-a:ses_1",
               "set": {"updated": 3.0, "activity": {"state": "busy", "since": 3.0}},
               "unset": ["cost"],
               "tail": {"drop": 1, "put": [[11, {"partID": "p1", "messageID": "msg_1",
                        "kind": "text", "role": "assistant", "text": "reading"}]]}}),
        json!({"seq": 13, "type": "order.patch", "ops": [["-", 4, 1], ["+", 0, ["vm-a:ses_2"]]]}),
        json!({"seq": 14, "type": "part", "key": "vm-a:ses_1", "upstream": 9,
               "part": {"type": "text", "id": "p1", "messageID": "msg_1", "at": null,
                        "textOf": {"length": 41, "hash": "1c0e9b7f"}}}),
    ];
    for change in &changes {
        round_trip::<JournalEntry>(change);
    }
}

#[test]
fn hello_says_protocol_3_and_reset_carries_the_neutral_fleet() {
    assert_eq!(PROTOCOL, 3);
    round_trip::<Control>(&json!({
        "type": "hello", "protocol": PROTOCOL, "epoch": "3f9a0c21b7d4", "head": 48211,
        "build": "dev", "stream": "9c1f0e7a5b2d4c66a1e3f00b7d2c9a41",
        "interest": {"thread": "vm-a:ses_2", "under": [], "holds": []}
    }));
    round_trip::<Control>(&json!({"type": "caught", "seq": 48240}));
    round_trip::<Control>(&json!({"type": "thread.stale", "key": "vm-a:ses_8"}));
    round_trip::<Control>(&json!({
        "type": "catchup", "entries": [{"seq": 48236, "type": "delta", "key": "vm-a:ses_7",
        "messageID": "msg_4", "partID": "prt_7_4_0", "field": "text",
        "delta": " and the build passes.", "offset": 112}]
    }));
    round_trip::<Control>(&json!({
        "type": "interest", "ask": 3, "thread": "vm-a:ses_7", "under": ["vm-a:ses_2"],
        "holds": ["vm-a:ses_8"], "seq": 48240, "stale": ["vm-a:ses_8"]
    }));
    round_trip::<InterestPost>(&json!({
        "ask": 4, "thread": "vm-a:ses_7", "under": ["vm-a:ses_2"], "holds": ["vm-a:ses_8"],
        "since": {"vm-a:ses_7": 48190}
    }));
    round_trip::<Control>(&json!({
        "type": "reset", "seq": 0, "epoch": "e2", "reason": "epoch",
        "fleet": {"agents": [], "threads": [thread_json()], "asks": [], "order": ["vm-a:ses_1"]}
    }));
}

#[test]
fn every_shape_has_a_schema_the_document_can_hold() {
    use utoipa::PartialSchema;
    let schemas = [
        Agent::schema(),
        Capabilities::schema(),
        Thread::schema(),
        Message::schema(),
        Part::schema(),
        Ask::schema(),
        AskSettled::schema(),
        Send::schema(),
        Start::schema(),
        Accepted::schema(),
        Born::schema(),
        AnswerBody::schema(),
        Unsupported::schema(),
        Change::schema(),
        Control::schema(),
        Fleet::schema(),
        StreamFrame::schema(),
        OrderOp::schema(),
        InterestPost::schema(),
    ];
    for schema in schemas {
        let json = serde_json::to_value(&schema).unwrap();
        assert!(json.is_object(), "{json}");
    }
}
