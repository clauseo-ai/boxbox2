//! one raw event checked against the dictionary and written as one ndjson
//! line, by v1's rules (`lib/telemetry/log.ts`, `normalize`), so v1's days
//! and v2's read the same:
//!
//! - an unknown kind or an undeclared prop is dropped, never stored.
//! - `at` defaults to the time the batch arrived, and a stamp more than six
//!   hours from it is replaced by it.
//! - a client id is kept to 40 characters; a missing one is minted.
//! - `ok` is 1 for `true` or `1`, else 0; text is kept to 500 characters;
//!   booleans count as 1 and 0; numbers must be finite; integers round.
//!
//! two deliberate differences: `at` is always a whole millisecond, and an
//! array or object sent for a text prop is stored as its json rather than
//! as javascript's `String()` of it ("[object Object]").

use serde_json::Value;

use super::dictionary::{self, ColumnType, ENVELOPE, Kind};

/// the most events one post may carry, so one request cannot fill a disk.
pub const MAX_BATCH: usize = 500;
const MAX_TEXT_CHARS: usize = 500;
const MAX_ID_CHARS: usize = 40;
const SKEW_MS: i64 = 6 * 60 * 60 * 1000;

/// the envelope columns the server fills itself; producers set the rest.
const SERVER_COLUMNS: [&str; 6] = ["id", "at", "kind", "device", "device_class", "props"];

/// kinds whose truth the server owns (`scars.md`, line 1717): v1 sent them
/// from clients to a needs tracker; v2 derives needs itself (m4), and only
/// the server's own rows of these kinds are kept.
const SERVER_OWNED_KINDS: [&str; 4] = ["need.raised", "need.cleared", "need.served", "push.acted"];

/// one stored event: its stamp (which picks the day file) and its line.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// the producer's id, or one minted on arrival: the writer drops a repeat
    /// (a batch sent by both the worker and the page's beacon).
    pub id: String,
    pub at: i64,
    pub line: String,
}

/// why part of an event was not stored.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Dropped {
    NotAnObject,
    UnknownKind(String),
    ServerOwned(String),
    UndeclaredProp { kind: &'static str, prop: String },
}

impl std::fmt::Display for Dropped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAnObject => f.write_str("an event that is not a json object"),
            Self::UnknownKind(kind) => write!(f, "unknown event kind \"{kind}\""),
            Self::ServerOwned(kind) => write!(f, "{kind} from a client (the server derives needs)"),
            Self::UndeclaredProp { kind, prop } => {
                write!(f, "undeclared prop \"{prop}\" on {kind}")
            }
        }
    }
}

/// the batch-wide facts every event in it shares.
#[derive(Debug, Clone, Copy)]
pub struct Origin<'a> {
    pub device: &'a str,
    pub device_class: &'a str,
    pub received_at: i64,
    /// the server wrote it itself (`Sender::record`), never a client's
    /// batch: a class a client can claim is not proof.
    pub server: bool,
}

/// checks one event; `None` means it was dropped whole, and `dropped`
/// says why (an event can also lose single props and still be stored).
pub fn normalize(
    raw: &Value,
    origin: Origin<'_>,
    mint_id: &mut impl FnMut() -> String,
    dropped: &mut Vec<Dropped>,
) -> Option<Row> {
    let Some(raw) = raw.as_object() else {
        dropped.push(Dropped::NotAnObject);
        return None;
    };
    let name = raw.get("kind").and_then(Value::as_str).unwrap_or_default();
    if SERVER_OWNED_KINDS.contains(&name) && !origin.server {
        dropped.push(Dropped::ServerOwned(name.into()));
        return None;
    }
    let Some(kind) = dictionary::kind(name) else {
        dropped.push(Dropped::UnknownKind(name.into()));
        return None;
    };

    let stamped = raw.get("at").and_then(Value::as_f64).and_then(to_i64);
    let at = match stamped {
        Some(at) if (at - origin.received_at).abs() <= SKEW_MS => at,
        _ => origin.received_at,
    };
    let id = match raw.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.chars().take(MAX_ID_CHARS).collect(),
        _ => mint_id(),
    };

    let mut line = Line::default();
    line.field("id", &Value::String(id.clone()));
    line.field("at", &Value::from(at));
    line.field("kind", &Value::from(kind.name));
    line.field("device", &Value::from(origin.device));
    line.field("device_class", &Value::from(origin.device_class));
    for column in ENVELOPE
        .iter()
        .filter(|c| !SERVER_COLUMNS.contains(&c.name))
    {
        let Some(value) = raw.get(column.name).filter(|v| !v.is_null()) else {
            continue;
        };
        if column.name == "ok" {
            let ok = matches!(value, Value::Bool(true)) || value.as_f64() == Some(1.0);
            line.field("ok", &Value::from(u8::from(ok)));
        } else if let Some(value) = coerce(value, column.ty) {
            line.field(column.name, &value);
        }
    }
    if let Some(props) = props(kind, raw.get("props"), dropped) {
        line.raw("props", &props);
    }
    Some(Row {
        id,
        at,
        line: line.finish(),
    })
}

