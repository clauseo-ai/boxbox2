/* the scene engine: fleet truth in, seventeen cells out. every scene in
   docs/scope-board.md §6's catalogue renders here, pure, so the tests can
   pin each one to fixtures (§13: a scene without a test quietly stops
   firing). `app/board/board.tsx` is the visual law these imitate.

   two layers compose every frame: a BASE (the current bank, a function of
   state) and an optional TRANSIENT (a one-shot animation that overrides
   whole frames or single cells). deep work filters the result; the night
   curve rides the GLOBAL byte in render.ts, never here. */

import type { LiveSeat, Seat } from "../../lib/board/seats";
import { bindingFor, type BindingState } from "../../lib/board/contract";
import {
  BREATH_SLOT, cell, DARK_FRAME, FLOOR_CELL, KEY_COUNT, LEVEL,
  LIVE_BREATH_SLOT, SLOT, WIRE, type Cell,
} from "./protocol";

/* ——— geometry ——— */

/** the digit-key order — pit options AND the drive queue since
    2026-07-29 ("order it 123456789"): rank n sits on the key whose cap
    says n, so the glass's badges and the pad agree. */
export const DIGIT_WIRES = [
  WIRE.k1, WIRE.k2, WIRE.k3,
  WIRE.k4, WIRE.k5, WIRE.k6,
  WIRE.k7, WIRE.k8, WIRE.k9,
];
export const MACHINE_WIRES = [WIRE.div, WIRE.mul, WIRE.min];

/** the board's perimeter, clockwise — the racetrack. */
export const RING = [
  WIRE.nl, WIRE.div, WIRE.mul, WIRE.min, WIRE.plus, WIRE.ent,
  WIRE.dot, WIRE.k0, WIRE.k1, WIRE.k4, WIRE.k7,
];

/** four column stacks, bottom→top, for meters (the /board sim's STACKS) */
export const STACKS = [
  [WIRE.k0, WIRE.k1, WIRE.k4, WIRE.k7, WIRE.nl],
  [WIRE.k0, WIRE.k2, WIRE.k5, WIRE.k8, WIRE.div],
  [WIRE.dot, WIRE.k3, WIRE.k6, WIRE.k9, WIRE.mul],
  [WIRE.ent, WIRE.ent, WIRE.plus, WIRE.plus, WIRE.min],
];

/* ——— transients ——— */

export type TransientFrame = {
  holdMs: number;
  /** KEY_COUNT cells; null = transparent, base shows through */
  cells: (Cell | null)[];
};

export type Transient = {
  name: string;
  frames: TransientFrame[];
  /** survives the deep work filter (permission arrivals, red flags) */
  essential?: boolean;
};

const clear = (): (Cell | null)[] => Array(KEY_COUNT).fill(null);

export class TransientPlayer {
  private active: Transient | null = null;
  private startedAt = 0;
  private queue: Transient[] = [];

  push(t: Transient, now: number) {
    if (this.active) {
      /* one at a time; arrivals queue, they never interleave */
      this.queue.push(t);
      return;
    }
    this.active = t;
    this.startedAt = now;
  }

  /** the overlay for this instant, or null when no transient is running */
  current(now: number, deepWork: boolean): (Cell | null)[] | null {
    while (this.active) {
      let t = now - this.startedAt;
      for (const f of this.active.frames) {
        if (t < f.holdMs) {
          if (deepWork && !this.active.essential) return null;
          return f.cells;
        }
        t -= f.holdMs;
      }
      this.active = this.queue.shift() ?? null;
      this.startedAt = now;
    }
    return null;
  }

  busy(): boolean {
    return this.active !== null;
  }
}

/* ——— transient builders, the catalogue's one-shots ——— */

/** formation lap: the roll call. every bound key sweeps in its livery,
    then the base state settles. no bindings yet → a ring sweep in `you`,
    the board introducing itself. */
