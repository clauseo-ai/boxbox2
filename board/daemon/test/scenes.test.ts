/* every row of the scene catalogue (docs/scope-board.md §6), pinned to a
   fixture. a scene in the catalogue with no test is a scene that will
   quietly stop firing — §13's rule, and the whole reason this file
   exists. the /board page sim is the visual twin these frames imitate. */

import { describe, expect, test } from "bun:test";
import type { Seat } from "../../lib/board/seats";
import {
  BREATH_SLOT, cell, DARK_FRAME, FLOOR_CELL, LEVEL, LIVE_BREATH_SLOT, SLOT,
  WIRE, type Cell,
} from "../src/protocol";
import {
  applyFloor, arrivalPulse, briefing, composite, deepWorkFilter, DIGIT_WIRES,
  formationLap, queueCells, redFlag, renderDrive, renderFleet,
  renderPit, RING, seatCell, STACKS, TransientPlayer, victoryLap,
  vuCells, type DriveModel,
} from "../src/scenes";

const NOW = Date.parse("2026-07-26T12:00:00Z");

function seat(over: Partial<Seat> & { key: string; need: Seat["need"] }): Seat {
  const [host, sessionID] = over.key.split(":");
  return {
    host, sessionID, state: "needsYou", updatedAt: NOW, hot: false, child: false,
    ...over,
  } as Seat;
}

function driveModel(over: Partial<DriveModel> = {}): DriveModel {
  return {
    bound: [], hotSeats: [], liveSeats: [], page: 0,
    machines: [{ reachable: true }, { reachable: true }, { reachable: true }],
    copyArmed: false,
    ...over,
  };
}

describe("formation lap", () => {
  test("bound keys sweep in wire order, in their liveries", () => {
    const t = formationLap([{ wire: WIRE.k7, slot: 9 }, { wire: WIRE.k8, slot: 10 }]);
    expect(t.frames.length).toBe(2);
    expect(t.frames[0].cells[WIRE.k7]).toBe(cell(9, LEVEL.hot));
    expect(t.frames[1].cells[WIRE.k8]).toBe(cell(10, LEVEL.hot));
    expect(t.frames[1].cells[WIRE.k7]).toBe(cell(9, LEVEL.dim)); /* trail */
  });

  test("no bindings: the board introduces itself with a ring sweep", () => {
    const t = formationLap([]);
    expect(t.frames.length).toBe(RING.length);
    expect(t.frames[0].cells[RING[0]]).toBe(cell(SLOT.you, LEVEL.hot));
  });
});

describe("the briefing", () => {
  test("two green passes, row by row, then done", () => {
    const t = briefing();
    /* 5 rows × 2 passes + 2 rests */
    expect(t.frames.length).toBe(12);
    expect(t.frames[0].cells[WIRE.nl]).toBe(cell(SLOT.live, LEVEL.mid));
    expect(t.frames[0].cells[WIRE.k0]).toBe(null); /* only the row lights */
  });
});

describe("box box (arrival)", () => {
  test("two pulses at the key, then stillness", () => {
    const t = arrivalPulse(WIRE.k5, SLOT.needsHot);
    expect(t.frames.length).toBe(4);
    expect(t.frames[0].cells[WIRE.k5]).toBe(cell(SLOT.needsHot, LEVEL.hot));
    expect(t.frames[1].cells[WIRE.k5]).toBe(cell(SLOT.off, LEVEL.off));
    expect(t.frames[0].cells[WIRE.k4]).toBe(null); /* only that key */
  });
});

describe("the queue is state, not scene: seat cells", () => {
  test("the six-signal family maps needs to slots, hot escalates", () => {
    expect(seatCell(seat({ key: "h1:a", need: "permission" }))).toBe(cell(SLOT.perm, LEVEL.rest));
    expect(seatCell(seat({ key: "h1:a", need: "permission", hot: true }))).toBe(cell(SLOT.permHot, LEVEL.hot));
    expect(seatCell(seat({ key: "h1:a", need: "fault" }))).toBe(cell(SLOT.fault, LEVEL.hot));
    expect(seatCell(seat({ key: "h1:a", need: "unread" }))).toBe(cell(SLOT.needs, LEVEL.rest));
  });
});

