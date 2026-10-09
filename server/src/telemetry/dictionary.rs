//! the telemetry dictionary, generated from `telemetry/schema.json` at
//! build time (see `build/telemetry.rs`). `telemetry/schema.ts` is the
//! source of truth (decision 17); nothing here is edited by hand.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnType {
    Text,
    Integer,
    Real,
}

#[derive(Debug)]
pub struct Column {
    pub name: &'static str,
    pub ty: ColumnType,
}

#[derive(Debug)]
pub struct Prop {
    pub name: &'static str,
    pub ty: ColumnType,
}

#[derive(Debug)]
pub struct Kind {
    pub name: &'static str,
    pub props: &'static [Prop],
}

include!(concat!(env!("OUT_DIR"), "/telemetry.rs"));

/// the declared kind called `name`.
#[must_use]
pub fn kind(name: &str) -> Option<&'static Kind> {
    KINDS
        .binary_search_by(|kind| kind.name.cmp(name))
        .ok()
        .and_then(|at| KINDS.get(at))
}

#[must_use]
pub fn is_device_class(class: &str) -> bool {
    DEVICE_CLASSES.contains(&class)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_sorted_so_lookup_finds_every_one() {
        assert!(KINDS.windows(2).all(|pair| pair[0].name < pair[1].name));
        for declared in KINDS {
            assert_eq!(kind(declared.name).map(|k| k.name), Some(declared.name));
        }
        assert!(kind("agent.imaginary").is_none());
    }

    #[test]
    fn carries_the_v1_envelope_and_kinds() {
        let names: Vec<&str> = ENVELOPE.iter().map(|c| c.name).collect();
        assert_eq!(
            names,
            [
                "id",
                "at",
                "kind",
                "device",
                "device_class",
                "surface",
                "host",
                "session",
                "repo",
                "ok",
                "ms",
                "props"
            ]
        );
        for v1_kind in [
            "app.open",
            "verb",
            "agent.prompt",
            "board.key",
            "friction.rage",
        ] {
            assert!(kind(v1_kind).is_some(), "{v1_kind} keeps its name");
        }
        assert!(is_device_class("board") && is_device_class("automation"));
        assert!(!is_device_class("toaster"));
    }
}