export function formationLap(
  bound: { wire: number; slot: number }[],
): Transient {
  const frames: TransientFrame[] = [];
  if (bound.length === 0) {
    for (let i = 0; i < RING.length; i++) {
      const cells = clear();
      cells[RING[i]] = cell(SLOT.you, LEVEL.hot);
      cells[RING[(i + RING.length - 1) % RING.length]] = cell(SLOT.you, LEVEL.dim);
      frames.push({ holdMs: 70, cells });
    }
  } else {
    for (const [i, b] of bound.entries()) {
      const cells = clear();
      cells[b.wire] = cell(b.slot, LEVEL.hot);
      const prev = bound[i - 1];
      if (prev) cells[prev.wire] = cell(prev.slot, LEVEL.dim);
      frames.push({ holdMs: 420, cells });
    }
  }
  return { name: "formation", frames };
}

/** the briefing: the night replayed in three seconds — a green sweep per
    row, twice, then the base (which already shows what stands) takes over. */
export function briefing(): Transient {
  const rows = [
    [WIRE.nl, WIRE.div, WIRE.mul, WIRE.min],
    [WIRE.k7, WIRE.k8, WIRE.k9, WIRE.plus],
    [WIRE.k4, WIRE.k5, WIRE.k6],
    [WIRE.k1, WIRE.k2, WIRE.k3, WIRE.ent],
    [WIRE.k0, WIRE.dot],
  ];
  const frames: TransientFrame[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const row of rows) {
      const cells = clear();
      for (const w of row) cells[w] = cell(SLOT.live, LEVEL.mid);
      frames.push({ holdMs: 140, cells });
    }
    frames.push({ holdMs: pass === 0 ? 200 : 350, cells: clear() });
  }
  return { name: "briefing", frames };
}

/** box box: a need arrives. two pulses at its key, then stillness — the
    base holds it at rest and age does any further shouting. */
export function arrivalPulse(wire: number, slot: number, essential = false): Transient {
  const on = clear();
  on[wire] = cell(slot, LEVEL.hot);
  const off = clear();
  off[wire] = cell(SLOT.off, LEVEL.off);
  return {
    name: "arrival",
    essential,
    frames: [
      { holdMs: 240, cells: on },
      { holdMs: 170, cells: off },
      { holdMs: 240, cells: on },
      { holdMs: 170, cells: off },
    ],
  };
}

/** the victory lap: two green laps around the perimeter with a trail.
    fires on a verdict (a reviewable checkout leaving the board). */
export function victoryLap(): Transient {
  const frames: TransientFrame[] = [];
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < RING.length; i++) {
      const cells = clear();
      cells[RING[i]] = cell(SLOT.live, LEVEL.hot);
      cells[RING[(i + RING.length - 1) % RING.length]] = cell(SLOT.live, LEVEL.mid);
      cells[RING[(i + RING.length - 2) % RING.length]] = cell(SLOT.live, LEVEL.dim);
      frames.push({ holdMs: 80, cells });
    }
  }
  return { name: "victory", frames };
}

/** the red flag: a fault announces itself. the base then holds it hot. */
export function redFlag(wire: number): Transient {
  return arrivalPulse(wire, SLOT.fault, true);
}

/* ——— live overlays (not transients: they track held state) ——— */

/** the voice meter: four rms bands on the four column stacks. */
export function vuCells(bands: [number, number, number, number]): (Cell | null)[] {
  const cells = clear();
  bands.forEach((h, col) => {
    const height = Math.max(0, Math.min(5, h));
    for (let i = 0; i < height; i++) {
      const wire = STACKS[col][i];
      const head = i === height - 1;
      const c = cell(SLOT.you, head ? LEVEL.hot : LEVEL.rest);
      if (cells[wire] === null || (cells[wire] as number) < c) cells[wire] = c;
    }
  });
  return cells;
}

/** the queue view, shown while a seat is held: one lime key per parked
    order on the digit keys (1..n, the same address grammar as the
    seats), ent gold when a flush is armed — chord ent to fire it.
    depth 0 is an honest empty board: nothing parked, nothing to flush.
    replaced the fuel gauge 2026-07-29 (zero seat-holds in the log; 33%
    of prompts queue and the glass's flush fired 58 times). */
export function queueCells(depth: number): Cell[] {
  const cells = [...DARK_FRAME] as Cell[];
  const n = Math.max(0, Math.min(9, depth));
  for (let i = 0; i < n; i++) {
    cells[DIGIT_WIRES[i]] = cell(SLOT.live, LEVEL.bright);
  }
  if (n > 0) cells[WIRE.ent] = cell(SLOT.perm, LEVEL.bright);
  return cells;
}

/* ——— the banks (base layer) ——— */

