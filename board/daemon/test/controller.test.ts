/* the conductor under test: paging that wraps and snaps home, the 3×3
   spill around bound keys, ent-as-send (the dictation flow's other
   half, 2026-07-27), and the seat map the glass badges ride. real
   FleetState, fake wire — the client records what the keys would have
   fired at the origin. */

import { describe, expect, test } from "bun:test";
import { Controller } from "../src/controller";
import { FleetState } from "../src/state";
import { DIGIT_WIRES } from "../src/scenes";
import { WIRE } from "../src/protocol";
import type { BoxboxClient } from "../src/client";
import type { BoardConfig } from "../src/config";
import type { BoardDevice } from "../src/device";
import type { Radio } from "../src/radio";
import type { Logger } from "../src/log";
import type { SeatStatus } from "../../lib/board/seats";

const NOW = Date.parse("2026-07-27T12:00:00Z");

function makeController(state: FleetState) {
  /** every origin-reaching client method records its name in `calls`;
      the radio fake records meter/say traffic; board.key telemetry
      lands in `emits` so label tests can pin targets. */
  const calls = {
    focus: [] as string[],
    compose: [] as string[],
    flush: [] as { host: string; sessionID: string; directory?: string }[],
    calls: [] as string[],
  };
  const emits = [] as { kind: string; target?: string; verb?: string }[];
  const radioCalls = { meter: [] as string[], said: [] as string[] };
  const radioState = { active: false, msSinceVoice: 0 };
  const client = {
    emit(kind: string, props: Record<string, unknown>) {
      emits.push({
        kind,
        target: props.target as string | undefined,
        verb: props.verb as string | undefined,
      });
    },
    focus: async (k: string) => {
      calls.focus.push(k);
      calls.calls.push("focus");
      return true;
    },
    composeMachine: async (m: string) => {
      calls.compose.push(m);
      calls.calls.push("composeMachine");
      return true;
    },
    markRead: async () => {
      calls.calls.push("markRead");
      return true;
    },
    flushQueue: async (host: string, sessionID: string, directory?: string) => {
      calls.flush.push({ host, sessionID, directory });
      calls.calls.push("flushQueue");
      return true;
    },
  } as unknown as BoxboxClient;
  const radio = {
    startMeter() {
      radioCalls.meter.push("start");
      radioState.active = true;
    },
    stopMeter() {
      radioCalls.meter.push("stop");
      radioState.active = false;
    },
    say(text: string) {
      radioCalls.said.push(text);
    },
    meterActive: () => radioState.active,
    msSinceVoice: () => radioState.msSinceVoice,
  } as unknown as Radio;
  const log = { info() {}, warn() {}, error() {} } as unknown as Logger;
  const cfg = {
    origin: "", password: "", stateDir: "",
    holdMs: 350, doubleMs: 300, rejectArmMs: 5000, awayMs: 60_000,
    nightCurve: [], spendLineUsd: 500, voice: "", micMeter: false,
    machineOrder: ["h1", "h3", "h2"], handsFreeSilenceMs: 45_000,
  } as BoardConfig;
  const controller = new Controller(
    state, client, {} as BoardDevice, radio, cfg, log,
  );
  return { controller, calls, emits, radioCalls, radioState };
}

/** n busy root sessions on h1, freshest first (s00 newest) */
function busyState(n: number): FleetState {
  const state = new FleetState();
  const rows: unknown[] = [];
  const status: SeatStatus = { h1: {} };
  for (let i = 0; i < n; i++) {
    const id = `s${String(i).padStart(2, "0")}`;
    rows.push({ id, title: id, time: { updated: 100_000 - i } });
    status.h1[id] = { type: "busy" };
  }
  state.setSessions("h1", rows);
  state.status = status;
  return state;
}

function tap(c: Controller, wire: number, at: number) {
  c.onKey(wire, true, at);
  c.onKey(wire, false, at + 50);
  c.tick(at + 500); /* flush past the double window */
}

function doubleTap(c: Controller, wire: number, at: number) {
  c.onKey(wire, true, at);
  c.onKey(wire, false, at + 50);
  c.onKey(wire, true, at + 150);
  c.onKey(wire, false, at + 200);
}

/** a user message born while the loop is busy: one parked order, the
    same inference the queue light rides (state.ts message.updated) */
function queueUserMessage(state: FleetState, host: string, sessionID: string, id: string) {
  state.applyBrain({
    kind: "frame",
    host,
    frame: {
      payload: {
        type: "message.updated",
        properties: { info: { id, sessionID, role: "user" } },
      },
    },
  } as Parameters<FleetState["applyBrain"]>[0]);
}

