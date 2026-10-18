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
      const routed = routeFrame(line, true);
      expect(routed?.to).toBe("board");
      expect(routed?.frame).toEqual(JSON.parse(line));
    }
  });

  test("a stream that never asked (a phone, an ipad) drops them", () => {
    for (const line of [lines.here, lines.gone, lines.focus, lines.compose]) expect(routeFrame(line, false)).toBeNull();
  });

  test("the journal's own frames still need what they needed: a seq, and a type this protocol has", () => {
    expect(routeFrame(lines.order, true)?.to).toBe("journal");
    expect(routeFrame(JSON.stringify({ type: "order", order: [] }), true)).toBeNull();
    expect(routeFrame(JSON.stringify({ type: "board.light", key: "desk:s1" }), true)).toBeNull();
    expect(routeFrame(JSON.stringify({ type: "boardhere", seats: [] }), true)).toBeNull();
    expect(routeFrame(JSON.stringify({ type: "mystery", seq: 3 }), true)).toBeNull();
    expect(routeFrame("{not json", true)).toBeNull();
    expect(routeFrame("null", true)).toBeNull();
  });

  test("board frames between journal entries leave the cursor and the reducer's state exactly as without them", () => {
    const apply = (stream: string[]): { state: SyncState; board: number } => {
      let state = INITIAL_STATE;
      let board = 0;
      for (const line of stream) {
        const routed = routeFrame(line, true);
        if (!routed) continue;
        if (routed.to === "board") {
          board++;
          continue;
        }
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
