/* the deliberate changes a replay against v2 is allowed, and nothing else.
   decision 1 binds every key and light; decision 79 changes four things the
   traces see, each written here as a rule a reviewer can read: which
   scenario, which steps (by label), which channel, and exactly which part of
   a line may differ. the diff applies them and prints every line they
   forgave separately, "accounted for by decision 79", so a forgiven line is
   never silent. a difference no rule names fails the gate.

   a rule never rewrites a line on its own: it says when a trace line and a
   replay line are the same behaviour. the diff still pairs lines in order,
   so a rule can only forgive a line the replay actually drew. */

import { type CHANNELS, DIGIT_WIRES, type Seats } from "./normalize";
import type { Gesture } from "./scenarios";

export type Channel = (typeof CHANNELS)[number];

export type Delta = {
  id: string;
  /** the decision that makes it deliberate */
  source: string;
  why: string;
  /** a scenario's name, or every scenario */
  scenario: string | "*";
  /** step labels, or every step */
  steps: readonly string[] | "*";
  channel: Channel;
  /** the trace's line and the replay's line are the same behaviour under this rule */
  same: (expected: string, actual: string, context?: LineContext) => boolean;
  /** a replay line with no trace line to pair with that this rule still accounts for */
  extra?: (actual: string) => boolean;
};

/** what the diff knows about a pair of lines beyond their text (leds only, across versions) */
export type LineContext = {
  /** the seat map each frame was drawn under */
  expectedSeats: Seats | null;
  actualSeats: Seats | null;
  /** the replay's frame was drawn before the first view reached the daemon */
  actualBeforeView: boolean;
  /** the trace's frame is v1's seat memo redrawing the pre-pit picture after an answer */
  expectedMemo?: boolean;
  /** how long the replay's frame held, in ms */
  actualHold?: number;
};

/** a step whose recorded presses v2 does not replay as recorded, because the verb moved keys */
export type KeyChange = { scenario: string; step: string; gesture: Gesture; source: string; why: string };

/** the 17 cells of a normalized frame line, or null for any other line */
export function frameCells(line: string): number[] | null {
  if (!line.startsWith("frame ")) return null;
  const cells = line.slice(6).split(" ").map((h) => Number.parseInt(h, 16));
  return cells.length === 17 && cells.every((c) => Number.isInteger(c)) ? cells : null;
}

/** two frames that differ, and only in `cells` */
function differsOnlyAt(expected: number[], actual: number[], cells: readonly number[]): boolean {
  let differs = false;
  for (let i = 0; i < 17; i++) {
    if (expected[i] === actual[i]) continue;
    if (!cells.includes(i)) return false;
    differs = true;
  }
  return differs;
}

const WIRE_DIV = 1;
const WIRE_MUL = 2;
const WIRE_MIN = 3;
const WIRE_PLUS = 7;
const WIRE_ENT = 14;
const WIRE_DOT = 16;

/** v1's mark-read light on +, the cell every drive frame in the traces carries there: slot 2 at level 5 */
export const V1_MARK_READ_CELL = 0x25;
/** the floor: what a machine key with no machine shows (v1's * and - with one host) */
export const FLOOR_CELL = 0x03;

const MARK_READ_STEP = "tap plus: mark the top call read";
const FLEET_STEPS = ["tap nl: drive to fleet", "tap k3 in fleet: no verb"];

/** `telemetry board.key {props} rest`, split; null for any other line */
function boardKey(line: string): { props: { [key: string]: unknown }; rest: string } | null {
  const match = /^telemetry board\.key (\{.*?\})( .*)?$/.exec(line);
  if (!match?.[1]) return null;
  try {
    const props = JSON.parse(match[1]) as unknown;
    return typeof props === "object" && props !== null ? { props: props as { [key: string]: unknown }, rest: match[2] ?? "" } : null;
  } catch {
    return null;
  }
}

/** a board.key event for the hold on . that marks read, either half */
function isDotHold(line: string): { props: { [key: string]: unknown }; rest: string } | null {
  const k = boardKey(line);
  return k && k.props.wire === WIRE_DOT && k.props.target === "read" && (k.props.verb === "holdStart" || k.props.verb === "holdEnd") ? k : null;
}

