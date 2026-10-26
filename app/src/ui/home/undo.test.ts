import { describe, expect, test } from "bun:test";
import { dropUndo, liveUndo, offerUndo, state, type Undo, undoFailed } from "../../store";
import { dropped, failed, offered, type Offers, settled, toastAnnouncement } from "./offers";
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
  test("it tells the offer when it runs out: Infinity while held, the time kept when stopped held, and what is left on a remount", () => {
    const m = manual();
    const said: number[] = [];
    const time = new Lifetime(TOAST_MS, () => {}, m.clock, (at) => said.push(at));
    time.restart();
    m.pass(1000);
    time.hold();
    m.pass(5000);
    time.stop();
    expect(said).toEqual([TOAST_MS, Infinity, 6000 + 5000]);
    const again = new Lifetime(TOAST_MS, () => {}, m.clock, (at) => said.push(at));
    again.restart(2000);
    expect(said.at(-1)).toBe(6000 + 2000);
    again.stop();
  });

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

const offer = (serial: number, cause: Undo["cause"], keys = [`a:${serial}`]): Undo => ({ keys, title: null, serial, cause, until: 0, busy: false, error: null });
const none: Offers = { now: null, next: [] };

describe("the toast's offers: expiry and order", () => {
  test("an offer whose time ran out is gone on read, though no toast was mounted to drop it; one still running stays", () => {
    const at = offered(none, offer(1, "hand"), 1000);
    expect(at.now?.until).toBe(1000 + TOAST_MS);
    expect(settled(at, 1000 + TOAST_MS - 1)).toBe(at);
    expect(settled(at, 1000 + TOAST_MS)).toEqual(none);
    // held (Infinity) never runs out
    expect(settled({ now: { ...offer(1, "hand"), until: Infinity }, next: [] }, 1e12).now?.serial).toBe(1);
  });

  test("in the store: coming back after the time shows nothing, and ⌘z finds no offer", () => {
    offerUndo(["a:9"], "hand", 0);
    expect(liveUndo(TOAST_MS - 1)?.keys).toEqual(["a:9"]);
    expect(liveUndo(TOAST_MS)).toBeNull();
    expect(state.undo).toBeNull();
  });

  test("an auto-clear never replaces a hand clear's toast: it waits, and shows for its own full time when the hand toast ends", () => {
    const hand = offered(none, offer(1, "hand"), 0);
    const both = offered(hand, offer(2, "auto"), 1000);
    expect(both.now?.serial).toBe(1);
    expect(both.next.map((o) => o.serial)).toEqual([2]);
    // dropped by its toast (undone, dismissed, timed out): the auto shows from now
    expect(dropped(both, 1, 3000).now).toMatchObject({ serial: 2, until: 3000 + TOAST_MS });
    // ran out while home was away: the auto's time starts where the hand's ended
    expect(settled(both, TOAST_MS + 10).now).toMatchObject({ serial: 2, until: 2 * TOAST_MS });
    expect(settled(both, 2 * TOAST_MS).now).toBeNull();
  });

  test("a second auto-clear joins the one waiting; anything else replaces what is on screen", () => {
    const waiting = offered(offered(offered(none, offer(1, "hand"), 0), offer(2, "auto"), 0), offer(3, "auto", ["a:2", "a:3"]), 0);
    expect(waiting.next).toHaveLength(1);
    expect(waiting.next[0]?.keys).toEqual(["a:2", "a:3"]);
    expect(offered(waiting, offer(4, "hand"), 0).now?.serial).toBe(4);
    const auto = offered(none, offer(5, "auto"), 0);
    expect(offered(auto, offer(6, "auto"), 0).now?.serial).toBe(6);
    expect(offered(auto, offer(7, "hand"), 0).now?.serial).toBe(7);
  });

  test("a failed undo always shows its line: on screen it stays, and when a newer toast took over the failed one comes back first", () => {
    const first = offered(none, offer(1, "hand"), 0);
    const still = failed(first, first.now ?? offer(1, "hand"), "not brought back. try again", 100);
    expect(still.now).toMatchObject({ serial: 1, error: "not brought back. try again", until: 100 + TOAST_MS });
    const newer = offered(first, offer(2, "hand"), 50);
    const back = failed(newer, offer(1, "hand"), "it is working again", 100);
    expect(back.now).toMatchObject({ serial: 1, error: "it is working again" });
    expect(back.next.map((o) => o.serial)).toEqual([2]);
    // in the store, through the undo's own copy of the offer
    offerUndo(["b:1"], "hand", 0);
    const mine = state.undo && { ...state.undo };
    offerUndo(["b:2"], "hand", 10);
    if (mine) undoFailed(mine, "not brought back", 20);
    expect(state.undo?.keys).toEqual(["b:1"]);
    expect(state.undoNext.map((o) => o.keys)).toEqual([["b:2"]]);
    dropUndo(state.undo?.serial ?? -1, 30);
    expect(state.undo?.keys).toEqual(["b:2"]);
    dropUndo(state.undo?.serial ?? -1, 40);
  });

  test("the live region's words: the line, the one thread's title, why the undo failed, nothing without a toast", () => {
    expect(toastAnnouncement(null)).toBe("");
    expect(toastAnnouncement({ keys: ["a:1", "a:2"], title: null, error: null })).toBe("cleared 2");
    expect(toastAnnouncement({ keys: ["a:1"], title: "tidy the copy", error: null })).toBe("cleared 1, tidy the copy");
    expect(toastAnnouncement({ keys: ["a:1"], title: "tidy the copy", error: "not brought back" })).toBe("not brought back");
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
