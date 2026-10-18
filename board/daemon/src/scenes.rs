//! the scene engine: fleet truth in, seventeen cells out. every scene in the
//! catalogue renders here, pure, so the tests can pin each one to a frame
//! (`docs/board.md`). time is an input: the player takes `now_ms`, never a
//! clock.
//!
//! two layers compose every frame: a base (the current bank, a function of
//! state) and an optional transient (a one-shot animation that overrides whole
//! frames or single cells). deep work filters the result. the night curve
//! rides the global byte in the daemon, never here.

use std::collections::VecDeque;

use boxbox_board_wire::Need;

use crate::protocol::{
    BREATH_SLOT, Cell, Cells, DARK_FRAME, FLOOR_CELL, KEY_COUNT, Key, LIVE_BREATH_SLOT, cell,
    level, slot,
};

/// a transient's cells: `None` is transparent, and the base shows through.
pub type Overlay = [Option<Cell>; KEY_COUNT];

const CLEAR: Overlay = [None; KEY_COUNT];

/// the most transients that may wait behind the playing one. a full queue
/// refuses the next push, so a burst of arrivals cannot grow it without bound.
pub const QUEUE_CAP: usize = 32;

/// the digit keys in rank order: rank n sits on the key whose cap says n, so
/// the glass's badges and the pad agree.
pub const DIGIT_WIRES: [Key; 9] = [
    Key::K1,
    Key::K2,
    Key::K3,
    Key::K4,
    Key::K5,
    Key::K6,
    Key::K7,
    Key::K8,
    Key::K9,
];

/// the four machine lights, in board order. decision 79: `+` joins `/ * -`,
/// and the copy-armed light it used to show moves to the dot key.
pub const MACHINE_WIRES: [Key; 4] = [Key::Div, Key::Mul, Key::Min, Key::Plus];

/// the board's perimeter, clockwise: the racetrack.
pub const RING: [Key; 11] = [
    Key::Nl,
    Key::Div,
    Key::Mul,
    Key::Min,
    Key::Plus,
    Key::Ent,
    Key::Dot,
    Key::K0,
    Key::K1,
    Key::K4,
    Key::K7,
];

/// four column stacks, bottom to top, for meters. the fourth is v1's as it is:
/// it lists `ent` twice, so its heights 1 and 2 light the same key.
pub const STACKS: [[Key; 5]; 4] = [
    [Key::K0, Key::K1, Key::K4, Key::K7, Key::Nl],
    [Key::K0, Key::K2, Key::K5, Key::K8, Key::Div],
    [Key::Dot, Key::K3, Key::K6, Key::K9, Key::Mul],
    [Key::Ent, Key::Ent, Key::Plus, Key::Plus, Key::Min],
];

/// the briefing's rows, in the order the sweep lights them.
const BRIEFING_ROWS: [&[Key]; 5] = [
    &[Key::Nl, Key::Div, Key::Mul, Key::Min],
    &[Key::K7, Key::K8, Key::K9, Key::Plus],
    &[Key::K4, Key::K5, Key::K6],
    &[Key::K1, Key::K2, Key::K3, Key::Ent],
    &[Key::K0, Key::Dot],
];

/// a key's cell at the next keypad frame, step by step.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransientFrame {
    pub hold_ms: u64,
    /// `None` is transparent: the base shows through.
    pub cells: Overlay,
}

/// a one-shot animation: frames played in order, each held for its `hold_ms`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transient {
    pub name: &'static str,
    pub frames: Vec<TransientFrame>,
    /// survives the deep work filter (permission arrivals, red flags).
    pub essential: bool,
}

fn put(cells: &mut Overlay, key: Key, c: Cell) {
    cells[key.index()] = Some(c);
}

/// the ring key `i` steps around, wrapping.
fn ring_at(i: usize) -> Key {
    RING[i % RING.len()]
}

fn frame(hold_ms: u64, cells: Overlay) -> TransientFrame {
    TransientFrame { hold_ms, cells }
}

/// a key bound to a livery: the formation lap sweeps it in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Livery {
    pub wire: Key,
    pub slot: u8,
}

/// the transient player: one transient at a time, the rest queued behind it.
/// it owns the clock of the transient it plays; the caller supplies `now_ms`.
#[derive(Debug, Default)]
pub struct TransientPlayer {
    active: Option<Playing>,
    queue: VecDeque<Transient>,
}

#[derive(Debug)]
struct Playing {
    transient: Transient,
    frame: usize,
    /// when the current frame ends, on the caller's clock.
    frame_end: u64,
}

impl Playing {
    fn start(transient: Transient, now_ms: u64) -> Self {
        let frame_end = transient
            .frames
            .first()
            .map_or(now_ms, |f| now_ms.saturating_add(f.hold_ms));
        Self {
            transient,
            frame: 0,
            frame_end,
        }
    }
}