/// declared props as a json object in dictionary order; undeclared ones
/// are reported.
fn props(kind: &'static Kind, raw: Option<&Value>, dropped: &mut Vec<Dropped>) -> Option<String> {
    let raw = raw.and_then(Value::as_object)?;
    for name in raw
        .keys()
        .filter(|name| !kind.props.iter().any(|p| p.name == *name))
    {
        dropped.push(Dropped::UndeclaredProp {
            kind: kind.name,
            prop: name.clone(),
        });
    }
    let mut props = Line::default();
    for prop in kind.props {
        if let Some(value) = raw.get(prop.name).and_then(|value| coerce(value, prop.ty)) {
            props.field(prop.name, &value);
        }
    }
    props.nonempty().map(Line::finish)
}

fn coerce(value: &Value, ty: ColumnType) -> Option<Value> {
    match ty {
        ColumnType::Text => {
            let text = match value {
                Value::Null => return None,
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            Some(Value::String(text.chars().take(MAX_TEXT_CHARS).collect()))
        }
        ColumnType::Integer | ColumnType::Real => {
            let number = match value {
                Value::Bool(flag) => f64::from(u8::from(*flag)),
                Value::Number(number) => number.as_f64()?,
                Value::String(text) => text.trim().parse::<f64>().ok()?,
                _ => return None,
            };
            if !number.is_finite() {
                return None;
            }
            if ty == ColumnType::Integer {
                to_i64(number).map(Value::from)
            } else {
                serde_json::Number::from_f64(number).map(Value::Number)
            }
        }
    }
}

/// rounds to the nearest whole number when it fits an i64.
fn to_i64(number: f64) -> Option<i64> {
    const LIMIT: f64 = 9_007_199_254_740_992.0; // 2^53, past which f64 skips integers
    let rounded = number.round();
    #[allow(
        clippy::cast_possible_truncation,
        reason = "bounded to ±2^53 on the line above"
    )]
    (rounded.abs() <= LIMIT).then_some(rounded as i64)
}

/// a json object written key by key, so lines keep v1's column order.
#[derive(Default)]
struct Line(String);

impl Line {
    fn field(&mut self, key: &str, value: &Value) {
        self.0.push(if self.0.is_empty() { '{' } else { ',' });
        self.0.push_str(&Value::from(key).to_string());
        self.0.push(':');
        self.0.push_str(&value.to_string());
    }

    /// a field whose value is already a json text.
    fn raw(&mut self, key: &str, json: &str) {
        self.0.push(if self.0.is_empty() { '{' } else { ',' });
        self.0.push_str(&Value::from(key).to_string());
        self.0.push(':');
        self.0.push_str(json);
    }

    fn nonempty(self) -> Option<Self> {
        (!self.0.is_empty()).then_some(self)
    }

    fn finish(mut self) -> String {
        if self.0.is_empty() {
            self.0.push('{');
        }
        self.0.push('}');
        self.0
    }
}

