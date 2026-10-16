//! held to the fixtures recorded from the dev gateway (`docs/openclaw.md`
//! 2.3, 2.4), plus hand-built bodies for shapes no recording holds.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::{Block, DecodeError, Envelope, Role, Row, Truncation};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/openclaw")
        .join(name);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn rows(name: &str) -> Vec<Row> {
    fixture(name)["messages"]
        .as_array()
        .unwrap_or_else(|| panic!("{name} has no messages array"))
        .iter()
        .enumerate()
        .map(|(i, v)| Row::decode(v).unwrap_or_else(|e| panic!("{name} row {i}: {e}")))
        .collect()
}

fn transcript_fixtures() -> Vec<String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/openclaw");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| {
            n.starts_with("transcript-")
                && std::path::Path::new(n)
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("json"))
        })
        .collect();
    names.sort();
    names
}

fn first_text(row: &Row) -> &str {
    row.content
        .iter()
        .find_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no text block in {row:?}"))
}

#[test]
fn every_transcript_fixture_row_decodes_without_fallback_blocks() {
    let names = transcript_fixtures();
    assert!(
        names.len() >= 11,
        "expected the recorded set, found {names:?}"
    );
    for name in names {
        let decoded = rows(&name);
        assert!(!decoded.is_empty(), "{name} has no rows");
        for (i, row) in decoded.iter().enumerate() {
            assert!(
                !row.has_unknown(),
                "{name} row {i} has a fallback block: {row:?}"
            );
            assert!(!matches!(row.role, Role::Other(_)), "{name} row {i} role");
            assert!(row.meta.id.is_some(), "{name} row {i} has no __openclaw.id");
            assert!(
                row.meta.seq.is_some(),
                "{name} row {i} has no __openclaw.seq"
            );
        }
    }
}

#[test]
fn text_fixture_has_user_string_as_text_block_and_assistant_text() {
    let r = rows("transcript-text.json");
    assert_eq!(r[0].role, Role::User);
    assert_eq!(
        r[0].content,
        vec![Block::Text {
            text: "say a few words".into()
        }]
    );
    assert_eq!(r[0].meta.sender_is_owner, Some(true));
    assert!(r[0].meta.idempotency_key.is_some());
    assert_eq!(r[1].role, Role::Assistant);
    assert_eq!(
        first_text(&r[1]),
        "the gateway is real and only the model is scripted, so every row, event and approval"
    );
    assert_eq!(r[1].stop_reason.as_deref(), Some("stop"));
    assert_eq!(r[1].provider.as_deref(), Some("mock-openai"));
    assert!(r[1].model.is_some());
    assert_eq!(r[1].usage.as_ref().and_then(|u| u.cost_usd), Some(0.0));
    assert_eq!(r[1].timestamp, Some(1_792_054_850_941));
}

#[test]
fn tail_rows_carry_openclaw_seq_in_order() {
    let r = rows("transcript-compaction.json");
    let seqs: Vec<u64> = r.iter().filter_map(|row| row.meta.seq).collect();
    assert_eq!(seqs, (1..=9).collect::<Vec<u64>>());
}

#[test]
fn thinking_fixture_has_thinking_then_text() {
    let r = rows("transcript-thinking.json");
    assert_eq!(
        r[1].content[0],
        Block::Thinking {
            thinking: "the person wants a short answer, so one line will do.".into()
        }
    );
    assert_eq!(first_text(&r[1]), "one line, after thinking.");
}

#[test]
fn tools_fixture_tool_call_matches_its_tool_result_row() {
    let r = rows("transcript-tools.json");
    let Block::ToolCall {
        id,
        name,
        arguments,
        ..
    } = &r[1].content[0]
    else {
        panic!("expected a tool call, got {:?}", r[1].content);
    };
    assert_eq!(name, "read");
    assert_eq!(arguments["path"], "notes.md");
    assert_eq!(r[2].role, Role::ToolResult);
    assert_eq!(r[2].tool_call_id.as_deref(), Some(id.as_str()));
    assert_eq!(r[2].tool_name.as_deref(), Some("read"));
    assert_eq!(r[2].is_error, Some(false));
    assert!(first_text(&r[2]).starts_with("# bench notes"));
}

