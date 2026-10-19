import { describe, expect, test } from "bun:test";
import { type Frame, routeFrame } from "./protocol";
import { type Action, INITIAL_STATE, reduce, type SyncState } from "./reducer";

const EPOCH = "j1";
const fleet = { hosts: [], sessions: [], asks: [], order: [] };

const lines = {
  hello: JSON.stringify({ type: "hello", protocol: 1, epoch: EPOCH, head: 2 }),
  reset: JSON.stringify({ type: "reset", seq: 1, epoch: EPOCH, reason: "none", fleet }),
  order: JSON.stringify({ type: "order", seq: 2, order: [] }),
  here: JSON.stringify({ type: "board.here", seats: [{ key: "desk:s1", digit: 1 }, { key: "desk:s2", digit: 2, bound: true }] }),
  gone: JSON.stringify({ type: "board.gone" }),
  focus: JSON.stringify({ type: "board.focus", key: "desk:s1" }),
  compose: JSON.stringify({ type: "board.compose", machine: "vm" }),
};

describe("board frames on the app's stream", () => {
  test("each board frame is taken as it is, without a seq, when the stream asked for them", () => {
    for (const line of [lines.here, lines.gone, lines.focus, lines.compose]) {
      const routed = routeFrame(line, true, true);
      expect(routed?.to).toBe("board");
      expect(routed?.frame).toEqual(JSON.parse(line));
    }
  });

  test("a stream that never asked (a phone, an ipad) drops them", () => {
    for (const line of [lines.here, lines.gone, lines.focus, lines.compose]) expect(routeFrame(line, false, true)).toBeNull();
  });

  test("the journal's own frames still need what they needed: a seq, and a type this protocol has", () => {
    expect(routeFrame(lines.order, true, true)?.to).toBe("journal");
    expect(routeFrame(JSON.stringify({ type: "order", order: [] }), true, true)).toBeNull();
    expect(routeFrame(JSON.stringify({ type: "board.light", key: "desk:s1" }), true, true)).toBeNull();
    expect(routeFrame(JSON.stringify({ type: "boardhere", seats: [] }), true, true)).toBeNull();
    expect(routeFrame(JSON.stringify({ type: "mystery", seq: 3 }), true, true)).toBeNull();
    expect(routeFrame("{not json", true, true)).toBeNull();
    expect(routeFrame("null", true, true)).toBeNull();
  });

  test("board frames between journal entries leave the cursor and the reducer's state exactly as without them", () => {
    const apply = (stream: string[]): { state: SyncState; board: number } => {
      let state = INITIAL_STATE;
      let board = 0;
      for (const line of stream) {
        const routed = routeFrame(line, true, true);
        if (!routed) continue;
        if (routed.to === "board") {
          board++;
          continue;
        }
        if (routed.to === "colours") continue;
        const action: Action = { type: "frame", frame: routed.frame satisfies Frame, epoch: EPOCH };
        state = reduce(state, action).state;
      }
      return { state, board };
    };
    const plain = apply([lines.hello, lines.reset, lines.order]);
    const mixed = apply([lines.here, lines.hello, lines.focus, lines.reset, lines.compose, lines.here, lines.order, lines.gone]);
    expect(mixed.board).toBe(5);
    expect(plain.state.cursor).toEqual({ epoch: EPOCH, seq: 2 });
    expect(mixed.state.cursor).toEqual(plain.state.cursor);
    expect(mixed.state).toEqual(plain.state);
  });
});
describe("colour frames on the app's stream", () => {
  const api = { host: "desk", root: "/w", auto: "teal", chosen: null };
  const map = JSON.stringify({ type: "colours", colours: [api] });
  const change = JSON.stringify({ type: "colour", colour: { ...api, chosen: "slate" } });

  test("each is taken as it is, without a seq, when the stream asked for them", () => {
    for (const line of [map, change]) {
      const routed = routeFrame(line, false, true);
      expect(routed?.to).toBe("colours");
      expect(routed?.frame).toEqual(JSON.parse(line));
    }
  });

  test("a stream that did not ask routes none of them", () => {
    for (const line of [map, change]) expect(routeFrame(line, true, false)).toBeNull();
  });

  test("a colour line with a seq is no journal entry, nor a colour frame", () => {
    for (const colours of [true, false]) {
      expect(routeFrame(JSON.stringify({ type: "colour", seq: 3, colour: api }), true, colours)).toBeNull();
      expect(routeFrame(JSON.stringify({ type: "colours", seq: 3, colours: [api] }), true, colours)).toBeNull();
    }
  });

  test("colour frames between journal entries move no cursor and count as no entry or gap", () => {
    const apply = (stream: string[]): SyncState => {
      let state = INITIAL_STATE;
      for (const line of stream) {
        const routed = routeFrame(line, false, true);
        if (!routed || routed.to === "board") continue;
        const action: Action = routed.to === "colours" ? routed.frame : { type: "frame", frame: routed.frame, epoch: EPOCH };
        state = reduce(state, action).state;
      }
      return state;
    };
    const plain = apply([lines.hello, lines.reset, lines.order]);
    const mixed = apply([lines.hello, map, lines.reset, change, lines.order]);
    expect(mixed.cursor).toEqual({ epoch: EPOCH, seq: 2 });
    expect(mixed.counters).toEqual(plain.counters);
    expect(mixed.fleet.colours).toEqual({ "desk:/w": { auto: "teal", chosen: "slate" } });
    expect({ ...mixed, fleet: { ...mixed.fleet, colours: {} } }).toEqual(plain);
  });
});
