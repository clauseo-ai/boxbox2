/* the undo toast mounted as home mounts it (home.tsx: a keyed <Show> over state.undo, the toast's time inside,
   toast-life.ts), with no dom: an undo that lands, or a refusal, or the time running out ends it with no stale read (an
   accessor from a <Show> read after the store let go of the offer threw, and the toast stayed with its undo disabled).
   solid's browser build only (`bun test --conditions browser`, the justfile's check). */

import { afterEach, describe, expect, test } from "bun:test";
import { createMemo, createRoot, createSignal, onCleanup, Show } from "solid-js";
import { dropUndo, offerUndo, state, undoBusy, undoFailed } from "../../store";
import { toastLife } from "./toast-life";
import type { Clock } from "./undo";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

/** a clock the test moves by hand */
function manual() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  const clock: Clock = {
    now: () => now,
    after: (ms, run) => { const id = next++; due.set(id, { at: now + ms, run }); return id; },
    cancel: (id) => void due.delete(id as number),
  };
  return { clock, pass(ms: number) { now += ms; for (const [id, job] of [...due]) if (job.at <= now) { due.delete(id); job.run(); } }, pending: () => due.size };
}

const ring = { restart: () => {}, pause: () => {}, play: () => {}, stop: () => {} };

/** home's mount: a keyed <Show> over the offer; counts the toasts mounted and unmounted */
function mountHome(clock: Clock) {
  const seen = { mounted: 0, gone: 0 };
  let dispose = () => {};
  createRoot((d) => {
    dispose = d;
    const shown = Show({
      get when() { return state.undo; },
      keyed: true,
      children: (undo) => {
        seen.mounted++;
        toastLife(undo, ring, clock);
        onCleanup(() => seen.gone++);
        return "toast";
      },
    }) as unknown as () => unknown;
    // read the <Show> the way the dom would, so its children mount and update
    createMemo(() => shown());
  });
  return { seen, dispose };
}

let unmount = () => {};
afterEach(() => { unmount(); if (state.undo) dropUndo(state.undo.serial); });

describe.skipIf(!reactive)("the undo toast, mounted as home mounts it", () => {
  test("an undo that lands ends the toast with no error, its busy hold and all", () => {
    const m = manual();
    const home = mountHome(m.clock);
    unmount = home.dispose;
    offerUndo(["desk:ses_1"], "hand", 0);
    expect(home.seen.mounted).toBe(1);
    const serial = state.undo?.serial ?? -1;
    // undoLast: busy (the time holds), then the server brought it back
    expect(() => undoBusy(serial, true)).not.toThrow();
    expect(() => dropUndo(serial)).not.toThrow();
    expect(state.undo).toBeNull();
    expect(home.seen.gone).toBe(1);
    expect(m.pending()).toBe(0);
  });

  test("focus in the toast is still known when an undo that lands ends it, so focus goes to the bar, not the body", () => {
    const m = manual();
    const atEnd: { focused: boolean | null } = { focused: null };
    let dispose = () => {};
    createRoot((d) => {
      dispose = d;
      const shown = Show({
        get when() { return state.undo; },
        keyed: true,
        children: (undo) => {
          const life = toastLife(undo, ring, m.clock);
          // the undo button pressed: focus is in the toast (toast.tsx, onFocusIn)
          life.set("focus", true);
          onCleanup(() => (atEnd.focused = life.focused()));
          return "toast";
        },
      }) as unknown as () => unknown;
      createMemo(() => shown());
    });
    unmount = dispose;
    offerUndo(["desk:ses_1"], "hand", 0);
    const serial = state.undo?.serial ?? -1;
    undoBusy(serial, true);
    dropUndo(serial);
    expect(atEnd.focused).toBe(true);
  });

  test("a refused undo stays on the toast; a newer clear keeps the toast mounted with the new offer; the time ends it", () => {
    const m = manual();
    const home = mountHome(m.clock);
    unmount = home.dispose;
    offerUndo(["desk:ses_1"], "hand", 0);
    const first = state.undo ? { ...state.undo } : null;
    undoBusy(first?.serial ?? -1, true);
    if (first) expect(() => undoFailed(first, "it is on home already", 0)).not.toThrow();
    expect(state.undo?.error).toBe("it is on home already");
    expect(home.seen).toEqual({ mounted: 1, gone: 0 });
    offerUndo(["desk:ses_2"], "hand", 0);
    expect(home.seen).toEqual({ mounted: 1, gone: 0 });
    expect(() => m.pass(6000)).not.toThrow();
    expect(state.undo).toBeNull();
    expect(home.seen.gone).toBe(1);
  });
});
