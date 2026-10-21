//! the fold against the app: each thread fixture's raw cmx2 json,
//! translated message by message as the server reads it, folded, and
//! compared field by field with the summary the app's own functions give
//! for it (`scripts/summary-reference.ts`, its goldens beside this file).

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::*;
use crate::source::cmx2::translate;
use crate::wire::{Mail, Message, MessageError, PartTime, TextPart, ToolState};

const GOLDENS: [&str; 4] = [
    "cmx-deploy",
    "northstar-heavy",
    "northstar-heavy.ses_f9e06dac4ffeWesFqrB3Echd9w",
    "notes-asks",
];

/// the fields the fold cannot give as the app does, because the neutral
/// message loses a cmx2 field the app reads (`thread turn field`): none
/// since the wire carries `summary`, `notice` and the error's `name`.
const KNOWN: &[&str] = &[];

#[derive(Deserialize)]
struct Raw {
    info: Box<RawValue>,
    parts: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Thread {
    messages: Vec<Raw>,
}

#[derive(Deserialize)]
struct Fixture {
    messages: Vec<Raw>,
    #[serde(default)]
    children: Vec<Thread>,
    #[serde(default)]
    snapshots: Vec<Thread>,
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn read(path: &PathBuf) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// the messages a golden names, translated as the cmx2 source does.
fn messages(golden: &Value) -> Vec<MessageWithParts> {
    let name = golden["fixture"].as_str().unwrap();
    let path = repo().join(format!("app/src/ui/thread/fixtures/{name}.json"));
    let fixture: Fixture = serde_json::from_str(&read(&path)).unwrap();
    let raw = match &golden["source"] {
        Value::String(s) if s == "messages" => fixture.messages,
        Value::String(s) if s == "last-snapshot" => {
            fixture.snapshots.into_iter().last().unwrap().messages
        }
        Value::Object(o) => {
            let i: usize = o["child"]
                .as_str()
                .and_then(|n| n.strip_prefix(NUMBER))
                .unwrap()
                .parse()
                .unwrap();
            fixture.children.into_iter().nth(i).unwrap().messages
        }
        other => panic!("unknown source {other}"),
    };
    raw.iter()
        .map(|m| MessageWithParts {
            info: translate::message(&m.info).unwrap(),
            parts: m.parts.iter().map(|p| translate::part(p)).collect(),
        })
        .collect()
}

/// two json values as the same number, string, bool or absence.
/// the app's numbers are read from the golden's text as exact strings
/// (`exact`): `serde_json` without `float_roundtrip` reads a 17-digit float up
/// to one unit in the last place away from what javascript wrote.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::String(y))) if y.starts_with(NUMBER) => {
            x.as_f64().map(f64::to_bits) == y[NUMBER.len()..].parse::<f64>().ok().map(f64::to_bits)
        }
        _ => a == b,
    }
}

const NUMBER: &str = "#number:";

/// the golden's json with every number outside a string turned into the
/// string `#number:<its text>`.
fn exact(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    let mut chars = text.chars().peekable();
    let (mut quoted, mut escaped) = (false, false);
    while let Some(c) = chars.next() {
        if quoted {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            out.push(c);
        } else if c == '-' || c.is_ascii_digit() {
            out.push('"');
            out.push_str(NUMBER);
            out.push(c);
            while let Some(&d) = chars.peek() {
                if !(d.is_ascii_digit() || "+-.eE".contains(d)) {
                    break;
                }
                out.push(d);
                chars.next();
            }
            out.push('"');
        } else {
            out.push(c);
        }
    }
    out
}

/// every field of `ours` and `app` that differs, as `<at> <field>: ours, app`.
fn fields(at: &str, ours: &Value, app: &Value, out: &mut Vec<String>) {
    let keys: BTreeSet<&String> = ours
        .as_object()
        .unwrap()
        .keys()
        .chain(app.as_object().unwrap().keys())
        .collect();
    for k in keys {
        if !same(ours.get(k), app.get(k)) {
            out.push(format!("{at} {k}: {:?}, {:?}", ours.get(k), app.get(k)));
        }
    }
}

