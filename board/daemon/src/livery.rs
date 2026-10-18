//! livery slots: a bound thread keeps one of the five palette slots 9 to 13
//! for as long as it is bound, and no two threads ever share one (a v1
//! defect: its slots were handed out by position while a thread kept its
//! old one, so a new binding could land on a slot in use). a slot's colour
//! is pushed to the board when it is assigned or changes, not only on
//! connect (the other v1 defect).

use boxbox_board_wire::Binding;

use crate::protocol::LIVERY_SLOTS;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Held {
    key: String,
    rgb: [u8; 3],
}

#[derive(Debug, Default)]
pub struct Liveries {
    held: [Option<Held>; 5],
    /// what the board holds in each slot; `None` after a connect.
    pushed: [Option<[u8; 3]>; 5],
}

impl Liveries {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// a new board knows none of the slots.
    pub fn connected(&mut self) {
        self.pushed = [None; 5];
    }

    /// assigns slots for these bindings: a thread already holding a slot
    /// keeps it, a slot whose thread is no longer bound frees, and a new
    /// thread takes the lowest free slot, in wire order. past five bound
    /// threads, the rest have no livery.
    pub fn sync(&mut self, bindings: &[Binding]) {
        let mut sorted: Vec<&Binding> = bindings.iter().collect();
        sorted.sort_by_key(|b| b.wire);
        for held in &mut self.held {
            if held
                .as_ref()
                .is_some_and(|h| !sorted.iter().any(|b| b.key == h.key))
            {
                *held = None;
            }
        }
        for b in sorted {
            if let Some(h) = self.held.iter_mut().flatten().find(|h| h.key == b.key) {
                h.rgb = b.color;
                continue;
            }
            if let Some(free) = self.held.iter_mut().find(|h| h.is_none()) {
                *free = Some(Held {
                    key: b.key.clone(),
                    rgb: b.color,
                });
            }
        }
    }

    /// the palette writes the board still needs: (slot, rgb) for each slot
    /// whose colour it does not hold. marks them pushed.
    pub fn pending(&mut self) -> Vec<(u8, [u8; 3])> {
        let mut out = Vec::new();
        for (i, held) in self.held.iter().enumerate() {
            let Some(h) = held else { continue };
            if self.pushed[i] != Some(h.rgb) {
                self.pushed[i] = Some(h.rgb);
                out.push((LIVERY_SLOTS[i], h.rgb));
            }
        }
        out
    }

    /// the slot a bound thread wears.
    #[must_use]
    pub fn slot(&self, key: &str) -> Option<u8> {
        self.held
            .iter()
            .position(|h| h.as_ref().is_some_and(|h| h.key == key))
            .map(|i| LIVERY_SLOTS[i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bind(wire: u8, key: &str, color: [u8; 3]) -> Binding {
        Binding {
            wire,
            key: key.into(),
            color,
        }
    }

    #[test]
    fn a_new_binding_takes_a_free_slot_and_is_pushed_at_once() {
        let mut l = Liveries::new();
        l.connected();
        l.sync(&[bind(11, "h:a", [1, 2, 3])]);
        assert_eq!(l.pending(), vec![(9, [1, 2, 3])]);
        assert!(l.pending().is_empty());
        l.sync(&[bind(11, "h:a", [1, 2, 3]), bind(4, "h:b", [4, 5, 6])]);
        assert_eq!(l.pending(), vec![(10, [4, 5, 6])]);
        assert_eq!(l.slot("h:a"), Some(9));
        assert_eq!(l.slot("h:b"), Some(10));
    }

    #[test]
    fn two_threads_never_share_a_slot() {
        let mut l = Liveries::new();
        l.sync(&[bind(4, "h:a", [1, 1, 1]), bind(5, "h:b", [2, 2, 2])]);
        // a unbinds, c binds on a lower wire: v1 handed c slot 9 by position
        // while b kept 10, then b's next re-sort gave b 9 too.
        l.sync(&[bind(5, "h:b", [2, 2, 2]), bind(1, "h:c", [3, 3, 3])]);
        let b = l.slot("h:b");
        let c = l.slot("h:c");
        assert_eq!(b, Some(10));
        assert_eq!(c, Some(9));
        l.sync(&[
            bind(5, "h:b", [2, 2, 2]),
            bind(1, "h:c", [3, 3, 3]),
            bind(0, "h:d", [4, 4, 4]),
        ]);
        let mut slots: Vec<u8> = ["h:b", "h:c", "h:d"]
            .iter()
            .filter_map(|k| l.slot(k))
            .collect();
        slots.sort_unstable();
        slots.dedup();
        assert_eq!(slots.len(), 3);
    }

    #[test]
    fn a_connect_pushes_every_held_slot_again() {
        let mut l = Liveries::new();
        l.sync(&[bind(4, "h:a", [1, 1, 1])]);
        assert_eq!(l.pending().len(), 1);
        l.connected();
        assert_eq!(l.pending(), vec![(9, [1, 1, 1])]);
    }

    #[test]
    fn a_colour_change_is_pushed() {
        let mut l = Liveries::new();
        l.sync(&[bind(4, "h:a", [1, 1, 1])]);
        l.pending();
        l.sync(&[bind(4, "h:a", [9, 9, 9])]);
        assert_eq!(l.pending(), vec![(9, [9, 9, 9])]);
    }
}
