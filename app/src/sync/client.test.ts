/* the ui thread's side of the wire (client.ts): patches land once a frame while the page shows, and at once while it is
   hidden, through the queue (queue.ts). the store ends as it would had each post been applied in turn. the browser is
   stubbed: a worker that only records, and frames run by hand */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unwrap } from "solid-js/store";
import type { FromWorker } from "./messages";
import type { Patch } from "./reducer";

type Listener = (event: { data: FromWorker }) => void;
let listener: Listener | null = null;
let visibility: "visible" | "hidden" = "visible";
const documentListeners = new Map<string, () => void>();
const frames = new Map<number, () => void>();
let next = 1;
const saved: Record<string, unknown> = {};
const stubs: Record<string, unknown> = {
  window: { addEventListener: () => undefined, removeEventListener: () => undefined },
  document: {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (name: string, fn: () => void) => documentListeners.set(name, fn),
    removeEventListener: (name: string) => documentListeners.delete(name),
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

const runAll = (queue: Map<number, () => void>) => {
  const due = [...queue.values()];
  queue.clear();
  for (const fn of due) fn();
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
const at = ["threads", "k", "messages", 0, "parts", 0, "text"] as const;
const text = () => unwrap(store.state.threads)["k"]?.messages[0]?.parts[0]?.["text"];
const view = { key: "k", status: "live", messages: [{ info: { id: "m", sessionID: "s", role: "assistant", time: { created: 1 } }, parts: [{ id: "p", sessionID: "s", messageID: "m", type: "text", text: "" }] }] };

describe("the ui's side of the wire", () => {
  test("a visible page lands every post of a frame in that frame, once", () => {
    post([{ path: ["threads", "k"], value: structuredClone(view) }]);
    post([{ path: at, append: "hel", from: 0 }]);
    expect(store.state.threads["k"]).toBeUndefined();
    expect(frames.size).toBe(1);
    runAll(frames);
    expect(text()).toBe("hel");
  });

  test("a hidden page lands each post at once, with what waited for a frame before it hid", () => {
    post([{ path: at, append: "lo", from: 3 }]);
    expect(frames.size).toBe(1);
    visibility = "hidden";
    documentListeners.get("visibilitychange")?.();
    expect(text()).toBe("hel");
    post([{ path: at, append: " wo", from: 5 }]);
    expect(text()).toBe("hello wo");
    post([{ path: at, append: "rld", from: 8 }]);
    expect(text()).toBe("hello world");
    // the frame asked for before it hid comes when it shows again, with nothing left to land
    visibility = "visible";
    runAll(frames);
    expect(text()).toBe("hello world");
  });

  test("many posts before a frame land as applying each in turn would", () => {
    let length = 11;
    for (let i = 0; i < 5000; i++) {
      post([{ path: at, append: "x", from: length }, { path: ["fleet", "order"], value: [`k${i}`] }]);
      length++;
    }
    runAll(frames);
    expect(String(text()).length).toBe(5011);
    expect([...store.state.fleet.order]).toEqual(["k4999"]);
  });
});
