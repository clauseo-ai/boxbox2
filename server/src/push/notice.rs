//! what the fleet hands push: a notice about one thread, with the facts
//! `decide` needs to judge it. the fleet knows what happened; push knows
//! who is looking and who is subscribed.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// the kinds a person turns on per device (`design.md`, attention: "which
/// of the four kinds push. that is the whole settings page for push").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
#[schema(as = PushKind)]
pub enum Kind {
    /// a question or a permission.
    Ask,
    /// a turn a person started is done.
    Done,
    /// a real fault.
    Fault,
    /// a worktree is ready to review.
    Ready,
}

impl Kind {
    pub const ALL: [Self; 4] = [Self::Ask, Self::Done, Self::Fault, Self::Ready];

    const fn bit(self) -> u8 {
        match self {
            Self::Ask => 1,
            Self::Done => 2,
            Self::Fault => 4,
            Self::Ready => 8,
        }
    }
}

/// a device's chosen kinds, stored as a bitset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindSet(u8);

impl KindSet {
    pub const ALL: Self = Self(15);

    #[must_use]
    pub fn of(kinds: &[Kind]) -> Self {
        Self(kinds.iter().fold(0, |bits, kind| bits | kind.bit()))
    }

    /// from the stored column; bits this build does not know are ignored.
    #[must_use]
    pub fn from_bits(bits: i64) -> Self {
        Self(u8::try_from(bits & i64::from(Self::ALL.0)).unwrap_or(0))
    }

    #[must_use]
    pub fn bits(self) -> i64 {
        i64::from(self.0)
    }

    #[must_use]
    pub fn contains(self, kind: Kind) -> bool {
        self.0 & kind.bit() != 0
    }

    #[must_use]
    pub fn kinds(self) -> Vec<Kind> {
        Kind::ALL
            .into_iter()
            .filter(|kind| self.contains(*kind))
            .collect()
    }
}

/// a thread's identity, `host:session` (`scars.md`, line 1335: composite
/// ids that do not parse are refused).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Thread {
    key: String,
    split: usize,
}

impl Thread {
    /// parses `host:session`; the host follows `boxbox.toml`'s naming rule.
    #[must_use]
    pub fn parse(key: &str) -> Option<Self> {
        let (host, session) = key.split_once(':')?;
        let host_ok = !host.is_empty()
            && host.len() <= 32
            && host
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        let session_ok = !session.is_empty()
            && session.len() <= 128
            && session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        (host_ok && session_ok).then(|| Self {
            key: key.to_owned(),
            split: host.len(),
        })
    }

    #[must_use]
    pub fn key(&self) -> &str {
        &self.key
    }

    #[must_use]
    pub fn host(&self) -> &str {
        &self.key[..self.split]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AskKind {
    Question,
    Permission,
}

/// what a notice is about. an ask carries its id, so tapping opens the
/// thread with that ask focused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum About {
    Ask { id: String, kind: AskKind },
    Done,
    Fault,
    Ready,
}

impl About {
    #[must_use]
    pub fn kind(&self) -> Kind {
        match self {
            Self::Ask { .. } => Kind::Ask,
            Self::Done => Kind::Done,
            Self::Fault => Kind::Fault,
            Self::Ready => Kind::Ready,
        }
    }

    /// the telemetry `need` prop: question | permission | done | fault | ready.
    #[must_use]
    pub fn need(&self) -> &'static str {
        match self {
            Self::Ask {
                kind: AskKind::Question,
                ..
            } => "question",
            Self::Ask {
                kind: AskKind::Permission,
                ..
            } => "permission",
            Self::Done => "done",
            Self::Fault => "fault",
            Self::Ready => "ready",
        }
    }
}

/// the facts about where an event came from that rule a push out
/// (`architecture.md`, push and presence). the fleet fills them; `decide`
/// reads them.
#[allow(
    clippy::struct_excessive_bools,
    reason = "four independent facts, each a reason of its own"
)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Origin {
    /// a person started the turn this "done" ends (armed by the send route).
    pub armed: bool,
    /// the person's own action caused it (their interrupt, their abort).
    pub own_action: bool,
    /// a subagent raised it, not the thread's own agent.
    pub subagent: bool,
    /// it arrived in a replay after a reconnect, not live.
    pub replayed: bool,
}

/// one thing that might buzz a pocket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// stable for the event (`ask:<id>`, `done:<message id>`): the same
    /// event never reaches a device twice.
    pub id: String,
    pub about: About,
    pub thread: Thread,
    /// "ledger wants you", "api is done": written by the fleet in the voice.
    pub title: String,
    /// the question, the result line, the reason; trimmed to fit a banner.
    pub body: String,
    pub origin: Origin,
    /// the app icon's number after this notice, when the fleet knows it.
    pub badge: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_keys_parse_only_as_host_colon_session() {
        let thread = Thread::parse("desk:ses_01J9").unwrap();
        assert_eq!((thread.host(), thread.key()), ("desk", "desk:ses_01J9"));
        for bad in [
            "",
            "desk",
            ":ses",
            "desk:",
            "Desk:ses",
            "desk:ses/x",
            "a:b:c",
        ] {
            assert!(Thread::parse(bad).is_none(), "{bad} parsed");
        }
    }

    #[test]
    fn a_kind_set_round_trips_through_its_column_and_ignores_unknown_bits() {
        let set = KindSet::of(&[Kind::Ask, Kind::Fault]);
        assert_eq!(KindSet::from_bits(set.bits()), set);
        assert_eq!(set.kinds(), vec![Kind::Ask, Kind::Fault]);
        assert_eq!(KindSet::from_bits(255), KindSet::ALL);
        assert!(!set.contains(Kind::Done));
    }
}
