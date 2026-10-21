/* a child a lane let go of reads in the details panel's agents list as it did before the store held only what is on screen
   (docs/architecture.md, the worker to the ui): while its parent is drawn, a released child stays in the store, so its step
   count, its report state and, for an archived child, its cost are what they were while it was held, which is what main
   showed; when the parent leaves the stage the store lets it go. the real worker runs in this process with its cache on
   fake-indexeddb, and the sync client's verbs are routed to it, so live.ts, the holds and the worker's filter are the app's
   own. solid's browser build only (`bun test --conditions browser`, the justfile's check). */

import "fake-indexeddb/auto";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import type { FromWorker } from "../../sync/messages";
import type { FleetSnapshot, Message, Part, SessionEntry } from "../../sync/protocol";
import type { Sync } from "../../sync/worker";
import type { AgentRow, Kin } from "./details-model";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();
if (reactive) (globalThis as { window?: unknown }).window ??= globalThis;

const HOST = "bench";
const PARENT = `${HOST}:ses_parent`;
const CHILD = `${HOST}:ses_child`;
const GONE = `${HOST}:ses_gone`;
const T0 = 1_790_000_000_000;

const entry = (key: string, parentID?: string): SessionEntry => ({
  key,
  host: HOST,
  id: key.slice(HOST.length + 1),
  info: { id: key.slice(HOST.length + 1), slug: "s", projectID: "/w", directory: "/w", title: key, version: "0", time: { created: T0, updated: T0 + 9_000 }, source: "cmx2", cost: 0.5, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } }, ...(parentID ? { parentID } : {}) },
  status: null,
  agents: 0,
  processes: 0,
  tail: [],
  needs: [],
  read: null,
}) as SessionEntry;
const user = (session: string, n: number): Message => ({ info: { id: `msg_${session}_u${n}`, sessionID: session, role: "user", time: { created: T0 + n * 1000 } }, parts: [{ id: `prt_${session}_u${n}`, sessionID: session, messageID: `msg_${session}_u${n}`, type: "text", text: `ask ${n}` }] }) as Message;
const tool = (session: string, message: string, n: number, name: string, metadata: Record<string, unknown> = {}): Part =>
  ({ id: `prt_${message}_${n}`, sessionID: session, messageID: message, type: "tool", callID: `call_${message}_${n}`, tool: name, state: { status: "completed", input: { filePath: `/w/f${n}.ts`, brief: "do it" }, output: "x", metadata, time: { start: T0 + n, end: T0 + n + 10 } } }) as unknown as Part;
const assistant = (session: string, n: number, parts: (id: string) => Part[], cost = 0): Message => {
  const id = `msg_${session}_a${n}`;
  return { info: { id, sessionID: session, role: "assistant", cost, time: { created: T0 + n * 1000 + 100, completed: T0 + n * 1000 + 900 } } as Message["info"], parts: [...parts(id), { id: `prt_${id}_t`, sessionID: session, messageID: id, type: "text", text: `said ${n}` } as Part] };
};
const spawn = (child: string) => ({ child_session_id: child, agents: [{ name: child, id: child }] });
const TRANSCRIPTS: Record<string, Message[]> = {
  [PARENT]: [user("ses_parent", 0), assistant("ses_parent", 0, (m) => [tool("ses_parent", m, 1, "spawn", spawn("ses_child")), tool("ses_parent", m, 2, "spawn", spawn("ses_gone"))])],
  [CHILD]: [user("ses_child", 0), assistant("ses_child", 0, (m) => [tool("ses_child", m, 1, "read"), tool("ses_child", m, 2, "read"), tool("ses_child", m, 3, "edit")])],
  // archived: the fleet no longer has it, so its cost is read from its messages
  [GONE]: [user("ses_gone", 0), assistant("ses_gone", 0, (m) => [tool("ses_gone", m, 1, "read")], 0.25)],
};
const snapshot: FleetSnapshot = { hosts: [], sessions: [entry(PARENT), entry(CHILD, "ses_parent")], asks: [], order: [PARENT, CHILD] };

/* the client's verbs go to the worker in this process, as client.ts posts them to the real one */
let sync: Sync | null = null;
const route = (action: (s: Sync) => unknown) => void (sync ? action(sync) : undefined);
if (reactive) {
  const real = await import("../../sync/client");
  mock.module("../../sync/client", () => ({
    ...real,
    showThread: (key: string) => route((s) => s.show(key)),
    hideThread: (key: string) => route((s) => s.hide(key)),
    holdThread: (key: string) => route((s) => s.hold(key)),
    releaseThread: (key: string) => route((s) => s.release(key)),
  }));
}