impl TransientPlayer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// plays `t` now if nothing is playing, else queues it behind the rest.
    /// returns `false` when the queue is full and `t` was dropped.
    pub fn push(&mut self, t: Transient, now_ms: u64) -> bool {
        if self.active.is_some() {
            /* one at a time; arrivals queue, they never interleave */
            if self.queue.len() >= QUEUE_CAP {
                return false;
            }
            self.queue.push_back(t);
        } else {
            self.active = Some(Playing::start(t, now_ms));
        }
        true
    }

    /// the overlay for this instant, or `None` when no transient is running or
    /// the deep work filter holds a non-essential one back. advances the player.
    #[must_use]
    pub fn current(&mut self, now_ms: u64, deep_work: bool) -> Option<Overlay> {
        self.advance(now_ms);
        let playing = self.active.as_ref()?;
        if deep_work && !playing.transient.essential {
            return None;
        }
        playing.transient.frames.get(playing.frame).map(|f| f.cells)
    }

    /// when the playing frame ends, on the caller's clock: the moment to call
    /// [`TransientPlayer::current`] again. `None` when idle. a deadline already
    /// past means call now.
    #[must_use]
    pub fn next_deadline(&self) -> Option<u64> {
        self.active.as_ref().map(|p| p.frame_end)
    }

    /// whether a transient is playing or queued.
    #[must_use]
    pub fn busy(&self) -> bool {
        self.active.is_some()
    }

    /// drops the playing transient and the queue, as an unplug does.
    pub fn clear(&mut self) {
        self.active = None;
        self.queue.clear();
    }

    /// moves past every frame that has ended by `now_ms`, and starts the next
    /// queued transient at `now_ms` once the playing one has finished.
    fn advance(&mut self, now_ms: u64) {
        loop {
            let Some(playing) = self.active.as_mut() else {
                return;
            };
            if now_ms < playing.frame_end {
                return;
            }
            playing.frame += 1;
            if let Some(next) = playing.transient.frames.get(playing.frame) {
                playing.frame_end = playing.frame_end.saturating_add(next.hold_ms);
                continue;
            }
            self.active = self.queue.pop_front().map(|t| Playing::start(t, now_ms));
        }
    }
}

/// formation lap: the roll call. every bound key sweeps in its livery, then the
/// base settles. with no bindings, a ring sweep in `you` introduces the board.
#[must_use]
pub fn formation_lap(bound: &[Livery]) -> Transient {
    let mut frames = Vec::new();
    if bound.is_empty() {
        for i in 0..RING.len() {
            let mut cells = CLEAR;
            put(&mut cells, ring_at(i), cell(slot::YOU, level::HOT));
            put(
                &mut cells,
                ring_at(i + RING.len() - 1),
                cell(slot::YOU, level::DIM),
            );
            frames.push(frame(70, cells));
        }
    } else {
        for (i, b) in bound.iter().enumerate() {
            let mut cells = CLEAR;
            put(&mut cells, b.wire, cell(b.slot, level::HOT));
            if let Some(prev) = i.checked_sub(1).and_then(|j| bound.get(j)) {
                put(&mut cells, prev.wire, cell(prev.slot, level::DIM));
            }
            frames.push(frame(420, cells));
        }
    }
    Transient {
        name: "formation",
        frames,
        essential: false,
    }
}

/// the briefing: the night replayed in three seconds. a green sweep per row,
/// twice, then the base takes over.
#[must_use]
pub fn briefing() -> Transient {
    let mut frames = Vec::new();
    for pass in 0..2 {
        for row in BRIEFING_ROWS {
            let mut cells = CLEAR;
            for &w in row {
                put(&mut cells, w, cell(slot::LIVE, level::MID));
            }
            frames.push(frame(140, cells));
        }
        frames.push(frame(if pass == 0 { 200 } else { 350 }, CLEAR));
    }
    Transient {
        name: "briefing",
        frames,
        essential: false,
    }
}

/// box box: a need arrives. two pulses at its key, then stillness. the base
/// holds it at rest and age does any further shouting.
#[must_use]
pub fn arrival_pulse(wire: Key, slot: u8, essential: bool) -> Transient {
    let mut on = CLEAR;
    put(&mut on, wire, cell(slot, level::HOT));
    let mut off = CLEAR;
    put(&mut off, wire, cell(slot::OFF, level::OFF));
    Transient {
        name: "arrival",
        essential,
        frames: vec![
            frame(240, on),
            frame(170, off),
            frame(240, on),
            frame(170, off),
        ],
    }
}

/// the victory lap: two green laps around the perimeter with a trail. fires on
/// a verdict (a reviewable checkout leaving the board).
#[must_use]
pub fn victory_lap() -> Transient {
    let mut frames = Vec::new();
    for _lap in 0..2 {
        for i in 0..RING.len() {
            let mut cells = CLEAR;
            put(&mut cells, ring_at(i), cell(slot::LIVE, level::HOT));
            put(
                &mut cells,
                ring_at(i + RING.len() - 1),
                cell(slot::LIVE, level::MID),
            );
            put(
                &mut cells,
                ring_at(i + RING.len() - 2),
                cell(slot::LIVE, level::DIM),
            );
            frames.push(frame(80, cells));
        }
    }
    Transient {
        name: "victory",
        frames,
        essential: false,
    }
}

/// the red flag: a fault announces itself. the base then holds it hot.
#[must_use]
pub fn red_flag(wire: Key) -> Transient {
    arrival_pulse(wire, slot::FAULT, true)
}

/// the voice meter: four rms bands, each 0 to 5, climbing the four stacks.
#[must_use]
pub fn vu_cells(bands: [u8; 4]) -> Overlay {
    let mut cells = CLEAR;
    for (stack, &h) in STACKS.iter().zip(bands.iter()) {
        let height = usize::from(h.min(5));
        for (i, &wire) in stack.iter().enumerate().take(height) {
            let head = i + 1 == height;
            let c = cell(slot::YOU, if head { level::HOT } else { level::REST });
            match cells[wire.index()] {
                Some(prev) if prev >= c => {}
                _ => put(&mut cells, wire, c),
            }
        }
    }
    cells
}

/// the queue view, shown while a seat is held: one lime key per parked order
/// on the digit keys, and ent gold when a flush is armed. depth 0 is an honest
/// empty board.
#[must_use]
pub fn queue_cells(depth: usize) -> Cells {
    let mut cells = DARK_FRAME;
    let n = depth.min(9);
    for &w in DIGIT_WIRES.iter().take(n) {
        cells[w.index()] = cell(slot::LIVE, level::BRIGHT);
    }
    if n > 0 {
        cells[Key::Ent.index()] = cell(slot::PERM, level::BRIGHT);
    }
    cells
}

/// a seat: one session that wants the person, as the drive bank shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seat {
    /// `${host}:${sessionID}`, the key the routes take.
    pub key: String,
    pub need: Need,
    /// earned the chip: a fault always, any other need after ten minutes waiting.
    pub hot: bool,
}

