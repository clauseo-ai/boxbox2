//! wire protocol v1, the daemon's half (`docs/board.md`). the firmware's
//! keymap.c holds the mirror tables. pure: no hid, no io, so every byte here
//! is testable without a board.

use std::error::Error;
use std::fmt;

pub const PROTO_VERSION: u8 = 1;
pub const REPORT_LEN: usize = 32;
pub const KEY_COUNT: usize = 17;

/// host to board.
pub const OP_HELLO: u8 = 0x01;
pub const OP_PALETTE: u8 = 0x02;
pub const OP_FRAME: u8 = 0x03;
pub const OP_GLOBAL: u8 = 0x04;
pub const OP_PING: u8 = 0x05;
pub const OP_MODE: u8 = 0x06;

/// board to host.
pub const OP_HELLO_ACK: u8 = 0x81;
pub const OP_KEY: u8 = 0x82;
pub const OP_MODE_ECHO: u8 = 0x83;

/// wire order: the sim order, top-left to bottom-right. never the led order
/// (bottom-up) or the matrix order (`docs/board.md`, the keypad's three maps).
pub const WIRE_NAMES: [&str; KEY_COUNT] = [
    "nl", "div", "mul", "min", "k7", "k8", "k9", "plus", "k4", "k5", "k6", "k1", "k2", "k3", "ent",
    "k0", "dot",
];

/// one of the seventeen keys, named by its wire index. the discriminant is
/// the index the firmware reports and the cells are laid out in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Key {
    Nl = 0,
    Div,
    Mul,
    Min,
    K7,
    K8,
    K9,
    Plus,
    K4,
    K5,
    K6,
    K1,
    K2,
    K3,
    Ent,
    K0,
    Dot,
}

impl Key {
    /// every key, in wire order.
    pub const ALL: [Key; KEY_COUNT] = [
        Key::Nl,
        Key::Div,
        Key::Mul,
        Key::Min,
        Key::K7,
        Key::K8,
        Key::K9,
        Key::Plus,
        Key::K4,
        Key::K5,
        Key::K6,
        Key::K1,
        Key::K2,
        Key::K3,
        Key::Ent,
        Key::K0,
        Key::Dot,
    ];

    /// the wire index, as the firmware numbers it.
    #[must_use]
    pub const fn wire(self) -> u8 {
        self as u8
    }

    /// the position in a [`Cells`] frame.
    #[must_use]
    pub const fn index(self) -> usize {
        self as usize
    }

    /// the key a firmware wire index names, or `None` past the seventeenth.
    #[must_use]
    pub fn from_wire(wire: u8) -> Option<Key> {
        Key::ALL.get(usize::from(wire)).copied()
    }

    /// the name the sim and the trace use for this key.
    #[must_use]
    pub const fn name(self) -> &'static str {
        WIRE_NAMES[self as usize]
    }
}

/// the firmware's wire to led table. the daemon never sends led indices; this
/// exists so the golden test can pin spec, firmware and keyboard.json together.
pub const WIRE_TO_LED: [u8; KEY_COUNT] = [13, 14, 15, 16, 10, 11, 12, 9, 6, 7, 8, 3, 4, 5, 2, 0, 1];

/// palette slots 0 to 8 have reserved meaning; 9 to 15 are liveries.
pub mod slot {
    pub const OFF: u8 = 0;
    pub const YOU: u8 = 1;
    pub const NEEDS: u8 = 2;
    pub const NEEDS_HOT: u8 = 3;
    pub const PERM: u8 = 4;
    pub const PERM_HOT: u8 = 5;
    pub const FAULT: u8 = 6;
    pub const LIVE: u8 = 7;
    pub const INFO: u8 = 8;
}

/// slots 9 to 13 are liveries. 14 and 15 are animated: the daemon streams
/// their rgb through sines, so motion is smooth 8-bit palette space and never
/// the 4-bit level staircase. `LIVE_BREATH` is the lime working pulse; `BREATH`
/// is the radio's slow violet float, an invitation to press.
pub const LIVERY_SLOTS: [u8; 5] = [9, 10, 11, 12, 13];
pub const LIVE_BREATH_SLOT: u8 = 14;
pub const BREATH_SLOT: u8 = 15;