describe("the 3×3 spill", () => {
  test("ten workers: nine seat at once, DIGIT order (rank n = key n), tenth pages", () => {
    const { controller } = makeController(busyState(10));
    controller.seats(NOW);
    expect(controller.resolveWire(DIGIT_WIRES[0])?.key).toBe("h1:s00");
    expect(controller.resolveWire(DIGIT_WIRES[8])?.key).toBe("h1:s08");
    expect(controller.wireForKey("h1:s09")).toBe(null); /* paged out */
    expect(controller.pageCount()).toBe(2);
  });

  test("a bound key drops out of the flow; its agent renders there", () => {
    const state = busyState(3);
    state.bindings = {
      keys: { [String(DIGIT_WIRES[0])]: { agent: "h1:s01", color: "#be00ff", at: 1, device: "t" } },
    };
    const { controller } = makeController(state);
    controller.seats(NOW);
    expect(controller.wireForKey("h1:s01")).toBe(DIGIT_WIRES[0]);
    expect(controller.resolveWire(DIGIT_WIRES[0])?.key).toBe("h1:s01");
    /* the queue flows around the livery */
    expect(controller.resolveWire(DIGIT_WIRES[1])?.key).toBe("h1:s00");
    expect(controller.resolveWire(DIGIT_WIRES[2])?.key).toBe("h1:s02");
  });
});

describe("paging", () => {
  test("dot wraps: past the last page it comes home, never off the end", () => {
    const { controller } = makeController(busyState(10));
    controller.seats(NOW);
    tap(controller, WIRE.dot, NOW);
    expect(controller.page).toBe(1);
    expect(controller.resolveWire(DIGIT_WIRES[0])?.key).toBe("h1:s09");
    tap(controller, WIRE.dot, NOW + 2000);
    expect(controller.page).toBe(0); /* the one-way trip is dead */
    expect(controller.resolveWire(DIGIT_WIRES[0])?.key).toBe("h1:s00");
  });

  test("the page snaps home when the list shrinks under it", () => {
    const state = busyState(10);
    const { controller } = makeController(state);
    controller.seats(NOW);
    tap(controller, WIRE.dot, NOW);
    expect(controller.page).toBe(1);
    /* nine threads finish and are deleted; only s00 remains */
    state.status = { h1: { s00: { type: "busy" } } };
    for (let i = 1; i < 10; i++) {
      state.applyBrain({
        kind: "frame",
        host: "h1",
        frame: {
          payload: {
            type: "session.deleted",
            properties: { info: { id: `s${String(i).padStart(2, "0")}` } },
          },
        },
      } as Parameters<FleetState["applyBrain"]>[0]);
    }
    controller.observe(NOW + 2000); /* past the seat memo */
    expect(controller.page).toBe(0);
  });
});

describe("ent is a real enter key", () => {
  test("the daemon only witnesses the tap: no verb resolves, nothing fires at the origin", () => {
    const { controller, calls } = makeController(busyState(2));
    controller.seats(NOW);
    doubleTap(controller, DIGIT_WIRES[0], NOW); /* pointed, dictation armed */
    tap(controller, WIRE.ent, NOW + 2000);
    /* the keystroke is the firmware's; the daemon must not reach for
       the origin (the send channel is dead, 2026-07-27) */
    expect(calls.focus).toEqual(["h1:s00"]);
    expect(calls.calls.filter((c) => c !== "focus")).toEqual([]);
  });
});

describe("the machines row starts threads", () => {
  test("tap div/mul/min fires compose at the machine in machineOrder", () => {
    const { controller, calls } = makeController(busyState(1));
    controller.seats(NOW);
    tap(controller, WIRE.div, NOW);
    tap(controller, WIRE.mul, NOW + 2000);
    tap(controller, WIRE.min, NOW + 4000);
    /* the harness cfg's order: div=h1, mul=h3, min=boxbox */
    expect(calls.compose).toEqual(["h1", "h3", "h2"]);
    expect(calls.calls.filter((c) => c === "focus")).toEqual([]);
  });

  test("the pit's skip key still outranks the machines row", () => {
    const state = busyState(1);
    state.pending = [
      {
        id: "perm1",
        host: "h1",
        sessionID: "s00",
        kind: "permission",
        raw: {},
      } as (typeof state.pending)[number],
    ];
    const { controller, calls } = makeController(state);
    controller.seats(NOW);
    tap(controller, DIGIT_WIRES[0], NOW); /* enter the pit on the seat */
    expect(controller.bank).toBe("pit");
    tap(controller, WIRE.min, NOW + 2000); /* skip, not compose */
    expect(controller.bank).toBe("drive");
    expect(calls.compose).toEqual([]);
  });
});