/// a seat that is working, lit on the live-breath slot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSeat {
    pub key: String,
    /// streamed text in the last two seconds: the key lights bright, not at rest.
    pub delta_fresh: bool,
}

/// a seat with its livery slot, when its agent is bound to a key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeatView {
    pub seat: Seat,
    pub livery_slot: Option<u8>,
}

/// a bound digit key: its livery, and when alive, the seat or the working state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundKey {
    pub wire: Key,
    pub slot: u8,
    pub seat: Option<Seat>,
    pub working: bool,
    pub delta_fresh: bool,
}

/// one machine light: up when any of its agents is connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MachineView {
    pub up: bool,
}

/// one row of the unbound grid: a seat that wants the person, or a working one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    Need(Seat),
    Live(LiveSeat),
}

fn row_cell(row: &Row) -> Cell {
    match row {
        Row::Need(seat) => seat_cell(seat),
        Row::Live(l) => cell(
            LIVE_BREATH_SLOT,
            if l.delta_fresh {
                level::BRIGHT
            } else {
                level::REST
            },
        ),
    }
}

/// everything the drive bank shows, as the daemon sees it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DriveModel {
    /// bound wires with their livery slot and, when alive, their seat.
    pub bound: Vec<BoundKey>,
    /// the rows the unbound digit keys show, in the order the app ranks them
    /// (digit n is the app's window n). they lay onto the grid in this order and
    /// page through it.
    pub rows: Vec<Row>,
    pub page: usize,
    /// at most four, in board order. an absent machine draws no light.
    pub machines: Vec<MachineView>,
    /// something is waiting: the dot key shows it when there is no page to show.
    pub copy_armed: bool,
}

/// the drive bank, the base layer. the radio's breath and the working pulse
/// ride their own slots; the grid fills in digit order.
#[must_use]
pub fn render_drive(m: &DriveModel) -> Cells {
    let mut cells = DARK_FRAME;

    /* nl holds steady violet: the daemon is driving. the radio alone breathes. */
    cells[Key::Nl.index()] = cell(slot::YOU, level::BRIGHT);
    cells[Key::K0.index()] = cell(BREATH_SLOT, level::BRIGHT);

    /* machines: steady lime when up, loud red when down. nothing breathes for
    attention it has not earned. */
    for (&wire, mv) in MACHINE_WIRES.iter().zip(m.machines.iter()) {
        cells[wire.index()] = if mv.up {
            cell(slot::LIVE, level::REST)
        } else {
            cell(slot::FAULT, level::BRIGHT)
        };
    }

    /* bound keys: state outranks identity. a signal takes the led, the livery
    holds it otherwise, and a bound working agent pulses lime. */
    for b in &m.bound {
        cells[b.wire.index()] = match &b.seat {
            Some(seat) => seat_cell(seat),
            None if b.working => cell(
                LIVE_BREATH_SLOT,
                if b.delta_fresh {
                    level::BRIGHT
                } else {
                    level::REST
                },
            ),
            None => cell(b.slot, level::DIM),
        };
    }

    /* the rows fill every unbound grid key in digit order, one paged list. rows
    1 and 2 are not livery-reserved. */
    let seat_wires: Vec<Key> = DIGIT_WIRES
        .iter()
        .copied()
        .filter(|w| !m.bound.iter().any(|b| b.wire == *w))
        .collect();
    let row_cells: Vec<Cell> = m.rows.iter().map(row_cell).collect();
    let start = m.page * seat_wires.len();
    for (i, &wire) in seat_wires.iter().enumerate() {
        if let Some(&c) = row_cells.get(start + i) {
            cells[wire.index()] = c;
        }
    }

    /* ent is a real enter key: a steady violet at rest, never the anonymous floor. */
    cells[Key::Ent.index()] = cell(slot::YOU, level::REST);

    /* the dot key says there is more to page to. decision 79: when there is no
    page, the copy-armed light moves here from plus, at the same slot and level. */
    if !seat_wires.is_empty() && row_cells.len() > seat_wires.len() {
        cells[Key::Dot.index()] = cell(slot::INFO, level::IDLE);
    } else if m.copy_armed {
        cells[Key::Dot.index()] = cell(slot::NEEDS, level::DIM);
    }
    cells
}

/// the cell of one seat: its need, escalated when it is hot.
#[must_use]
pub fn seat_cell(seat: &Seat) -> Cell {
    match seat.need {
        Need::Permission => {
            if seat.hot {
                cell(slot::PERM_HOT, level::HOT)
            } else {
                cell(slot::PERM, level::REST)
            }
        }
        Need::Question => {
            if seat.hot {
                cell(slot::INFO, level::HOT)
            } else {
                cell(slot::INFO, level::REST)
            }
        }
        Need::Fault => cell(slot::FAULT, level::HOT),
        Need::Review => {
            if seat.hot {
                cell(slot::NEEDS_HOT, level::BRIGHT)
            } else {
                cell(slot::NEEDS, level::REST)
            }
        }
        /* v1's unread: a finished turn or a job's news, wire `news` (decision 80) */
        Need::News => {
            if seat.hot {
                cell(slot::NEEDS_HOT, level::HOT)
            } else {
                cell(slot::NEEDS, level::REST)
            }
        }
    }
}

/// the pit: the bank an open ask is answered from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PitModel {
    Permission { hot: bool, reject_armed: bool },
    Question { options: usize },
}

