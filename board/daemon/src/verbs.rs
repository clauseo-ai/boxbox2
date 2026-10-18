//! verb derivation: raw down/up and a clock in, the four-verb grammar out. a
//! tap looks, a hold listens, a double speaks, a chord extends. one grammar for
//! all seventeen keys; the firmware knows none of it, and the timings are
//! daemon config.
//!
//! pure state machine with time as an input. the rules (`docs/board.md`, the
//! drive bank):
//!
//! - tap: down then up under `hold_ms`. reported only after the double window
//!   closes, because a second tap inside it upgrades to a double. keys where a
//!   double means nothing are listed as tap-immediate and skip the wait.
//! - hold: down past `hold_ms`. `HoldStart` fires at the threshold, while the
//!   key is still down; `HoldEnd` on release.
//! - double: two taps where the second down lands inside `double_ms` of the
//!   first up.
//! - chord: a second key goes down while another is held. both leave the
//!   grammar and the pair fires as one chord event. order-agnostic; the chord
//!   ends when either releases.

/// the two windows the grammar runs on, in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerbTimings {
    pub hold_ms: u64,
    pub double_ms: u64,
}

pub const DEFAULT_TIMINGS: VerbTimings = VerbTimings {
    hold_ms: 350,
    double_ms: 300,
};

