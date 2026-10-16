//! a connection as `boxbox.toml` or a pairing gives it: one socket or event
//! stream, one credential, one supervisor child (`docs/agents.md`, section
//! 8, config). `[[host]]` is sugar for `[[cmx2]]`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use reqwest::Url;

use crate::config::{HostConfig, Origin};
use crate::wire::Source;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionConfig {
    Cmx2(HostConfig),
    Openclaw(OpenclawConfig),
    /// reserved for m10; no source runs one yet.
    Hermes(HermesConfig),
}

/// an `[[openclaw]]` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenclawConfig {
    /// at most 24 characters, so derived agent keys fit.
    pub name: String,
    /// the gateway's websocket, `wss://` or `ws://` on loopback.
    pub url: Url,
    /// a file holding the gateway token, mode 0600; read when the source connects.
    pub token_file: PathBuf,
    /// a file holding the gateway device key, mode 0600; boxbox keeps its
    /// own in `source_secrets` when absent (`openclaw.md` 3.2).
    pub device_key: Option<PathBuf>,
    pub mode: OpenclawMode,
    /// the computer it runs on, as labels say it; the connection's name when absent.
    pub machine: Option<String>,
    /// `[openclaw.agents.<foreign id>]`: per agent overrides.
    pub agents: BTreeMap<String, AgentOverride>,
    pub origin: Origin,
}

/// how much an openclaw connection may do (`openclaw.md` 3.1).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum OpenclawMode {
    #[default]
    Full,
    /// sends nothing that writes: every write capability is false
    /// (`openclaw.md`, section 4).
    Watch,
}

/// a `[[hermes]]` entry: the seam reserves it (decision 35).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HermesConfig {
    pub name: String,
    pub url: Url,
    pub token_file: Option<PathBuf>,
    pub machine: Option<String>,
    pub origin: Origin,
}

/// what the config pins for one foreign agent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentOverride {
    /// the agent key, `[a-z0-9-]{1,32}`, instead of the derived one.
    pub key: Option<String>,
    /// the label's name.
    pub name: Option<String>,
    /// a named assistant palette slot.
    pub palette: Option<String>,
}

impl ConnectionConfig {
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Cmx2(c) => &c.name,
            Self::Openclaw(c) => &c.name,
            Self::Hermes(c) => &c.name,
        }
    }

    #[must_use]
    pub fn url(&self) -> &Url {
        match self {
            Self::Cmx2(c) => &c.url,
            Self::Openclaw(c) => &c.url,
            Self::Hermes(c) => &c.url,
        }
    }

    #[must_use]
    pub fn origin(&self) -> Origin {
        match self {
            Self::Cmx2(c) => c.origin,
            Self::Openclaw(c) => c.origin,
            Self::Hermes(c) => c.origin,
        }
    }

    #[must_use]
    pub fn source(&self) -> Source {
        match self {
            Self::Cmx2(_) => Source::Cmx2,
            Self::Openclaw(_) => Source::Openclaw,
            Self::Hermes(_) => Source::Hermes,
        }
    }

    /// the computer the connection's agents run on, as labels say it.
    #[must_use]
    pub fn machine(&self) -> &str {
        match self {
            Self::Cmx2(c) => &c.name,
            Self::Openclaw(c) => c.machine.as_deref().unwrap_or(&c.name),
            Self::Hermes(c) => c.machine.as_deref().unwrap_or(&c.name),
        }
    }
}
