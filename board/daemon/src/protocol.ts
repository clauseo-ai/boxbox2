/* wire protocol v1, the daemon's half. docs/scope-board.md §4 is the law;
   the firmware's keymap.c holds the mirror tables. pure module: no hid,
   no io, so every byte here is testable without a board. */

export const PROTO_VERSION = 1;
export const REPORT_LEN = 32;
export const KEY_COUNT = 17;

/* host → board */
export const OP_HELLO = 0x01;
export const OP_PALETTE = 0x02;
export const OP_FRAME = 0x03;
export const OP_GLOBAL = 0x04;
export const OP_PING = 0x05;
export const OP_MODE = 0x06;

/* board → host */
export const OP_HELLO_ACK = 0x81;
export const OP_KEY = 0x82;
export const OP_MODE_ECHO = 0x83;

/** wire order: the /board sim order, top-left to bottom-right. NEVER the
    led order (bottom-up) or the matrix order — docs/scope-board.md §3. */
export const WIRE_NAMES = [
  "nl", "div", "mul", "min",
  "k7", "k8", "k9", "plus",
  "k4", "k5", "k6",
  "k1", "k2", "k3", "ent",
  "k0", "dot",
] as const;

export type WireName = (typeof WIRE_NAMES)[number];

export const WIRE: Record<WireName, number> = Object.fromEntries(
  WIRE_NAMES.map((n, i) => [n, i]),
) as Record<WireName, number>;

/** reference copy of the firmware's wire→led table. the daemon never
    sends led indices — this exists so the three-way golden test can pin
    spec == firmware == keyboard.json without parsing C at runtime. */
export const WIRE_TO_LED = [13, 14, 15, 16, 10, 11, 12, 9, 6, 7, 8, 3, 4, 5, 2, 0, 1] as const;

/** palette slots 0-8 are reserved meaning; 9-15 are liveries. */
export const SLOT = {
  off: 0,
  you: 1,
  needs: 2,
  needsHot: 3,
  perm: 4,
  permHot: 5,
  fault: 6,
  live: 7,
  info: 8,
} as const;

/** slots 9-13 are liveries. 14 and 15 are the two ANIMATED slots: the
    daemon streams their rgb through sines so motion is smooth 8-bit
    palette space, never the 4-bit level staircase (first light verdict).
    BREATH (15) is the radio's violet float, slow — an invitation, press
    me (the old nl heartbeat went steady 2026-07-27: the watchdog's flip
    to the donor numpad already announces a dead daemon). LIVE_BREATH
    (14) is the lime working-pulse, faster — energy, not sleep. */
export const LIVERY_SLOTS = [9, 10, 11, 12, 13] as const;
export const LIVE_BREATH_SLOT = 14;
export const BREATH_SLOT = 15;

/** the reserved palette in LED SPACE, not screen space. every value here
    was proven on THIS board's leds at first light (2026-07-26): the time
    capsule test rendered the 2023 donor colors and the corne's palette
    sat in frame as reference. the law the photos taught: channels at
    zero or loud, nothing mushy in the middle — on ws2812s, desaturation
    IS channels sitting close together. same six voices as design v2;
    hue identity lives in the channel ratios, loudness in LEVEL. */
export const RESERVED_RGB: Record<number, [number, number, number]> = {
  /* the FLOOR, not black (his verdict 2026-07-27, bench/floor.ts audition
     against five candidates on the real caps): an unlit key idles at a
     neutral white whisper so the instrument never reads as a switched-off
     numpad — the caps carry printed legends, and dead black shows them.
     true black still exists, but only through LEVEL 0 (calc, the
     watchdog's zeroed buffer), never through this rgb. */
  [SLOT.off]: [255, 255, 255],
  [SLOT.you]: [190, 0, 255] /* punchier than the corne's 150 — his call at the bench */,
  [SLOT.needs]: [255, 0, 115],
  [SLOT.needsHot]: [255, 0, 160] /* the capsule's tall-key purple-pink */,
  [SLOT.perm]: [255, 190, 0] /* capsule amber reads gold under these caps */,
  [SLOT.permHot]: [255, 230, 0],
  [SLOT.fault]: [255, 0, 0],
  [SLOT.live]: [180, 255, 0] /* LIME — the capsule's dot key, his call: one voice for alive */,
  [SLOT.info]: [40, 110, 255] /* clear blue, teal-safe */,
};