describe("the seat map (the glass's key badges)", () => {
  test("digit = rank: s00 answers to 1, s08 to 9, the tenth waits on page 2's key 1", () => {
    const { controller } = makeController(busyState(10));
    controller.seats(NOW);
    const map = controller.seatMap();
    const of = (k: string) => map.seats.find((s) => s.key === k);
    expect(map.pages).toBe(2);
    expect(map.page).toBe(0);
    expect(of("h1:s00")).toEqual({ key: "h1:s00", digit: 1, visible: true });
    expect(of("h1:s08")).toEqual({ key: "h1:s08", digit: 9, visible: true });
    /* paged out: still badged with the digit it lands on after dot */
    expect(of("h1:s09")).toEqual({ key: "h1:s09", digit: 1, visible: false });
  });

  test("paging flips visibility, never digits", () => {
    const { controller } = makeController(busyState(10));
    controller.seats(NOW);
    tap(controller, WIRE.dot, NOW);
    const map = controller.seatMap();
    const of = (k: string) => map.seats.find((s) => s.key === k);
    expect(map.page).toBe(1);
    expect(of("h1:s09")).toEqual({ key: "h1:s09", digit: 1, visible: true });
    expect(of("h1:s00")).toEqual({ key: "h1:s00", digit: 1, visible: false });
  });

  test("a bound agent keeps her key's digit on every page; the queue flows around", () => {
    const state = busyState(3);
    state.bindings = {
      keys: { [String(DIGIT_WIRES[3])]: { agent: "h1:s01", color: "#be00ff", at: 1, device: "t" } },
    };
    const { controller } = makeController(state);
    controller.seats(NOW);
    const map = controller.seatMap();
    const of = (k: string) => map.seats.find((s) => s.key === k);
    expect(of("h1:s01")).toEqual({ key: "h1:s01", digit: 4, visible: true });
    expect(of("h1:s00")).toEqual({ key: "h1:s00", digit: 1, visible: true });
    expect(of("h1:s02")).toEqual({ key: "h1:s02", digit: 2, visible: true });
  });
});

describe("the radio is a wispr key", () => {
  test("double-tap opens hands-free: flag up, meter held open through the release", () => {
    const { controller, radioCalls } = makeController(busyState(1));
    controller.seats(NOW);
    doubleTap(controller, WIRE.k0, NOW);
    expect(controller.handsFree).toBe(true);
    /* the last meter word must be start — the second release must not
       silence a mic wispr is still listening through */
    expect(radioCalls.meter[radioCalls.meter.length - 1]).toBe("start");
  });

  test("one press while hands-free is wispr's stop: no readback, no verb, meter off", () => {
    const { controller, radioCalls, emits } = makeController(busyState(1));
    controller.seats(NOW);
    doubleTap(controller, WIRE.k0, NOW);
    controller.onKey(WIRE.k0, true, NOW + 5000);
    controller.onKey(WIRE.k0, false, NOW + 5050);
    controller.tick(NOW + 7000); /* past every window: no tap may settle */
    expect(controller.handsFree).toBe(false);
    expect(radioCalls.meter[radioCalls.meter.length - 1]).toBe("stop");
    expect(radioCalls.said).toEqual([]); /* the CD voice stays out of the paste */
    /* exactly one stop record (verb tap); the start rode the double */
    expect(
      emits.filter(
        (e) => e.kind === "board.key" && e.target === "handsfree" && e.verb === "tap",
      ).length,
    ).toBe(1);
  });

  test("triple-tap dismissal cannot re-arm: the tail presses die in the refractory", () => {
    const { controller } = makeController(busyState(1));
    controller.seats(NOW);
    doubleTap(controller, WIRE.k0, NOW);
    /* wispr's triple-tap: press 1 stops, presses 2+3 land right behind
       it — inside the double window, where they would read as a fresh
       double and re-arm a session wispr just cancelled */
    controller.onKey(WIRE.k0, true, NOW + 5000);
    controller.onKey(WIRE.k0, false, NOW + 5040);
    controller.onKey(WIRE.k0, true, NOW + 5120);
    controller.onKey(WIRE.k0, false, NOW + 5160);
    controller.onKey(WIRE.k0, true, NOW + 5240);
    controller.onKey(WIRE.k0, false, NOW + 5280);
    controller.tick(NOW + 7000);
    expect(controller.handsFree).toBe(false);
    /* a deliberate double after the refractory arms again */
    doubleTap(controller, WIRE.k0, NOW + 8000);
    expect(controller.handsFree).toBe(true);
  });

  test("silence clears the flag: dead reckoning needs an honest ear", () => {
    const { controller, radioState } = makeController(busyState(1));
    controller.seats(NOW);
    doubleTap(controller, WIRE.k0, NOW);
    radioState.msSinceVoice = 44_000;
    controller.tick(NOW + 44_000);
    expect(controller.handsFree).toBe(true); /* still inside the window */
    radioState.msSinceVoice = 46_000;
    controller.tick(NOW + 46_000);
    expect(controller.handsFree).toBe(false);
  });

  test("a lone tap still reads back; radio.point is dead — no focus on a double", () => {
    const { controller, radioCalls, calls } = makeController(busyState(2));
    controller.seats(NOW);
    tap(controller, WIRE.k0, NOW);
    expect(radioCalls.said.length).toBe(1);
    doubleTap(controller, WIRE.k0, NOW + 3000);
    expect(calls.focus).toEqual([]);
  });
});

