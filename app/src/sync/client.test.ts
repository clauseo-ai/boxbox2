/* the ui thread's side of the wire (client.ts): patches land once a frame while the page shows, and at once while it is
   hidden, through the queue (queue.ts). the store ends as it would had each post been applied in turn. the browser is
   stubbed: a worker that only records, and frames run by hand */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unwrap } from "solid-js/store";
import type { FromWorker, ToWorker } from "./messages";
import { QUEUE_CAP, type RawEvent, Telemetry } from "./telemetry";
import type { Patch } from "./reducer";

type Listener = (event: { data: FromWorker }) => void;
let listener: Listener | null = null;
let visibility: "visible" | "hidden" = "visible";
const documentListeners = new Map<string, () => void>();
const frames = new Map<number, () => void>();
let next = 1;
/* where the stub worker's posts go, when a test hands them on (the telemetry tests); and the beacons the page sent */
let toWorker: ((message: unknown) => void) | null = null;
const beacons: Blob[] = [];
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
    postMessage(message: unknown) {
      toWorker?.(message);
    }
    terminate() {}
  },
  requestAnimationFrame: (fn: () => void) => {
    frames.set(next, fn);
    return next++;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  navigator: { sendBeacon: (_url: string, body: Blob) => beacons.push(body) > 0 },
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
const text = () => (unwrap(store.state.threads)["k"]?.messages[0]?.parts[0] as Record<string, unknown> | undefined)?.["text"];
const view = { key: "k", status: "live", messages: [{ info: { id: "m", role: "assistant", created: 1 }, parts: [{ id: "p", messageID: "m", type: "text", text: "" }] }] };

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

/* the page keeps a copy of each telemetry row it emits until the worker says it was sent or dropped, for the beacon on
   the way out. what the page holds is read from that beacon: hiding sends it and empties the map */
describe("the page's unsent telemetry rows", () => {
  const hide = async (): Promise<string[]> => {
    beacons.length = 0;
    visibility = "hidden";
    documentListeners.get("visibilitychange")?.();
    visibility = "visible";
    documentListeners.get("visibilitychange")?.();
    const rows = await Promise.all(beacons.map(async (b) => (JSON.parse(await b.text()) as { events: RawEvent[] }).events));
    return rows.flat().map((e) => e.id).filter((id) => id.startsWith("t"));
  };
  const shift = (id: string, at: number) => client.emit("perf.shift", { score: 0, shifts: 0 }, { id, at });

  test("past the cap the oldest copy goes, though the worker never answers", async () => {
    await hide();
    for (let i = 0; i < QUEUE_CAP + 100; i++) shift(`t${i}`, i + 1);
    const held = await hide();
    expect(held.length).toBe(QUEUE_CAP);
    expect(held[0]).toBe("t100");
  });

  test("with the server answering 503 for a long run the worker's drops are let go, and rows sent later are deleted", async () => {
    let status = 503;
    let pending = 0;
    const http = Bun.serve({
      port: 0,
      async fetch(req) {
        pending++;
        await req.json();
        pending--;
        return new Response(null, { status });
      },
    });
    const dropped: string[] = [];
    const flushed: string[] = [];
    const telemetry = new Telemetry(
      "dev_1",
      "mac",
      (ids) => (flushed.push(...ids), listener?.({ data: { type: "flushed", ids } })),
      () => null,
      `http://127.0.0.1:${http.port}/api/telemetry`,
      (ids) => (dropped.push(...ids), listener?.({ data: { type: "dropped", ids } })),
    );
    toWorker = (message) => {
      const m = message as ToWorker;
      if (m.type === "telemetry") telemetry.emitAny(m.kind, m.props, m.envelope);
    };
    const settle = async () => {
      for (let waited = 0; waited < 2000; waited += 5) {
        await Bun.sleep(5);
        if (pending === 0) break;
      }
      await telemetry.flush();
    };
    await hide();
    const ids = Array.from({ length: 3000 }, (_, i) => `t${i}`);
    for (const [i, id] of ids.entries()) {
      shift(id, i + 1);
      if (i % 100 === 99) await settle();
    }
    await settle();
    // every row the worker dropped was let go, so the page holds what the worker still retries: the cap's worth
    expect(dropped).toEqual(ids.slice(0, ids.length - QUEUE_CAP));
    expect(flushed).toEqual([]);
    status = 204;
    await settle();
    expect(flushed).toEqual(ids.slice(ids.length - QUEUE_CAP));
    expect(await hide()).toEqual([]);
    toWorker = null;
    telemetry.stop();
    http.stop(true);
  });
});