#[test]
fn question_fixture_custom_row_holds_nested_ask_user_call_and_result() {
    let r = rows("transcript-question.json");
    let custom = r.iter().find(|row| row.role == Role::Custom).unwrap();
    let Block::ToolCall {
        id,
        name,
        parent_tool_call_id,
        ..
    } = &custom.content[0]
    else {
        panic!("expected a tool call, got {:?}", custom.content);
    };
    assert_eq!(name, "ask_user");
    assert!(parent_tool_call_id.is_some());
    let Block::ToolResult {
        tool_call_id,
        tool_name,
        content,
        ..
    } = &custom.content[1]
    else {
        panic!("expected a nested tool result, got {:?}", custom.content);
    };
    assert_eq!(tool_call_id, id);
    assert_eq!(tool_name.as_deref(), Some("ask_user"));
    assert!(matches!(&content[0], Block::Text { text } if text.starts_with("greeting: hello")));
}

#[test]
fn image_fixture_image_block_has_artifact_url_and_mime() {
    let r = rows("transcript-image.json");
    let Block::Image(img) = &r[1].content[1] else {
        panic!("expected an image, got {:?}", r[1].content);
    };
    assert_eq!(
        img.artifact_id.as_deref(),
        Some("artifact_managed_image_9f9bd825-a822-44ee-8523-b97616aed0ba")
    );
    let url = img.url.as_deref().unwrap();
    assert!(
        url.starts_with("/api/chat/media/outgoing/") && url.ends_with("/full"),
        "{url}"
    );
    assert_eq!(img.mime_type.as_deref(), Some("image/png"));
    assert_eq!(img.alt.as_deref(), Some("dot.png"));
    assert_eq!(
        (img.width, img.height, img.size_bytes),
        (Some(4), Some(4), Some(73))
    );
}

#[test]
fn tts_fixture_audio_block_and_delivery_tts_text() {
    let r = rows("transcript-tts.json");
    let Block::Audio(audio) = &r[1].content[1] else {
        panic!("expected audio, got {:?}", r[1].content);
    };
    assert_eq!(
        audio.artifact_id.as_deref(),
        Some("artifact_managed_media_08bf8be2-4e14-42de-acaf-a4559668918d")
    );
    assert!(
        audio
            .url
            .as_deref()
            .unwrap()
            .starts_with("/api/chat/media/outgoing/")
    );
    assert_eq!(audio.mime_type.as_deref(), Some("audio/mpeg"));
    assert_eq!(audio.playback.as_deref(), Some("native"));
    let tts = r[1].delivery.as_ref().and_then(|d| d.tts.as_ref()).unwrap();
    assert_eq!(tts.tagged, Some(true));
    assert_eq!(tts.text.as_deref(), Some("the bench speaks this line."));
}

#[test]
fn reply_fixture_has_reply_to_current_and_user_quote() {
    let r = rows("transcript-reply.json");
    let delivery = r[1].delivery.as_ref().unwrap();
    assert_eq!(delivery.reply_to_current, Some(true));
    assert_eq!(delivery.reply_to_id, None);
    assert_eq!(
        r[2].reply_to_id.as_deref(),
        Some("8c3e3daa-8f1a-49d8-aaf3-77b144addf15")
    );
    let preview = r[2].reply_to_preview.as_ref().unwrap();
    assert_eq!(
        preview.text.as_deref(),
        Some("answering the message you sent.")
    );
    assert_eq!(preview.sender_label.as_deref(), Some("Assistant"));
}

#[test]
fn reset_and_compaction_fixtures_have_system_rows_with_kind() {
    let reset = rows("transcript-reset.json");
    assert_eq!(reset[0].role, Role::System);
    assert_eq!(reset[0].meta.kind.as_deref(), Some("reset"));
    let compaction = rows("transcript-compaction.json");
    let sys = compaction
        .iter()
        .find(|row| row.role == Role::System)
        .unwrap();
    assert_eq!(sys.meta.kind.as_deref(), Some("compaction"));
}