describe("drive bank", () => {
  test("nl holds steady violet — daemon driving; only the radio breathes", () => {
    const cells = renderDrive(driveModel());
    expect(cells[WIRE.nl]).toBe(cell(SLOT.you, LEVEL.bright));
    expect(cells[WIRE.k0]).toBe(cell(BREATH_SLOT, LEVEL.bright));
  });

  test("machines row: STEADY green alive, loud red dead — no pulse, nothing breathes for attention it has not earned", () => {
    const cells = renderDrive(driveModel({
      machines: [{ reachable: true }, { reachable: false }, { reachable: true }],
    }));
    expect(cells[WIRE.div]).toBe(cell(SLOT.live, LEVEL.rest));
    expect(cells[WIRE.mul]).toBe(cell(SLOT.fault, LEVEL.bright));
    expect(cells[WIRE.min]).toBe(cell(SLOT.live, LEVEL.rest));
  });

  test("a bound key idles in its livery; a signal takes the led", () => {
    const idle = renderDrive(driveModel({ bound: [{ wire: WIRE.k7, slot: 9 }] }));
    expect(idle[WIRE.k7]).toBe(cell(9, LEVEL.dim));
    const hot = renderDrive(driveModel({
      bound: [{ wire: WIRE.k7, slot: 9, seat: seat({ key: "h1:a", need: "permission", hot: true }) }],
    }));
    expect(hot[WIRE.k7]).toBe(cell(SLOT.permHot, LEVEL.hot));
  });

  test("the queue fills the whole unbound grid in DIGIT order (rank n = key n, 2026-07-29)", () => {
    const seats = [
      seat({ key: "h1:a", need: "permission" }),
      seat({ key: "h1:b", need: "question" }),
      seat({ key: "h1:c", need: "unread" }),
      seat({ key: "h1:d", need: "unread" }),
    ];
    const cells = renderDrive(driveModel({ hotSeats: seats }));
    /* digit order: rank 1 on the key whose cap says 1, counting up */
    expect(cells[WIRE.k1]).toBe(seatCell(seats[0]));
    expect(cells[WIRE.k2]).toBe(seatCell(seats[1]));
    expect(cells[WIRE.k3]).toBe(seatCell(seats[2]));
    expect(cells[WIRE.k4]).toBe(seatCell(seats[3]));
    expect(cells[WIRE.k5]).toBe(0); /* four threads, four keys — no more */
    expect(cells[WIRE.dot]).toBe(0); /* one page: no page light */
  });

  test("a bound key drops out of the flow; the queue seats around it", () => {
    const seats = [
      seat({ key: "h1:a", need: "permission" }),
      seat({ key: "h1:b", need: "unread" }),
    ];
    const cells = renderDrive(driveModel({
      bound: [{ wire: WIRE.k1, slot: 9 }],
      hotSeats: seats,
    }));
    expect(cells[WIRE.k1]).toBe(cell(9, LEVEL.dim)); /* the livery holds */
    expect(cells[WIRE.k2]).toBe(seatCell(seats[0]));
    expect(cells[WIRE.k3]).toBe(seatCell(seats[1]));
  });

  test("dot lights only past nine: a second page exists", () => {
    const seats = Array.from({ length: 10 }, (_, i) =>
      seat({ key: `h1:s${i}`, need: "unread" }),
    );
    const cells = renderDrive(driveModel({ hotSeats: seats }));
    expect(cells[WIRE.dot]).not.toBe(0);
    /* nine visible on page 0, dot still lit on page 1 (paging wraps) */
    const page1 = renderDrive(driveModel({ hotSeats: seats, page: 1 }));
    expect(page1[WIRE.k1]).toBe(seatCell(seats[9]));
    expect(page1[WIRE.k2]).toBe(0);
    expect(page1[WIRE.dot]).not.toBe(0);
  });

  test("live sessions seat AFTER needs and pulse on the LIVE_BREATH slot", () => {
    const live = (key: string, fresh = false) => ({
      seat: { key, host: "h1", sessionID: key.slice(3), updatedAt: NOW },
      deltaFresh: fresh,
    });
    const cells = renderDrive(driveModel({
      hotSeats: [seat({ key: "h1:call", need: "permission" })],
      liveSeats: [live("h1:w1", true), live("h1:w2")],
    }));
    /* k1 = the need (triage first), k2/k3 = the workers */
    expect(cells[WIRE.k1]).toBe(seatCell(seat({ key: "h1:call", need: "permission" })));
    expect(cells[WIRE.k2]).toBe(cell(LIVE_BREATH_SLOT, LEVEL.bright)); /* tokens landing */
    expect(cells[WIRE.k3]).toBe(cell(LIVE_BREATH_SLOT, LEVEL.rest));
  });

  test("live seats page together with needs", () => {
    const live = (key: string) => ({
      seat: { key, host: "h1", sessionID: key.slice(3), updatedAt: NOW },
      deltaFresh: false,
    });
    const model = driveModel({
      hotSeats: [seat({ key: "h1:a", need: "unread" }), seat({ key: "h1:b", need: "unread" })],
      liveSeats: Array.from({ length: 8 }, (_, i) => live(`h1:w${i}`)),
      page: 1,
    });
    const cells = renderDrive(model);
    /* page 1 starts at index 9: the last worker lands on k1 */
    expect(cells[WIRE.k1]).toBe(cell(LIVE_BREATH_SLOT, LEVEL.rest));
    expect(cells[WIRE.k2]).toBe(0);
  });

  test("a bound WORKING agent pulses lime on its own key", () => {
    const cells = renderDrive(driveModel({
      bound: [{ wire: WIRE.k7, slot: 9, working: true, deltaFresh: true }],
    }));
    expect(cells[WIRE.k7]).toBe(cell(LIVE_BREATH_SLOT, LEVEL.bright));
  });

  test("copy arms the plus key when something waits", () => {
    expect(renderDrive(driveModel({ copyArmed: true }))[WIRE.plus]).not.toBe(0);
    expect(renderDrive(driveModel())[WIRE.plus]).toBe(0);
  });

  test("ent holds a steady violet at rest: a real enter key, never the anonymous floor", () => {
    expect(renderDrive(driveModel())[WIRE.ent]).toBe(cell(SLOT.you, LEVEL.rest));
  });
});

