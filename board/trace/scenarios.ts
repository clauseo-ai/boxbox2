/* the three recorded sessions. each is what a user does with the board
   on a working day, reduced to a script a world can stage and a fake board
   can press: the setup the world builds before the daemon starts, then the
   steps, each a key gesture or something an agent does.

   wire indices are the protocol's (docs/scope-board.md §3 in v1): nl 0,
   div 1, mul 2, min 3, k7 4, k8 5, k9 6, plus 7, k4 8, k5 9, k6 10,
   k1 11, k2 12, k3 13, ent 14, k0 15, dot 16. */

import type { World } from "./world";

export const WIRE = {
  nl: 0, div: 1, mul: 2, min: 3, k7: 4, k8: 5, k9: 6, plus: 7, k4: 8, k5: 9,
  k6: 10, k1: 11, k2: 12, k3: 13, ent: 14, k0: 15, dot: 16,
} as const;
export type WireName = keyof typeof WIRE;

/** one gesture, in the daemon's own timings (tap under 350ms, double inside 300ms) */
export type Gesture =
  | { kind: "tap"; key: WireName }
  | { kind: "double"; key: WireName }
  | { kind: "hold"; key: WireName; ms: number }
  /** hold `hold`, then press `with` while it is down; both release together */
  | { kind: "chord"; hold: WireName; with: WireName; ms: number };

export type KeyEvent = { at: number; wire: number; down: boolean };

export type Step =
  | { label: string; gesture: Gesture }
  | {
      label: string;
      world: (world: World) => Promise<void>;
      /** the step is not over until the board has drawn at least one new frame */
      frameChange?: boolean;
    }
  /** nothing pressed, nothing staged: let batched calls (telemetry) flush */
  | { label: string; idleMs: number };

export type Scenario = {
  name: string;
  about: string;
  /** staged before the daemon starts, so its first snapshot already holds it */
  setup: (world: World) => Promise<void>;
  steps: Step[];
};

const TAP_MS = 70;
const DOUBLE_GAP_MS = 110;

/** a gesture as raw switch events, offsets from the step's start */
export function keyEvents(gesture: Gesture): KeyEvent[] {
  switch (gesture.kind) {
    case "tap":
      return [
        { at: 0, wire: WIRE[gesture.key], down: true },
        { at: TAP_MS, wire: WIRE[gesture.key], down: false },
      ];
    case "double": {
      const wire = WIRE[gesture.key];
      return [
        { at: 0, wire, down: true },
        { at: TAP_MS, wire, down: false },
        { at: TAP_MS + DOUBLE_GAP_MS, wire, down: true },
        { at: 2 * TAP_MS + DOUBLE_GAP_MS, wire, down: false },
      ];
    }
    case "hold":
      return [
        { at: 0, wire: WIRE[gesture.key], down: true },
        { at: gesture.ms, wire: WIRE[gesture.key], down: false },
      ];
    case "chord":
      return [
        { at: 0, wire: WIRE[gesture.hold], down: true },
        { at: 450, wire: WIRE[gesture.with], down: true },
        { at: 450 + gesture.ms, wire: WIRE[gesture.with], down: false },
        { at: 450 + gesture.ms + 30, wire: WIRE[gesture.hold], down: false },
      ];
  }
}

const tap = (key: WireName, label: string): Step => ({ label, gesture: { kind: "tap", key } });
const DRAIN: Step = { label: "the board rests while telemetry flushes", idleMs: 6000 };

/** threads opened one after another, each settled before the next, so
    their order on the digit keys (oldest waiting first) is fixed */
async function openInOrder(world: World, aliases: string[]) {
  for (const alias of aliases) {
    await world.open(alias, { kind: "reply" });
    await world.settled(alias);
    await Bun.sleep(150);
  }
}

const ELEVEN = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo"];