/// the reserved palette in led space, indexed by slot 0 to 8. channels sit at
/// zero or loud: on ws2812s, desaturation is channels close together.
pub const RESERVED_RGB: [[u8; 3]; 9] = [
    // the floor, not black: an unlit key idles at a neutral white whisper so
    // the board never reads as switched off. true black is level 0 only.
    [255, 255, 255],
    [190, 0, 255],
    [255, 0, 115],
    [255, 0, 160],
    [255, 190, 0],
    [255, 230, 0],
    [255, 0, 0],
    [180, 255, 0],
    [40, 110, 255],
];

/// the reserved rgb of a slot 0 to 8, or `None` for a livery or animated slot.
#[must_use]
pub fn reserved_rgb(slot: u8) -> Option<[u8; 3]> {
    RESERVED_RGB.get(usize::from(slot)).copied()
}

/// 4-bit brightness levels: an index into the firmware's perceptual curve, not
/// a linear pwm value. scenes speak in these named stops, never raw numbers.
pub mod level {
    pub const OFF: u8 = 0;
    pub const IDLE: u8 = 3;
    pub const DIM: u8 = 5;
    pub const REST: u8 = 9;
    pub const MID: u8 = 11;
    pub const BRIGHT: u8 = 13;
    pub const HOT: u8 = 15;
}

/// palette in the high nibble, level in the low: `palette << 4 | level`.
pub type Cell = u8;

/// one key's cell. both arguments are masked to their nibble.
#[must_use]
pub const fn cell(slot: u8, level: u8) -> Cell {
    ((slot & 0x0f) << 4) | (level & 0x0f)
}

/// the floor: what "off" looks like while the daemon drives. the off slot's
/// white at the idle stop, below every signal and above black. calc mode
/// bypasses it: a numpad is dark.
pub const FLOOR_CELL: Cell = cell(slot::OFF, level::IDLE);

/// a whole frame, one cell per key, in wire index order.
pub type Cells = [Cell; KEY_COUNT];

pub const DARK_FRAME: Cells = [0; KEY_COUNT];

/// an outbound report: a leading report id byte, then 32 data bytes. node-hid
/// on darwin wanted the id; qmk's raw hid uses 0.
pub type Report = [u8; REPORT_LEN + 1];

/// a frame whose cell count is not seventeen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameError {
    pub got: usize,
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "frame wants {KEY_COUNT} cells, got {}", self.got)
    }
}

impl Error for FrameError {}

/// lays `op` and `payload` into a report. every caller passes a fixed-size
/// payload that fits; a longer one is cut, never written past the report.
fn report(op: u8, payload: &[u8]) -> Report {
    let mut r = [0u8; REPORT_LEN + 1];
    r[1] = op;
    for (dst, src) in r[2..].iter_mut().zip(payload) {
        *dst = *src;
    }
    r
}

#[must_use]
pub fn hello_report() -> Report {
    report(OP_HELLO, &[PROTO_VERSION])
}

#[must_use]
pub fn palette_report(slot: u8, rgb: [u8; 3]) -> Report {
    report(OP_PALETTE, &[slot & 0x0f, rgb[0], rgb[1], rgb[2]])
}

/// a frame report. refuses any cell count but seventeen.
///
/// # Errors
///
/// [`FrameError`] when `cells` does not hold exactly [`KEY_COUNT`] cells.
pub fn frame_report(cells: &[Cell]) -> Result<Report, FrameError> {
    if cells.len() != KEY_COUNT {
        return Err(FrameError { got: cells.len() });
    }
    Ok(report(OP_FRAME, cells))
}

/// the global brightness byte: `scale` rounded and clamped to 0 to 255.
#[must_use]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the value is rounded and clamped to 0..=255 before the cast"
)]
pub fn global_report(scale: f64) -> Report {
    let byte = scale.round().clamp(0.0, 255.0) as u8;
    report(OP_GLOBAL, &[byte])
}

#[must_use]
pub fn ping_report() -> Report {
    report(OP_PING, &[])
}

#[must_use]
pub fn mode_report(calc: bool) -> Report {
    report(OP_MODE, &[u8::from(calc)])
}

/// why the board changed mode. an unknown byte reads as `Host`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeReason {
    Host,
    Local,
    Watchdog,
}

impl ModeReason {
    #[must_use]
    pub const fn from_byte(byte: u8) -> ModeReason {
        match byte {
            1 => ModeReason::Local,
            2 => ModeReason::Watchdog,
            _ => ModeReason::Host,
        }
    }
}

