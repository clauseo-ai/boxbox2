import { describe, expect, test } from "bun:test";
import { dropUndo, offerUndo, state } from "../../store";
import { DRAIN_FRAMES, Lifetime, TOAST_MS, toastWords, undoName, wedge } from "./undo";

/** a clock the test moves by hand */
function manual() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    clock: {
      now: () => now,
      after: (ms: number, run: () => void) => {
        const id = next++;
        due.set(id, { at: now + ms, run });
        return id;
      },
      cancel: (id: unknown) => void due.delete(id as number),
    },
    pass(ms: number) {
      now += ms;
      for (const [id, job] of [...due]) if (job.at <= now) {
        due.delete(id);
        job.run();
      }
    },
    pending: () => due.size,
  };
}

describe("the toast's time", () => {
  test("it runs out after 6 s", () => {
    const m = manual();
    let gone = 0;
    const time = new Lifetime(TOAST_MS, () => gone++, m.clock);
    time.restart();
    m.pass(5999);
    expect(gone).toBe(0);
    m.pass(1);
    expect(gone).toBe(1);
  });

  test("a hold keeps what was left, and the time runs on from there", () => {
    const m = manual();
    let gone = 0;
    const time = new Lifetime(TOAST_MS, () => gone++, m.clock);
    time.restart();
    m.pass(4000);
    time.hold();
    m.pass(60_000);
    expect(gone).toBe(0);
    time.release();
    m.pass(1999);
    expect(gone).toBe(0);
    m.pass(1);
    expect(gone).toBe(1);
  });

  test("two holds (a pointer and focus) need both released", () => {
    const m = manual();
    let gone = 0;
    const time = new Lifetime(TOAST_MS, () => gone++, m.clock);
    time.restart();
    time.hold();
    time.hold();
    time.release();
    m.pass(10_000);
    expect(gone).toBe(0);
    time.release();
    m.pass(TOAST_MS);
    expect(gone).toBe(1);
  });

  test("a newer clear starts the full time again, and stop leaves no timer behind", () => {
    const m = manual();
    let gone = 0;
    const time = new Lifetime(TOAST_MS, () => gone++, m.clock);
    time.restart();
    m.pass(5000);
    time.restart();
    m.pass(5000);
    expect(gone).toBe(0);
    time.stop();
    expect(m.pending()).toBe(0);
  });
});

describe("the toast's clear, in the store", () => {
  test("a clear is offered back with the one thread's title; a newer one replaces it, and only its own serial drops it", () => {
    offerUndo([]);
    expect(state.undo).toBeNull();
    offerUndo(["a:1", "a:2"]);
    const first = state.undo?.serial ?? -1;
    expect(state.undo).toMatchObject({ keys: ["a:1", "a:2"], title: null, busy: false, error: null });
    offerUndo(["a:3"]);
    const second = state.undo?.serial ?? -1;
    expect(second).toBeGreaterThan(first);
    dropUndo(first);
    expect(state.undo?.serial).toBe(second);
    dropUndo(second);
    expect(state.undo).toBeNull();
  });
});

describe("the toast's words and ring", () => {
  test("words and a name of its own", () => {
    expect(toastWords(5)).toBe("cleared 5");
    expect(undoName({ keys: ["a:1"], title: "tidy the onboarding copy" })).toBe("undo clearing tidy the onboarding copy");
    expect(undoName({ keys: ["a:1", "a:2"], title: null })).toBe("undo clearing 2 threads");
  });

  test("the ring is whole at the start and gone at the end, seven points at every frame", () => {
    expect(wedge(0)).toBe("polygon(50% 50%, 50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, 50% 0%)");
    expect(wedge(1)).toBe("polygon(50% 50%, 50% 0%, 50% 0%, 50% 0%, 50% 0%, 50% 0%, 50% 0%)");
    expect(wedge(0.5)).toBe("polygon(50% 50%, 50% 100%, 50% 100%, 50% 100%, 0% 100%, 0% 0%, 50% 0%)");
    for (const frame of DRAIN_FRAMES) expect(frame.clipPath.split(",").length).toBe(7);
    expect(DRAIN_FRAMES.map((f) => f.offset)).toEqual([0, 1 / 8, 3 / 8, 5 / 8, 7 / 8, 1]);
  });
});
