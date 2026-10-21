/* perf.thread times a thread's first paint by the frame that paints it (ui/thread/stage.tsx): what the landing writes inside a
   frame paints in that frame, and what the store takes in a task paints in the next. client.ts says which, as the store's
   readers run (`landingInFrame`). the browser is stubbed as in client.test.ts: a worker that only records, frames run by
   hand. run with `--conditions browser`, so the store's effects run (justfile, check) */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import type { FromWorker } from "./messages";
import type { Patch } from "./reducer";

type Listener = (event: { data: FromWorker }) => void;
let listener: Listener | null = null;
let visibility: "visible" | "hidden" = "visible";
const frames = new Map<number, () => void>();
let next = 1;
const saved: Record<string, unknown> = {};
const stubs: Record<string, unknown> = {
  window: { addEventListener: () => undefined, removeEventListener: () => undefined },
  document: {
    get visibilityState() {
      return visibility;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  },
  location: { href: "https://boxbox.test/", search: "" },
  history: { state: null, replaceState: () => undefined },
  localStorage: { getItem: () => "device", setItem: () => undefined },
  Worker: class {
    addEventListener(_name: string, fn: Listener) {
      listener = fn;
    }
    postMessage() {}
    terminate() {}
  },
  requestAnimationFrame: (fn: () => void) => {
    frames.set(next, fn);
    return next++;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
};

let client: typeof import("./client");
let store: typeof import("../store");

beforeAll(async () => {
  for (const [name, value] of Object.entries(stubs)) {
    saved[name] = (globalThis as Record<string, unknown>)[name];
    (globalThis as Record<string, unknown>)[name] = value;
  }
  client = await import("./client");
  store = await import("../store");
  client.startSync();
});

afterAll(() => {
  client.stopSync();
  for (const [name, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[name] = value;
});

const post = (patches: Patch[]) => listener?.({ data: { type: "patches", patches } });
const frame = () => {
  const due = [...frames.values()];
  frames.clear();
  for (const fn of due) fn();
};
const view = (status: string) => ({ key: "k", status, messages: [] });

/* solid's server build (a plain `bun test`) runs no effects: this runs in the browser build only */
const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch {
    return false;
  }
})();

describe.skipIf(!reactive)("the frame a landed thread paints in", () => {
  test("what the landing writes in a frame reads as in that frame; what lands in a task, as not", () => {
    const seen: Array<[string, boolean]> = [];
    const dispose = createRoot((dispose) => {
      createEffect(on(() => store.state.threads["k"]?.status, (status) => { if (status) seen.push([status, client.landingInFrame()]); }, { defer: true }));
      return dispose;
    });
    // a visible page: the copy-back waits for the frame and lands in it
    post([{ path: ["threads", "k"], value: view("live") }]);
    expect(seen).toEqual([]);
    frame();
    // a hidden page: the post lands at once, in its own task
    visibility = "hidden";
    post([{ path: ["threads", "k"], value: view("stale") }]);
    visibility = "visible";
    dispose();
    expect(seen).toEqual([["live", true], ["stale", false]]);
    expect(client.landingInFrame()).toBe(false);
  });
});