type Store = typeof import("../../store");
type Live = typeof import("./live");
type Details = typeof import("./details-model");
type Worker = typeof import("../../sync/worker");
type Protocol = typeof import("../../sync/protocol");
const at = (path: string): string => path;
const store = reactive ? ((await import(at("../../store"))) as Store) : ({} as Store);
const live = reactive ? ((await import(at("./live"))) as Live) : ({} as Live);
const details = reactive ? ((await import(at("./details-model"))) as Details) : ({} as Details);
const workerModule = reactive ? ((await import(at("../../sync/worker"))) as Worker) : ({} as Worker);
const protocol = reactive ? ((await import(at("../../sync/protocol"))) as Protocol) : ({} as Protocol);

const saved = { fetch: globalThis.fetch, postMessage: (globalThis as Record<string, unknown>)["postMessage"] };
afterAll(() => {
  sync?.stop();
  globalThis.fetch = saved.fetch;
  (globalThis as Record<string, unknown>)["postMessage"] = saved.postMessage;
});

async function until(what: string, ok: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`waited for ${what}`);
    await Bun.sleep(2);
  }
}

describe.skipIf(!reactive)("a released child in the details panel's agents list", () => {
  test("reads as it did while held for as long as its parent is drawn, and leaves the store when the parent leaves", async () => {
    let clock = T0;
    let push: (frame: unknown, id?: string) => void = () => {};
    const encoder = new TextEncoder();
    (globalThis as Record<string, unknown>)["postMessage"] = (message: FromWorker) => {
      if (message.type === "patches") store.applyPatches(structuredClone(message.patches));
      else if (message.type === "boot") store.bootSync(structuredClone(message.sync));
      else if (message.type === "stream") store.setStream(message.stream);
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/stream")) {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
        init?.signal?.addEventListener("abort", () => controller?.error(new DOMException("aborted", "AbortError")), { once: true });
        push = (frame, id) => controller?.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(frame)}\n\n`));
        return new Response(body, { status: 200 });
      }
      const read = /sessions\/([^/]+)\/messages$/.exec(url);
      if (read) return new Response(JSON.stringify(TRANSCRIPTS[`${HOST}:${decodeURIComponent(read[1] ?? "")}`] ?? []), { status: 200, headers: { "x-cmx2-seq": "u1:50" } });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const worker = new workerModule.Sync("device", "mac", false, undefined, () => clock);
    sync = worker;
    await worker.boot(null);
    push({ type: "hello", epoch: "j1", head: 1, build: "test", protocol: protocol.PROTOCOL });
    push({ type: "reset", epoch: "j1", seq: 1, reason: "none", fleet: snapshot }, "j1:1");
    await until("the fleet", () => store.state.fleet.sessions[CHILD] !== undefined);
    await worker.open(PARENT);

    const view = createRoot((dispose) => ({ data: live.createThreadData(() => PARENT, () => "rows"), dispose }));
    const panel = () => {
      const data = view.data;
      const roster = details.rosterOf(data.turns(), data.children());
      return JSON.stringify({
        agents: roster.map((a: AgentRow) => [a.id, details.agentState(a), a.child.steps, a.child.ms, a.child.held]),
        kin: data.kin().map((k: Kin) => [k.id, k.cost, k.gone]),
      });
    };
    await until("the parent", () => view.data.turns().length > 0);
    // both children's rows come within a screen of the view: the lane holds them and they are read
    view.data.seen("ses_child", 100);
    view.data.seen("ses_gone", 300);
    const unwrapped = () => unwrap(store.state.threads) as Record<string, unknown>;
    await until("both children held", () => unwrapped()[CHILD] !== undefined && unwrapped()[GONE] !== undefined && view.data.children().get("ses_child")?.held === true && view.data.children().get("ses_gone")?.held === true);
    await Bun.sleep(60);
    const heldPanel = panel();
    expect(JSON.parse(heldPanel).agents).toContainEqual(["ses_child", "3 steps", 3, expect.any(Number), true]);
    expect(JSON.parse(heldPanel).kin).toContainEqual(["ses_gone", 0.25, true]);

    // scrolled away: the lane lets go of both, and the parent stays on the stage. main kept them in the store; so does this
    view.data.seen("ses_child", null);
    view.data.seen("ses_gone", null);
    await Bun.sleep(80);
    clock += workerModule.COOL_AFTER_MS + 60_000;
    await worker.sweep();
    await Bun.sleep(80);
    expect(panel()).toBe(heldPanel);
    expect(unwrapped()[CHILD]).toBeDefined();

    // the parent leaves the stage: its children leave the store with it, and memory in time
    view.dispose();
    await until("the store lets them go", () => unwrapped()[CHILD] === undefined && unwrapped()[GONE] === undefined);
    clock += workerModule.COOL_AFTER_MS + 60_000;
    await worker.sweep();
    const state = (worker as unknown as { state: { cold: Record<string, unknown> } }).state;
    expect(state.cold[CHILD]).toBeDefined();
    expect(state.cold[GONE]).toBeDefined();
  }, 20_000);
});
