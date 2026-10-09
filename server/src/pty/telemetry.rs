//! the relay's telemetry rows (`term.open`, `term.reconnect`,
//! `term.bytes` in `telemetry/schema.ts`). they go through the same
//! normalization as the ingest, so an undeclared prop is dropped here
//! exactly as it would be from a client, and reach the same writer.

use serde_json::{Map, Value, json};
use tracing::debug;

use crate::telemetry::{self, Batch, Origin, dictionary};

const MAX_DEVICE_CHARS: usize = 40;

/// who the rows are about: the device and class the pane named when it
/// dialled, or the server's own when it named none.
#[derive(Debug, Clone)]
pub struct Stamp {
    device: String,
    class: String,
    host: String,
}

impl Stamp {
    #[must_use]
    pub fn new(device: Option<&str>, class: Option<&str>, host: &str) -> Self {
        let device = device.map(str::trim).filter(|d| !d.is_empty()).map_or_else(
            || "server".to_owned(),
            |d| d.chars().take(MAX_DEVICE_CHARS).collect(),
        );
        let class = class
            .filter(|c| dictionary::is_device_class(c))
            .unwrap_or("server")
            .to_owned();
        Self {
            device,
            class,
            host: host.to_owned(),
        }
    }
}

/// one row: its kind, outcome, duration and props.
#[derive(Debug)]
pub struct Row {
    kind: &'static str,
    ok: Option<bool>,
    ms: Option<u64>,
    props: Map<String, Value>,
}

impl Row {
    #[must_use]
    pub fn new(kind: &'static str) -> Self {
        Self {
            kind,
            ok: None,
            ms: None,
            props: Map::new(),
        }
    }

    #[must_use]
    pub fn ok(mut self, ok: bool) -> Self {
        self.ok = Some(ok);
        self
    }

    #[must_use]
    pub fn ms(mut self, ms: u64) -> Self {
        self.ms = Some(ms);
        self
    }

    #[must_use]
    pub fn prop(mut self, name: &str, value: impl Into<Value>) -> Self {
        self.props.insert(name.to_owned(), value.into());
        self
    }
}

/// hands the row to the writer without waiting. a writer that is backed
/// up loses the row, which is what the ingest does with a client's batch
/// it cannot take; a relay never waits on telemetry.
pub fn emit(sender: &telemetry::Sender, stamp: &Stamp, row: Row) {
    let received_at = crate::now_ms();
    let mut event = json!({
        "kind": row.kind,
        "at": received_at,
        "surface": "term",
        "host": stamp.host,
        "props": Value::Object(row.props),
    });
    if let Some(ok) = row.ok {
        event["ok"] = Value::from(u8::from(ok));
    }
    if let Some(ms) = row.ms {
        event["ms"] = Value::from(ms);
    }
    let origin = Origin {
        device: &stamp.device,
        device_class: &stamp.class,
        received_at,
        server: false,
    };
    let mut dropped = Vec::new();
    let mut mint = || format!("{received_at:x}-{:08x}", rand::random::<u32>());
    let rows: Vec<_> = telemetry::normalize::normalize(&event, origin, &mut mint, &mut dropped)
        .into_iter()
        .collect();
    if sender.send(Batch { rows, dropped }).is_err() {
        debug!(
            kind = row.kind,
            "telemetry is backed up; the relay's row was not kept"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unnamed_or_unknown_device_is_stamped_as_the_server() {
        let stamp = Stamp::new(None, Some("toaster"), "bench");
        assert_eq!(stamp.device, "server");
        assert_eq!(stamp.class, "server");
        let stamp = Stamp::new(Some("d-1"), Some("automation"), "bench");
        assert_eq!(
            (stamp.device.as_str(), stamp.class.as_str()),
            ("d-1", "automation")
        );
        let long = "x".repeat(90);
        assert_eq!(
            Stamp::new(Some(&long), None, "h").device.len(),
            MAX_DEVICE_CHARS
        );
    }

    #[test]
    fn every_row_the_relay_writes_is_declared() {
        let rows = [
            Row::new("term.open")
                .ok(true)
                .ms(12)
                .prop("resume", 0)
                .prop("replayed", 40)
                .prop("dropped", 0),
            Row::new("term.reconnect")
                .ok(false)
                .prop("cause", "overflow")
                .prop("error", "cannot connect"),
            Row::new("term.bytes")
                .ms(1)
                .prop("down", 10)
                .prop("up", 2)
                .prop("redials", 1)
                .prop("overflows", 0)
                .prop("end", "closed"),
        ];
        for row in rows {
            let kind =
                dictionary::kind(row.kind).unwrap_or_else(|| panic!("{} is declared", row.kind));
            for name in row.props.keys() {
                assert!(
                    kind.props.iter().any(|p| p.name == name),
                    "{}.{name} is declared",
                    row.kind
                );
            }
        }
    }
}