export const DECISION_79: Delta[] = [
  {
    id: "plus is machine 4, and the mark-read light moves to dot",
    source: "decision 79",
    why:
      "+ lights the fourth machine instead of v1's mark-read light (copy armed, slot 2 level 5): where the trace's + shows it, the replay's + shows a machine light (the floor when there is no fourth machine, or what / * - show). " +
      "the light moves to . with the verb: where the trace's . is the floor (no more pages to hint), the replay's . may show it",
    scenario: "*",
    steps: "*",
    channel: "leds",
    same: (expected, actual) => {
      const e = frameCells(expected);
      const a = frameCells(actual);
      if (!e || !a || !differsOnlyAt(e, a, [WIRE_PLUS, WIRE_DOT])) return false;
      const plus = e[WIRE_PLUS] === a[WIRE_PLUS] || (e[WIRE_PLUS] === V1_MARK_READ_CELL && [FLOOR_CELL, a[WIRE_DIV], a[WIRE_MUL], a[WIRE_MIN]].includes(a[WIRE_PLUS]));
      const dot = e[WIRE_DOT] === a[WIRE_DOT] || (e[WIRE_DOT] === FLOOR_CELL && a[WIRE_DOT] === V1_MARK_READ_CELL);
      return plus && dot;
    },
  },
  {
    id: "the fleet bank's fourth column",
    source: "decision 79",
    why: "the fleet bank shows four machine columns and no spend odometer: the odometer's stack (ent, ent, +, +, -) is the fourth machine's column",
    scenario: "thread-switching",
    steps: FLEET_STEPS,
    channel: "leds",
    same: (expected, actual) => {
      const e = frameCells(expected);
      const a = frameCells(actual);
      return e !== null && a !== null && differsOnlyAt(e, a, [WIRE_MIN, WIRE_PLUS, WIRE_ENT]);
    },
  },
  {
    id: "mark read is a hold on dot: the presses",
    source: "decision 79",
    why: "the step that tapped + to mark the top call read holds . instead, so the board reports wire 16 where the trace has wire 7",
    scenario: "thread-switching",
    steps: [MARK_READ_STEP],
    channel: "board",
    same: (expected, actual) =>
      (expected === `key ${WIRE_PLUS} down` && actual === `key ${WIRE_DOT} down`) || (expected === `key ${WIRE_PLUS} up` && actual === `key ${WIRE_DOT} up`),
  },
  {
    id: "mark read is a hold on dot: the key's light",
    source: "decision 79",
    why: "under the finger it is . that answers, not +",
    scenario: "thread-switching",
    steps: [MARK_READ_STEP],
    channel: "leds",
    same: (expected, actual) => {
      const e = frameCells(expected);
      const a = frameCells(actual);
      return e !== null && a !== null && differsOnlyAt(e, a, [WIRE_PLUS, WIRE_DOT]);
    },
  },
  {
    id: "mark read is a hold on dot: the key event",
    source: "decision 79",
    why:
      "the board.key event names the key, gesture and target: v1's one tap on + (target copy) is a hold on . in the replay, which v2's grammar reports as holdStart and holdEnd (target read), as it does every hold. the bank and the outcome must match",
    scenario: "thread-switching",
    steps: [MARK_READ_STEP],
    channel: "calls",
    same: (expected, actual) => {
      const e = boardKey(expected);
      const a = isDotHold(actual);
      return e !== null && a !== null && e.props.wire === WIRE_PLUS && e.rest === a.rest && e.props.bank === a.props.bank;
    },
    extra: (actual) => isDotHold(actual) !== null,
  },
];

export const KEY_CHANGES: KeyChange[] = [
  {
    scenario: "thread-switching",
    step: MARK_READ_STEP,
    gesture: { kind: "hold", key: "dot", ms: 600 },
    source: "decision 79",
    why: "mark-read moved from a tap on + to a hold on .",
  },
];

/** the rules that hold in one step and channel of one scenario */
export function deltasFor(deltas: readonly Delta[], scenario: string, step: string, channel: Channel): Delta[] {
  return deltas.filter((d) => (d.scenario === "*" || d.scenario === scenario) && (d.steps === "*" || d.steps.includes(step)) && d.channel === channel);
}
/** the seat memo's window: normalize.ts's SEAT_MEMO_MS, the server's 250ms coalesce on v2's side */
const MEMO_MS = 250;
/** a hold is measured at the fake board, from one write to the next, after both crossed the server's stream, the
    proxy, the daemon and the socket: a frame the server held for one 250ms build was seen holding 251ms. so the window
    is read with this much measurement slack, and no more */
export const HOLD_SLACK_MS = 10;

const frameLine = (cells: number[]) => `frame ${cells.map((c) => c.toString(16).padStart(2, "0")).join(" ")}`;

/** the replay's frame with its digit cells moved to where the trace's seat map puts each thread, or null when the two
    maps do not seat the same threads */
export function permuteDigits(actual: number[], actualSeats: Seats, expectedSeats: Seats): number[] | null {
  const seated = (seats: Seats) => seats.filter((k): k is string => k !== null).sort().join("\n");
  if (seated(actualSeats) !== seated(expectedSeats)) return null;
  const out = [...actual];
  for (const [i, key] of expectedSeats.entries()) {
    const wire = DIGIT_WIRES[i] as number;
    if (key === null) {
      if (actualSeats[i] !== null) return null;
      continue;
    }
    const from = actualSeats.indexOf(key);
    out[wire] = actual[DIGIT_WIRES[from] as number] as number;
  }
  return out;
}

/** a frame rule that forgives the decision 79 cells (+ and .) as well, so a frame both reseated and relit still pairs */
const decision79Frame = (expected: string, actual: string) => DECISION_79.some((d) => d.channel === "leds" && d.scenario === "*" && d.same(expected, actual));