/// the pit bank. a permission answers once, always, reject or skip; a question
/// lays its options on the digit keys.
#[must_use]
pub fn render_pit(m: PitModel) -> Cells {
    let mut cells = DARK_FRAME;
    match m {
        PitModel::Permission { hot, reject_armed } => {
            cells[Key::K5.index()] =
                cell(if hot { slot::PERM_HOT } else { slot::PERM }, level::HOT);
            cells[Key::K1.index()] = cell(slot::PERM_HOT, level::BRIGHT); /* once */
            cells[Key::K2.index()] = cell(slot::PERM, level::REST); /* always */
            cells[Key::K3.index()] = if reject_armed {
                cell(slot::FAULT, level::HOT) /* armed: the next press fires */
            } else {
                cell(slot::PERM, level::DIM)
            };
            cells[Key::Min.index()] = cell(slot::INFO, level::IDLE); /* skip */
        }
        PitModel::Question { options } => {
            cells[Key::K5.index()] = cell(slot::INFO, level::HOT);
            /* option 5 shares the call key, and the call yields to the option */
            for &w in DIGIT_WIRES.iter().take(options.min(9)) {
                cells[w.index()] = cell(slot::INFO, level::REST);
            }
            cells[Key::K0.index()] = cell(slot::YOU, level::IDLE); /* voice answers */
            cells[Key::Min.index()] = cell(slot::INFO, level::IDLE); /* skip */
        }
    }
    cells
}

/// the fleet bank: one column per machine, up to four, each 0 to 5 high.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FleetModel {
    /// per machine, in board order: activity 0 to 5. the fleet bank draws the
    /// first four and no spend odometer (decision 79).
    pub columns: Vec<u8>,
}

/// the fleet bank. a column's top step is brighter; the rest sit dim.
#[must_use]
pub fn render_fleet(m: &FleetModel) -> Cells {
    let mut cells = DARK_FRAME;
    for (stack, &height) in STACKS.iter().zip(m.columns.iter().take(4)) {
        let h = usize::from(height.min(5));
        for (i, &wire) in stack.iter().enumerate().take(h) {
            cells[wire.index()] = cell(
                slot::LIVE,
                if i + 1 == h { level::REST } else { level::DIM },
            );
        }
    }
    cells
}

/// the slots deep work lets through: permission and fault, the money.
const DEEP_WORK_SLOTS: [u8; 3] = [slot::PERM, slot::PERM_HOT, slot::FAULT];

/// deep work: silent except for money. permission and fault survive, and
/// everything else goes dark. a render filter, never a subscription change.
#[must_use]
pub fn deep_work_filter(cells: Cells) -> Cells {
    cells.map(|c| {
        if DEEP_WORK_SLOTS.contains(&(c >> 4)) {
            c
        } else {
            0
        }
    })
}

/// the floor: no driven key is ever black. a cell that would render dark, at
/// level 0, idles at the off slot's white whisper instead.
#[must_use]
pub fn apply_floor(cells: Cells) -> Cells {
    /* level 0 is the low nibble clear: `trailing_zeros` reads that as a bit count */
    cells.map(|c| {
        if c.trailing_zeros() >= 4 {
            FLOOR_CELL
        } else {
            c
        }
    })
}