#[test]
fn attachment_fixture_user_row_has_inbound_media_facts() {
    let r = rows("transcript-attachment.json");
    let media = &r[0].meta.media;
    assert_eq!(media.len(), 2);
    assert!(
        media[0]
            .source
            .as_deref()
            .unwrap()
            .starts_with("media://inbound/")
    );
    assert_eq!(media[0].kind.as_deref(), Some("image"));
    assert_eq!(media[0].content_type.as_deref(), Some("image/png"));
    assert_eq!(media[0].file_name.as_deref(), Some("dot.png"));
    assert_eq!(media[1].kind.as_deref(), Some("audio"));
    assert_eq!(media[1].duration_ms, Some(1207));
    assert_eq!(media[1].size_bytes, Some(6026));
}

#[test]
fn unknown_block_type_becomes_unknown_and_the_row_survives() {
    let v = json!({
        "role": "assistant",
        "content": [
            {"type": "hologram", "beam": 3},
            {"type": "text", "text": "still here"},
            {"type": "text"},
            "not an object"
        ],
        "model": "m",
        "__openclaw": {"id": "x", "seq": 4}
    });
    let row = Row::decode(&v).unwrap();
    assert!(
        matches!(&row.content[0], Block::Unknown { kind, raw } if kind == "hologram" && raw["beam"] == 3)
    );
    assert_eq!(
        row.content[1],
        Block::Text {
            text: "still here".into()
        }
    );
    // a known type missing its essentials falls back rather than showing blank
    assert!(matches!(&row.content[2], Block::Unknown { kind, .. } if kind == "text"));
    assert!(matches!(&row.content[3], Block::Unknown { kind, .. } if kind.is_empty()));
    assert!(row.has_unknown());
    assert_eq!(row.model.as_deref(), Some("m"));
    assert_eq!(row.meta.seq, Some(4));
}

#[test]
fn spec_media_blocks_without_recordings_decode() {
    let v = json!({
        "role": "assistant",
        "content": [
            {"type": "video", "artifactId": "a1", "url": "/u", "mimeType": "video/mp4", "fileName": "v.mp4"},
            {"type": "audio", "artifactId": "a2", "isVoiceNote": true},
            {"type": "attachment", "attachment": {"artifactId": "a3", "url": "/d", "kind": "document", "label": "r.pdf", "mimeType": "application/pdf", "sizeBytes": 9}},
            {"type": "attachment_error", "message": "gone"}
        ]
    });
    let row = Row::decode(&v).unwrap();
    assert!(!row.has_unknown(), "{row:?}");
    assert!(matches!(&row.content[0], Block::Video(m) if m.artifact_id.as_deref() == Some("a1")));
    assert!(matches!(&row.content[1], Block::Audio(m) if m.is_voice_note == Some(true)));
    assert!(
        matches!(&row.content[2], Block::Attachment(a) if a.label.as_deref() == Some("r.pdf") && a.size_bytes == Some(9))
    );
    assert!(matches!(&row.content[3], Block::AttachmentError { raw } if raw["message"] == "gone"));
}

#[test]
fn origin_sender_truncation_and_quote_meta_decode() {
    let v = json!({
        "role": "user",
        "content": "[chat.history omitted: message too large]",
        "__openclaw": {
            "id": "r1",
            "senderIsOwner": false,
            "senderName": "a member",
            "senderUsername": "member1",
            "senderId": "+0",
            "transport": {"channel": "whatsapp", "messageId": "s1", "replyToId": "s0"},
            "inputProvenance": {"kind": "internal_system", "sourceTool": "cron", "jobId": "j"},
            "truncated": true,
            "reason": "oversized"
        }
    });
    let row = Row::decode(&v).unwrap();
    let m = &row.meta;
    assert_eq!(m.sender_is_owner, Some(false));
    assert_eq!(m.sender_name.as_deref(), Some("a member"));
    assert_eq!(m.sender_username.as_deref(), Some("member1"));
    assert_eq!(m.sender_id.as_deref(), Some("+0"));
    let t = m.transport.as_ref().unwrap();
    assert_eq!(
        (
            t.channel.as_deref(),
            t.message_id.as_deref(),
            t.reply_to_id.as_deref()
        ),
        (Some("whatsapp"), Some("s1"), Some("s0"))
    );
    assert_eq!(
        m.input_provenance.as_ref().map(|p| p.kind.as_str()),
        Some("internal_system")
    );
    assert_eq!(m.truncated, Some(Truncation::Oversized));

    let cut = json!({"role": "assistant", "content": [], "__openclaw": {"truncated": true, "reason": "display-cap"}});
    assert_eq!(
        Row::decode(&cut).unwrap().meta.truncated,
        Some(Truncation::DisplayCap)
    );
}