/// a verb the grammar settled. `at` is the moment it happened, which can be
/// earlier than the call that reported it (a tap settles at its up).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerbEvent {
    Tap { wire: u8, at: u64 },
    Double { wire: u8, at: u64 },
    HoldStart { wire: u8, at: u64 },
    HoldEnd { wire: u8, at: u64, held_ms: u64 },
    Chord { wires: [u8; 2], at: u64 },
    ChordEnd { wires: [u8; 2], at: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyState {
    Down {
        down_at: u64,
    },
    /// `HoldStart` already fired.
    Held {
        down_at: u64,
    },
    /// waiting out the double window.
    TapPending {
        up_at: u64,
    },
    /// a double confirmed on this up.
    SecondDown {
        down_at: u64,
    },
}

/// the verb engine. feed it raw switch events, tick it on the clock, and sleep
/// until [`VerbEngine::next_deadline`].
#[derive(Debug)]
pub struct VerbEngine {
    /// kept in insertion order, as the typescript map was: the chord search and
    /// the tick walk both read it in that order. at most one entry per wire.
    keys: Vec<(u8, KeyState)>,
    chord: Option<[u8; 2]>,
    timings: VerbTimings,
    tap_immediate: Vec<u8>,
}

impl VerbEngine {
    #[must_use]
    pub fn new(timings: VerbTimings, tap_immediate: &[u8]) -> Self {
        Self {
            keys: Vec::new(),
            chord: None,
            timings,
            tap_immediate: tap_immediate.to_vec(),
        }
    }

    pub fn retime(&mut self, timings: VerbTimings) {
        self.timings = timings;
    }

    /// feeds a raw switch event at `at` and returns any verbs it settles.
    pub fn feed(&mut self, wire: u8, down: bool, at: u64) -> Vec<VerbEvent> {
        let mut out = Vec::new();
        let state = self.get(wire);

        if down {
            /* a second key while one is held or still down is a chord */
            if self.chord.is_none() {
                let other = self.keys.iter().find_map(|&(other, s)| {
                    let held_or_down = matches!(s, KeyState::Down { .. } | KeyState::Held { .. });
                    (other != wire && held_or_down).then_some(other)
                });
                if let Some(other) = other {
                    self.chord = Some([other, wire]);
                    /* the first key leaves the grammar: its pending life is cancelled */
                    self.delete(other);
                    self.delete(wire);
                    out.push(VerbEvent::Chord {
                        wires: [other, wire],
                        at,
                    });
                    return out;
                }
            }

            if let Some(KeyState::TapPending { up_at }) = state {
                /* a second down inside the double window */
                if at.saturating_sub(up_at) <= self.timings.double_ms {
                    self.set(wire, KeyState::SecondDown { down_at: at });
                    return out;
                }
                /* the window has closed but tick has not run yet: flush the tap */
                out.push(VerbEvent::Tap { wire, at: up_at });
            }
            self.set(wire, KeyState::Down { down_at: at });
            return out;
        }

        if let Some([a, b]) = self.chord {
            if wire == a || wire == b {
                out.push(VerbEvent::ChordEnd { wires: [a, b], at });
                self.chord = None;
                /* the surviving key of the pair is spent: its later up is ignored */
                self.delete(a);
                self.delete(b);
            }
            return out;
        }

        let Some(state) = state else {
            return out;
        };
        match state {
            KeyState::Held { down_at } => {
                out.push(VerbEvent::HoldEnd {
                    wire,
                    at,
                    held_ms: at.saturating_sub(down_at),
                });
                self.delete(wire);
            }
            KeyState::SecondDown { .. } => {
                out.push(VerbEvent::Double { wire, at });
                self.delete(wire);
            }
            KeyState::Down { down_at } => {
                if at.saturating_sub(down_at) >= self.timings.hold_ms {
                    /* released after the threshold but before tick noticed: a hold */
                    out.push(VerbEvent::HoldStart {
                        wire,
                        at: down_at + self.timings.hold_ms,
                    });
                    out.push(VerbEvent::HoldEnd {
                        wire,
                        at,
                        held_ms: at.saturating_sub(down_at),
                    });
                    self.delete(wire);
                } else if self.tap_immediate.contains(&wire) {
                    out.push(VerbEvent::Tap { wire, at });
                    self.delete(wire);
                } else {
                    self.set(wire, KeyState::TapPending { up_at: at });
                }
            }
            KeyState::TapPending { .. } => {}
        }
        out
    }

    /// advances the clock to `now`: fires each hold start at its threshold and
    /// settles each tap whose double window has closed. call it at a deadline.
    pub fn tick(&mut self, now: u64) -> Vec<VerbEvent> {
        let hold_ms = self.timings.hold_ms;
        let double_ms = self.timings.double_ms;
        let mut out = Vec::new();
        self.keys.retain_mut(|(wire, state)| match *state {
            KeyState::Down { down_at } if now.saturating_sub(down_at) >= hold_ms => {
                *state = KeyState::Held { down_at };
                out.push(VerbEvent::HoldStart {
                    wire: *wire,
                    at: down_at + hold_ms,
                });
                true
            }
            KeyState::TapPending { up_at } if now.saturating_sub(up_at) > double_ms => {
                out.push(VerbEvent::Tap {
                    wire: *wire,
                    at: up_at,
                });
                false
            }
            _ => true,
        });
        out
    }

    /// the next moment [`VerbEngine::tick`] would settle something, or `None`
    /// when no key is open. a deadline already past means tick now.
    #[must_use]
    pub fn next_deadline(&self) -> Option<u64> {
        self.keys
            .iter()
            .filter_map(|&(_, state)| match state {
                KeyState::Down { down_at } => Some(down_at + self.timings.hold_ms),
                KeyState::TapPending { up_at } => Some(up_at + self.timings.double_ms + 1),
                KeyState::Held { .. } | KeyState::SecondDown { .. } => None,
            })
            .min()
    }

    /// drops all in-flight state. called on a mode echo: a layer flip hides key
    /// events, so every open press, hold and pending tap is a lie the next real
    /// event would settle wrongly.
    pub fn reset(&mut self) {
        self.keys.clear();
        self.chord = None;
    }

    /// is this wire held past the threshold? the meter and the gauge key off it.
    #[must_use]
    pub fn is_held(&self, wire: u8) -> bool {
        matches!(self.get(wire), Some(KeyState::Held { .. }))
    }

    #[must_use]
    pub fn active_chord(&self) -> Option<[u8; 2]> {
        self.chord
    }

    fn get(&self, wire: u8) -> Option<KeyState> {
        self.keys
            .iter()
            .find(|(w, _)| *w == wire)
            .map(|&(_, state)| state)
    }

    /// a map set: an existing wire keeps its place in the order.
    fn set(&mut self, wire: u8, state: KeyState) {
        match self.keys.iter_mut().find(|(w, _)| *w == wire) {
            Some(entry) => entry.1 = state,
            None => self.keys.push((wire, state)),
        }
    }

    fn delete(&mut self, wire: u8) {
        self.keys.retain(|(w, _)| *w != wire);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: VerbTimings = VerbTimings {
        hold_ms: 350,
        double_ms: 300,
    };

    fn kinds(events: &[VerbEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match e {
                VerbEvent::Tap { .. } => "tap",
                VerbEvent::Double { .. } => "double",
                VerbEvent::HoldStart { .. } => "holdStart",
                VerbEvent::HoldEnd { .. } => "holdEnd",
                VerbEvent::Chord { .. } => "chord",
                VerbEvent::ChordEnd { .. } => "chordEnd",
            })
            .collect()
    }

    #[test]
    fn tap_settles_after_the_double_window() {
        let mut v = VerbEngine::new(T, &[]);
        assert!(v.feed(5, true, 0).is_empty());
        assert!(v.feed(5, false, 100).is_empty());
        assert!(v.tick(300).is_empty(), "window still open: 100 + 300 = 400");
        let settled = v.tick(401);
        assert_eq!(kinds(&settled), ["tap"]);
        assert_eq!(settled[0], VerbEvent::Tap { wire: 5, at: 100 });
    }

    #[test]
    fn double_second_down_inside_the_window_upgrades() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(5, true, 0);
        v.feed(5, false, 100);
        assert!(v.feed(5, true, 250).is_empty());
        assert_eq!(kinds(&v.feed(5, false, 320)), ["double"]);
        assert!(v.tick(1000).is_empty(), "nothing left pending");
    }

    #[test]
    fn two_slow_taps_are_two_taps_never_a_double() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(5, true, 0);
        v.feed(5, false, 100);
        let first = v.feed(5, true, 500); /* window closed at 400 */
        assert_eq!(kinds(&first), ["tap"]);
        v.feed(5, false, 560);
        assert_eq!(kinds(&v.tick(900)), ["tap"]);
    }

    #[test]
    fn hold_starts_at_the_threshold_via_tick_and_ends_on_release() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(7, true, 0);
        assert!(v.tick(349).is_empty());
        let start = v.tick(350);
        assert_eq!(kinds(&start), ["holdStart"]);
        assert_eq!(start[0], VerbEvent::HoldStart { wire: 7, at: 350 });
        let end = v.feed(7, false, 900);
        assert_eq!(kinds(&end), ["holdEnd"]);
        assert_eq!(
            end[0],
            VerbEvent::HoldEnd {
                wire: 7,
                at: 900,
                held_ms: 900
            }
        );
        assert!(!v.is_held(7));
    }

    #[test]
    fn hold_released_before_any_tick_still_resolves_as_a_hold() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(7, true, 0);
        assert_eq!(kinds(&v.feed(7, false, 500)), ["holdStart", "holdEnd"]);
    }

    #[test]
    fn chord_a_second_key_while_one_is_down_fuses_the_pair() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(15, true, 0); /* radio down */
        let chord = v.feed(4, true, 120);
        assert_eq!(kinds(&chord), ["chord"]);
        assert_eq!(
            chord[0],
            VerbEvent::Chord {
                wires: [15, 4],
                at: 120
            }
        );
        /* neither key taps or holds on release; the chord ends once */
        assert_eq!(kinds(&v.feed(15, false, 700)), ["chordEnd"]);
        assert!(v.feed(4, false, 800).is_empty());
        assert!(v.tick(2000).is_empty());
    }

    #[test]
    fn chord_swallows_the_first_keys_pending_hold() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(15, true, 0);
        v.tick(350); /* radio holdStart fired */
        let events = v.feed(9, true, 400);
        assert_eq!(kinds(&events), ["chord"]);
        assert_eq!(kinds(&v.feed(9, false, 500)), ["chordEnd"]);
        /* the radio's up must not fire a stray holdEnd */
        assert!(v.feed(15, false, 600).is_empty());
    }

    #[test]
    fn tap_immediate_keys_skip_the_double_window() {
        let mut v = VerbEngine::new(T, &[11]);
        v.feed(11, true, 0);
        assert_eq!(kinds(&v.feed(11, false, 80)), ["tap"]);
    }

    #[test]
    fn is_held_answers_while_held_for_the_meter_and_the_gauge() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(15, true, 0);
        v.tick(360);
        assert!(v.is_held(15));
        v.feed(15, false, 400);
        assert!(!v.is_held(15));
    }

    /// the 2026-07-27 wedge: nl went down on drive, the layer flipped to calc
    /// (which reports nothing), and the exit hold's orphaned key-up arrived
    /// minutes later, closing the stale hold with a monstrous held time. a mode
    /// echo must wipe in-flight state.
    #[test]
    fn reset_drops_open_holds_so_a_later_orphan_up_settles_nothing() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(0, true, 0);
        assert_eq!(kinds(&v.tick(350)), ["holdStart"]); /* the hold is open */
        v.reset(); /* mode echo: the layer flipped under us */
        assert!(
            v.feed(0, false, 200_000).is_empty(),
            "orphan up: no holdEnd"
        );
        assert!(v.tick(201_000).is_empty());
        assert!(!v.is_held(0));
    }

    #[test]
    fn reset_clears_an_active_chord() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(15, true, 0);
        assert_eq!(kinds(&v.feed(4, true, 100)), ["chord"]);
        v.reset();
        assert!(v.feed(15, false, 300).is_empty(), "no chordEnd after reset");
        assert_eq!(v.active_chord(), None);
    }

    #[test]
    fn deadline_is_the_next_hold_or_the_close_of_a_double_window() {
        let mut v = VerbEngine::new(T, &[]);
        assert_eq!(v.next_deadline(), None, "no key open: nothing to wake for");
        v.feed(5, true, 0);
        assert_eq!(v.next_deadline(), Some(350), "a down key wakes at its hold");
        v.feed(5, false, 100);
        assert_eq!(
            v.next_deadline(),
            Some(401),
            "a tap wakes one ms past its window"
        );
        assert!(
            v.tick(400).is_empty(),
            "the window is still open at its close"
        );
        assert_eq!(kinds(&v.tick(401)), ["tap"]);
        assert_eq!(v.next_deadline(), None);
    }

    #[test]
    fn deadline_fires_the_event_when_ticked_at_it() {
        let mut v = VerbEngine::new(T, &[]);
        v.feed(7, true, 1_000);
        let at = v.next_deadline().expect("a hold is pending");
        assert_eq!(kinds(&v.tick(at)), ["holdStart"]);
        assert_eq!(
            v.next_deadline(),
            None,
            "a held key has no deadline of its own"
        );
    }

    #[test]
    fn retime_changes_the_windows_for_the_next_event() {
        let mut v = VerbEngine::new(T, &[]);
        v.retime(VerbTimings {
            hold_ms: 100,
            double_ms: 300,
        });
        v.feed(7, true, 0);
        assert_eq!(kinds(&v.tick(100)), ["holdStart"]);
    }
}
