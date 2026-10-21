import { describe, expect, test } from "bun:test";
import { type Frame, parseCursor, routeFrame, textOf } from "./protocol";
import { type Action, INITIAL_STATE, reduce, type SyncState } from "./reducer";

const EPOCH = "j1";
const fleet = { agents: [], threads: [], asks: [], order: [] };

const lines = {
  hello: JSON.stringify({ type: "hello", protocol: 3, epoch: EPOCH, head: 2, build: "b", stream: "0", interest: { thread: null, under: [], holds: [] } }),
  reset: JSON.stringify({ type: "reset", seq: 1, epoch: EPOCH, reason: "none", fleet }),
  order: JSON.stringify({ type: "order", seq: 2, keys: [] }),
  here: JSON.stringify({ type: "board.here", seats: [{ key: "desk:s1", digit: 1 }, { key: "desk:s2", digit: 2, bound: true }] }),
  gone: JSON.stringify({ type: "board.gone" }),
  focus: JSON.stringify({ type: "board.focus", key: "desk:s1" }),
  compose: JSON.stringify({ type: "board.compose", machine: "vm" }),
};

/** the sse id a line came with: the journal's entries and the reset carry one */
const idOf = (line: string) => {
  const value = JSON.parse(line) as { type: string; seq?: number };
  return value.type === "hello" || value.seq === undefined ? null : parseCursor(`${EPOCH}:${value.seq}`);
};

describe("board frames on the app's stream", () => {
  test("each board frame is taken as it is, without a seq, when the stream asked for them", () => {
    for (const line of [lines.here, lines.gone, lines.focus, lines.compose]) {
      const routed = routeFrame(line, true);
      expect(routed?.to).toBe("board");
      expect(routed && "frame" in routed ? routed.frame : null).toEqual(JSON.parse(line));
    }
  });

  test("a stream that never asked (a phone, an ipad) drops them", () => {
    for (const line of [lines.here, lines.gone, lines.focus, lines.compose]) expect(routeFrame(line, false)).toBeNull();
  });

  test("the journal's own frames still need their seq; a type this protocol lacks is skipped, not dropped", () => {
    expect(routeFrame(lines.order, true)?.to).toBe("journal");
    expect(routeFrame(JSON.stringify({ type: "order", keys: [] }), true)).toBeNull();
    // an unknown type is skipped and its id still moves the cursor (docs/protocol.md, section 3)
    expect(routeFrame(JSON.stringify({ type: "board.light", key: "desk:s1" }), true)).toEqual({ to: "skip", type: "board.light" });
    expect(routeFrame(JSON.stringify({ type: "mystery", seq: 3 }), true)).toEqual({ to: "skip", type: "mystery" });
    expect(routeFrame("{not json", true)).toBeNull();
    expect(routeFrame("null", true)).toBeNull();
    expect(routeFrame(JSON.stringify({ seq: 3 }), true)).toBeNull();
  });

  test("protocol 3's control frames pass, with or without an id", () => {
    for (const frame of [
      { type: "caught", seq: 9 },
      { type: "catchup", entries: [{ seq: 4, type: "delta", key: "a:b", messageID: "m", partID: "p", field: "text", delta: "x", offset: 0 }] },
      { type: "interest", ask: 1, thread: "a:b", under: [], holds: [], seq: 9, stale: ["a:c"] },
      { type: "thread.stale", key: "a:b" },
    ]) {
      expect(routeFrame(JSON.stringify(frame), false)).toEqual({ to: "journal", frame: frame as Frame });
    }
  });

  test("a catch-up or a confirm that does not parse is a protocol error, routed as broken", () => {
    expect(routeFrame(JSON.stringify({ type: "catchup", entries: [{ type: "thread", seq: 3 }] }), false)).toEqual({ to: "broken", what: "catchup-error" });
    expect(routeFrame(JSON.stringify({ type: "catchup", entries: [{ type: "delta", key: "a:b" }] }), false)).toEqual({ to: "broken", what: "catchup-error" });
    expect(routeFrame(JSON.stringify({ type: "catchup" }), false)).toEqual({ to: "broken", what: "catchup-error" });
    expect(routeFrame(JSON.stringify({ type: "interest", ask: 1, under: [], holds: [] }), false)).toEqual({ to: "broken", what: "catchup-error" });
    expect(routeFrame(JSON.stringify({ type: "interest", ask: 1, seq: 2, under: "a:b", holds: [] }), false)).toEqual({ to: "broken", what: "catchup-error" });
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
        if (routed.to !== "journal") continue;
        const action: Action = { type: "frame", frame: routed.frame, id: idOf(line) };
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

  test("each is taken as it is, without a seq, on every stream", () => {
    for (const line of [map, change]) {
      for (const board of [true, false]) {
        const routed = routeFrame(line, board);
        expect(routed?.to).toBe("colours");
        expect(routed && "frame" in routed ? routed.frame : null).toEqual(JSON.parse(line));
      }
    }
  });

  test("a colour line with a seq is no journal entry, nor a colour frame", () => {
    expect(routeFrame(JSON.stringify({ type: "colour", seq: 3, colour: api }), true)).toBeNull();
    expect(routeFrame(JSON.stringify({ type: "colours", seq: 3, colours: [api] }), true)).toBeNull();
  });

  test("colour frames between journal entries move no cursor and count as no entry", () => {
    const apply = (stream: string[]): SyncState => {
      let state = INITIAL_STATE;
      for (const line of stream) {
        const routed = routeFrame(line, false);
        if (!routed || (routed.to !== "colours" && routed.to !== "journal")) continue;
        const action: Action = routed.to === "colours" ? routed.frame : { type: "frame", frame: routed.frame, id: idOf(line) };
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

describe("a settled text's hash", () => {
  test("is fnv-1a 32 over utf-16 code units, 8 lowercase hex, its length in utf-16 units", () => {
    // fnv-1a 32 reference values: the empty string is the offset basis, "a" and "foobar" the published vectors
    expect(textOf("")).toEqual({ length: 0, hash: "811c9dc5" });
    expect(textOf("a")).toEqual({ length: 1, hash: "e40c292c" });
    expect(textOf("foobar")).toEqual({ length: 6, hash: "bf9cf968" });
    // an emoji is two code units, each hashed
    expect(textOf("🙂").length).toBe(2);
    expect(textOf("🙂").hash).not.toBe(textOf("").hash);
  });
});