/// v1's shape for an id the client did not send: arrival in base 36, a dash,
/// eight random base-36 digits.
pub fn mint_id(received_at: i64) -> String {
    format!(
        "{}-{}",
        base36(u64::try_from(received_at).unwrap_or(0)),
        base36(rand::random::<u64>())
            .chars()
            .take(8)
            .collect::<String>()
    )
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[usize::try_from(n % 36).unwrap_or(0)]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_ids_look_like_v1s() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        let id = mint_id(1_790_684_879_750);
        let (stamp, random) = id.split_once('-').unwrap();
        assert_eq!(stamp, "mumnjk3q");
        assert!(random.len() <= 8 && !random.is_empty());
    }
    use serde_json::json;

    const NOW: i64 = 1_790_684_879_750;

    fn run(raw: &Value) -> (Option<Row>, Vec<Dropped>) {
        let mut dropped = Vec::new();
        let origin = Origin {
            device: "dev-1",
            device_class: "automation",
            received_at: NOW,
            server: false,
        };
        let row = normalize(raw, origin, &mut || "minted".into(), &mut dropped);
        (row, dropped)
    }

    fn line(raw: &Value) -> Value {
        serde_json::from_str(&run(raw).0.unwrap().line).unwrap()
    }

    #[test]
    fn writes_the_v1_line_shape_in_v1_column_order() {
        let raw = json!({"id": "abc", "at": NOW - 5, "kind": "verb", "surface": "thread",
            "host": "desk", "ok": true, "ms": 2.4, "props": {"name": "markRead"}});
        let (row, dropped) = run(&raw);
        let row = row.unwrap();
        assert!(dropped.is_empty());
        assert_eq!(row.at, NOW - 5);
        assert_eq!(
            row.line,
            r#"{"id":"abc","at":1790684879745,"kind":"verb","device":"dev-1","device_class":"automation","surface":"thread","host":"desk","ok":1,"ms":2,"props":{"name":"markRead"}}"#
        );
    }

    #[test]
    fn unknown_kinds_and_client_needs_are_dropped_whole() {
        let (row, dropped) = run(&json!({"kind": "agent.imaginary"}));
        assert!(row.is_none());
        assert_eq!(dropped, [Dropped::UnknownKind("agent.imaginary".into())]);
        let (row, dropped) = run(&json!({"kind": "need.raised"}));
        assert!(row.is_none());
        assert_eq!(dropped, [Dropped::ServerOwned("need.raised".into())]);
        assert_eq!(run(&json!([1])).1, [Dropped::NotAnObject]);
    }

    #[test]
    fn the_servers_own_need_rows_are_kept() {
        let mut dropped = Vec::new();
        let origin = Origin {
            device: "server",
            device_class: "server",
            received_at: NOW,
            server: true,
        };
        let raw = json!({"kind": "need.raised", "session": "desk:ses_1", "props": {"need": "question", "id": "ask:desk:q1"}});
        let row = normalize(&raw, origin, &mut || "minted".into(), &mut dropped);
        assert!(dropped.is_empty(), "{dropped:?}");
        assert!(
            row.unwrap()
                .line
                .contains(r#""props":{"need":"question","id":"ask:desk:q1"}"#)
        );
    }

    #[test]
    fn props_keep_dictionary_order_whatever_order_they_arrive_in() {
        let row = run(&json!({"kind": "verb", "props": {"chars": 42, "name": "sendPrompt"}}))
            .0
            .unwrap();
        assert!(
            row.line
                .ends_with(r#""props":{"name":"sendPrompt","chars":42}}"#),
            "{}",
            row.line
        );
    }

    #[test]
    fn undeclared_props_go_and_the_event_stays() {
        let (row, dropped) =
            run(&json!({"kind": "verb", "props": {"name": "x", "title": "secret"}}));
        assert!(row.unwrap().line.contains(r#""props":{"name":"x"}"#));
        assert_eq!(
            dropped,
            [Dropped::UndeclaredProp {
                kind: "verb",
                prop: "title".into()
            }]
        );
    }

    #[test]
    fn a_stamp_far_from_arrival_is_replaced_and_a_missing_id_minted() {
        let skewed = line(&json!({"kind": "app.open", "at": NOW - SKEW_MS - 1}));
        assert_eq!(skewed["at"], NOW);
        assert_eq!(skewed["id"], "minted");
        let close = line(&json!({"kind": "app.open", "at": NOW - SKEW_MS}));
        assert_eq!(close["at"], NOW - SKEW_MS);
        let long_id = "x".repeat(60);
        assert_eq!(
            line(&json!({"kind": "app.open", "id": long_id}))["id"]
                .as_str()
                .unwrap()
                .len(),
            40
        );
    }

    #[test]
    fn values_coerce_like_v1() {
        assert_eq!(coerce(&json!(true), ColumnType::Integer), Some(json!(1)));
        assert_eq!(coerce(&json!("12.6"), ColumnType::Integer), Some(json!(13)));
        assert_eq!(coerce(&json!(1.5), ColumnType::Real), Some(json!(1.5)));
        assert_eq!(coerce(&json!("nope"), ColumnType::Real), None);
        assert_eq!(coerce(&json!(7), ColumnType::Text), Some(json!("7")));
        assert_eq!(coerce(&Value::Null, ColumnType::Text), None);
        let long = "é".repeat(600);
        assert_eq!(
            coerce(&json!(long), ColumnType::Text)
                .unwrap()
                .as_str()
                .unwrap()
                .chars()
                .count(),
            500
        );
        assert_eq!(to_i64(1e300), None);
        let ok_zero = line(&json!({"kind": "verb", "ok": "yes"}));
        assert_eq!(ok_zero["ok"], 0);
    }
}
