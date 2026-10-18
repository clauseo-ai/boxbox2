//! what goes over the wire for a frame: the frame itself only when it
//! differs from the last one the board holds, the two animated palette slots
//! at most 25 times a second and only while a cell on screen uses them, the
//! global brightness when the hour moves, and a ping after 500 ms with
//! nothing written (inside the firmware's 2000 ms watchdog).

use std::f64::consts::PI;

use crate::protocol::{
    BREATH_SLOT, Cells, LIVE_BREATH_SLOT, Report, frame_report, global_report, palette_report,
    ping_report, reserved_rgb, slot,
};

pub const KEEPALIVE_MS: u64 = 500;
/// the floor between writes of one animated slot: 25 a second.
pub const ANIM_MIN_MS: u64 = 40;
/// the radio's violet float, slow: an invitation.
pub const BREATH_PERIOD_MS: u64 = 3_400;
/// the lime working pulse, faster: energy, not sleep.
pub const LIVE_PERIOD_MS: u64 = 1_800;

#[derive(Debug, Default)]
struct Anim {
    rgb: Option<[u8; 3]>,
    /// the last step, written or not (the sweep can hold a colour for a
    /// step at its floor and its peak).
    stepped_at: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Painter {
    last_frame: Option<Cells>,
    last_write: u64,
    global: Option<u8>,
    breath: Anim,
    live: Anim,
}

/// the sweep both slots ride: perceptual floor 0.30, squared into pwm,
/// since the leds' pwm is linear light.
#[must_use]
pub fn sweep(base: [u8; 3], period_ms: u64, now: u64) -> [u8; 3] {
    // now % period is under 3400: exact in f64.
    #[allow(clippy::cast_precision_loss)]
    let phase = (now % period_ms) as f64 / period_ms as f64;
    let s = 0.3 + 0.7 * (0.5 - 0.5 * (2.0 * PI * phase).cos());
    let s = s * s;
    // each channel is 0..=255 scaled by s in 0..=1.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    base.map(|c| (f64::from(c) * s).round().clamp(0.0, 255.0) as u8)
}

fn uses(cells: &Cells, palette: u8) -> bool {
    cells.iter().any(|c| c >> 4 == palette)
}

impl Painter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// a new board holds no frame and the firmware's full brightness (v1
    /// skipped the global byte on a replug inside the same hour).
    pub fn connected(&mut self) {
        *self = Self::default();
    }

    /// the reserved palette, slots 0 to 8, pushed before anything renders.
    #[must_use]
    pub fn reserved_palette() -> Vec<Report> {
        (slot::OFF..=slot::INFO)
            .filter_map(|s| Some(palette_report(s, reserved_rgb(s)?)))
            .collect()
    }

    /// a report went out at `now` (the hello and palette too).
    pub fn wrote(&mut self, now: u64) {
        self.last_write = now;
    }

    /// the reports this frame needs, in order: global, the two animated
    /// slots, then the frame or a ping. calls [`Painter::wrote`] for them.
    pub fn paint(&mut self, cells: &Cells, now: u64, brightness: u8) -> Vec<Report> {
        let mut out = Vec::new();
        if self.global != Some(brightness) {
            self.global = Some(brightness);
            out.push(global_report(f64::from(brightness)));
        }
        for (palette, base, period) in [
            (BREATH_SLOT, slot::YOU, BREATH_PERIOD_MS),
            (LIVE_BREATH_SLOT, slot::LIVE, LIVE_PERIOD_MS),
        ] {
            let anim = if palette == BREATH_SLOT {
                &mut self.breath
            } else {
                &mut self.live
            };
            let due = anim.stepped_at.is_none_or(|at| now >= at + ANIM_MIN_MS);
            if !due || !uses(cells, palette) {
                continue;
            }
            anim.stepped_at = Some(now);
            let rgb = sweep(reserved_rgb(base).unwrap_or([0; 3]), period, now);
            if anim.rgb != Some(rgb) {
                anim.rgb = Some(rgb);
                out.push(palette_report(palette, rgb));
            }
        }
        if self.last_frame.as_ref() != Some(cells) {
            if let Ok(report) = frame_report(cells) {
                self.last_frame = Some(*cells);
                out.push(report);
            }
        } else if out.is_empty() && now >= self.last_write + KEEPALIVE_MS {
            out.push(ping_report());
        }
        if !out.is_empty() {
            self.last_write = now;
        }
        out
    }

    /// when the wire next needs a write without anything changing: the next
    /// animation step while a slot is on screen, else the keepalive.
    #[must_use]
    pub fn next_deadline(&self, cells: &Cells) -> u64 {
        let mut next = self.last_write + KEEPALIVE_MS;
        for (palette, anim) in [(BREATH_SLOT, &self.breath), (LIVE_BREATH_SLOT, &self.live)] {
            if uses(cells, palette) {
                let at = anim.stepped_at.map_or(0, |at| at + ANIM_MIN_MS);
                next = next.min(at);
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{DARK_FRAME, OP_FRAME, OP_GLOBAL, OP_PALETTE, OP_PING, cell, level};

    fn ops(reports: &[Report]) -> Vec<u8> {
        reports.iter().map(|r| r[1]).collect()
    }

    #[test]
    fn a_frame_goes_once_then_pings_keep_the_watchdog_fed() {
        let mut p = Painter::new();
        let frame = DARK_FRAME;
        assert_eq!(ops(&p.paint(&frame, 0, 255)), vec![OP_GLOBAL, OP_FRAME]);
        assert!(p.paint(&frame, 100, 255).is_empty());
        assert_eq!(p.next_deadline(&frame), 500);
        assert_eq!(ops(&p.paint(&frame, 500, 255)), vec![OP_PING]);
        assert_eq!(p.next_deadline(&frame), 1_000);
    }

    #[test]
    fn the_animated_slot_streams_only_while_on_screen_at_most_25_a_second() {
        let mut p = Painter::new();
        let mut frame = DARK_FRAME;
        frame[0] = cell(BREATH_SLOT, level::BRIGHT);
        let first = p.paint(&frame, 1_000, 255);
        assert_eq!(ops(&first), vec![OP_GLOBAL, OP_PALETTE, OP_FRAME]);
        assert_eq!(p.next_deadline(&frame), 1_040);
        assert!(
            p.paint(&frame, 1_020, 255).is_empty(),
            "inside the 40 ms floor"
        );
        assert_eq!(ops(&p.paint(&frame, 1_040, 255)), vec![OP_PALETTE]);
        let dark = DARK_FRAME;
        assert_eq!(ops(&p.paint(&dark, 1_080, 255)), vec![OP_FRAME]);
        assert_eq!(
            p.next_deadline(&dark),
            1_580,
            "off screen: only the keepalive"
        );
    }

    #[test]
    fn a_connect_resends_the_frame_and_the_brightness() {
        let mut p = Painter::new();
        p.paint(&DARK_FRAME, 0, 200);
        p.connected();
        assert_eq!(
            ops(&p.paint(&DARK_FRAME, 10, 200)),
            vec![OP_GLOBAL, OP_FRAME]
        );
    }

    #[test]
    fn the_sweep_dips_to_the_floor_and_peaks_at_the_colour() {
        assert_eq!(sweep([200, 100, 0], 1_000, 0), [18, 9, 0]);
        assert_eq!(sweep([200, 100, 0], 1_000, 500), [200, 100, 0]);
    }
}