export type MachineView = { reachable: boolean };

export type SeatView = {
  seat: Seat;
  /** livery slot when this seat's agent is bound to a key */
  liverySlot?: number;
};

export type DriveModel = {
  /** bound wires with their livery slot and, when alive, their seat */
  bound: { wire: number; slot: number; seat?: Seat; working?: boolean; deltaFresh?: boolean }[];
  /** ranked hot seats NOT already on a bound key; the unbound 3×3 pages through */
  hotSeats: Seat[];
  /** working sessions, freshest tokens first — they fill the grid AFTER
      the needs and pulse lime on the LIVE_BREATH slot ("go to live
      sessions", first light). deltaFresh lifts the level while tokens
      land. */
  liveSeats: { seat: LiveSeat; deltaFresh: boolean }[];
  page: number;
  machines: MachineView[];
  /** something is waiting (plus = copy armed) */
  copyArmed: boolean;
};

export function renderDrive(m: DriveModel): Cell[] {
  const cells = [...DARK_FRAME] as Cell[];

  /* nl holds STEADY violet: the daemon is driving ("the purple itself
     is the indicator", 2026-07-27 — the old heartbeat breath carried no
     information the watchdog doesn't already shout by flipping the whole
     board to the donor numpad within 2s). the radio alone rides the
     BREATH slot: its float is an invitation, press me. */
  cells[WIRE.nl] = cell(SLOT.you, LEVEL.bright);
  cells[WIRE.k0] = cell(BREATH_SLOT, LEVEL.bright);

  /* machines: steady green alive, loud red dead. no pulse — "nothing
     breathes for attention it has not earned", and a healthy machine has
     earned none. */
  for (const [i, mv] of m.machines.entries()) {
    const wire = MACHINE_WIRES[i];
    if (wire === undefined) break;
    cells[wire] = mv.reachable
      ? cell(SLOT.live, LEVEL.rest)
      : cell(SLOT.fault, LEVEL.bright);
  }

  /* bound keys: state outranks identity — a signal takes the led, the
     livery holds it otherwise. a bound WORKING agent pulses lime. */
  for (const b of m.bound) {
    cells[b.wire] = b.seat
      ? seatCell(b.seat)
      : b.working
        ? cell(LIVE_BREATH_SLOT, b.deltaFresh ? LEVEL.bright : LEVEL.rest)
        : cell(b.slot, LEVEL.dim);
  }

  /* the automatic queue fills every unbound grid key in DIGIT order —
     needs first (the triage order), then live sessions, one paged list.
     rank n sits on key n (2026-07-29, "order it 123456789": the digit is
     the address — the glass badges each thread's digit, and that only
     works if 4 means fourth). rows 1-2 are not livery-reserved
     (2026-07-27, "use all nine keys"): up to nine threads at a glance,
     paging only past that. a working seat pulses on the LIVE_BREATH
     slot. */
  const seatWires = DIGIT_WIRES.filter(
    (w) => !m.bound.some((b) => b.wire === w),
  );
  const rowCells: Cell[] = [
    ...m.hotSeats.map((s) => seatCell(s)),
    ...m.liveSeats.map((l) =>
      cell(LIVE_BREATH_SLOT, l.deltaFresh ? LEVEL.bright : LEVEL.rest),
    ),
  ];
  const start = m.page * seatWires.length;
  for (const [i, wire] of seatWires.entries()) {
    const c = rowCells[start + i];
    if (c !== undefined) cells[wire] = c;
  }

  if (m.copyArmed) cells[WIRE.plus] = cell(SLOT.needs, LEVEL.dim);
  /* ent is a REAL enter key (firmware KC_PENT, 2026-07-27): it holds a
     steady violet — the two always-real keys carry a standing identity,
     never the anonymous floor. steady, not breathing: it asks for
     nothing. rest, not idle ("a little dim", his call 2026-07-27): a
     colored key you can read across the desk. */
  cells[WIRE.ent] = cell(SLOT.you, LEVEL.rest);
  if (seatWires.length > 0 && rowCells.length > seatWires.length) {
    cells[WIRE.dot] = cell(SLOT.info, LEVEL.idle);
  }
  return cells;
}