/** the deliberate changes beyond decision 79: the server's seat order (decision 80), the daemon's silence until the
    board is plugged in (decision 81), and v1's telemetry fixed. printed under their own heading */
export const BEYOND_79: Delta[] = [
  {
    id: "seats follow the app's window order",
    source: "decision 80",
    why: "digit n is the app's window n, so the threads sit on other digits than v1's own triage put them: a frame compares by thread, each thread's light moved through each side's own seat map to where the trace's map seats it, and every other key byte for byte (calls and readback are read by digit in normalize.ts)",
    scenario: "*",
    steps: "*",
    channel: "leds",
    same: (expected, actual, context) => {
      const e = frameCells(expected);
      const a = frameCells(actual);
      if (!e || !a || !context?.expectedSeats || !context.actualSeats) return false;
      const moved = permuteDigits(a, context.actualSeats, context.expectedSeats);
      if (!moved) return false;
      const line = frameLine(moved);
      return line !== actual && (line === expected || decision79Frame(expected, line));
    },
  },
  {
    id: "the thread's true state where v1 redrew its seat memo",
    source: "decision 80",
    why: "after an answer, v1's seat memo could redraw the picture from before the pit for under 250ms; v2 has no memo (the server's view is its state) and shows the answered thread as it is for that moment instead. only where the trace's frame is that memo redraw, the replay's frame holds for at most 250ms (measured at the board, with HOLD_SLACK_MS), and, read by thread, the two differ on one digit key alone (decision 79's cells apart)",
    scenario: "*",
    steps: "*",
    channel: "leds",
    same: (expected, actual, context) => {
      const e = frameCells(expected);
      const a = frameCells(actual);
      if (!e || !a || context?.expectedMemo !== true || (context.actualHold ?? Number.POSITIVE_INFINITY) > MEMO_MS + HOLD_SLACK_MS) return false;
      const moved = context.expectedSeats && context.actualSeats ? permuteDigits(a, context.actualSeats, context.expectedSeats) : a;
      if (!moved) return false;
      const differing = DIGIT_WIRES.filter((w) => e[w] !== moved[w]);
      if (differing.length !== 1) return false;
      /* every other cell as the trace has it, then the rest must be the trace's frame or differ by decision 79 alone */
      const settled = [...moved];
      settled[differing[0] as number] = e[differing[0] as number] as number;
      const line = frameLine(settled);
      return line === expected || decision79Frame(expected, line);
    },
  },
  {
    id: "a bare frame before the first view",
    source: "decision 81",
    why: "the daemon opens no server connection until the board is plugged in, so its first frame, drawn on the hello before any view has arrived, cannot show threads or machines yet; v1 was already connected and drew its first frame full. only a frame drawn before the first view, never after",
    scenario: "*",
    steps: "*",
    channel: "leds",
    same: (expected, actual, context) => frameCells(expected) !== null && frameCells(actual) !== null && context?.actualBeforeView === true,
  },
  {
    id: "board.connect says the board's real firmware",
    source: "telemetry fix",
    why: "v1 sent a hardcoded fw 1; v2 sends the hello ack's fw and proto and counts reconnects. the outcome and every other field must match",
    scenario: "*",
    steps: "*",
    channel: "calls",
    same: (expected, actual) => {
      const e = telemetryOf(expected, "board.connect");
      const a = telemetryOf(actual, "board.connect");
      if (!e || !a || e.rest !== a.rest || e.props.fw !== 1) return false;
      const others = (p: { [key: string]: unknown }) => JSON.stringify(Object.entries(p).filter(([k]) => !["fw", "proto", "reconnects"].includes(k)));
      return typeof a.props.fw === "number" && a.props.proto === e.props.proto && typeof a.props.reconnects === "number" && others(e.props) === others(a.props);
    },
  },
  {
    id: "perf.board is new",
    source: "telemetry fix",
    why: "the daemon's budget row (docs/board.md, budgets: rss, footprint and cpu); v1 had none",
    scenario: "*",
    steps: "*",
    channel: "calls",
    same: () => false,
    extra: (actual) => telemetryOf(actual, "perf.board") !== null,
  },
];

/** `telemetry <kind> {props} rest`, split, for one kind; null for any other line */
function telemetryOf(line: string, kind: string): { props: { [key: string]: unknown }; rest: string } | null {
  const prefix = `telemetry ${kind} `;
  if (!line.startsWith(prefix)) return null;
  const match = /^(\{.*?\})( .*)?$/.exec(line.slice(prefix.length));
  if (!match?.[1]) return null;
  try {
    const props = JSON.parse(match[1]) as unknown;
    return typeof props === "object" && props !== null ? { props: props as { [key: string]: unknown }, rest: match[2] ?? "" } : null;
  } catch {
    return null;
  }
}

/** every deliberate change a replay against v2 forgives */
export const V2_DELTAS: Delta[] = [...DECISION_79, ...BEYOND_79];