/// what differs between the fold's summary of one golden's thread and the
/// app's, and how many turns, spawns and files were compared.
fn compare(name: &str) -> (Vec<String>, [usize; 3]) {
    let golden: Value = serde_json::from_str(&exact(&read(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("src/fleet/summary/fold/goldens/{name}.json")),
    )))
    .unwrap();
    let mut fold = Fold::new(golden["directory"].as_str().unwrap());
    for m in &messages(&golden) {
        fold.push(m);
    }
    let summary = fold.finish();
    let key = golden["child"]["key"].as_str().unwrap();
    let ours = json!({
        "total": summary.total,
        "turns": summary.turns,
        "spawns": summary.spawns,
        "files": summary.files,
        "child": summary.as_child(key),
    });
    let mut diffs = Vec::new();
    if !same(ours.get("total"), golden.get("total")) {
        diffs.push(format!("{name} total"));
    }
    fields(
        &format!("{name} child"),
        &ours["child"],
        &golden["child"],
        &mut diffs,
    );
    let mut counted = [0; 3];
    for (n, list) in ["turns", "spawns", "files"].into_iter().enumerate() {
        let (a, b) = (
            ours[list].as_array().unwrap(),
            golden[list].as_array().unwrap(),
        );
        assert_eq!(
            a.len(),
            b.len(),
            "{name}: {list} count, ours {}, app {}",
            a.len(),
            b.len()
        );
        counted[n] = a.len();
        for (i, (x, y)) in a.iter().zip(b).enumerate() {
            let at = match list {
                "turns" => format!("{name} turn {}", y["id"].as_str().unwrap()),
                _ => format!("{name} {list}[{i}]"),
            };
            fields(&at, x, y, &mut diffs);
        }
    }
    (diffs, counted)
}

