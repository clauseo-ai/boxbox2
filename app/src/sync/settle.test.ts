import { describe, expect, test } from "bun:test";
import { routeFrame } from "./protocol";
import { type Action, INITIAL_STATE, reduce } from "./reducer";

const row = { key: "desk:ses_1", doneAt: 1000, seenAt: 2000, clearedAt: 3_602_000 };

describe("the server's word on its own clearing (settle frames)", () => {
  test("an away list and an auto-clear route outside the journal; one with a seq is no frame", () => {
    expect(routeFrame(JSON.stringify({ type: "away", threads: [row] }), false)).toEqual({ to: "settle", frame: { type: "away", threads: [row] } });
    expect(routeFrame(JSON.stringify({ type: "autoCleared", keys: ["desk:ses_1"], at: 5 }), false)).toEqual({ to: "settle", frame: { type: "autoCleared", keys: ["desk:ses_1"], at: 5 } });
    expect(routeFrame(JSON.stringify({ type: "away", threads: [], seq: 4 }), false)).toBeNull();
  });

  test("the away list replaces what the fleet holds, as one patch, and survives a reset", () => {
    const first = reduce(INITIAL_STATE, { type: "away", threads: [row] });
    expect(first.state.fleet.away).toEqual([row]);
    expect(first.patches).toEqual([{ path: ["fleet", "away"], value: [row] }]);
    const emptied = reduce(first.state, { type: "away", threads: [] });
    expect(emptied.state.fleet.away).toEqual([]);
    const reset = reduce(first.state, { type: "frame", frame: { type: "reset", epoch: "e1", seq: 0, fleet: { agents: [], asks: [], order: [], threads: [] } } as never, id: null });
    expect(reset.state.fleet.away).toEqual([row]);
  });

  const hello: Action = { type: "frame", frame: { type: "hello", protocol: 3, epoch: "e1", head: 0, build: "b", stream: "s1", interest: { thread: null, under: [], holds: [] } }, id: null };
  const resetFrame = { type: "frame", frame: { type: "reset", epoch: "e1", seq: 0, reason: "none", fleet: { agents: [], asks: [], order: [], threads: [] } }, id: null } as never;

  const caughtFrame = { type: "frame", frame: { type: "caught", seq: 0 }, id: { epoch: "e1", seq: 0 } } as never;
  const awayFrame = (threads: (typeof row)[]): Action => ({ type: "away", threads });

  test("a hello alone leaves the away list as it is, with no patch for it", () => {
    const cached = reduce(INITIAL_STATE, awayFrame([row])).state;
    const opened = reduce(cached, hello);
    expect(opened.state.fleet.away).toEqual([row]);
    expect(opened.patches.some((p) => p.path[1] === "away")).toBe(false);
    expect(reduce(INITIAL_STATE, hello).patches.some((p) => p.path[1] === "away")).toBe(false);
  });

  test("the away frame after the hello replaces the list, with no empty list between (no flicker on a reconnect)", () => {
    const other = { ...row, key: "desk:ses_2" };
    const cached = reduce(INITIAL_STATE, awayFrame([row])).state;
    const opened = reduce(cached, hello);
    const sent = reduce(opened.state, awayFrame([row, other]));
    // every patch between the hello and the away frame, and the frame's own: never an empty list
    const patches = [...opened.patches, ...sent.patches].filter((p) => p.path[1] === "away");
    expect(patches).toEqual([{ path: ["fleet", "away"], value: [row, other] }]);
    // the resume ends: the list stays this connection's word
    expect(reduce(sent.state, resetFrame).state.fleet.away).toEqual([row, other]);
    expect(reduce(sent.state, caughtFrame).state.fleet.away).toEqual([row, other]);
    // the server's empty list (nothing is away) empties it
    expect(reduce(reduce(opened.state, awayFrame([])).state, resetFrame).state.fleet.away).toEqual([]);
  });

  test("a resume that ends with no away frame after its hello (an older server) empties the list: a stale one never returns", () => {
    const cached = reduce(INITIAL_STATE, awayFrame([row])).state;
    const opened = reduce(cached, hello).state;
    const reset = reduce(opened, resetFrame);
    expect(reset.state.fleet.away).toEqual([]);
    expect(reset.patches).toContainEqual({ path: ["fleet", "away"], value: [] });
    // the same at the end of a catch-up
    const resumed = reduce({ ...opened, cursor: { epoch: "e1", seq: 0 } }, caughtFrame);
    expect(resumed.state.fleet.away).toEqual([]);
    // and only once: an away frame later on the same stream stands through the next reset
    const later = reduce(reset.state, awayFrame([row])).state;
    expect(reduce(later, resetFrame).state.fleet.away).toEqual([row]);
  });
});
