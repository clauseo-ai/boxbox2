//! the translation table, one test per domain event: a cmx2 frame in, the
//! one source event it means out. frames are written as the pinned daemon
//! writes them (`vendor/cmx2/openapi.json`).

use super::*;
use crate::cmx2::decode_frame;

fn translate(frame: &str) -> Option<SourceEvent> {
    let decoded = decode_frame(frame).unwrap();
    event(
        "desk",
        decoded.directory.as_deref(),
        &decoded.event,
        &decoded.payload,
    )
    .unwrap()
}

fn payload(kind: &str, properties: &str) -> String {
    format!(r#"{{"payload":{{"id":"e","type":"{kind}","properties":{properties}}}}}"#)
}

fn info(id: &str) -> String {
    format!(
        r#"{{"id":"{id}","parentID":"ses_0","slug":"s","projectID":"/w/app","directory":"/w/app-wt","title":"fix it","version":"0","source":"cmx2","cost":0.5,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"effort":"high","model":{{"id":"opus","providerID":"anthropic"}},"time":{{"created":1,"updated":2}}}}"#
    )
}

#[test]
fn session_created_is_a_born_thread_with_its_place_and_raw_info() {
    let frame = payload(
        "session.created",
        &format!(r#"{{"sessionID":"ses_1","info":{}}}"#, info("ses_1")),
    );
    let Some(SourceEvent::Thread { thread, born }) = translate(&frame) else {
        panic!("not a thread");
    };
    assert!(born);
    assert_eq!(thread.id, "ses_1");
    assert_eq!(thread.parent.as_deref(), Some("ses_0"));
    assert_eq!(
        thread.place,
        Some(Place {
            root: "/w/app".into(),
            directory: "/w/app-wt".into(),
            name: "app".into()
        })
    );
    assert_eq!(thread.model.as_deref(), Some("anthropic/opus"));
    assert_eq!(thread.raw.unwrap().get(), info("ses_1"));
}

#[test]
fn session_updated_is_a_thread_not_born() {
    let frame = payload(
        "session.updated",
        &format!(r#"{{"sessionID":"ses_1","info":{}}}"#, info("ses_1")),
    );
    assert!(matches!(
        translate(&frame),
        Some(SourceEvent::Thread { born: false, .. })
    ));
}

#[test]
fn a_fork_carries_where_it_came_from_apart_from_its_parent() {
    let at = info("ses_2").replace(
        r#""parentID":"ses_0","#,
        r#""forkedFrom":{"sessionID":"ses_1","messageID":"msg_9"},"#,
    );
    let thread = thread_from_json(RawValue::from_string(at).unwrap()).unwrap();
    assert_eq!(thread.parent, None, "a fork is not an agent of its source");
    assert_eq!(
        thread.forked_from,
        Some(crate::wire::ForkedFrom {
            thread: "ses_1".into(),
            message: Some("msg_9".into()),
        })
    );
    let whole = info("ses_3").replace(
        r#""parentID":"ses_0","#,
        r#""forkedFrom":{"sessionID":"ses_1"},"#,
    );
    let thread = thread_from_json(RawValue::from_string(whole).unwrap()).unwrap();
    assert_eq!(
        thread.forked_from.map(|f| (f.thread, f.message)),
        Some(("ses_1".to_owned(), None))
    );
    // an older daemon says nothing of forks: no lineage, nothing refused
    let plain = thread_from_json(RawValue::from_string(info("ses_4")).unwrap()).unwrap();
    assert_eq!(plain.forked_from, None);
    assert_eq!(plain.parent.as_deref(), Some("ses_0"));
}

#[test]
fn a_project_that_is_not_a_path_roots_the_place_at_the_directory_and_names_it_by_the_project() {
    let raw = info("ses_1").replace(r#""projectID":"/w/app""#, r#""projectID":"global""#);
    let thread = thread_from_json(RawValue::from_string(raw).unwrap()).unwrap();
    let place = thread.place.unwrap();
    assert_eq!(
        (place.root.as_str(), place.name.as_str()),
        ("/w/app-wt", "global")
    );
}

#[test]
fn session_deleted_is_thread_removed() {
    let frame = payload(
        "session.deleted",
        &format!(r#"{{"sessionID":"ses_1","info":{}}}"#, info("ses_1")),
    );
    assert!(
        matches!(translate(&frame), Some(SourceEvent::ThreadRemoved { thread }) if thread == "ses_1")
    );
}

#[test]
fn session_status_is_activity_with_retry_kept_apart_from_busy() {
    let busy = payload(
        "session.status",
        r#"{"sessionID":"ses_1","status":{"type":"busy","since":5}}"#,
    );
    assert!(matches!(
        translate(&busy),
        Some(SourceEvent::Activity { activity: Activity::Busy { since: Some(since) }, .. }) if (since - 5.0).abs() < f64::EPSILON
    ));
    // a busy status without a start leaves it absent, never 0
    let unstamped = payload(
        "session.status",
        r#"{"sessionID":"ses_1","status":{"type":"busy"}}"#,
    );
    let Some(SourceEvent::Activity { activity, .. }) = translate(&unstamped) else {
        panic!("not an activity");
    };
    assert_eq!(activity, Activity::Busy { since: None });
    assert_eq!(
        serde_json::to_string(&activity).unwrap(),
        r#"{"state":"busy"}"#
    );
    let retry = payload(
        "session.status",
        r#"{"sessionID":"ses_1","status":{"type":"retry","attempt":2,"message":"rate limited","next":9}}"#,
    );
    assert!(matches!(
        translate(&retry),
        Some(SourceEvent::Activity {
            activity: Activity::Retry { attempt: 2, .. },
            ..
        })
    ));
    let parked = payload(
        "session.status",
        r#"{"sessionID":"ses_1","status":{"type":"idle","parked":{"agents":1,"jobs":2}}}"#,
    );
    assert!(matches!(
        translate(&parked),
        Some(SourceEvent::Activity {
            activity: Activity::Parked {
                agents: 1,
                jobs: 2,
                since: None
            },
            ..
        })
    ));
    let idle = payload(
        "session.status",
        r#"{"sessionID":"ses_1","status":{"type":"idle"}}"#,
    );
    assert!(matches!(
        translate(&idle),
        Some(SourceEvent::Activity {
            activity: Activity::Idle,
            ..
        })
    ));
}

#[test]
fn session_idle_is_a_turn_ended_never_an_idle_activity() {
    let frame = payload("session.idle", r#"{"sessionID":"ses_1"}"#);
    assert!(
        matches!(translate(&frame), Some(SourceEvent::TurnEnded { thread }) if thread == "ses_1")
    );
}

#[test]
fn message_updated_is_a_message_with_its_client_id_and_model() {
    let frame = payload(
        "message.updated",
        r#"{"sessionID":"ses_1","info":{"id":"msg_1","sessionID":"ses_1","role":"user","time":{"created":3},"clientID":"c1","queued":true,"agent":"build","model":{"providerID":"anthropic","modelID":"opus"},"variant":"high"}}"#,
    );
    let Some(SourceEvent::Message {
        thread, message, ..
    }) = translate(&frame)
    else {
        panic!("not a message");
    };
    assert_eq!(thread, "ses_1");
    assert_eq!(message.role, Role::User);
    assert_eq!(message.client_id.as_deref(), Some("c1"));
    assert!(message.queued);
    assert_eq!(message.model.as_deref(), Some("anthropic/opus"));
    assert_eq!(message.effort.as_deref(), Some("high"));
}

/// a finished btw as the pinned daemon writes it in `btw.updated`.
const BTW_DONE: &str = r#"{"sessionID":"ses_1","btw":{"id":"btw_1","sessionID":"ses_1","text":"why a cache?","answer":"the reads repeat","status":"done","afterMessageID":"msg_9","time":{"created":10,"completed":12,"dismissed":13},"promotedMessageID":"msg_10","model":{"providerID":"anthropic","modelID":"opus"},"tokens":{"input":5,"output":7,"cache":{"read":100,"write":2}},"cost":0.01}}"#;

#[test]
fn btw_updated_is_the_whole_btw_with_its_times_flattened() {
    let Some(SourceEvent::Btw { thread, btw }) = translate(&payload("btw.updated", BTW_DONE))
    else {
        panic!("not a btw");
    };
    assert_eq!(thread, "ses_1");
    assert_eq!(
        serde_json::to_value(&*btw).unwrap(),
        serde_json::json!({
            "id": "btw_1",
            "question": "why a cache?",
            "answer": "the reads repeat",
            "status": "done",
            "afterMessageID": "msg_9",
            "created": 10.0,
            "completed": 12.0,
            "dismissed": 13.0,
            "promotedMessageID": "msg_10",
            "model": "anthropic/opus",
            "tokens": {"input": 5, "output": 7, "cacheRead": 100, "cacheWrite": 2},
            "cost": 0.01
        })
    );
}

#[test]
fn a_btw_is_read_loosely_and_refused_only_without_its_facts() {
    let raw = |json: &str| serde_json::value::RawValue::from_string(json.to_owned()).unwrap();
    // a running one, just asked, with odd extras: read, the extras dropped
    let running = btw(&raw(
        r#"{"id":"btw_2","text":"q","answer":"","status":"running","time":{"created":1,"completed":"soon"},"error":7,"model":"opus","tokens":[]}"#,
    ))
    .unwrap();
    assert_eq!(running.status, crate::wire::BtwStatus::Running);
    assert_eq!(
        (
            running.completed,
            running.error,
            running.model,
            running.tokens
        ),
        (None, None, None, None)
    );
    // an error keeps its words
    let failed = btw(&raw(
        r#"{"id":"btw_3","text":"q","answer":"par","status":"error","error":"the daemon restarted before it answered","time":{"created":1}}"#,
    ))
    .unwrap();
    assert_eq!(
        failed.error.as_deref(),
        Some("the daemon restarted before it answered")
    );
    // no status boxbox knows, or no question: refused
    assert!(
        btw(&raw(
            r#"{"id":"b","text":"q","status":"thinking","time":{"created":1}}"#
        ))
        .is_err()
    );
    assert!(btw(&raw(r#"{"id":"b","status":"done","time":{"created":1}}"#)).is_err());
}

#[test]
fn btw_delta_is_its_text_with_no_offset_of_its_own() {
    let frame = payload(
        "btw.delta",
        r#"{"sessionID":"ses_1","btwID":"btw_1","delta":"the "}"#,
    );
    let Some(SourceEvent::BtwDelta { thread, btw, delta }) = translate(&frame) else {
        panic!("not a btw delta");
    };
    assert_eq!(
        (thread.as_str(), btw.as_str(), delta.as_str()),
        ("ses_1", "btw_1", "the ")
    );
}

#[test]
fn a_promoted_user_message_names_its_btw() {
    let frame = payload(
        "message.updated",
        r#"{"sessionID":"ses_1","info":{"id":"msg_10","sessionID":"ses_1","role":"user","time":{"created":3},"btw":"btw_1"}}"#,
    );
    let Some(SourceEvent::Message { message, .. }) = translate(&frame) else {
        panic!("not a message");
    };
    assert_eq!(message.btw.as_deref(), Some("btw_1"));
    let plain = payload(
        "message.updated",
        r#"{"sessionID":"ses_1","info":{"id":"msg_11","sessionID":"ses_1","role":"user","time":{"created":3}}}"#,
    );
    let Some(SourceEvent::Message { message, .. }) = translate(&plain) else {
        panic!("not a message");
    };
    assert_eq!(message.btw, None);
    assert!(
        serde_json::to_value(&*message)
            .unwrap()
            .get("btw")
            .is_none()
    );
}

#[test]
fn message_part_updated_is_a_part_placed_by_its_id() {
    let frame = payload(
        "message.part.updated",
        r#"{"sessionID":"ses_1","part":{"id":"prt_ses1_0004_2","sessionID":"ses_1","messageID":"msg_1","type":"text","text":"hello"}}"#,
    );
    let Some(SourceEvent::Part { part, .. }) = translate(&frame) else {
        panic!("not a part");
    };
    let Part::Text(text) = *part else {
        panic!("not text")
    };
    assert_eq!(text.text.as_deref(), Some("hello"));
    assert_eq!(text.at, Some(PartAt { step: 4, index: 2 }));
}

#[test]
fn message_part_delta_is_a_delta_at_its_offset() {
    let frame = payload(
        "message.part.delta",
        r#"{"sessionID":"ses_1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"hi","offset":7}"#,
    );
    assert!(matches!(
        translate(&frame),
        Some(SourceEvent::Delta { offset: 7, ref delta, .. }) if delta == "hi"
    ));
}

#[test]
fn message_removed_is_message_removed() {
    let frame = payload(
        "message.removed",
        r#"{"sessionID":"ses_1","messageID":"msg_1"}"#,
    );
    assert!(matches!(
        translate(&frame),
        Some(SourceEvent::MessageRemoved { ref message, .. }) if message == "msg_1"
    ));
}

#[test]
fn permission_asked_is_an_ask_with_three_options_always_lasting() {
    let frame = payload(
        "permission.asked",
        r#"{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["ls"],"metadata":{},"always":["ls *"]}"#,
    );
    let Some(SourceEvent::AskRaised { ask }) = translate(&frame) else {
        panic!("not an ask");
    };
    assert_eq!(
        (ask.key.as_str(), ask.id.as_str(), ask.kind),
        ("desk:ses_1", "per_1", AskKind::Permission)
    );
    let permission = ask.permission.unwrap();
    assert_eq!(permission.title, "bash");
    assert_eq!(permission.always, ["ls *"]);
    assert_eq!(
        permission
            .options
            .iter()
            .map(|o| (o.id, o.lasting))
            .collect::<Vec<_>>(),
        [
            (PermissionReply::Once, false),
            (PermissionReply::Always, true),
            (PermissionReply::Reject, false)
        ]
    );
}

#[test]
fn question_asked_is_an_ask_with_its_questions() {
    let frame = payload(
        "question.asked",
        r#"{"id":"que_1","sessionID":"ses_1","questions":[{"question":"which?","header":"pick","options":[{"label":"a","description":"first"}],"multiple":true}]}"#,
    );
    let Some(SourceEvent::AskRaised { ask }) = translate(&frame) else {
        panic!("not an ask");
    };
    let questions = ask.questions.unwrap();
    assert_eq!(questions[0].question, "which?");
    assert_eq!(questions[0].header, "pick");
    assert!(questions[0].multiple);
    assert_eq!(questions[0].options[0].label, "a");
}

#[test]
fn a_reply_settles_its_ask_by_kind_and_names_who() {
    let replied = payload(
        "permission.replied",
        r#"{"sessionID":"ses_1","requestID":"per_1","reply":"once","by":"phone"}"#,
    );
    let Some(SourceEvent::AskSettled { ask, kind, settled }) = translate(&replied) else {
        panic!("not a settle");
    };
    assert_eq!((ask.as_str(), kind), ("per_1", AskKind::Permission));
    assert_eq!(settled.option.as_deref(), Some("once"));
    assert_eq!(
        settled.by,
        Some(SettledBy {
            kind: SettlerKind::Device,
            name: Some("phone".into()),
            device: None
        })
    );
    let answered = payload(
        "question.replied",
        r#"{"sessionID":"ses_1","requestID":"que_1","answers":[["a"]],"by":"abort"}"#,
    );
    let Some(SourceEvent::AskSettled { kind, settled, .. }) = translate(&answered) else {
        panic!("not a settle");
    };
    assert_eq!(kind, AskKind::Question);
    assert_eq!(settled.by.unwrap().kind, SettlerKind::System);
    let rejected = payload(
        "question.rejected",
        r#"{"sessionID":"ses_1","requestID":"que_1"}"#,
    );
    let Some(SourceEvent::AskSettled { kind, settled, .. }) = translate(&rejected) else {
        panic!("not a settle");
    };
    assert_eq!(
        (kind, settled.option.as_deref(), settled.by),
        (AskKind::Question, Some("reject"), None)
    );
}

#[test]
fn session_error_is_a_fault_in_the_errors_words_and_none_without_a_session() {
    let frame = payload(
        "session.error",
        r#"{"sessionID":"ses_1","error":{"name":"APIError","data":{"message":"the model is overloaded"}}}"#,
    );
    assert!(matches!(
        translate(&frame),
        Some(SourceEvent::Fault { ref words, .. }) if words == "the model is overloaded"
    ));
    let orphan = payload(
        "session.error",
        r#"{"error":{"name":"APIError","data":{"message":"x"}}}"#,
    );
    assert!(translate(&orphan).is_none());
}

#[test]
fn a_review_request_is_a_review_notice_in_the_notes_words() {
    let frame = payload(
        "worktree.review.requested",
        r#"{"sessionID":"ses_1","name":"wt-1","branch":"fix","note":"the tests pass","directory":"/w/app-wt"}"#,
    );
    assert!(matches!(
        translate(&frame),
        Some(SourceEvent::Notice { notice: Notice::Review { ref checkout, ref words }, .. })
            if checkout == "wt-1" && words == "the tests pass"
    ));
}

#[test]
fn a_merged_or_discarded_worktree_settles_reviews_by_name_and_directory() {
    let merged = format!(
        r#"{{"directory":"/w/app","payload":{{"id":"e","type":"worktree.merged","properties":{}}}}}"#,
        r#"{"name":"wt-1","branch":"cmx2/wt-1","base":"main","commit":"abc","commits":1}"#
    );
    let discarded = format!(
        r#"{{"payload":{{"id":"e","type":"worktree.discarded","properties":{}}}}}"#,
        r#"{"name":"wt-1","branch":"cmx2/wt-1","base":"main","commit":"abc","commits":1}"#
    );
    assert!(matches!(
        translate(&merged),
        Some(SourceEvent::ReviewSettled { ref worktree, directory: Some(ref d) }) if worktree == "wt-1" && d == "/w/app"
    ));
    assert!(matches!(
        translate(&discarded),
        Some(SourceEvent::ReviewSettled {
            directory: None,
            ..
        })
    ));
}

#[test]
fn a_process_notice_is_a_job_notice() {
    let frame = payload(
        "process.notify",
        r#"{"process":{"id":"proc_1","sessionID":"ses_1","pid":1,"command":"bun dev","cwd":"/w","title":"dev server","kind":"job","status":"running","exitCode":0,"ports":[],"origin":"model","startedAt":1},"reason":"port","detail":"listening on 5173"}"#,
    );
    assert!(matches!(
        translate(&frame),
        Some(SourceEvent::Notice { notice: Notice::Job { ref process, ref reason, ref title, .. }, .. })
            if process == "proc_1" && reason == "port" && title == "dev server"
    ));
}

#[test]
fn an_event_nothing_consumes_translates_to_nothing() {
    let frame = payload("session.compacted", r#"{"sessionID":"ses_1"}"#);
    if let Ok(decoded) = decode_frame(&frame) {
        assert!(
            event("desk", None, &decoded.event, &decoded.payload)
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn every_cmx2_part_kind_maps_to_its_neutral_kind() {
    let kinds = [
        (
            r#"{"id":"p","sessionID":"s","messageID":"m","type":"reasoning","text":"hmm"}"#,
            "reasoning",
        ),
        (
            r#"{"id":"p","sessionID":"s","messageID":"m","type":"tool","callID":"c","tool":"bash","state":{"status":"running","input":{"command":"ls"}}}"#,
            "tool",
        ),
        (
            r#"{"id":"p","sessionID":"s","messageID":"m","type":"file","mime":"image/png","filename":"a.png","url":"data:image/png;base64,AA=="}"#,
            "image",
        ),
        (
            r#"{"id":"p","sessionID":"s","messageID":"m","type":"file","mime":"application/pdf","filename":"a.pdf","url":"data:application/pdf;base64,AA=="}"#,
            "file",
        ),
        (
            r#"{"id":"p","sessionID":"s","messageID":"m","type":"compaction","auto":true}"#,
            "compaction",
        ),
        (
            r#"{"id":"p","sessionID":"s","messageID":"m","type":"step-finish","reason":"stop","cost":0.1,"tokens":{}}"#,
            "marker",
        ),
        (
            r#"{"id":"p","sessionID":"s","messageID":"m","type":"snapshot","snapshot":"abc"}"#,
            "snapshot",
        ),
    ];
    for (json, kind) in kinds {
        let part = part(&RawValue::from_string(json.to_owned()).unwrap());
        assert_eq!(part.kind(), kind, "{json}");
    }
}

#[test]
fn a_tool_family_is_the_clients_table_moved_to_the_server() {
    assert_eq!(family("bash"), Family::Shell);
    assert_eq!(family("grep"), Family::Search);
    assert_eq!(family("spawn_agent"), Family::Spawn);
    assert_eq!(family("codesearch"), Family::Web);
    assert_eq!(family("mystery"), Family::Other);
}

#[test]
fn a_part_whose_neutral_form_would_tell_the_tail_otherwise_stays_unknown() {
    // a tool with no call id cannot be a neutral tool; its json still names the tool
    let raw = RawValue::from_string(
        r#"{"id":"p","messageID":"m","type":"tool","tool":"bash","state":{"status":"running","title":"ls"}}"#.to_owned(),
    )
    .unwrap();
    let part = part(&raw);
    assert!(matches!(part, Part::Unknown(_)));
    assert_eq!(part_facts(&part), PartFacts::deserialize(&*raw).ok());
}

#[test]
fn a_tail_read_skips_a_message_that_does_not_decode_and_keeps_its_stamp() {
    let body = br#"[{"info":{"id":"msg_1","role":"assistant","time":{"created":1}},"parts":[]},{"info":{"role":"user"},"parts":[]}]"#;
    let read = tail(
        "ses_1".into(),
        Stamp {
            epoch: "ep".into(),
            seq: 4,
        },
        None,
        body,
    )
    .unwrap();
    assert_eq!(read.messages.len(), 1);
    assert_eq!(read.upstream.unwrap().seq, 4);
}

/// the converse of the test below: every kind `event`'s match names is in
/// `CONSUMED`, so an arm added without its entry fails here instead of being
/// filtered away upstream (`types=`, `upstream/watcher.rs`) unseen.
#[test]
fn every_kind_the_translation_matches_is_in_the_consumed_list() {
    let source = include_str!("../translate.rs");
    let start = source.find("\npub fn event(").expect("translate::event");
    let body = &source[start..];
    let body = &body[..body.find("\n}\n").expect("the end of event")];
    let matched: std::collections::BTreeSet<String> = body
        .split("Event::")
        .skip(1)
        .filter_map(|rest| {
            let name: String = rest
                .chars()
                .take_while(char::is_ascii_alphanumeric)
                .collect();
            rest[name.len()..].starts_with('(').then_some(name)
        })
        .collect();
    let named: std::collections::BTreeSet<&str> = crate::cmx2::EventKind::ALL
        .iter()
        .filter(|kind| matched.contains(&format!("{kind:?}")))
        .map(|kind| kind.as_str())
        .collect();
    assert_eq!(
        matched.len(),
        named.len(),
        "an arm names no known kind: {matched:?}"
    );
    assert_eq!(named, CONSUMED.into_iter().collect());
}

#[test]
fn every_consumed_kind_has_a_frame_that_translates() {
    // one frame per consumed kind, each of which must translate to something: a stream filtered to
    // `CONSUMED` drops every other kind, so a kind the table reads and the list lacks would be lost
    let frames = consumed_frames();
    let mut names: Vec<&str> = frames.iter().map(|(name, _)| *name).collect();
    names.sort_unstable();
    let mut listed = CONSUMED.to_vec();
    listed.sort_unstable();
    assert_eq!(names, listed, "the frames cover the list, each kind once");
    for (name, frame) in &frames {
        let kind =
            cmx2::EventKind::from_wire(name).unwrap_or_else(|| panic!("{name} is not declared"));
        let decoded = decode_frame(frame).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(decoded.event.kind(), kind, "{name}");
        assert!(translate(frame).is_some(), "{name} translates to nothing");
    }
}

/// a valid frame of each consumed kind.
#[allow(
    clippy::too_many_lines,
    reason = "one frame per kind, written out as the daemon writes it, is the point of the table"
)]
fn consumed_frames() -> Vec<(&'static str, String)> {
    let info = info("ses_1");
    vec![
        (
            "message.updated",
            payload(
                "message.updated",
                r#"{"sessionID":"ses_1","info":{"id":"msg_1","sessionID":"ses_1","role":"user","time":{"created":3}}}"#,
            ),
        ),
        (
            "message.part.updated",
            payload(
                "message.part.updated",
                r#"{"sessionID":"ses_1","part":{"id":"prt_ses1_0004_2","sessionID":"ses_1","messageID":"msg_1","type":"text","text":"hello"}}"#,
            ),
        ),
        (
            "message.part.delta",
            payload(
                "message.part.delta",
                r#"{"sessionID":"ses_1","messageID":"msg_1","partID":"prt_1","field":"text","delta":"hi","offset":7}"#,
            ),
        ),
        (
            "message.removed",
            payload(
                "message.removed",
                r#"{"sessionID":"ses_1","messageID":"msg_1"}"#,
            ),
        ),
        ("btw.updated", payload("btw.updated", BTW_DONE)),
        (
            "btw.delta",
            payload(
                "btw.delta",
                r#"{"sessionID":"ses_1","btwID":"btw_1","delta":"the "}"#,
            ),
        ),
        (
            "session.created",
            payload(
                "session.created",
                &format!(r#"{{"sessionID":"ses_1","info":{info}}}"#),
            ),
        ),
        (
            "session.updated",
            payload(
                "session.updated",
                &format!(r#"{{"sessionID":"ses_1","info":{info}}}"#),
            ),
        ),
        (
            "session.deleted",
            payload(
                "session.deleted",
                &format!(r#"{{"sessionID":"ses_1","info":{info}}}"#),
            ),
        ),
        (
            "session.status",
            payload(
                "session.status",
                r#"{"sessionID":"ses_1","status":{"type":"busy","since":5}}"#,
            ),
        ),
        (
            "session.idle",
            payload("session.idle", r#"{"sessionID":"ses_1"}"#),
        ),
        (
            "permission.asked",
            payload(
                "permission.asked",
                r#"{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["ls"],"metadata":{},"always":["ls *"]}"#,
            ),
        ),
        (
            "question.asked",
            payload(
                "question.asked",
                r#"{"id":"que_1","sessionID":"ses_1","questions":[{"question":"which?","header":"pick","options":[{"label":"a","description":"first"}],"multiple":true}]}"#,
            ),
        ),
        (
            "permission.replied",
            payload(
                "permission.replied",
                r#"{"sessionID":"ses_1","requestID":"per_1","reply":"once","by":"phone"}"#,
            ),
        ),
        (
            "question.replied",
            payload(
                "question.replied",
                r#"{"sessionID":"ses_1","requestID":"que_1","answers":[["a"]],"by":"abort"}"#,
            ),
        ),
        (
            "question.rejected",
            payload(
                "question.rejected",
                r#"{"sessionID":"ses_1","requestID":"que_1"}"#,
            ),
        ),
        (
            "session.error",
            payload(
                "session.error",
                r#"{"sessionID":"ses_1","error":{"name":"APIError","data":{"message":"x"}}}"#,
            ),
        ),
        (
            "worktree.review.requested",
            payload(
                "worktree.review.requested",
                r#"{"sessionID":"ses_1","name":"wt-1","branch":"fix","note":"the tests pass","directory":"/w/app-wt"}"#,
            ),
        ),
        (
            "worktree.merged",
            payload(
                "worktree.merged",
                r#"{"name":"wt-1","branch":"cmx2/wt-1","base":"main","commit":"abc","commits":1}"#,
            ),
        ),
        (
            "worktree.discarded",
            payload(
                "worktree.discarded",
                r#"{"name":"wt-1","branch":"cmx2/wt-1","base":"main","commit":"abc","commits":1}"#,
            ),
        ),
        (
            "process.notify",
            payload(
                "process.notify",
                r#"{"process":{"id":"proc_1","sessionID":"ses_1","pid":1,"command":"bun dev","cwd":"/w","title":"dev server","kind":"job","status":"running","exitCode":0,"ports":[],"origin":"model","startedAt":1},"reason":"port","detail":"listening on 5173"}"#,
            ),
        ),
    ]
}

#[test]
fn a_streaming_flag_reads_as_a_bool_and_anything_else_as_false() {
    // read by `part` straight from the daemon's json, as a tail read reads it: a flag that is not a
    // bool leaves the part a text part, not streaming, as the reducer always read it
    for (extra, streaming) in [
        ("", false),
        (r#","streaming":true"#, true),
        (r#","streaming":"yes""#, false),
    ] {
        let json = format!(
            r#"{{"id":"prt_ses1_0004_2","sessionID":"ses_1","messageID":"msg_1","type":"text","text":"hi"{extra}}}"#
        );
        let raw = serde_json::value::RawValue::from_string(json).unwrap();
        let Part::Text(text) = part(&raw) else {
            panic!("not text: {extra}");
        };
        assert_eq!(text.streaming, streaming, "{extra}");
    }
}

#[test]
fn a_busy_status_carries_the_prompts_waiting_behind_its_turn() {
    let busy = payload(
        "session.status",
        r#"{"sessionID":"ses_1","status":{"type":"busy","since":5,"queued":2}}"#,
    );
    assert!(matches!(
        translate(&busy),
        Some(SourceEvent::Activity { queued: 2, .. })
    ));
    let idle = payload(
        "session.status",
        r#"{"sessionID":"ses_1","status":{"type":"idle","queued":3}}"#,
    );
    assert!(
        matches!(
            translate(&idle),
            Some(SourceEvent::Activity { queued: 0, .. })
        ),
        "only a running turn has prompts waiting behind it"
    );
}

#[test]
fn a_tools_attachments_are_neutral_images_and_files_named_after_the_tool_part() {
    let raw = RawValue::from_string(
        r#"{"id":"prt_s_3_1","sessionID":"s","messageID":"msg_3","type":"tool","callID":"c1","tool":"read","state":{"status":"completed","input":{},"output":"","title":"x","metadata":{},"time":{"start":1,"end":2},"attachments":[{"type":"file","mime":"image/png","filename":"shot.png","url":"data:image/png;base64,AA=="},{"type":"file","mime":"application/pdf","filename":"spec.pdf","url":"data:application/pdf;base64,AA=="}]}}"#.into(),
    )
    .unwrap();
    let Part::Tool(tool) = part(&raw) else {
        panic!("not a tool part");
    };
    let attachments = tool.state.attachments.unwrap();
    let Part::Image(image) = &attachments[0] else {
        panic!("{:?}", attachments[0]);
    };
    assert_eq!(
        (
            image.id.as_str(),
            image.message_id.as_str(),
            image.mime.as_str()
        ),
        ("prt_s_3_1.a0", "msg_3", "image/png")
    );
    assert_eq!(image.at, None);
    assert_eq!(image.filename.as_deref(), Some("shot.png"));
    assert_eq!(image.flavour, Flavour::Attached);
    let Part::File(file) = &attachments[1] else {
        panic!("{:?}", attachments[1]);
    };
    assert_eq!(
        (file.id.as_str(), file.filename.as_str()),
        ("prt_s_3_1.a1", "spec.pdf")
    );
    assert_eq!(
        file.url.as_deref(),
        Some("data:application/pdf;base64,AA==")
    );
}

#[test]
fn a_question_that_says_nothing_of_custom_answers_takes_them() {
    let request = RawValue::from_string(
        r#"{"id":"que_1","sessionID":"ses_1","questions":[{"question":"which?","header":"h","options":[]},{"question":"and?","header":"h","options":[],"custom":false}]}"#.into(),
    )
    .unwrap();
    let ask = ask("desk", AskKind::Question, &request).unwrap();
    let questions = ask.questions.unwrap();
    assert!(
        questions[0].custom,
        "absent means a typed answer is allowed"
    );
    assert!(!questions[1].custom);
}

#[test]
fn a_message_carries_its_mail_envelope() {
    let info = RawValue::from_string(
        r#"{"id":"msg_1","sessionID":"ses_1","role":"user","time":{"created":1},"mail":{"kind":"report","from":"/root/h1","fromID":"ses_9"}}"#.into(),
    )
    .unwrap();
    let message = message(&info).unwrap();
    let mail = message.mail.unwrap();
    assert_eq!(
        (
            mail.kind.as_str(),
            mail.from.as_deref(),
            mail.from_id.as_deref()
        ),
        ("report", Some("/root/h1"), Some("ses_9"))
    );
    let plain = RawValue::from_string(
        r#"{"id":"msg_2","sessionID":"ses_1","role":"user","time":{"created":1}}"#.into(),
    )
    .unwrap();
    assert!(message_of(&plain).mail.is_none());
}

fn message_of(info: &RawValue) -> Message {
    message(info).unwrap()
}

#[test]
fn a_message_error_is_sent_for_any_error_object_with_its_words_only_when_given() {
    let with = |error: &str| {
        let info = format!(
            r#"{{"id":"msg_1","sessionID":"ses_1","role":"assistant","time":{{"created":1}}{error}}}"#
        );
        message(&RawValue::from_string(info).unwrap())
            .unwrap()
            .error
    };
    assert_eq!(with(""), None);
    assert_eq!(
        with(r#","error":{}"#),
        Some(MessageError {
            message: None,
            name: None
        })
    );
    let aborted = with(r#","error":{"name":"MessageAbortedError"}"#).unwrap();
    assert_eq!(
        (aborted.message.as_deref(), aborted.name.as_deref()),
        (None, Some("MessageAbortedError"))
    );
    // absent words stay absent on the wire, never ""
    assert_eq!(
        serde_json::to_string(&aborted).unwrap(),
        r#"{"name":"MessageAbortedError"}"#
    );
    let said = with(r#","error":{"name":"APIError","data":{"message":"overloaded"}}"#).unwrap();
    assert_eq!(
        (said.message.as_deref(), said.name.as_deref()),
        (Some("overloaded"), Some("APIError"))
    );
}

#[test]
fn a_repo_is_named_exactly_as_the_apps_repo_name_reads_a_root() {
    for (project, name) in [
        ("/home/me/src/api", "api"),
        ("/w/app/", "app"),
        ("/w/app//", "app"),
        (r"C:\src\api\", "api"),
        (r"/mixed\path/api", "api"),
        ("global", "global"),
        ("/", "/"),
        ("", ""),
    ] {
        assert_eq!(repo_name(project), name, "{project:?}");
    }
}

#[test]
fn a_thread_whose_project_leaves_no_segment_is_named_by_the_project_not_its_title() {
    let raw = info("ses_1").replace(r#""projectID":"/w/app""#, r#""projectID":"/""#);
    let thread = thread_from_json(RawValue::from_string(raw).unwrap()).unwrap();
    assert_eq!(thread.place.unwrap().name, "/");
}

#[test]
fn a_malformed_pattern_question_or_option_drops_only_itself() {
    let permission = ask(
        "desk",
        AskKind::Permission,
        &RawValue::from_string(
            r#"{"id":"per_1","sessionID":"ses_1","permission":"bash","patterns":["ls",3,"pwd"],"always":["ls *",null]}"#
                .to_owned(),
        )
        .unwrap(),
    )
    .unwrap()
    .permission
    .unwrap();
    assert_eq!(permission.patterns, ["ls", "pwd"]);
    assert_eq!(permission.always, ["ls *"]);
    let questions = ask(
        "desk",
        AskKind::Question,
        &RawValue::from_string(
            r#"{"id":"que_1","sessionID":"ses_1","questions":[
                {"question":"first?","header":"one","options":[{"label":"a"},{"nolabel":1},{"label":"b"}]},
                {"header":"no question text"},
                {"question":"third?","header":"three","custom":false,"multiple":"yes"},
                {"question":"fourth?","header":"four","custom":false}
            ]}"#
            .to_owned(),
        )
        .unwrap(),
    )
    .unwrap()
    .questions
    .unwrap();
    // the second has no words and goes; a malformed field costs only itself
    assert_eq!(
        questions
            .iter()
            .map(|q| (q.question.as_str(), q.header.as_str(), q.custom))
            .collect::<Vec<_>>(),
        [
            ("first?", "one", true),
            ("third?", "three", false),
            ("fourth?", "four", false)
        ]
    );
    assert_eq!(
        questions[0]
            .options
            .iter()
            .map(|o| o.label.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
}
