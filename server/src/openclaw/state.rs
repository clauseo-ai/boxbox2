//! a connection's state as the agents screen reads it (`docs/home.md`,
//! pairing states; `docs/openclaw.md` 2.5, 3.3, 3.4): what the connection
//! task publishes on its watch channel, and its mapping to the neutral
//! wire's `AgentStatus` and `AgentConnection`.

use super::protocol::PINNED_VERSION;
use crate::source::{ConnectionStatus, OpenclawConfig};
use crate::upstream::FrameCounts;
use crate::wire::{AgentConnection, AgentStatus, Refusal};

/// where the connection is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Phase {
    /// dialling, handshaking, or waiting out a backoff after a clean drop.
    #[default]
    Connecting,
    /// the gateway waits for this device to be approved; `request_id` is
    /// what `openclaw devices approve` takes (3.4).
    Pairing { request_id: Option<String> },
    /// a `hello-ok` was accepted. syncing or ready is the sync engine's
    /// word: this state does not know whether every window has its read.
    Connected,
    /// the last attempt failed and another follows.
    Down,
    /// boxbox will not talk to the gateway until the config changes (or,
    /// for a protocol refusal, the next 30-minute retry).
    Refused(Refusal),
}

/// what the connection task publishes after every change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectionState {
    pub phase: Phase,
    /// ms, when the phase last changed.
    pub since: i64,
    /// plain words for the person; for pairing, the approval command.
    pub last_error: Option<String>,
    /// accepted hellos since boxbox started.
    pub connects: u64,
    /// `server.version` of the last hello.
    pub version: Option<String>,
    /// the gateway's protocol; on a protocol refusal, the one it speaks.
    pub protocol: Option<u32>,
    /// `version` is not the pin's.
    pub untested: bool,
    /// requested scopes the gateway did not grant. without
    /// `operator.admin`, nothing that starts a turn is sent (3.3 step 7).
    pub missing_scopes: Vec<&'static str>,
    pub boot_id: Option<String>,
}

impl ConnectionState {
    /// whether a turn-starting write may go out now.
    #[must_use]
    pub fn can_start_turns(&self) -> bool {
        self.phase == Phase::Connected && !self.missing_scopes.contains(&"operator.admin")
    }

    /// the agent status for this state; `synced` is the sync engine's
    /// word that every window has had its first read.
    #[must_use]
    pub fn status(&self, synced: bool) -> AgentStatus {
        match self.phase {
            Phase::Connecting => AgentStatus::Connecting,
            Phase::Pairing { .. } => AgentStatus::Pairing,
            Phase::Connected if synced => AgentStatus::Ready,
            Phase::Connected => AgentStatus::Syncing,
            Phase::Down => AgentStatus::Down,
            Phase::Refused(_) => AgentStatus::Refused,
        }
    }

    /// the neutral wire's connection facts for `config`.
    #[must_use]
    pub fn connection(&self, config: &OpenclawConfig, frames: FrameCounts) -> AgentConnection {
        AgentConnection {
            name: config.name.clone(),
            url: config.url.to_string(),
            origin: config.origin,
            since: self.since,
            last_error: self.last_error.clone(),
            connects: self.connects,
            version: self.version.clone(),
            pinned: Some(PINNED_VERSION.to_owned()),
            untested: self.untested,
            protocol: self.protocol,
            refused: match self.phase {
                Phase::Refused(why) => Some(why),
                _ => None,
            },
            contract: None,
            contract_matches: None,
            frames,
            memory: None,
            cursor: None,
        }
    }

    /// the seam's `SourceEvent::Connection` payload.
    #[must_use]
    pub fn connection_status(
        &self,
        config: &OpenclawConfig,
        synced: bool,
        frames: FrameCounts,
    ) -> ConnectionStatus {
        ConnectionStatus {
            status: self.status(synced),
            connection: self.connection(config, frames),
            host: None,
        }
    }
}

/// the words for a pairing wait (3.4; `docs/home.md` shows them verbatim
/// under "approve boxbox on <name>'s gateway:").
#[must_use]
pub fn pairing_words(request_id: Option<&str>) -> String {
    match request_id {
        Some(id) => format!("openclaw devices approve {id}"),
        None => "openclaw devices list, then openclaw devices approve <request id>".to_owned(),
    }
}

/// the words for a gateway that granted less than boxbox asked (3.3 step 7).
#[must_use]
pub fn degraded_words(name: &str, missing: &[&str]) -> String {
    if missing.contains(&"operator.admin") {
        format!(
            "approve admin on the gateway: {name} granted boxbox less than it asked for, so boxbox cannot send. some approvals will not show either."
        )
    } else {
        format!(
            "{name} did not grant boxbox {}; those asks will not show. pair it again to grant them.",
            missing.join(" or ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connected_is_syncing_until_the_sync_engine_says_ready() {
        let state = ConnectionState {
            phase: Phase::Connected,
            ..ConnectionState::default()
        };
        assert_eq!(state.status(false), AgentStatus::Syncing);
        assert_eq!(state.status(true), AgentStatus::Ready);
        assert!(state.can_start_turns());
    }

    #[test]
    fn every_phase_has_its_agent_status() {
        let status = |phase| {
            ConnectionState {
                phase,
                ..ConnectionState::default()
            }
            .status(true)
        };
        assert_eq!(status(Phase::Connecting), AgentStatus::Connecting);
        assert_eq!(
            status(Phase::Pairing { request_id: None }),
            AgentStatus::Pairing
        );
        assert_eq!(status(Phase::Down), AgentStatus::Down);
        assert_eq!(
            status(Phase::Refused(Refusal::Protocol)),
            AgentStatus::Refused
        );
    }

    #[test]
    fn without_admin_nothing_that_starts_a_turn_may_go() {
        let state = ConnectionState {
            phase: Phase::Connected,
            missing_scopes: vec!["operator.admin"],
            ..ConnectionState::default()
        };
        assert!(!state.can_start_turns());
        assert!(
            degraded_words("vm-b", &state.missing_scopes)
                .starts_with("approve admin on the gateway: vm-b")
        );
    }

    #[test]
    fn the_pairing_words_carry_the_approval_command() {
        assert_eq!(pairing_words(Some("r-1")), "openclaw devices approve r-1");
    }
}