#[test]
fn summary_fold_matches_the_app_on_every_fixture_thread() {
    let mut all = Vec::new();
    for name in GOLDENS {
        let (diffs, [turns, spawns, files]) = compare(name);
        eprintln!(
            "{name}: {turns} turns, {spawns} spawns, {files} files compared, {} fields differ",
            diffs.len()
        );
        all.extend(diffs);
    }
    let differ: Vec<String> = all
        .iter()
        .map(|d| d.split(':').next().unwrap_or(d).to_owned())
        .collect();
    let unexplained: Vec<&String> = all
        .iter()
        .filter(|d| !KNOWN.iter().any(|k| d.starts_with(&format!("{k}:"))))
        .collect();
    let fixed: Vec<&&str> = KNOWN
        .iter()
        .filter(|k| !differ.iter().any(|d| d == *k))
        .collect();
    assert!(
        unexplained.is_empty(),
        "fields differ from the app:\n{}",
        unexplained
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert!(
        fixed.is_empty(),
        "known differences no longer differ, take them out of KNOWN: {fixed:?}"
    );
}

fn text(text: &str) -> Part {
    Part::Text(TextPart {
        id: "prt_1".to_owned(),
        message_id: "msg_1".to_owned(),
        at: None,
        text: Some(text.to_owned()),
        text_of: None,
        streaming: false,
        time: None::<PartTime>,
        synthetic: false,
        notice: false,
        mail: None::<Mail>,
    })
}

fn message(
    id: &str,
    role: Role,
    created: f64,
    completed: Option<f64>,
    parts: Vec<Part>,
) -> MessageWithParts {
    let info: Message =
        serde_json::from_value(json!({"id": id, "role": role.as_str(), "created": created}))
            .unwrap();
    MessageWithParts {
        info: Message { completed, ..info },
        parts,
    }
}

fn tool(tool: &str, status: &str, input: &Value, metadata: &Value) -> Part {
    let state: ToolState =
        serde_json::from_value(json!({"status": status, "input": input, "metadata": metadata}))
            .unwrap();
    Part::Tool(ToolPart {
        id: "prt_2".to_owned(),
        message_id: "msg_2".to_owned(),
        at: None,
        call_id: "call_1".to_owned(),
        tool: tool.to_owned(),
        family: translate::family(tool),
        state,
    })
}

#[test]
fn summary_wire_shape_matches_the_spec_example() {
    let mut fold = Fold::new("/w");
    fold.push(&message(
        "msg_01",
        Role::User,
        1000.0,
        None,
        vec![text("\n  \nmake the importer skip empty rows\nmore")],
    ));
    let mut reply = message(
        "msg_02",
        Role::Assistant,
        1001.0,
        Some(1090.0),
        vec![
            tool(
                "edit",
                "completed",
                &json!({"filePath": "/w/src/import.ts", "oldString": "a", "newString": "b\nc"}),
                &json!({}),
            ),
            tool(
                "spawn",
                "completed",
                &json!({"brief": "look"}),
                &json!({"agents": [{"name": "/root/researcher", "seat": "explore", "id": "ses_9"}]}),
            ),
            text("done"),
        ],
    );
    reply.info.model = Some("provider/model-a".to_owned());
    reply.info.effort = Some("high".to_owned());
    reply.info.cost = Some(0.41);
    fold.push(&reply);
    let mut mail = text("the report");
    if let Part::Text(t) = &mut mail {
        t.mail = Some(Mail {
            kind: "report".to_owned(),
            from: Some("/root/researcher".to_owned()),
            from_id: Some("ses_9".to_owned()),
        });
    }
    fold.push(&message("msg_40", Role::User, 2000.0, None, vec![mail]));
    let mut failed = message("msg_41", Role::Assistant, 2001.0, Some(2002.0), vec![]);
    failed.info.error = Some(MessageError {
        message: "boom".to_owned(),
        name: None,
    });
    fold.push(&failed);
    fold.push(&message("msg_42", Role::User, 3000.0, None, vec![]));
    let s = fold.finish();
    assert_eq!(s.total, 5);
    assert_eq!(
        serde_json::to_value(&s.turns).unwrap(),
        json!([
            {"id": "msg_01", "by": "you", "at": 1000, "end": 1090, "line": "make the importer skip empty rows", "steps": 2,
             "ask": false, "error": false, "status": "done", "model": "provider/model-a", "effort": "high", "cost": 0.41,
             "answered": true, "messages": 2},
            {"id": "msg_40", "by": "mail", "from": "researcher", "fromID": "ses_9", "at": 2000, "end": 2002, "line": "", "steps": 0,
             "status": "failed", "answered": false, "messages": 2}
        ])
    );
    assert_eq!(
        serde_json::to_value(&s.spawns).unwrap(),
        json!([{"turn": "msg_01", "part": "prt_2", "name": "researcher", "type": "explore", "child": "ses_9", "at": 1001}])
    );
    assert_eq!(
        serde_json::to_value(&s.files).unwrap(),
        json!([{"path": "src/import.ts", "add": 2, "del": 1, "at": 1001}])
    );
    assert_eq!(
        serde_json::to_value(s.as_child("vm-a:ses_2")).unwrap(),
        json!({"key": "vm-a:ses_2", "steps": 2, "first": 1000, "end": 1000})
    );
}

#[test]
fn summary_line_counts_utf16_and_javascript_blanks() {
    assert_eq!(first_line("\u{feff}\n\u{85}x"), "\u{85}x");
    let long = "é".repeat(400);
    assert_eq!(first_line(&long).chars().count(), 300);
    assert_eq!(first_line(&format!("{}\nlate", " ".repeat(20_000))), "");
}

#[test]
fn summary_short_paths_as_the_app() {
    assert_eq!(short_path("/r/a/b", "/r"), "a/b");
    assert_eq!(short_path("/r", "/r"), "/r");
    assert_eq!(short_path("/Users/x/y", "/r"), "~/y");
    assert_eq!(short_path("/home/x", ""), "~");
    assert_eq!(short_path("/opt/x", "/r"), "/opt/x");
}
