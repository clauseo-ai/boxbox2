import { describe, expect, test } from "bun:test";
import { routeFrame } from "./protocol";
import { INITIAL_STATE, reduce } from "./reducer";

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
});
