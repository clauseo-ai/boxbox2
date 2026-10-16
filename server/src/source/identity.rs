//! who an agent is to a person (`docs/agents.md`, section 8): its label,
//! its mark and its palette. every source builds its agents' facts here, so
//! a cmx2 agent and an assistant are named by one rule.

use sha2::{Digest, Sha256};

use super::{AgentFacts, ConnectionConfig};
use crate::config::ASSISTANT_PALETTES;
use crate::wire::{Capabilities, Kind, Label, LabelSource, Mark, Source};

/// square for a coding agent (the repo mark windows show), round for an
/// assistant and for other.
#[must_use]
pub fn mark(kind: Kind) -> Mark {
    match kind {
        Kind::Coding => Mark::Square,
        Kind::Assistant | Kind::Other => Mark::Round,
    }
}

/// the agent's named slot. a coding agent has none (its threads keep the
/// repo palettes, hashed from `host:root`); any other agent wears the slot
/// its config names, else the one its key hashes to, so the same agent
/// keeps its colour across restarts and machines.
#[must_use]
pub fn palette(kind: Kind, configured: Option<&str>, key: &str) -> Option<String> {
    if kind == Kind::Coding {
        return None;
    }
    if let Some(slot) = configured.filter(|slot| ASSISTANT_PALETTES.contains(slot)) {
        return Some(slot.to_owned());
    }
    let digest = Sha256::digest(key.as_bytes());
    let at = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) as usize
        % ASSISTANT_PALETTES.len();
    Some(ASSISTANT_PALETTES[at].to_owned())
}

/// the runtime's word people read.
#[must_use]
pub fn label_source(source: Source) -> LabelSource {
    match source {
        Source::Cmx2 => LabelSource::Cmx,
        Source::Openclaw => LabelSource::Openclaw,
        Source::Hermes => LabelSource::Hermes,
    }
}

/// an agent's label: the config's name for it, else its own display name,
/// else none (every cmx2 agent); the machine is the config's, else the
/// connection's name.
#[must_use]
pub fn label(
    connection: &ConnectionConfig,
    configured: Option<&str>,
    display: Option<&str>,
) -> Label {
    let name = match connection {
        ConnectionConfig::Cmx2(_) => None,
        _ => configured
            .or(display)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
    };
    Label {
        name,
        source: label_source(connection.source()),
        machine: connection.machine().to_owned(),
    }
}

/// the label as a person reads it, the parts joined with " · ":
/// "cmx · vm-a", "assistant · openclaw · vm-b".
#[must_use]
pub fn words(label: &Label) -> String {
    let source = match label.source {
        LabelSource::Cmx => "cmx",
        LabelSource::Openclaw => "openclaw",
        LabelSource::Hermes => "hermes",
    };
    match &label.name {
        Some(name) => format!("{name} · {source} · {}", label.machine),
        None => format!("{source} · {}", label.machine),
    }
}

/// one foreign agent of a connection, as a source publishes it: the key it
/// was given (section 3), the config's overrides for its foreign id, and
/// the runtime's own display name.
#[must_use]
pub fn foreign(
    connection: &ConnectionConfig,
    foreign_id: &str,
    key: String,
    kind: Kind,
    display: Option<&str>,
    capabilities: Capabilities,
) -> AgentFacts {
    let configured = match connection {
        ConnectionConfig::Openclaw(c) => c.agents.get(foreign_id),
        ConnectionConfig::Cmx2(_) | ConnectionConfig::Hermes(_) => None,
    };
    let name = configured.and_then(|a| a.name.as_deref());
    let slot = configured.and_then(|a| a.palette.as_deref());
    AgentFacts {
        palette: palette(kind, slot, &key),
        key,
        foreign_id: Some(foreign_id.to_owned()),
        label: label(connection, name, display),
        kind,
        source: connection.source(),
        mark: mark(kind),
        capabilities,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::config::{HostConfig, Origin};
    use crate::source::{AgentOverride, OpenclawConfig, OpenclawMode};

    fn openclaw(machine: Option<&str>) -> ConnectionConfig {
        let mut agents = BTreeMap::new();
        agents.insert(
            "main".to_owned(),
            AgentOverride {
                key: Some("assistant".into()),
                name: Some("assistant".into()),
                palette: Some("coral".into()),
            },
        );
        ConnectionConfig::Openclaw(OpenclawConfig {
            name: "vm-b".into(),
            url: reqwest::Url::parse("ws://127.0.0.1:4740").unwrap(),
            token_file: "/tmp/token".into(),
            device_key: None,
            mode: OpenclawMode::Full,
            machine: machine.map(str::to_owned),
            agents,
            origin: Origin::Config,
        })
    }

    #[test]
    fn a_cmx2_agent_is_named_by_its_runtime_and_machine_and_never_by_a_name() {
        let host = ConnectionConfig::Cmx2(HostConfig {
            name: "vm-a".into(),
            url: reqwest::Url::parse("http://127.0.0.1:4840").unwrap(),
            credential: None,
            origin: Origin::Config,
        });
        let named = label(&host, Some("ignored"), Some("ignored"));
        assert_eq!(named.name, None);
        assert_eq!(words(&named), "cmx · vm-a");
        assert_eq!(mark(Kind::Coding), Mark::Square);
        assert_eq!(palette(Kind::Coding, Some("coral"), "vm-a"), None);
    }

    #[test]
    fn an_assistant_takes_the_configs_name_then_its_own_and_the_configs_machine() {
        let facts = foreign(
            &openclaw(Some("studio")),
            "main",
            "assistant".into(),
            Kind::Assistant,
            Some("Molty"),
            Capabilities::default(),
        );
        assert_eq!(words(&facts.label), "assistant · openclaw · studio");
        assert_eq!(facts.mark, Mark::Round);
        assert_eq!(facts.palette.as_deref(), Some("coral"));
        let other = foreign(
            &openclaw(None),
            "helper",
            "vm-b-helper".into(),
            Kind::Assistant,
            Some("Helper"),
            Capabilities::default(),
        );
        assert_eq!(words(&other.label), "Helper · openclaw · vm-b");
        let nameless = label(&openclaw(None), None, Some("  "));
        assert_eq!(words(&nameless), "openclaw · vm-b");
    }

    #[test]
    fn an_assistant_with_no_slot_takes_the_one_its_key_hashes_to_every_time() {
        let first = palette(Kind::Assistant, None, "vm-b-helper").unwrap();
        assert!(ASSISTANT_PALETTES.contains(&first.as_str()));
        assert_eq!(palette(Kind::Other, None, "vm-b-helper"), Some(first));
        // an unknown slot (config load refuses one; a paired agent cannot name one) falls back to the hash
        assert_eq!(
            palette(Kind::Assistant, Some("teal"), "vm-b-helper"),
            palette(Kind::Assistant, None, "vm-b-helper")
        );
        // the slots spread: twenty keys reach more than one of the five
        let seen: std::collections::BTreeSet<String> = (0..20)
            .filter_map(|n| palette(Kind::Assistant, None, &format!("agent-{n}")))
            .collect();
        assert!(seen.len() > 1, "{seen:?}");
    }
}