describe("nl cycles two banks", () => {
  test("drive → fleet → drive: the grid is gone", () => {
    const { controller } = makeController(busyState(1));
    controller.seats(NOW);
    tap(controller, WIRE.nl, NOW);
    expect(controller.bank).toBe("fleet");
    tap(controller, WIRE.nl, NOW + 2000);
    expect(controller.bank).toBe("drive");
  });
});

describe("the nl verb swap (2026-08-01): calc took the double, deep work took the hold", () => {
  test("holding nl past the threshold toggles deep work, under the finger", () => {
    const { controller } = makeController(busyState(1));
    controller.seats(NOW);
    controller.onKey(WIRE.nl, true, NOW);
    controller.tick(NOW + 400); /* past holdMs: fires at the threshold */
    expect(controller.deepWork).toBe(true);
    controller.onKey(WIRE.nl, false, NOW + 900);
    expect(controller.deepWork).toBe(true); /* the release does not re-toggle */
    controller.onKey(WIRE.nl, true, NOW + 2000);
    controller.tick(NOW + 2400);
    controller.onKey(WIRE.nl, false, NOW + 2900);
    expect(controller.deepWork).toBe(false);
  });

  test("double-tap nl is a daemon no-op: calc is the firmware's verb", () => {
    const { controller, emits } = makeController(busyState(1));
    controller.seats(NOW);
    doubleTap(controller, WIRE.nl, NOW);
    expect(controller.deepWork).toBe(false);
    expect(controller.bank).toBe("drive"); /* no bank flip either */
    const key = emits.find((e) => e.kind === "board.key" && e.verb === "double");
    expect(key?.target).toBe("mode");
  });
});

describe("the queue verb", () => {
  test("holding a seat opens the queue view; release closes it", () => {
    const { controller } = makeController(busyState(2));
    controller.seats(NOW);
    controller.onKey(DIGIT_WIRES[0], true, NOW);
    controller.tick(NOW + 400); /* past holdMs */
    expect(controller.heldSeat?.key).toBe("h1:s00");
    controller.onKey(DIGIT_WIRES[0], false, NOW + 900);
    expect(controller.heldSeat).toBe(null);
  });

  test("hold a seat, press ent: the flush fires when orders are parked", () => {
    const state = busyState(2);
    const { controller, calls } = makeController(state);
    controller.seats(NOW);
    queueUserMessage(state, "h1", "s00", "u1");
    controller.onKey(DIGIT_WIRES[0], true, NOW);
    controller.tick(NOW + 400);
    controller.onKey(WIRE.ent, true, NOW + 500); /* the chord fires on the down */
    expect(calls.flush.length).toBe(1);
    expect(calls.flush[0].host).toBe("h1");
    expect(calls.flush[0].sessionID).toBe("s00");
    controller.onKey(WIRE.ent, false, NOW + 600);
    controller.onKey(DIGIT_WIRES[0], false, NOW + 700);
    expect(controller.heldSeat).toBe(null); /* chordEnd closes the view */
  });

  test("an empty queue keeps the chord inert: no bare interrupt", () => {
    const { controller, calls } = makeController(busyState(2));
    controller.seats(NOW);
    controller.onKey(DIGIT_WIRES[0], true, NOW);
    controller.tick(NOW + 400);
    controller.onKey(WIRE.ent, true, NOW + 500);
    expect(calls.flush).toEqual([]);
  });
});

describe("telemetry labels tell the truth", () => {
  test("a radio hold logs talk, a seat hold logs queue — the gauge lie is dead", () => {
    const { controller, emits } = makeController(busyState(2));
    controller.seats(NOW);
    controller.onKey(WIRE.k0, true, NOW);
    controller.tick(NOW + 400);
    controller.onKey(WIRE.k0, false, NOW + 900);
    controller.onKey(DIGIT_WIRES[0], true, NOW + 2000);
    controller.tick(NOW + 2400);
    controller.onKey(DIGIT_WIRES[0], false, NOW + 2900);
    const targets = emits.filter((e) => e.kind === "board.key").map((e) => e.target);
    expect(targets).toContain("talk");
    expect(targets).toContain("queue");
    expect(targets).not.toContain("gauge");
  });
});