describe("pit bank", () => {
  test("permission: once bright, always rest, reject dim until armed", () => {
    const cells = renderPit({ kind: "permission", hot: true, rejectArmed: false });
    expect(cells[WIRE.k5]).toBe(cell(SLOT.permHot, LEVEL.hot));
    expect(cells[WIRE.k1]).toBe(cell(SLOT.permHot, LEVEL.bright));
    expect(cells[WIRE.k2]).toBe(cell(SLOT.perm, LEVEL.rest));
    expect(cells[WIRE.k3]).toBe(cell(SLOT.perm, LEVEL.dim));
  });

  test("reject ARMED goes fault-red: the destructive law made visible", () => {
    const cells = renderPit({ kind: "permission", hot: false, rejectArmed: true });
    expect(cells[WIRE.k3]).toBe(cell(SLOT.fault, LEVEL.hot));
  });

  test("question: n options on the digit keys, voice on the radio", () => {
    const cells = renderPit({ kind: "question", options: 4 });
    expect(cells[WIRE.k1]).toBe(cell(SLOT.info, LEVEL.rest));
    expect(cells[WIRE.k4]).toBe(cell(SLOT.info, LEVEL.rest));
    expect(cells[WIRE.k6]).toBe(0); /* option 6 doesn't exist */
    expect(cells[WIRE.k0]).toBe(cell(SLOT.you, LEVEL.idle));
  });
});

describe("the queue view", () => {
  test("one lime key per parked order in digit order, ent gold when armed", () => {
    const cells = queueCells(3);
    expect(cells[WIRE.k1]).toBe(cell(SLOT.live, LEVEL.bright));
    expect(cells[WIRE.k2]).toBe(cell(SLOT.live, LEVEL.bright));
    expect(cells[WIRE.k3]).toBe(cell(SLOT.live, LEVEL.bright));
    expect(cells[WIRE.k4]).toBe(0); /* three orders, three keys — no more */
    expect(cells[WIRE.ent]).toBe(cell(SLOT.perm, LEVEL.bright)); /* flush armed */
  });

  test("depth 0 is an honest empty board: no count, no armed ent", () => {
    const cells = queueCells(0);
    for (const w of DIGIT_WIRES) expect(cells[w]).toBe(0);
    expect(cells[WIRE.ent]).toBe(0);
  });

  test("depth caps at the nine digits", () => {
    const cells = queueCells(12);
    expect(cells[WIRE.k9]).toBe(cell(SLOT.live, LEVEL.bright));
  });
});

describe("red flag", () => {
  test("essential: it survives deep work", () => {
    expect(redFlag(WIRE.k6).essential).toBe(true);
  });
});

describe("victory lap", () => {
  test("two laps around the ring with a trail", () => {
    const t = victoryLap();
    expect(t.frames.length).toBe(RING.length * 2);
    expect(t.frames[0].cells[RING[0]]).toBe(cell(SLOT.live, LEVEL.hot));
    expect(t.frames[2].cells[RING[0]]).toBe(cell(SLOT.live, LEVEL.dim)); /* trail */
  });
});

