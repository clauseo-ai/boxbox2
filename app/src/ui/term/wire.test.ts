import { describe, expect, test } from "bun:test";
import { type Effect, Wire } from "./wire";

const meta = (cursor: number) => new Uint8Array([0, ...new TextEncoder().encode(JSON.stringify({ cursor }))]);
const replay = (cursor: number | null) => new Uint8Array([1, ...new TextEncoder().encode(JSON.stringify({ cursor }))]);
const heartbeat = new Uint8Array([2]);

function written(effects: Effect[]): string {
  return effects.map((e) => (e.type === "write" ? e.text : "")).join("");
}

describe("the pane's side of the terminal wire", () => {
  test("a first open holds the replay and paints it whole when the meta lands", () => {
    const wire = new Wire();
    wire.opened();
    expect(wire.text("$ ls\r\n")).toEqual([]);
    expect(wire.text("a b\r\n")).toEqual([]);
    const effects = wire.binary(meta(11));
    expect(effects).toEqual([
      { type: "write", text: "$ ls\r\na b\r\n", replay: true },
      { type: "live", cursor: 11 },
    ]);
    expect(wire.cursor).toBe(11);
  });

  test("live output paints at once and moves the cursor by its utf-16 length", () => {
    const wire = new Wire();
    wire.opened();
    wire.binary(meta(0));
    expect(wire.text("🦀 ok")).toEqual([{ type: "write", text: "🦀 ok", replay: false }]);
    expect(wire.cursor).toBe(5);
  });

  test("a resume that lost nothing paints what it missed and no reset", () => {
    const wire = new Wire(100);
    wire.opened();
    wire.text("more\r\n");
    expect(wire.binary(meta(106))).toEqual([
      { type: "write", text: "more\r\n", replay: true },
      { type: "live", cursor: 106 },
    ]);
  });

  test("a resume past what cmx2 kept resets the screen before painting the tail", () => {
    const wire = new Wire(100);
    wire.opened();
    wire.text("tail");
    const effects = wire.binary(meta(5_000));
    expect(effects[0]).toEqual({ type: "reset" });
    expect(effects[1]).toEqual({ type: "note", text: "older output was not kept" });
    expect(written(effects)).toBe("tail");
    expect(wire.cursor).toBe(5_000);
  });

  test("the relay's replay frame drops an unfinished replay and starts over", () => {
    const wire = new Wire(40);
    wire.opened();
    wire.text("half of a rep");
    wire.binary(replay(40));
    wire.text("lay, whole\r\n");
    const effects = wire.binary(meta(52));
    expect(written(effects)).toBe("lay, whole\r\n");
    expect(effects.some((e) => e.type === "reset")).toBe(false);
  });

  test("a redial by the relay mid-stream holds its replay the same way", () => {
    const wire = new Wire();
    wire.opened();
    wire.binary(meta(10));
    wire.text("abc");
    wire.binary(replay(13));
    expect(wire.replaying).toBe(true);
    expect(wire.text("def")).toEqual([]);
    expect(written(wire.binary(meta(16)))).toBe("def");
    expect(wire.cursor).toBe(16);
  });

  test("heartbeats and frames the contract does not declare change nothing", () => {
    const wire = new Wire(7);
    expect(wire.binary(heartbeat)).toEqual([]);
    expect(wire.binary(new Uint8Array([9, 1, 2]))).toEqual([]);
    expect(wire.binary(new Uint8Array([0, 123]))).toEqual([]);
    expect(wire.cursor).toBe(7);
  });

  test("a first open's full replay is never judged for holes", () => {
    const wire = new Wire();
    wire.opened();
    wire.text("head then tail");
    // cmx2 kept a head and a tail with a gap between; with no cursor there is nothing to compare against
    const effects = wire.binary(meta(900_000));
    expect(effects.some((e) => e.type === "reset")).toBe(false);
    expect(written(effects)).toBe("head then tail");
  });
});
