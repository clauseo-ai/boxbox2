/* the live strip moves its marks in place (lane.ts): a tick makes new shapes, but every piece the lane drew stays the
   same piece, so the element drawn for it stays, and what its class and style read is what the shapes say, the same as the
   lane drew when it made every piece again. solid's browser build only (`bun test --conditions browser`, the justfile's check). */

import { describe, expect, test } from "bun:test";
import { createMemo, createRoot, createSignal, mapArray } from "solid-js";
import { type Strip, type StripMark, stripShapes } from "./groups";
import { lane } from "./lane";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

const T0 = 1_790_000_000_000;
const mark = (n: number, kind: StripMark["kind"], ms: number, running = false): StripMark => ({ kind, at: T0 + n * 4000, ms, running, bad: n === 5, row: `r${n}`, part: `p${n}` });
const strip = (count: number): Strip => ({
  start: T0,
  end: T0 + count * 4000,
  live: true,
  ordered: false,
  gaps: [],
  thoughts: [{ at: T0, ms: 1500, streaming: false }, { at: T0 + (count - 1) * 4000, ms: 800, streaming: true }],
  marks: Array.from({ length: count }, (_, n) => mark(n, n % 4 === 0 ? "edit" : n % 4 === 1 ? "run" : n % 4 === 2 ? "read" : "spawn", n % 4 === 1 ? 2500 : 300, n === count - 1)),
});

/* what the old lane drew, a piece per shape */
const at = (left: number, width?: number) => ({ left: `${left}%`, ...(width !== undefined ? { width: `${width}%` } : {}) });
const markClass = (m: ReturnType<typeof stripShapes>["marks"][number]) => `strip-mk mk-${m.kind}${m.bar ? " mk-bar" : ""}${m.running ? " mk-running" : ""}${m.bad ? " mk-bad" : ""}`;

describe.skipIf(!reactive)("strip lane", () => {
  test("a minute of live ticks makes no piece again and draws what the shapes say; the old lane made every piece each second", () => {
    const [now, setNow] = createSignal(T0 + 12 * 4000);
    const [s, setS] = createSignal(strip(12));
    let made = 0;
    let madeBefore = 0;
    const r = createRoot((dispose) => {
      const shapes = createMemo(() => stripShapes(s(), now()));
      const pieces = lane(shapes);
      // count what is made: a piece of the lane is an element of the strip
      const counted = createMemo(mapArray(pieces.marks, (p) => { made++; return p; }));
      const before = createMemo(mapArray(() => shapes().marks, (m) => { madeBefore++; return m; }));
      return { shapes, pieces, counted, before, dispose };
    });
    r.counted();
    r.before();
    const first = made;
    const firstBefore = madeBefore;
    const kept = r.pieces.marks();
    for (let i = 1; i <= 60; i++) {
      setNow(T0 + 12 * 4000 + i * 1000);
      r.counted();
      r.before();
      const marks = r.pieces.marks();
      expect(marks).toHaveLength(kept.length);
      marks.forEach((p, n) => {
        expect(p).toBe(kept[n] as (typeof kept)[number]);
        const shape = r.shapes().marks[n];
        if (!shape) throw new Error("a piece without a shape");
        expect(p.class()).toBe(markClass(shape));
        expect(p.style()).toEqual(at(shape.left, shape.width));
      });
      r.pieces.thoughts().forEach((p, n) => { const t = r.shapes().thoughts[n]; expect(t && p.style()).toEqual(t && at(t.left, t.width)); });
      r.pieces.tracks().forEach((p, n) => { const t = r.shapes().tracks[n]; expect(t && p.style()).toEqual(t && at(t.left, t.width)); });
    }
    expect(made - first).toBe(0);
    // the old lane: every mark made again on every tick
    expect(madeBefore - firstBefore).toBe(60 * kept.length);
    // a step that arrives adds its piece and keeps the rest; the running mark becomes a settled one in place
    setS(strip(13));
    const grown = r.pieces.marks();
    r.counted();
    expect(made - first).toBe(1);
    expect(grown.slice(0, kept.length).every((p, n) => p === kept[n])).toBe(true);
    expect(grown[11]?.class()).toBe(markClass(r.shapes().marks[11] as ReturnType<typeof stripShapes>["marks"][number]));
    r.dispose();
  });

  test("marks that move between places and change kind keep the pieces where they stand and draw what the shapes say", () => {
    const [s, setS] = createSignal(strip(8));
    const r = createRoot((dispose) => {
      const shapes = createMemo(() => stripShapes(s(), T0 + 40_000));
      return { shapes, pieces: lane(shapes), dispose };
    });
    const kept = r.pieces.marks();
    const draws = () => r.pieces.marks().forEach((p, n) => {
      const shape = r.shapes().marks[n];
      if (!shape) throw new Error("a piece without a shape");
      expect(p.class()).toBe(markClass(shape));
      expect(p.style()).toEqual(at(shape.left, shape.width));
    });
    draws();
    // the marks reversed, a read became a failed edit, a long run settled into a tick, and one left
    const was = strip(8);
    const moved: Strip = { ...was, marks: [...was.marks].reverse().map((m, n) => (n === 2 ? { ...m, kind: "edit" as const, bad: true } : n === 4 ? { ...m, ms: 100 } : m)).slice(0, 7) };
    setS(moved);
    const after = r.pieces.marks();
    expect(after).toHaveLength(7);
    expect(after.every((p, n) => p === kept[n])).toBe(true);
    expect(r.shapes().marks.map((m) => m.kind)).not.toEqual(stripShapes(was, T0 + 40_000).marks.slice(0, 7).map((m) => m.kind));
    draws();
    r.dispose();
  });
});