/// lays a transient over the base: transparent cells show the base through.
#[must_use]
pub fn composite(base: Cells, overlay: Option<Overlay>) -> Cells {
    let Some(overlay) = overlay else {
        return base;
    };
    let mut out = base;
    for (dst, src) in out.iter_mut().zip(overlay) {
        if let Some(c) = src {
            *dst = c;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Key as K, LIVERY_SLOTS};

    fn seat(key: &str, need: Need) -> Seat {
        Seat {
            key: key.into(),
            need,
            hot: false,
        }
    }

    fn hot(key: &str, need: Need) -> Seat {
        Seat {
            hot: true,
            ..seat(key, need)
        }
    }

    fn needs(seats: &[Seat]) -> Vec<Row> {
        seats.iter().cloned().map(Row::Need).collect()
    }

    fn live(key: &str, fresh: bool) -> LiveSeat {
        LiveSeat {
            key: key.into(),
            delta_fresh: fresh,
        }
    }

    fn three_up() -> Vec<MachineView> {
        vec![MachineView { up: true }; 3]
    }

    fn drive() -> DriveModel {
        DriveModel {
            machines: three_up(),
            ..DriveModel::default()
        }
    }

    fn at(c: &Cells, k: Key) -> Cell {
        c[k.index()]
    }

    fn cell_at(o: &Overlay, k: Key) -> Option<Cell> {
        o[k.index()]
    }

    #[test]
    fn formation_lap_sweeps_bound_keys_in_their_liveries() {
        let t = formation_lap(&[
            Livery {
                wire: K::K7,
                slot: 9,
            },
            Livery {
                wire: K::K8,
                slot: 10,
            },
        ]);
        assert_eq!(t.frames.len(), 2);
        assert_eq!(
            cell_at(&t.frames[0].cells, K::K7),
            Some(cell(9, level::HOT))
        );
        assert_eq!(
            cell_at(&t.frames[1].cells, K::K8),
            Some(cell(10, level::HOT))
        );
        assert_eq!(
            cell_at(&t.frames[1].cells, K::K7),
            Some(cell(9, level::DIM)),
            "trail"
        );
    }

    #[test]
    fn formation_lap_with_no_bindings_introduces_the_board_with_a_ring_sweep() {
        let t = formation_lap(&[]);
        assert_eq!(t.frames.len(), RING.len());
        assert_eq!(
            cell_at(&t.frames[0].cells, RING[0]),
            Some(cell(slot::YOU, level::HOT))
        );
    }

    #[test]
    fn briefing_is_two_green_passes_row_by_row() {
        let t = briefing();
        /* 5 rows x 2 passes + 2 rests */
        assert_eq!(t.frames.len(), 12);
        assert_eq!(
            cell_at(&t.frames[0].cells, K::Nl),
            Some(cell(slot::LIVE, level::MID))
        );
        assert_eq!(
            cell_at(&t.frames[0].cells, K::K0),
            None,
            "only the row lights"
        );
    }

    #[test]
    fn arrival_is_two_pulses_at_the_key_then_stillness() {
        let t = arrival_pulse(K::K5, slot::NEEDS_HOT, false);
        assert_eq!(t.frames.len(), 4);
        assert_eq!(
            cell_at(&t.frames[0].cells, K::K5),
            Some(cell(slot::NEEDS_HOT, level::HOT))
        );
        assert_eq!(
            cell_at(&t.frames[1].cells, K::K5),
            Some(cell(slot::OFF, level::OFF))
        );
        assert_eq!(cell_at(&t.frames[0].cells, K::K4), None, "only that key");
    }

    #[test]
    fn the_queue_is_state_not_scene_the_signal_family_maps_needs_to_slots() {
        assert_eq!(
            seat_cell(&seat("h1:a", Need::Permission)),
            cell(slot::PERM, level::REST)
        );
        assert_eq!(
            seat_cell(&hot("h1:a", Need::Permission)),
            cell(slot::PERM_HOT, level::HOT)
        );
        assert_eq!(
            seat_cell(&hot("h1:a", Need::Fault)),
            cell(slot::FAULT, level::HOT)
        );
        assert_eq!(
            seat_cell(&seat("h1:a", Need::News)),
            cell(slot::NEEDS, level::REST)
        );
    }

    #[test]
    fn review_and_question_escalate_when_hot() {
        assert_eq!(
            seat_cell(&seat("h1:a", Need::Question)),
            cell(slot::INFO, level::REST)
        );
        assert_eq!(
            seat_cell(&hot("h1:a", Need::Question)),
            cell(slot::INFO, level::HOT)
        );
        assert_eq!(
            seat_cell(&seat("h1:a", Need::Review)),
            cell(slot::NEEDS, level::REST)
        );
        assert_eq!(
            seat_cell(&hot("h1:a", Need::Review)),
            cell(slot::NEEDS_HOT, level::BRIGHT)
        );
        assert_eq!(
            seat_cell(&hot("h1:a", Need::News)),
            cell(slot::NEEDS_HOT, level::HOT)
        );
    }

    #[test]
    fn nl_holds_steady_violet_and_only_the_radio_breathes() {
        let cells = render_drive(&drive());
        assert_eq!(at(&cells, K::Nl), cell(slot::YOU, level::BRIGHT));
        assert_eq!(at(&cells, K::K0), cell(BREATH_SLOT, level::BRIGHT));
    }

    #[test]
    fn machines_row_is_steady_lime_up_and_loud_red_down() {
        let cells = render_drive(&DriveModel {
            machines: vec![
                MachineView { up: true },
                MachineView { up: false },
                MachineView { up: true },
            ],
            ..DriveModel::default()
        });
        assert_eq!(at(&cells, K::Div), cell(slot::LIVE, level::REST));
        assert_eq!(at(&cells, K::Mul), cell(slot::FAULT, level::BRIGHT));
        assert_eq!(at(&cells, K::Min), cell(slot::LIVE, level::REST));
        assert_eq!(
            at(&cells, K::Plus),
            0,
            "a fourth machine absent draws no light"
        );
    }

    #[test]
    fn decision_79_four_machines_light_on_slash_star_minus_plus() {
        assert_eq!(MACHINE_WIRES, [K::Div, K::Mul, K::Min, K::Plus]);
        let cells = render_drive(&DriveModel {
            machines: vec![
                MachineView { up: true },
                MachineView { up: true },
                MachineView { up: true },
                MachineView { up: false },
            ],
            ..DriveModel::default()
        });
        assert_eq!(at(&cells, K::Plus), cell(slot::FAULT, level::BRIGHT));
        assert_eq!(at(&cells, K::Min), cell(slot::LIVE, level::REST));
    }

    #[test]
    fn a_machine_list_past_four_draws_only_four() {
        let cells = render_drive(&DriveModel {
            machines: vec![MachineView { up: true }; 6],
            ..DriveModel::default()
        });
        assert_eq!(at(&cells, K::Plus), cell(slot::LIVE, level::REST));
        assert_eq!(cells.iter().filter(|&&c| c >> 4 == slot::LIVE).count(), 4);
    }

    #[test]
    fn a_bound_key_idles_in_its_livery_and_a_signal_takes_the_led() {
        let idle = render_drive(&DriveModel {
            bound: vec![BoundKey {
                wire: K::K7,
                slot: 9,
                seat: None,
                working: false,
                delta_fresh: false,
            }],
            ..drive()
        });
        assert_eq!(at(&idle, K::K7), cell(9, level::DIM));
        let hot_seat = render_drive(&DriveModel {
            bound: vec![BoundKey {
                wire: K::K7,
                slot: 9,
                seat: Some(hot("h1:a", Need::Permission)),
                working: false,
                delta_fresh: false,
            }],
            ..drive()
        });
        assert_eq!(at(&hot_seat, K::K7), cell(slot::PERM_HOT, level::HOT));
    }

    #[test]
    fn the_queue_fills_the_whole_unbound_grid_in_digit_order() {
        let seats = vec![
            seat("h1:a", Need::Permission),
            seat("h1:b", Need::Question),
            seat("h1:c", Need::News),
            seat("h1:d", Need::News),
        ];
        let cells = render_drive(&DriveModel {
            rows: needs(&seats),
            ..drive()
        });
        /* rank 1 on the key whose cap says 1, counting up */
        assert_eq!(at(&cells, K::K1), seat_cell(&seats[0]));
        assert_eq!(at(&cells, K::K2), seat_cell(&seats[1]));
        assert_eq!(at(&cells, K::K3), seat_cell(&seats[2]));
        assert_eq!(at(&cells, K::K4), seat_cell(&seats[3]));
        assert_eq!(at(&cells, K::K5), 0, "four threads, four keys: no more");
        assert_eq!(at(&cells, K::Dot), 0, "one page: no page light");
    }

    #[test]
    fn a_bound_key_drops_out_of_the_flow_and_the_queue_seats_around_it() {
        let seats = vec![seat("h1:a", Need::Permission), seat("h1:b", Need::News)];
        let cells = render_drive(&DriveModel {
            bound: vec![BoundKey {
                wire: K::K1,
                slot: 9,
                seat: None,
                working: false,
                delta_fresh: false,
            }],
            rows: needs(&seats),
            ..drive()
        });
        assert_eq!(at(&cells, K::K1), cell(9, level::DIM), "the livery holds");
        assert_eq!(at(&cells, K::K2), seat_cell(&seats[0]));
        assert_eq!(at(&cells, K::K3), seat_cell(&seats[1]));
    }

    #[test]
    fn dot_lights_only_past_nine_and_the_second_page_exists() {
        let seats: Vec<Seat> = (0..10)
            .map(|i| seat(&format!("h1:s{i}"), Need::News))
            .collect();
        let cells = render_drive(&DriveModel {
            rows: needs(&seats),
            ..drive()
        });
        assert_ne!(at(&cells, K::Dot), 0);
        /* nine visible on page 0; the dot still lit on page 1 (paging wraps) */
        let page1 = render_drive(&DriveModel {
            rows: needs(&seats),
            page: 1,
            ..drive()
        });
        assert_eq!(at(&page1, K::K1), seat_cell(&seats[9]));
        assert_eq!(at(&page1, K::K2), 0);
        assert_ne!(at(&page1, K::Dot), 0);
    }

    #[test]
    fn live_sessions_seat_after_needs_and_pulse_on_the_live_breath_slot() {
        let cells = render_drive(&DriveModel {
            rows: vec![
                Row::Need(seat("h1:call", Need::Permission)),
                Row::Live(live("h1:w1", true)),
                Row::Live(live("h1:w2", false)),
            ],
            ..drive()
        });
        /* k1 is the need (triage first), k2 and k3 the workers */
        assert_eq!(
            at(&cells, K::K1),
            seat_cell(&seat("h1:call", Need::Permission))
        );
        assert_eq!(
            at(&cells, K::K2),
            cell(LIVE_BREATH_SLOT, level::BRIGHT),
            "tokens landing"
        );
        assert_eq!(at(&cells, K::K3), cell(LIVE_BREATH_SLOT, level::REST));
    }

    #[test]
    fn rows_page_together_in_the_order_given() {
        let model = DriveModel {
            rows: needs(&[seat("h1:a", Need::News), seat("h1:b", Need::News)])
                .into_iter()
                .chain((0..8).map(|i| Row::Live(live(&format!("h1:w{i}"), false))))
                .collect(),
            page: 1,
            ..drive()
        };
        let cells = render_drive(&model);
        /* page 1 starts at index 9: the last worker lands on k1 */
        assert_eq!(at(&cells, K::K1), cell(LIVE_BREATH_SLOT, level::REST));
        assert_eq!(at(&cells, K::K2), 0);
    }

    #[test]
    fn a_bound_working_agent_pulses_lime_on_its_own_key() {
        let cells = render_drive(&DriveModel {
            bound: vec![BoundKey {
                wire: K::K7,
                slot: 9,
                seat: None,
                working: true,
                delta_fresh: true,
            }],
            ..drive()
        });
        assert_eq!(at(&cells, K::K7), cell(LIVE_BREATH_SLOT, level::BRIGHT));
    }

    #[test]
    fn decision_79_plus_no_longer_shows_copy_armed_and_dot_takes_it_when_there_is_no_page() {
        let armed = render_drive(&DriveModel {
            copy_armed: true,
            ..drive()
        });
        assert_eq!(
            at(&armed, K::Plus),
            0,
            "plus is a machine light now, not copy"
        );
        assert_eq!(
            at(&armed, K::Dot),
            cell(slot::NEEDS, level::DIM),
            "copy-armed moves to dot"
        );
        let quiet = render_drive(&drive());
        assert_eq!(at(&quiet, K::Dot), 0);
    }

    #[test]
    fn decision_79_the_more_pages_hint_wins_the_dot_key_over_copy_armed() {
        let seats: Vec<Seat> = (0..10)
            .map(|i| seat(&format!("h1:s{i}"), Need::News))
            .collect();
        let cells = render_drive(&DriveModel {
            rows: needs(&seats),
            copy_armed: true,
            ..drive()
        });
        assert_eq!(at(&cells, K::Dot), cell(slot::INFO, level::IDLE));
    }

    #[test]
    fn ent_holds_a_steady_violet_at_rest_never_the_anonymous_floor() {
        assert_eq!(
            at(&render_drive(&drive()), K::Ent),
            cell(slot::YOU, level::REST)
        );
    }

    #[test]
    fn permission_once_bright_always_rest_reject_dim_until_armed() {
        let cells = render_pit(PitModel::Permission {
            hot: true,
            reject_armed: false,
        });
        assert_eq!(at(&cells, K::K5), cell(slot::PERM_HOT, level::HOT));
        assert_eq!(at(&cells, K::K1), cell(slot::PERM_HOT, level::BRIGHT));
        assert_eq!(at(&cells, K::K2), cell(slot::PERM, level::REST));
        assert_eq!(at(&cells, K::K3), cell(slot::PERM, level::DIM));
    }

    #[test]
    fn reject_armed_goes_fault_red_the_destructive_law_made_visible() {
        let cells = render_pit(PitModel::Permission {
            hot: false,
            reject_armed: true,
        });
        assert_eq!(at(&cells, K::K3), cell(slot::FAULT, level::HOT));
    }

    #[test]
    fn a_question_puts_n_options_on_the_digit_keys_and_voice_on_the_radio() {
        let cells = render_pit(PitModel::Question { options: 4 });
        assert_eq!(at(&cells, K::K1), cell(slot::INFO, level::REST));
        assert_eq!(at(&cells, K::K4), cell(slot::INFO, level::REST));
        assert_eq!(at(&cells, K::K6), 0, "option 6 does not exist");
        assert_eq!(at(&cells, K::K0), cell(slot::YOU, level::IDLE));
    }

    #[test]
    fn a_question_with_five_options_lets_option_five_take_the_call_key() {
        let cells = render_pit(PitModel::Question { options: 5 });
        assert_eq!(at(&cells, K::K5), cell(slot::INFO, level::REST));
    }

    #[test]
    fn queue_view_is_one_lime_key_per_parked_order_and_ent_gold_when_armed() {
        let cells = queue_cells(3);
        assert_eq!(at(&cells, K::K1), cell(slot::LIVE, level::BRIGHT));
        assert_eq!(at(&cells, K::K2), cell(slot::LIVE, level::BRIGHT));
        assert_eq!(at(&cells, K::K3), cell(slot::LIVE, level::BRIGHT));
        assert_eq!(at(&cells, K::K4), 0, "three orders, three keys: no more");
        assert_eq!(
            at(&cells, K::Ent),
            cell(slot::PERM, level::BRIGHT),
            "flush armed"
        );
    }

    #[test]
    fn queue_depth_zero_is_an_honest_empty_board() {
        let cells = queue_cells(0);
        for w in DIGIT_WIRES {
            assert_eq!(at(&cells, w), 0);
        }
        assert_eq!(at(&cells, K::Ent), 0);
    }

    #[test]
    fn queue_depth_caps_at_the_nine_digits() {
        assert_eq!(at(&queue_cells(12), K::K9), cell(slot::LIVE, level::BRIGHT));
    }

    #[test]
    fn red_flag_is_essential_so_it_survives_deep_work() {
        assert!(red_flag(K::K6).essential);
    }

    #[test]
    fn victory_lap_is_two_laps_around_the_ring_with_a_trail() {
        let t = victory_lap();
        assert_eq!(t.frames.len(), RING.len() * 2);
        assert_eq!(
            cell_at(&t.frames[0].cells, RING[0]),
            Some(cell(slot::LIVE, level::HOT))
        );
        assert_eq!(
            cell_at(&t.frames[2].cells, RING[0]),
            Some(cell(slot::LIVE, level::DIM)),
            "trail"
        );
    }

    #[test]
    fn deep_work_lets_only_permission_and_fault_reach_the_leds() {
        let mut base = DARK_FRAME;
        base[0] = cell(slot::LIVE, level::MID);
        base[1] = cell(slot::PERM_HOT, level::HOT);
        base[2] = cell(slot::NEEDS, level::REST);
        base[3] = cell(slot::FAULT, level::HOT);
        let filtered = deep_work_filter(base);
        assert_eq!(filtered[0], 0);
        assert_eq!(filtered[1], base[1]);
        assert_eq!(filtered[2], 0);
        assert_eq!(filtered[3], base[3]);
    }

    #[test]
    fn non_essential_transients_are_suppressed_and_essential_ones_play() {
        let mut p = TransientPlayer::new();
        assert!(p.push(arrival_pulse(K::K5, slot::NEEDS_HOT, false), 0));
        assert_eq!(p.current(10, true), None, "deep work eats it");
        let mut p2 = TransientPlayer::new();
        p2.push(red_flag(K::K5), 0);
        assert!(p2.current(10, true).is_some());
    }

    #[test]
    fn the_voice_meter_climbs_four_stacks_with_the_head_brightest() {
        let cells = vu_cells([2, 5, 0, 1]);
        assert_eq!(
            cell_at(&cells, STACKS[0][0]),
            Some(cell(slot::YOU, level::REST))
        );
        assert_eq!(
            cell_at(&cells, STACKS[0][1]),
            Some(cell(slot::YOU, level::HOT)),
            "head"
        );
        assert_eq!(
            cell_at(&cells, STACKS[1][4]),
            Some(cell(slot::YOU, level::HOT))
        );
        assert_eq!(cell_at(&cells, STACKS[2][0]), None, "silent column");
    }

    #[test]
    fn the_voice_meter_clamps_a_band_to_five() {
        let cells = vu_cells([9, 0, 0, 0]);
        assert_eq!(
            cell_at(&cells, STACKS[0][4]),
            Some(cell(slot::YOU, level::HOT))
        );
    }

    #[test]
    fn fleet_bank_draws_four_machine_columns_and_no_odometer() {
        let cells = render_fleet(&FleetModel {
            columns: vec![3, 0, 5, 2],
        });
        assert_eq!(at(&cells, STACKS[0][2]) >> 4, slot::LIVE);
        assert_eq!(at(&cells, STACKS[0][3]), 0);
        assert_eq!(at(&cells, STACKS[2][4]) >> 4, slot::LIVE);
        /* the fourth machine: height 2 lights ent (v1's stack), in live, not you */
        assert_eq!(at(&cells, K::Ent) >> 4, slot::LIVE);
        assert!(
            cells.iter().all(|&c| c >> 4 != slot::YOU),
            "no spend odometer in you"
        );
    }

    #[test]
    fn fleet_bank_ignores_a_fifth_column_and_clamps_height_to_five() {
        let cells = render_fleet(&FleetModel {
            columns: vec![0, 0, 0, 0, 5],
        });
        assert!(cells.iter().all(|&c| c == 0), "only four columns exist");
        let tall = render_fleet(&FleetModel { columns: vec![9] });
        assert_eq!(at(&tall, STACKS[0][4]), cell(slot::LIVE, level::REST));
    }

    #[test]
    fn no_driven_cell_stays_black_level_zero_becomes_the_off_whisper() {
        let base = render_drive(&drive());
        let floored = apply_floor(base);
        for (i, &c) in floored.iter().enumerate() {
            assert!(c & 0x0f > 0);
            if base[i] & 0x0f > 0 {
                assert_eq!(c, base[i], "lit cells ride through untouched");
            }
        }
        assert_eq!(floored[K::K5.index()], FLOOR_CELL);
    }

    #[test]
    fn the_floor_sits_below_every_named_stop() {
        assert_eq!(FLOOR_CELL & 0x0f, level::IDLE);
        assert_eq!(FLOOR_CELL >> 4, slot::OFF);
    }

    #[test]
    fn deep_work_suppresses_signals_not_power_the_floor_survives() {
        let mut base = DARK_FRAME;
        base[0] = cell(slot::LIVE, level::MID); /* not money: goes to the floor */
        base[1] = cell(slot::PERM_HOT, level::HOT); /* money: stays */
        let out = apply_floor(deep_work_filter(base));
        assert_eq!(out[0], FLOOR_CELL);
        assert_eq!(out[1], base[1]);
        assert_eq!(out[2], FLOOR_CELL);
    }

    #[test]
    fn blink_gaps_dip_to_the_floor_never_to_black() {
        let t = arrival_pulse(K::K5, slot::NEEDS_HOT, false);
        let gap = composite(DARK_FRAME, Some(t.frames[1].cells));
        assert_eq!(apply_floor(gap)[K::K5.index()], FLOOR_CELL);
    }

    #[test]
    fn the_player_plays_frames_on_time_queues_the_next_and_composites_over_base() {
        let mut p = TransientPlayer::new();
        p.push(arrival_pulse(K::K5, slot::NEEDS_HOT, false), 0);
        p.push(victory_lap(), 0); /* queued behind */
        assert_eq!(
            p.current(0, false).and_then(|o| o[K::K5.index()]),
            Some(cell(slot::NEEDS_HOT, level::HOT))
        );
        assert_eq!(
            p.current(250, false).and_then(|o| o[K::K5.index()]),
            Some(cell(slot::OFF, level::OFF))
        );
        /* the arrival ends at 820 ms; the victory starts fresh */
        let after = p.current(830, false);
        assert_eq!(
            after.and_then(|o| o[RING[0].index()]),
            Some(cell(slot::LIVE, level::HOT))
        );
        /* composite: transparent cells show the base */
        let mut base = DARK_FRAME;
        base[K::Dot.index()] = cell(slot::INFO, level::IDLE);
        let merged = composite(base, p.current(830, false));
        assert_eq!(at(&merged, K::Dot), cell(slot::INFO, level::IDLE));
    }

    #[test]
    fn the_player_reports_its_next_deadline_at_each_frame_end() {
        let mut p = TransientPlayer::new();
        assert_eq!(p.next_deadline(), None, "idle: nothing to wake for");
        p.push(arrival_pulse(K::K5, slot::NEEDS_HOT, false), 1_000);
        assert!(p.busy());
        assert_eq!(
            p.next_deadline(),
            Some(1_240),
            "the first frame ends 240 ms in"
        );
        let _ = p.current(1_240, false);
        assert_eq!(p.next_deadline(), Some(1_410));
        let _ = p.current(1_410, false);
        let _ = p.current(1_650, false);
        assert_eq!(
            p.next_deadline(),
            Some(1_820),
            "the last frame ends 170 ms after 1650"
        );
        let _ = p.current(1_820, false);
        assert_eq!(
            p.next_deadline(),
            None,
            "the last frame ended and nothing queued"
        );
        assert!(!p.busy());
    }

    #[test]
    fn a_queued_transient_starts_when_the_playing_one_ends_at_the_call_time() {
        let mut p = TransientPlayer::new();
        p.push(arrival_pulse(K::K5, slot::NEEDS_HOT, false), 0);
        p.push(victory_lap(), 0);
        /* the arrival ended at 820; the call comes late, at 900 */
        let _ = p.current(900, false);
        assert_eq!(
            p.next_deadline(),
            Some(980),
            "the victory frame starts at the call"
        );
    }

    #[test]
    fn a_frame_that_is_already_past_is_stepped_over_in_one_call() {
        let mut p = TransientPlayer::new();
        p.push(arrival_pulse(K::K5, slot::NEEDS_HOT, false), 0);
        /* past all four frames: the transient is done */
        assert_eq!(p.current(5_000, false), None);
        assert!(!p.busy());
    }

    #[test]
    fn a_full_queue_refuses_the_push_so_a_burst_cannot_grow_it_forever() {
        let mut p = TransientPlayer::new();
        assert!(
            p.push(victory_lap(), 0),
            "the playing one always takes a push"
        );
        for _ in 0..QUEUE_CAP {
            assert!(p.push(victory_lap(), 0));
        }
        assert!(!p.push(victory_lap(), 0), "the cap is reached");
    }

    #[test]
    fn clear_drops_the_playing_scene_and_the_queue_as_an_unplug_does() {
        let mut p = TransientPlayer::new();
        p.push(victory_lap(), 0);
        p.push(victory_lap(), 0);
        p.clear();
        assert!(!p.busy());
        assert_eq!(p.next_deadline(), None);
        assert_eq!(p.current(10, false), None);
    }

    #[test]
    fn an_empty_transient_plays_nothing_and_hands_over_at_once() {
        let empty = Transient {
            name: "empty",
            frames: Vec::new(),
            essential: false,
        };
        let mut p = TransientPlayer::new();
        p.push(empty, 0);
        p.push(red_flag(K::K5), 0);
        let o = p.current(0, false);
        assert_eq!(
            o.and_then(|o| o[K::K5.index()]),
            Some(cell(slot::FAULT, level::HOT))
        );
    }

    #[test]
    fn a_livery_slot_is_never_a_reserved_slot() {
        assert!(LIVERY_SLOTS.iter().all(|&s| s >= 9));
        let view = SeatView {
            seat: seat("h1:a", Need::Question),
            livery_slot: Some(LIVERY_SLOTS[0]),
        };
        assert_eq!(view.livery_slot, Some(9));
    }

    #[test]
    fn the_digit_order_and_the_ring_are_the_board_geometry() {
        assert_eq!(DIGIT_WIRES[0], K::K1);
        assert_eq!(DIGIT_WIRES[8], K::K9);
        assert_eq!(RING.len(), 11);
        assert_eq!(RING[0], K::Nl);
        assert_eq!(STACKS.len(), 4);
    }
}
