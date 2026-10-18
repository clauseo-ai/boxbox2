//! the frame: the controller's state composed into 17 cells, only when the
//! main loop wakes for something. the live overlays (the meter while
//! talking, the queue view while a seat is held) outrank the banks; the
//! transient scenes ride over the bank; deep work filters; the floor goes
//! down last, except in calc, where a numpad is dark.

use crate::controller::{Bank, Controller, RowKind};
use crate::protocol::{Cells, DARK_FRAME, Key, cell, level, slot};
use crate::scenes::{
    BoundKey, DriveModel, FleetModel, LiveSeat, MachineView, PitModel, Row, Seat, apply_floor,
    composite, deep_work_filter, queue_cells, render_drive, render_fleet, render_pit, vu_cells,
};

/// the queue blink: a working key flashes its depth every 3.2 s, 220 ms a beat.
pub const BLINK_CYCLE_MS: u64 = 3_200;
pub const BLINK_BEAT_MS: u64 = 220;

/// composes the frame for `now`. advances the transient player.
pub fn compose(c: &mut Controller, now: u64) -> Cells {
    // the player advances on every frame, even one an overlay hides, so its
    // deadline never stays in the past.
    let overlay = c.transients.current(now, c.deep_work);
    if c.calc_mode {
        return DARK_FRAME;
    }
    if c.meter_active() {
        let bands = c.meter.as_ref().map_or([0; 4], |l| l.bands);
        return apply_floor(composite(DARK_FRAME, Some(vu_cells(bands))));
    }
    if let Some(held) = &c.held_seat {
        let depth = c.fleet.thread(&held.key).map_or(0, |t| t.queued);
        return apply_floor(queue_cells(usize::try_from(depth).unwrap_or(usize::MAX)));
    }
    let mut base = match (c.bank, &c.pit) {
        (Bank::Pit, Some(pit)) => {
            let model = match pit.ask.kind {
                boxbox_board_wire::AskKind::Permission => PitModel::Permission {
                    hot: c
                        .fleet
                        .thread(&pit.key)
                        .is_some_and(|t| c.fleet.hot(t, now)),
                    reject_armed: pit.reject_armed_until > now,
                },
                boxbox_board_wire::AskKind::Question => PitModel::Question {
                    options: pit.ask.options.len().min(9),
                },
            };
            render_pit(model)
        }
        (Bank::Pit, None) => DARK_FRAME,
        (Bank::Fleet, _) => render_fleet(&FleetModel {
            columns: c
                .fleet
                .view()
                .machines
                .iter()
                .map(|m| m.activity.min(5))
                .collect(),
        }),
        (Bank::Drive, _) => drive(c, now),
    };
    if c.bank == Bank::Drive {
        blink_queues(c, &mut base, now);
    }
    let mut out = composite(base, overlay);
    if c.deep_work {
        out = deep_work_filter(out);
    }
    apply_floor(out)
}

fn drive(c: &Controller, now: u64) -> Cells {
    let fleet = &c.fleet;
    let bound: Vec<BoundKey> = c
        .bound_wires()
        .into_iter()
        .map(|(wire, key)| {
            let thread = fleet.thread(&key);
            BoundKey {
                wire,
                // past five bound threads there is no livery left: the key
                // still holds its thread, in the floor's white.
                slot: c.liveries.slot(&key).unwrap_or(slot::OFF),
                seat: thread.and_then(|t| {
                    Some(Seat {
                        key: key.clone(),
                        need: t.need?,
                        hot: fleet.hot(t, now),
                    })
                }),
                working: thread.is_some_and(|t| t.working),
                delta_fresh: thread.is_some_and(|t| t.fresh),
            }
        })
        .collect();
    let rows = c
        .rows()
        .into_iter()
        .map(|(t, kind)| match (kind, t.need) {
            (RowKind::Need, Some(need)) => Row::Need(Seat {
                key: t.key.clone(),
                need,
                hot: fleet.hot(t, now),
            }),
            _ => Row::Live(LiveSeat {
                key: t.key.clone(),
                delta_fresh: t.fresh,
            }),
        })
        .collect();
    render_drive(&DriveModel {
        bound,
        rows,
        page: c.page,
        machines: fleet
            .view()
            .machines
            .iter()
            .map(|m| MachineView { up: m.up })
            .collect(),
        copy_armed: fleet.top_call().is_some(),
    })
}

/// queued threads on screen flash their depth, `depth` short beats then rest.
fn blink_queues(c: &Controller, base: &mut Cells, now: u64) {
    let phase = now % BLINK_CYCLE_MS;
    let beat = phase / BLINK_BEAT_MS;
    for t in &c.fleet.view().threads {
        if t.queued == 0 {
            continue;
        }
        let Some(k) = c.wire_for_key(&t.key).and_then(Key::from_wire) else {
            continue;
        };
        if beat < u64::from(t.queued) * 2 && beat.is_multiple_of(2) {
            base[k.index()] = cell(slot::LIVE, level::HOT);
        }
    }
}

/// the next beat edge while a queued thread is on screen in the drive bank,
/// so the blink wakes the loop only when it changes.
#[must_use]
pub fn next_blink(c: &Controller, now: u64) -> Option<u64> {
    if c.calc_mode || c.bank != Bank::Drive || c.meter_active() || c.held_seat.is_some() {
        return None;
    }
    let deepest = c
        .fleet
        .view()
        .threads
        .iter()
        .filter(|t| t.queued > 0 && c.wire_for_key(&t.key).is_some())
        .map(|t| u64::from(t.queued))
        .max()?;
    let cycle_start = now - now % BLINK_CYCLE_MS;
    let phase = now % BLINK_CYCLE_MS;
    let beats = deepest * 2;
    let next_beat = (phase / BLINK_BEAT_MS + 1) * BLINK_BEAT_MS;
    if phase / BLINK_BEAT_MS < beats && next_beat < BLINK_CYCLE_MS {
        Some(cycle_start + next_beat)
    } else {
        Some(cycle_start + BLINK_CYCLE_MS)
    }
}