export const SCENARIOS: Scenario[] = [
  {
    name: "thread-switching",
    about:
      "eleven unread threads fill the digit keys and spill onto a second page. taps focus threads on both pages, " +
      "nl flips drive to fleet and back, a double tap aims dictation, plus marks the top call read, a machine key " +
      "opens compose, a hold on nl toggles deep work, and a double tap on nl drops the board into calc and back.",
    setup: (world) => openInOrder(world, ELEVEN),
    steps: [
      tap("k1", "tap k1: focus alpha"),
      tap("k5", "tap k5: focus echo"),
      tap("dot", "tap dot: page two"),
      tap("k2", "tap k2: focus kilo on page two"),
      tap("dot", "tap dot: wrap to page one"),
      tap("nl", "tap nl: drive to fleet"),
      tap("k3", "tap k3 in fleet: no verb"),
      tap("nl", "tap nl: fleet to drive"),
      { label: "double k3: aim dictation at charlie", gesture: { kind: "double", key: "k3" } },
      tap("plus", "tap plus: mark the top call read"),
      tap("div", "tap div: compose on the first machine"),
      { label: "hold nl: deep work on", gesture: { kind: "hold", key: "nl", ms: 600 } },
      { label: "hold nl: deep work off", gesture: { kind: "hold", key: "nl", ms: 600 } },
      { label: "double nl: the firmware drops to calc", gesture: { kind: "double", key: "nl" } },
      { label: "double nl: the firmware returns to drive", gesture: { kind: "double", key: "nl" } },
      DRAIN,
    ],
  },
  {
    name: "talk-key",
    about:
      "the radio key through its whole grammar: a hold talks with the meter up, a tap reads the top call back, " +
      "a double tap locks hands-free and the next press stops it, and a chord with a seat talks into that thread. " +
      "then a thread works, streaming, and the radio reads back again once it lands.",
    setup: (world) => openInOrder(world, ["alpha", "bravo", "charlie"]),
    steps: [
      { label: "hold k0: push to talk, meter up", gesture: { kind: "hold", key: "k0", ms: 1600 } },
      tap("k0", "tap k0: read back the top call"),
      { label: "double k0: hands-free on", gesture: { kind: "double", key: "k0" } },
      tap("k0", "tap k0: hands-free off"),
      { label: "chord k2 + k0: talk into bravo", gesture: { kind: "chord", hold: "k2", with: "k0", ms: 1200 } },
      {
        label: "charlie works: a streamed reply",
        world: async (world) => {
          await world.prompt("charlie", { kind: "work", words: 40, everyMs: 50 });
          await world.settled("charlie");
        },
        frameChange: true,
      },
      tap("k0", "tap k0: read back after charlie lands"),
      DRAIN,
    ],
  },
  {
    name: "permission-pit",
    about:
      "a permission arrives and the pit answers it with the digits: k1 allows once, k3 arms reject and a second " +
      "k3 fires it, min skips back to drive, k2 allows always. then a question with three options is answered " +
      "with k2.",
    setup: (world) => openInOrder(world, ["alpha", "bravo", "charlie"]),
    steps: [
      {
        label: "bravo asks permission",
        world: async (world) => {
          await world.prompt("bravo", { kind: "permission" });
          await world.settled("bravo");
        },
        frameChange: true,
      },
      tap("k1", "tap k1: into the pit"),
      tap("k3", "tap k3: reject armed"),
      tap("min", "tap min: skip back to drive"),
      tap("k1", "tap k1: into the pit again"),
      tap("k1", "tap k1: allow once"),
      {
        label: "bravo asks again",
        world: async (world) => {
          await world.settled("bravo");
          await world.prompt("bravo", { kind: "permission" });
          await world.settled("bravo");
        },
        frameChange: true,
      },
      tap("k1", "tap k1: into the pit"),
      tap("k3", "tap k3: reject armed"),
      tap("k3", "tap k3: reject fired"),
      {
        label: "bravo asks a third time",
        world: async (world) => {
          await world.settled("bravo");
          await world.prompt("bravo", { kind: "permission" });
          await world.settled("bravo");
        },
        frameChange: true,
      },
      tap("k1", "tap k1: into the pit"),
      tap("k2", "tap k2: allow always"),
      {
        label: "charlie asks a question with three options",
        world: async (world) => {
          await world.prompt("charlie", { kind: "question", options: 3 });
          await world.settled("charlie");
        },
        frameChange: true,
      },
      tap("k1", "tap k1: into the pit"),
      tap("k2", "tap k2: answer the second option"),
      DRAIN,
    ],
  },
];

export function scenario(name: string): Scenario {
  const found = SCENARIOS.find((s) => s.name === name);
  if (!found) throw new Error(`no scenario ${name}; there are ${SCENARIOS.map((s) => s.name).join(", ")}`);
  return found;
}