describe("deep work", () => {
  test("only permission and fault reach the leds", () => {
    const base = [...DARK_FRAME] as Cell[];
    base[0] = cell(SLOT.live, LEVEL.mid);
    base[1] = cell(SLOT.permHot, LEVEL.hot);
    base[2] = cell(SLOT.needs, LEVEL.rest);
    base[3] = cell(SLOT.fault, LEVEL.hot);
    const filtered = deepWorkFilter(base);
    expect(filtered[0]).toBe(0);
    expect(filtered[1]).toBe(base[1]);
    expect(filtered[2]).toBe(0);
    expect(filtered[3]).toBe(base[3]);
  });

  test("non-essential transients are suppressed, essential ones play", () => {
    const p = new TransientPlayer();
    p.push(arrivalPulse(WIRE.k5, SLOT.needsHot), 0);
    expect(p.current(10, true)).toBe(null); /* deep work eats it */
    const p2 = new TransientPlayer();
    p2.push(redFlag(WIRE.k5), 0);
    expect(p2.current(10, true)).not.toBe(null);
  });
});

describe("the voice meter", () => {
  test("four bands climb the four stacks, head brightest", () => {
    const cells = vuCells([2, 5, 0, 1]);
    expect(cells[STACKS[0][0]]).toBe(cell(SLOT.you, LEVEL.rest));
    expect(cells[STACKS[0][1]]).toBe(cell(SLOT.you, LEVEL.hot)); /* head */
    expect(cells[STACKS[1][4]]).toBe(cell(SLOT.you, LEVEL.hot));
    expect(cells[STACKS[2][0]]).toBe(null); /* silent column */
  });
});

describe("fleet bank", () => {
  test("columns rise with activity, the odometer fills toward the line", () => {
    const cells = renderFleet({ columns: [3, 0, 5], odometer: 0.6 });
    expect(cells[STACKS[0][2]] >> 4).toBe(SLOT.live);
    expect(cells[STACKS[0][3]]).toBe(0);
    expect(cells[STACKS[2][4]] >> 4).toBe(SLOT.live);
    /* 0.6 of the line = 3 of 5 cells in `you` */
    expect(cells[STACKS[3][2]] >> 4).toBe(SLOT.you);
  });
});

describe("the floor", () => {
  test("no driven cell stays black: level 0 becomes the off slot's whisper", () => {
    const base = renderDrive(driveModel());
    const floored = applyFloor(base);
    for (const [i, c] of floored.entries()) {
      expect(c & 0x0f).toBeGreaterThan(0);
      /* lit cells ride through untouched */
      if ((base[i] & 0x0f) > 0) expect(c).toBe(base[i]);
    }
    expect(floored[WIRE.k5]).toBe(FLOOR_CELL);
  });

  test("the floor sits below every named stop", () => {
    expect(FLOOR_CELL & 0x0f).toBe(LEVEL.idle);
    expect(FLOOR_CELL >> 4).toBe(SLOT.off);
  });

  test("deep work suppresses signals, not power: the floor survives", () => {
    const base = [...DARK_FRAME] as Cell[];
    base[0] = cell(SLOT.live, LEVEL.mid); /* not money: goes to floor */
    base[1] = cell(SLOT.permHot, LEVEL.hot); /* money: stays */
    const out = applyFloor(deepWorkFilter(base));
    expect(out[0]).toBe(FLOOR_CELL);
    expect(out[1]).toBe(base[1]);
    expect(out[2]).toBe(FLOOR_CELL);
  });

  test("blink gaps dip to the floor, never to black", () => {
    const t = arrivalPulse(WIRE.k5, SLOT.needsHot);
    const gap = composite([...DARK_FRAME] as Cell[], t.frames[1].cells);
    expect(applyFloor(gap)[WIRE.k5]).toBe(FLOOR_CELL);
  });
});

describe("transient player", () => {
  test("plays frames on time, queues the next, composites over base", () => {
    const p = new TransientPlayer();
    p.push(arrivalPulse(WIRE.k5, SLOT.needsHot), 0);
    p.push(victoryLap(), 0); /* queued behind */
    expect(p.current(0, false)?.[WIRE.k5]).toBe(cell(SLOT.needsHot, LEVEL.hot));
    expect(p.current(250, false)?.[WIRE.k5]).toBe(cell(SLOT.off, LEVEL.off));
    /* arrival ends at 820ms; victory starts fresh */
    const after = p.current(830, false);
    expect(after?.[RING[0]]).toBe(cell(SLOT.live, LEVEL.hot));
    /* composite: null cells show the base */
    const base = [...DARK_FRAME] as Cell[];
    base[WIRE.dot] = cell(SLOT.info, LEVEL.idle);
    const merged = composite(base, p.current(830, false));
    expect(merged[WIRE.dot]).toBe(cell(SLOT.info, LEVEL.idle));
  });
});