/** 4-bit brightness levels: an index into the firmware's perceptual rom
    curve, NOT a linear pwm value. these named stops are the design's
    vocabulary; scenes speak in these, never raw numbers. recalibrated at
    first light: the original stops sat in the curve's bottom fifth and
    were invisible at noon. */
export const LEVEL = {
  off: 0,
  idle: 3, /* livery ghost: you always know where she lives */
  dim: 5,
  rest: 9, /* a signal, standing — clearly a colored key across the desk */
  mid: 11,
  bright: 13,
  hot: 15, /* a signal, shouting — full send */
} as const;

export type Cell = number; /* palette<<4 | level */

export function cell(slot: number, level: number): Cell {
  return ((slot & 0x0f) << 4) | (level & 0x0f);
}

/** the floor: what "off" looks like while the daemon drives. the off
    slot's white at the idle stop — below every signal, above black.
    render.ts lays it under every bank except calc (the numpad soul
    keeps true dark). */
export const FLOOR_CELL: Cell = cell(SLOT.off, LEVEL.idle);

export const DARK_FRAME: readonly Cell[] = Object.freeze(
  Array<Cell>(KEY_COUNT).fill(0),
);

/* ——— outbound reports. node-hid on darwin wants a leading report id
   byte; qmk's raw hid uses 0. every report is exactly 1 + 32 bytes. ——— */

function report(op: number, payload: number[] = []): number[] {
  if (payload.length > REPORT_LEN - 1) {
    throw new Error(`payload ${payload.length} exceeds report body`);
  }
  return [0, op, ...payload, ...Array(REPORT_LEN - 1 - payload.length).fill(0)];
}

export function helloReport(): number[] {
  return report(OP_HELLO, [PROTO_VERSION]);
}

export function paletteReport(slot: number, rgb: [number, number, number]): number[] {
  return report(OP_PALETTE, [slot & 0x0f, ...rgb]);
}

export function frameReport(cells: readonly Cell[]): number[] {
  if (cells.length !== KEY_COUNT) {
    throw new Error(`frame wants ${KEY_COUNT} cells, got ${cells.length}`);
  }
  return report(OP_FRAME, [...cells]);
}

export function globalReport(scale: number): number[] {
  return report(OP_GLOBAL, [Math.max(0, Math.min(255, Math.round(scale)))]);
}

export function pingReport(): number[] {
  return report(OP_PING);
}

export function modeReport(calc: boolean): number[] {
  return report(OP_MODE, [calc ? 1 : 0]);
}

/* ——— inbound ——— */

export type BoardMessage =
  | { kind: "hello"; fw: number; proto: number; mode: number }
  | { kind: "key"; wire: number; down: boolean }
  | { kind: "mode"; mode: number; reason: "host" | "local" | "watchdog" }
  | { kind: "unknown"; op: number };

const MODE_REASONS = ["host", "local", "watchdog"] as const;

export function parseBoardReport(buf: Uint8Array): BoardMessage {
  switch (buf[0]) {
    case OP_HELLO_ACK:
      return { kind: "hello", fw: buf[1], proto: buf[2], mode: buf[3] };
    case OP_KEY:
      return { kind: "key", wire: buf[1], down: buf[2] === 0 };
    case OP_MODE_ECHO:
      return {
        kind: "mode",
        mode: buf[1],
        reason: MODE_REASONS[buf[2]] ?? "host",
      };
    default:
      return { kind: "unknown", op: buf[0] };
  }
}