/// an inbound report, read by [`parse_board_report`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoardMessage {
    Hello {
        fw: u8,
        proto: u8,
        mode: u8,
    },
    /// `down` is true for a press. the firmware sends 0 for down, 1 for up.
    Key {
        wire: u8,
        down: bool,
    },
    Mode {
        mode: u8,
        reason: ModeReason,
    },
    /// an op the daemon does not read, or a known op cut short. `op` is `None`
    /// for an empty report.
    Unknown {
        op: Option<u8>,
    },
}

/// reads one inbound report. a known op that is too short for its fields is
/// `Unknown`: the daemon logs it instead of guessing the missing bytes.
#[must_use]
pub fn parse_board_report(buf: &[u8]) -> BoardMessage {
    let Some(&op) = buf.first() else {
        return BoardMessage::Unknown { op: None };
    };
    match (op, buf) {
        (OP_HELLO_ACK, [_, fw, proto, mode, ..]) => BoardMessage::Hello {
            fw: *fw,
            proto: *proto,
            mode: *mode,
        },
        (OP_KEY, [_, wire, down, ..]) => BoardMessage::Key {
            wire: *wire,
            down: *down == 0,
        },
        (OP_MODE_ECHO, [_, mode, reason, ..]) => BoardMessage::Mode {
            mode: *mode,
            reason: ModeReason::from_byte(*reason),
        },
        _ => BoardMessage::Unknown { op: Some(op) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// the firmware's table, a copy of keymap.c's, for the golden below.
    const FIRMWARE_WIRE_TO_LED: [u8; KEY_COUNT] =
        [13, 14, 15, 16, 10, 11, 12, 9, 6, 7, 8, 3, 4, 5, 2, 0, 1];

    /// (row, col) of each wire key on the matrix: the sim's reading order, the
    /// one hand-written link between the spec and the keyboard.
    const WIRE_TO_MATRIX: [(u8, u8); KEY_COUNT] = [
        (0, 0),
        (0, 1),
        (0, 2),
        (0, 3),
        (1, 0),
        (1, 1),
        (1, 2),
        (2, 3),
        (2, 0),
        (2, 1),
        (2, 2),
        (3, 0),
        (3, 1),
        (3, 2),
        (4, 3),
        (4, 1),
        (4, 2),
    ];

    #[test]
    fn every_report_is_one_id_byte_and_32_data_bytes() {
        for r in [
            hello_report(),
            palette_report(1, [180, 122, 255]),
            frame_report(&DARK_FRAME).expect("seventeen cells"),
            global_report(128.0),
            ping_report(),
            mode_report(true),
        ] {
            assert_eq!(r.len(), 1 + REPORT_LEN);
            assert_eq!(r[0], 0);
        }
    }

    #[test]
    fn frame_golden_packs_palette_and_level() {
        let mut cells = DARK_FRAME;
        cells[Key::K5.index()] = cell(slot::PERM_HOT, level::HOT);
        cells[Key::K0.index()] = cell(slot::YOU, level::IDLE);
        let r = frame_report(&cells).expect("seventeen cells");
        assert_eq!(r[1], OP_FRAME);
        assert_eq!(r[2 + usize::from(Key::K5.wire())], (5 << 4) | 15);
        assert_eq!(r[2 + usize::from(Key::K0.wire())], (1 << 4) | 3);
        /* dark keys are 0x00, off slot at off level */
        assert_eq!(r[2 + usize::from(Key::Div.wire())], 0);
    }

    #[test]
    fn frame_refuses_the_wrong_cell_count() {
        assert_eq!(frame_report(&[1, 2, 3]), Err(FrameError { got: 3 }));
    }

    #[test]
    fn palette_golden() {
        let r = palette_report(6, [255, 59, 48]);
        assert_eq!(r[1..6], [OP_PALETTE, 6, 255, 59, 48]);
    }

    #[test]
    fn global_clamps() {
        assert_eq!(global_report(9000.0)[2], 255);
        assert_eq!(global_report(-4.0)[2], 0);
        assert_eq!(global_report(127.5)[2], 128);
    }

    #[test]
    fn opcodes_are_the_spec_table_in_both_directions() {
        assert_eq!(
            [OP_HELLO, OP_PALETTE, OP_FRAME, OP_GLOBAL, OP_PING, OP_MODE],
            [0x01, 0x02, 0x03, 0x04, 0x05, 0x06]
        );
        assert_eq!([OP_HELLO_ACK, OP_KEY, OP_MODE_ECHO], [0x81, 0x82, 0x83]);
    }

    #[test]
    fn hello_ack_carries_fw_proto_and_boot_mode() {
        assert_eq!(
            parse_board_report(&[0x81, 1, 1, 1]),
            BoardMessage::Hello {
                fw: 1,
                proto: 1,
                mode: 1
            }
        );
    }

    #[test]
    fn key_report_zero_is_down_and_one_is_up() {
        assert_eq!(
            parse_board_report(&[0x82, 15, 0]),
            BoardMessage::Key {
                wire: 15,
                down: true
            }
        );
        assert_eq!(
            parse_board_report(&[0x82, 0, 1]),
            BoardMessage::Key {
                wire: 0,
                down: false
            }
        );
    }

    #[test]
    fn mode_echo_reasons_are_host_local_and_watchdog() {
        assert_eq!(
            parse_board_report(&[0x83, 1, 2]),
            BoardMessage::Mode {
                mode: 1,
                reason: ModeReason::Watchdog
            }
        );
        assert_eq!(ModeReason::from_byte(1), ModeReason::Local);
        assert_eq!(ModeReason::from_byte(9), ModeReason::Host);
    }

    #[test]
    fn unknown_ops_surface_instead_of_vanishing() {
        assert_eq!(
            parse_board_report(&[0x7f]),
            BoardMessage::Unknown { op: Some(0x7f) }
        );
    }

    #[test]
    fn a_cut_short_known_op_is_unknown_not_guessed() {
        assert_eq!(
            parse_board_report(&[0x82, 3]),
            BoardMessage::Unknown { op: Some(0x82) }
        );
        assert_eq!(parse_board_report(&[]), BoardMessage::Unknown { op: None });
    }

    #[test]
    fn seventeen_wires_named_in_sim_order() {
        assert_eq!(WIRE_NAMES.len(), KEY_COUNT);
        assert_eq!(WIRE_NAMES[0], "nl");
        assert_eq!(WIRE_NAMES[15], "k0");
        assert_eq!(Key::Dot.wire(), 16);
        assert_eq!(Key::from_wire(16), Some(Key::Dot));
        assert_eq!(Key::from_wire(17), None);
        for (i, key) in Key::ALL.iter().enumerate() {
            assert_eq!(key.index(), i);
            assert_eq!(key.name(), WIRE_NAMES[i]);
        }
    }

    #[test]
    fn the_floor_sits_below_every_named_stop() {
        assert_eq!(FLOOR_CELL & 0x0f, level::IDLE);
        assert_eq!(FLOOR_CELL >> 4, slot::OFF);
    }

    #[test]
    fn reserved_palette_covers_slots_zero_to_eight_only() {
        assert_eq!(reserved_rgb(slot::FAULT), Some([255, 0, 0]));
        assert_eq!(reserved_rgb(slot::OFF), Some([255, 255, 255]));
        assert_eq!(reserved_rgb(LIVERY_SLOTS[0]), None);
        assert_eq!(reserved_rgb(BREATH_SLOT), None);
    }

    #[test]
    fn wire_to_led_is_a_permutation_of_the_seventeen_leds() {
        let mut seen = [false; KEY_COUNT];
        for led in WIRE_TO_LED {
            seen[usize::from(led)] = true;
        }
        assert!(seen.iter().all(|&s| s));
    }

    #[test]
    fn spec_wire_to_led_matches_the_firmware_copy() {
        assert_eq!(WIRE_TO_LED, FIRMWARE_WIRE_TO_LED);
    }

    /// the spec's wire to matrix table inverts to the firmware's
    /// `MATRIX_TO_WIRE` with the three dead cells left dead.
    #[test]
    fn matrix_to_wire_inverts_the_spec_table() {
        const NO_WIRE: u8 = 0xff;
        let mut matrix = [[NO_WIRE; 4]; 5];
        for (wire, &(r, c)) in WIRE_TO_MATRIX.iter().enumerate() {
            matrix[usize::from(r)][usize::from(c)] = u8::try_from(wire).expect("wire fits");
        }
        assert_eq!(matrix[1][3], NO_WIRE);
        assert_eq!(matrix[3][3], NO_WIRE);
        assert_eq!(matrix[4][0], NO_WIRE);
        for (wire, &(r, c)) in WIRE_TO_MATRIX.iter().enumerate() {
            assert_eq!(
                matrix[usize::from(r)][usize::from(c)],
                u8::try_from(wire).expect("wire fits")
            );
        }
    }

    /// the qmk tree beside this checkout's owner, when it is present (the
    /// machine that flashes). elsewhere the three golden tests below skip.
    fn qmk_mf17() -> Option<std::path::PathBuf> {
        let home = std::env::var_os("HOME")?;
        let dir = std::path::PathBuf::from(home).join("qmk_firmware/keyboards/magic_force/mf17");
        (dir.join("keyboard.json").is_file() && dir.join("keymaps/boxbox/keymap.c").is_file())
            .then_some(dir)
    }

    /// the body between `marker`'s opening brace and `close`, comments removed.
    fn c_table(src: &str, marker: &str, close: &str) -> Option<String> {
        let rest = &src[src.find(marker)? + marker.len()..];
        let open = rest.find('{')?;
        let body = &rest[open + 1..];
        let end = body.find(close)?;
        let mut out = String::new();
        let mut in_comment = false;
        let mut chars = body[..end].chars().peekable();
        while let Some(ch) = chars.next() {
            if in_comment {
                if ch == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    in_comment = false;
                }
            } else if ch == '/' && chars.peek() == Some(&'*') {
                chars.next();
                in_comment = true;
            } else {
                out.push(ch);
            }
        }
        Some(out)
    }

    #[test]
    fn spec_table_equals_the_truth_derived_from_keyboard_json() {
        let Some(dir) = qmk_mf17() else {
            eprintln!("qmk tree absent, keyboard.json golden skipped: run it on the mac");
            return;
        };
        let text = std::fs::read_to_string(dir.join("keyboard.json")).expect("keyboard.json reads");
        let kb: serde_json::Value = serde_json::from_str(&text).expect("keyboard.json parses");
        let layout = kb["rgb_matrix"]["layout"]
            .as_array()
            .expect("layout is a list");
        assert_eq!(layout.len(), KEY_COUNT);
        /* led i sits at matrix position layout[i].matrix: invert, then walk wire order */
        let derived: Vec<u8> = WIRE_TO_MATRIX
            .iter()
            .map(|&(r, c)| {
                let led = layout
                    .iter()
                    .position(|e| e["matrix"] == serde_json::json!([r, c]))
                    .expect("every wire has a matrix cell");
                u8::try_from(led).expect("led fits")
            })
            .collect();
        assert_eq!(derived, WIRE_TO_LED);
    }

    #[test]
    fn firmware_wire_to_led_matches_the_spec() {
        let Some(dir) = qmk_mf17() else {
            eprintln!("qmk tree absent, keymap golden skipped: run it on the mac");
            return;
        };
        let src =
            std::fs::read_to_string(dir.join("keymaps/boxbox/keymap.c")).expect("keymap reads");
        let table = c_table(&src, "WIRE_TO_LED[KEY_COUNT]", "}").expect("WIRE_TO_LED is present");
        let fw: Vec<u8> = table
            .split(',')
            .filter_map(|tok| tok.trim().parse::<u8>().ok())
            .collect();
        assert_eq!(fw, WIRE_TO_LED);
    }

    #[test]
    fn firmware_matrix_to_wire_inverts_the_spec_table() {
        let Some(dir) = qmk_mf17() else {
            eprintln!("qmk tree absent, matrix golden skipped: run it on the mac");
            return;
        };
        let src =
            std::fs::read_to_string(dir.join("keymaps/boxbox/keymap.c")).expect("keymap reads");
        let table = c_table(&src, "MATRIX_TO_WIRE[MATRIX_ROWS][MATRIX_COLS]", "\n};")
            .expect("MATRIX_TO_WIRE is present");
        let rows: Vec<Vec<u16>> = table
            .lines()
            .filter_map(|line| {
                let inner = line.split_once('{')?.1.split_once('}')?.0;
                Some(
                    inner
                        .split(',')
                        .map(|tok| match tok.trim() {
                            "NO_WIRE" => 0xff,
                            t => t.parse::<u16>().unwrap_or(0xffff),
                        })
                        .collect(),
                )
            })
            .collect();
        assert_eq!(rows.len(), 5);
        for (wire, &(r, c)) in WIRE_TO_MATRIX.iter().enumerate() {
            assert_eq!(
                rows[usize::from(r)][usize::from(c)],
                u16::try_from(wire).expect("wire fits")
            );
        }
        /* the three dead matrix cells stay dead */
        assert_eq!(rows[1][3], 0xff);
        assert_eq!(rows[3][3], 0xff);
        assert_eq!(rows[4][0], 0xff);
    }
}