export function seatCell(seat: Seat): Cell {
  switch (seat.need) {
    case "permission":
      return seat.hot ? cell(SLOT.permHot, LEVEL.hot) : cell(SLOT.perm, LEVEL.rest);
    case "question":
      return seat.hot ? cell(SLOT.info, LEVEL.hot) : cell(SLOT.info, LEVEL.rest);
    case "fault":
      return cell(SLOT.fault, LEVEL.hot);
    case "review":
      return seat.hot ? cell(SLOT.needsHot, LEVEL.bright) : cell(SLOT.needs, LEVEL.rest);
    case "unread":
      return seat.hot ? cell(SLOT.needsHot, LEVEL.hot) : cell(SLOT.needs, LEVEL.rest);
  }
}

export type PitModel =
  | {
      kind: "permission";
      hot: boolean;
      rejectArmed: boolean;
    }
  | {
      kind: "question";
      options: number;
    };

export function renderPit(m: PitModel): Cell[] {
  const cells = [...DARK_FRAME] as Cell[];
  if (m.kind === "permission") {
    cells[WIRE.k5] = cell(m.hot ? SLOT.permHot : SLOT.perm, LEVEL.hot);
    cells[WIRE.k1] = cell(SLOT.permHot, LEVEL.bright); /* once */
    cells[WIRE.k2] = cell(SLOT.perm, LEVEL.rest); /* always */
    cells[WIRE.k3] = m.rejectArmed
      ? cell(SLOT.fault, LEVEL.hot) /* armed: next press fires */
      : cell(SLOT.perm, LEVEL.dim);
    cells[WIRE.min] = cell(SLOT.info, LEVEL.idle); /* skip */
    return cells;
  }
  cells[WIRE.k5] = cell(SLOT.info, LEVEL.hot);
  const n = Math.max(0, Math.min(9, m.options));
  for (let i = 0; i < n; i++) {
    if (DIGIT_WIRES[i] === WIRE.k5 && n >= 5) {
      /* option 5 shares the call key; the call yields to the option */
    }
    cells[DIGIT_WIRES[i]] = cell(SLOT.info, LEVEL.rest);
  }
  cells[WIRE.k0] = cell(SLOT.you, LEVEL.idle); /* voice answers */
  cells[WIRE.min] = cell(SLOT.info, LEVEL.idle); /* skip */
  return cells;
}

export type FleetModel = {
  /** per machine column 0..2: activity 0..5 */
  columns: number[];
  /** spend 0..1 toward the day's line */
  odometer: number;
};

export function renderFleet(m: FleetModel): Cell[] {
  const cells = [...DARK_FRAME] as Cell[];
  m.columns.slice(0, 3).forEach((height, col) => {
    const h = Math.max(0, Math.min(5, Math.round(height)));
    for (let i = 0; i < h; i++) {
      cells[STACKS[col][i]] = cell(SLOT.live, i === h - 1 ? LEVEL.rest : LEVEL.dim);
    }
  });
  const oh = Math.round(Math.max(0, Math.min(1, m.odometer)) * 5);
  for (let i = 0; i < oh; i++) {
    cells[STACKS[3][i]] = cell(SLOT.you, i === oh - 1 ? LEVEL.rest : LEVEL.dim);
  }
  return cells;
}

/* ——— composition ——— */

const DEEP_WORK_SLOTS = new Set<number>([SLOT.perm, SLOT.permHot, SLOT.fault]);

/** deep work: silent except for money. permission and fault survive,
    everything else goes dark. a render filter, never a subscription
    change (docs/scope-board.md §6). */
export function deepWorkFilter(cells: Cell[]): Cell[] {
  return cells.map((c) => (DEEP_WORK_SLOTS.has(c >> 4) ? c : 0));
}

/** the floor: no driven key is ever black (2026-07-27, "there shouldn't
    be a situation where lights are switched off"). anything that would
    render dark — level 0 — idles at the off slot's white whisper
    instead. scenes keep speaking "off"; this is a render law, same tier
    as night. calc mode bypasses it in render.ts: a numpad is dark. */
export function applyFloor(cells: Cell[]): Cell[] {
  return cells.map((c) => ((c & 0x0f) === 0 ? FLOOR_CELL : c));
}

export function composite(base: Cell[], overlay: (Cell | null)[] | null): Cell[] {
  if (!overlay) return base;
  return base.map((c, i) => overlay[i] ?? c);
}
