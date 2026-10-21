/* the thinking box's pace (pace.ts): a 100 ms batch is revealed over the frames after it, in pieces that end at a word, all of it before
   the next batch is due, and what is shown is always exactly the text. driven by a fake clock at 60 fps */

import { describe, expect, test } from "bun:test";
import { type Clock, PACE_MS, pacer } from "./pace";

function world() {
  let t = 0;
  let next = 1;
  const frames = new Map<number, (now: number) => void>();
  const clock: Clock = {
    now: () => t,
    frame: (run) => { frames.set(next, run); return next++; },
    cancel: (id) => { frames.delete(id); },
  };
  /** time passes to `until`, a frame every 16.7 ms */
  const run = (until: number) => {
    while (t + 1000 / 60 <= until) {
      t += 1000 / 60;
      const due = [...frames.values()];
      frames.clear();
      for (const f of due) f(t);
    }
    t = until;
  };
  return { clock, run, pending: () => frames.size };
}

const words = "the agent weighs the three ways the test could fail and reads the file again before it decides which one to try first ".split(" ");
const batch = (n: number, from: number): string => Array.from({ length: n }, (_, i) => `${words[(from + i) % words.length]} `).join("");

describe("the thinking box's pace", () => {
  test("each 100 ms batch is revealed over several frames, ending before the next batch, in pieces that end at a word", () => {
    const w = world();
    let shown = "";
    const pieces: Array<{ at: number; text: string }> = [];
    const p = pacer("", { append: (s) => { shown += s; pieces.push({ at: w.clock.now(), text: s }); }, replace: (s) => { shown = s; } }, w.clock);
    let text = "";
    for (let b = 0; b < 50; b++) {
      text += batch(8, b * 8);
      p.set(text);
      const before = pieces.length;
      w.run((b + 1) * 100);
      expect(shown).toBe(text);
      const these = pieces.slice(before);
      expect(these.length).toBeGreaterThanOrEqual(3);
      expect(these.every((x) => x.at - b * 100 <= PACE_MS + 1000 / 60)).toBe(true);
      expect(these.every((x) => x.text.endsWith(" "))).toBe(true);
    }
    expect(w.pending()).toBe(0);
  });
  test("a batch that lands before the last is revealed carries on from the same reveal, and nothing is lost or doubled", () => {
    const w = world();
    let shown = "start ";
    const p = pacer(shown, { append: (s) => { shown += s; }, replace: (s) => { shown = s; } }, w.clock);
    let text = shown;
    for (let b = 0; b < 30; b++) {
      text += batch(12, b);
      p.set(text);
      w.run(b * 30 + 30);
      expect(text.startsWith(shown)).toBe(true);
    }
    w.run(10_000);
    expect(shown).toBe(text);
  });
  test("a text that does not carry on replaces what is shown at once, and stops the reveal", () => {
    const w = world();
    let shown = "";
    let replaced = 0;
    const p = pacer("", { append: (s) => { shown += s; }, replace: (s) => { shown = s; replaced++; } }, w.clock);
    p.set(batch(20, 0));
    w.run(20);
    p.set("something else entirely");
    expect(shown).toBe("something else entirely");
    expect(replaced).toBe(1);
    w.run(1000);
    expect(shown).toBe("something else entirely");
  });
  test("a word longer than its reach, or a pair of a character, is never split between pieces", () => {
    const w = world();
    let shown = "";
    const pieces: string[] = [];
    const p = pacer("", { append: (s) => { shown += s; pieces.push(s); }, replace: () => {} }, w.clock);
    const text = "😀".repeat(200);
    p.set(text);
    w.run(200);
    expect(shown).toBe(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const s of pieces) expect(s.length % 2).toBe(0);
  });
  test("dispose stops the reveal", () => {
    const w = world();
    let shown = "";
    const p = pacer("", { append: (s) => { shown += s; }, replace: () => {} }, w.clock);
    p.set(batch(40, 0));
    p.dispose();
    w.run(500);
    expect(shown).toBe("");
    expect(w.pending()).toBe(0);
  });
});