#[test]
fn essentials_are_errors_naming_the_field_and_optionals_are_tolerant() {
    assert_eq!(
        Row::decode(&json!({"content": "x"})),
        Err(DecodeError::Missing("role"))
    );
    assert!(matches!(
        Row::decode(&json!({"role": 3, "content": "x"})),
        Err(DecodeError::WrongType { field: "role", .. })
    ));
    assert!(matches!(
        Row::decode(&json!({"role": "user", "content": 7})),
        Err(DecodeError::WrongType {
            field: "content",
            ..
        })
    ));
    assert_eq!(Row::decode(&json!([])), Err(DecodeError::NotObject));
    assert_eq!("not json".parse::<Row>(), Err(DecodeError::NotObject));

    let row = Row::decode(&json!({
        "role": "mystery",
        "timestamp": "yesterday",
        "model": 5,
        "usage": "lots",
        "openclawDelivery": {"tts": 1, "replyToCurrent": "yes"},
        "__openclaw": {"id": 9, "seq": -1, "media": "nope", "truncated": "maybe"}
    }))
    .unwrap();
    assert_eq!(row.role, Role::Other("mystery".into()));
    assert!(row.content.is_empty());
    assert_eq!((row.timestamp, row.model, row.usage), (None, None, None));
    let d = row.delivery.unwrap();
    assert_eq!((d.tts, d.reply_to_current), (None, None));
    assert_eq!(
        (row.meta.id, row.meta.seq, row.meta.truncated),
        (None, None, None)
    );
    assert!(row.meta.media.is_empty());
}

#[test]
fn delta_envelope_built_from_a_fixture_row_decodes_with_message_seq() {
    // no delta answer is recorded yet, so the envelope wraps a recorded row
    // in the 5.1 shape.
    let fixture_row = fixture("transcript-tts.json")["messages"][1].clone();
    let env = json!({
        "sessionKey": "agent:main:dashboard:k",
        "agentId": "main",
        "message": fixture_row,
        "messageId": "e1",
        "messageSeq": 2,
        "runId": "r"
    });
    let e = Envelope::decode(&env).unwrap();
    assert_eq!(e.message_id, "e1");
    assert_eq!(e.message_seq, Some(2));
    assert_eq!(e.agent_id.as_deref(), Some("main"));
    assert_eq!(e.run_id.as_deref(), Some("r"));
    assert!(matches!(e.message.content[1], Block::Audio(_)));
    let via_serde: Envelope = serde_json::from_value(env).unwrap();
    assert_eq!(via_serde, e);

    assert_eq!(
        Envelope::decode(&json!({"messageId": "e1"})),
        Err(DecodeError::Missing("message"))
    );
    assert_eq!(
        Envelope::decode(&json!({"message": {"role": "user", "content": "x"}})),
        Err(DecodeError::Missing("messageId"))
    );
}

#[test]
fn chat_event_message_bodies_decode() {
    for name in ["chat-events-text.json", "chat-events-tts.json"] {
        let frames = fixture(name);
        let bodies: Vec<&Value> = frames
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["event"] == "chat")
            .filter_map(|f| f["payload"].get("message"))
            .collect();
        assert!(!bodies.is_empty(), "{name} has no chat message bodies");
        for body in bodies {
            let row = Row::decode(body).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(row.role, Role::Assistant);
            assert!(!row.has_unknown());
            assert!(!first_text(&row).is_empty());
            // live bodies carry no __openclaw sidecar
            assert_eq!(row.meta.id, None);
        }
    }
}

#[test]
fn rows_deserialize_through_serde() {
    let r: Vec<Row> =
        serde_json::from_value(fixture("transcript-tools.json")["messages"].clone()).unwrap();
    assert_eq!(r.len(), 4);
}
