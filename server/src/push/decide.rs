//! who gets buzzed: one pure function, table-tested
//! (`architecture.md`, push and presence). every call ends in a
//! `push.decided` row, the suppressed ones included, so a dead funnel shows
//! in a day, not months later.

use std::time::Duration;

use super::notice::{About, KindSet, Notice};

/// a "done" waits this long, and is dropped if the person looks at the
/// thread or the agent carries on meanwhile (`design.md`, attention).
pub const DONE_DELAY: Duration = Duration::from_secs(10);

/// why a notice did or did not go out. the names are the `reason` values
/// of `push.decided` and are never renamed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Sent,
    Watched,
    Continued,
    NotArmed,
    OwnAction,
    Subagent,
    Replayed,
    NoSubscriptions,
    KindOff,
    Duplicate,
}

impl Reason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sent => "sent",
            Self::Watched => "watched",
            Self::Continued => "continued",
            Self::NotArmed => "not-armed",
            Self::OwnAction => "own-action",
            Self::Subagent => "subagent",
            Self::Replayed => "replayed",
            Self::NoSubscriptions => "no-subscriptions",
            Self::KindOff => "kind-off",
            Self::Duplicate => "duplicate",
        }
    }
}

/// a notice arrives fresh, or comes back when its delay has run out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Fresh,
    Delayed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// push to these devices now.
    Send(Vec<String>),
    /// ask again after this long (a "done" waiting out its delay).
    Wait(Duration),
    /// push to nobody, for this reason.
    Drop(Reason),
}

/// judges one notice. `watched` is whether any device is looking at the
/// thread; `devices` is every subscribed device with its chosen kinds.
#[must_use]
pub fn decide<'a>(
    notice: &Notice,
    stage: Stage,
    watched: bool,
    devices: impl IntoIterator<Item = (&'a str, KindSet)>,
) -> Decision {
    let origin = notice.origin;
    if origin.replayed {
        return Decision::Drop(Reason::Replayed);
    }
    if origin.subagent {
        return Decision::Drop(Reason::Subagent);
    }
    if origin.own_action {
        return Decision::Drop(Reason::OwnAction);
    }
    let done = notice.about == About::Done;
    if done && !origin.armed {
        return Decision::Drop(Reason::NotArmed);
    }
    if watched {
        return Decision::Drop(Reason::Watched);
    }
    if done && stage == Stage::Fresh {
        return Decision::Wait(DONE_DELAY);
    }
    let kind = notice.about.kind();
    let mut subscribed = 0;
    let targets: Vec<String> = devices
        .into_iter()
        .inspect(|_| subscribed += 1)
        .filter(|(_, kinds)| kinds.contains(kind))
        .map(|(device, _)| device.to_owned())
        .collect();
    match (targets.is_empty(), subscribed) {
        (false, _) => Decision::Send(targets),
        (true, 0) => Decision::Drop(Reason::NoSubscriptions),
        (true, _) => Decision::Drop(Reason::KindOff),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::notice::{AskKind, Kind, Origin, Thread};

    fn notice(about: About, origin: Origin) -> Notice {
        Notice {
            id: "n1".into(),
            about,
            thread: Thread::parse("desk:s1").unwrap(),
            title: "ledger wants you".into(),
            body: "which greeting?".into(),
            origin,
            badge: None,
        }
    }

    fn ask() -> About {
        About::Ask {
            id: "q1".into(),
            kind: AskKind::Question,
        }
    }

    const ARMED: Origin = Origin {
        armed: true,
        own_action: false,
        subagent: false,
        replayed: false,
    };

    /// the push matrix from `verification.md`, plus the prefs rows: each
    /// row is (what happened, stage, watched, devices, the decision).
    type Row<'a> = (
        &'a str,
        Notice,
        Stage,
        bool,
        &'a [(&'a str, KindSet)],
        Decision,
    );

    #[test]
    #[allow(clippy::too_many_lines, reason = "one table, one row per case")]
    fn the_push_matrix() {
        let all = [("phone", KindSet::ALL), ("mac", KindSet::ALL)];
        let asks_only = [("phone", KindSet::of(&[Kind::Ask]))];
        let split = [
            ("phone", KindSet::of(&[Kind::Ask])),
            ("mac", KindSet::of(&[Kind::Ready])),
        ];
        let rows: Vec<Row> = vec![
            (
                "an ask on a thread someone is looking at",
                notice(ask(), Origin::default()),
                Stage::Fresh,
                true,
                &all,
                Decision::Drop(Reason::Watched),
            ),
            (
                "an ask while every device is hidden or unfocused",
                notice(ask(), Origin::default()),
                Stage::Fresh,
                false,
                &all,
                Decision::Send(vec!["phone".into(), "mac".into()]),
            ),
            (
                "a done for a turn a person started waits its delay",
                notice(About::Done, ARMED),
                Stage::Fresh,
                false,
                &all,
                Decision::Wait(DONE_DELAY),
            ),
            (
                "the same done after its delay goes out",
                notice(About::Done, ARMED),
                Stage::Delayed,
                false,
                &all,
                Decision::Send(vec!["phone".into(), "mac".into()]),
            ),
            (
                "a done whose thread became watched during the delay",
                notice(About::Done, ARMED),
                Stage::Delayed,
                true,
                &all,
                Decision::Drop(Reason::Watched),
            ),
            (
                "a done for a turn nobody started",
                notice(About::Done, Origin::default()),
                Stage::Fresh,
                false,
                &all,
                Decision::Drop(Reason::NotArmed),
            ),
            (
                "the person's own interrupt",
                notice(
                    About::Fault,
                    Origin {
                        own_action: true,
                        ..Origin::default()
                    },
                ),
                Stage::Fresh,
                false,
                &all,
                Decision::Drop(Reason::OwnAction),
            ),
            (
                "a subagent finishing",
                notice(
                    About::Done,
                    Origin {
                        subagent: true,
                        ..ARMED
                    },
                ),
                Stage::Fresh,
                false,
                &all,
                Decision::Drop(Reason::Subagent),
            ),
            (
                "an event replayed after a reconnect",
                notice(
                    ask(),
                    Origin {
                        replayed: true,
                        ..Origin::default()
                    },
                ),
                Stage::Fresh,
                false,
                &all,
                Decision::Drop(Reason::Replayed),
            ),
            (
                "a fault with no device subscribed",
                notice(About::Fault, Origin::default()),
                Stage::Fresh,
                false,
                &[],
                Decision::Drop(Reason::NoSubscriptions),
            ),
            (
                "a fault to devices that only want asks",
                notice(About::Fault, Origin::default()),
                Stage::Fresh,
                false,
                &asks_only,
                Decision::Drop(Reason::KindOff),
            ),
            (
                "a ready worktree reaches only the devices that want it",
                notice(About::Ready, Origin::default()),
                Stage::Fresh,
                false,
                &split,
                Decision::Send(vec!["mac".into()]),
            ),
        ];
        for (what, notice, stage, watched, devices, expected) in rows {
            let decision = decide(&notice, stage, watched, devices.iter().copied());
            assert_eq!(decision, expected, "{what}");
        }
    }

    #[test]
    fn a_replay_is_dropped_before_anything_else_is_judged() {
        let replayed_own = Origin {
            replayed: true,
            own_action: true,
            subagent: true,
            armed: false,
        };
        let decision = decide(&notice(About::Done, replayed_own), Stage::Fresh, true, []);
        assert_eq!(decision, Decision::Drop(Reason::Replayed));
    }
}
