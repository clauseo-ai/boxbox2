/* a child a lane let go of reads in the details panel's agents list as it did while it was held (docs/architecture.md, the worker to
   the ui): while its parent is drawn, a released child that was read leaves the store and cools in the worker, and its step count,
   its report state and, for an archived child, its cost are what the layer kept of it at the release (live.ts, `kept`); held again,
   it reads its own thread again. the real worker runs in this process with its cache on
   fake-indexeddb, against the fake protocol 3 server (sync/fixtures/server.ts), and the sync client's verbs are routed to it,
   so live.ts, the holds and the worker's filter are the app's own. the transcripts are cmx2's messages made neutral
   (sync/fixtures/neutral.ts). solid's browser build only (`bun test --conditions browser`, the justfile's check). */

import "fake-indexeddb/auto";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import { neutralMessage, thread } from "../../sync/fixtures/neutral";
import { type FakeServer, fakeServer } from "../../sync/fixtures/server";
import type { FromWorker } from "../../sync/messages";
import type { FleetSnapshot, Message, Thread } from "../../sync/protocol";
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

/** a cmx2 part or message as the daemon wrote it: the fixtures are made neutral the way translate.rs makes them */
type Raw = Record<string, unknown>;
const threadOf = (key: string, parent?: string): Thread => thread(key, { title: key, created: T0, updated: T0 + 9_000, cost: 0.5, ...(parent ? { parent } : {}) });
const user = (session: string, n: number): Message =>
  neutralMessage({ info: { id: `msg_${session}_u${n}`, sessionID: session, role: "user", time: { created: T0 + n * 1000 } }, parts: [{ id: `prt_${session}_u${n}`, sessionID: session, messageID: `msg_${session}_u${n}`, type: "text", text: `ask ${n}` }] });
const tool = (session: string, message: string, n: number, name: string, metadata: Raw = {}): Raw => ({
  id: `prt_${message}_${n}`,
  sessionID: session,
  messageID: message,
  type: "tool",
  callID: `call_${message}_${n}`,
  tool: name,
  state: { status: "completed", input: { filePath: `/w/f${n}.ts`, brief: "do it" }, output: "x", metadata, time: { start: T0 + n, end: T0 + n + 10 } },
});
const assistant = (session: string, n: number, parts: (id: string) => Raw[], cost = 0): Message => {
  const id = `msg_${session}_a${n}`;
  return neutralMessage({
    info: { id, sessionID: session, role: "assistant", cost, time: { created: T0 + n * 1000 + 100, completed: T0 + n * 1000 + 900 } },
    parts: [...parts(id), { id: `prt_${id}_t`, sessionID: session, messageID: id, type: "text", text: `said ${n}` }],
  });
};
const spawn = (child: string) => ({ child_session_id: child, agents: [{ name: child, id: child }] });
const TRANSCRIPTS: Record<string, Message[]> = {
  [PARENT]: [user("ses_parent", 0), assistant("ses_parent", 0, (m) => [tool("ses_parent", m, 1, "spawn", spawn("ses_child")), tool("ses_parent", m, 2, "spawn", spawn("ses_gone"))])],
  [CHILD]: [user("ses_child", 0), assistant("ses_child", 0, (m) => [tool("ses_child", m, 1, "read"), tool("ses_child", m, 2, "read"), tool("ses_child", m, 3, "edit")])],
  // archived: the fleet no longer has it, so its cost is read from its messages
  [GONE]: [user("ses_gone", 0), assistant("ses_gone", 0, (m) => [tool("ses_gone", m, 1, "read")], 0.25)],
};
const snapshot: FleetSnapshot = { agents: [], threads: [threadOf(PARENT), threadOf(CHILD, "ses_parent")], asks: [], order: [PARENT, CHILD] };

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
const at = (path: string): string => path;
const store = reactive ? ((await import(at("../../store"))) as Store) : ({} as Store);
const live = reactive ? ((await import(at("./live"))) as Live) : ({} as Live);
const details = reactive ? ((await import(at("./details-model"))) as Details) : ({} as Details);
const workerModule = reactive ? ((await import(at("../../sync/worker"))) as Worker) : ({} as Worker);

const savedPost = (globalThis as Record<string, unknown>)["postMessage"];
let server: FakeServer | null = null;
afterAll(() => {
  sync?.stop();
  server?.restore();
  (globalThis as Record<string, unknown>)["postMessage"] = savedPost;
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
    (globalThis as Record<string, unknown>)["postMessage"] = (message: FromWorker) => {
      if (message.type === "patches") store.applyPatches(structuredClone(message.patches));
      else if (message.type === "boot") store.bootSync(structuredClone(message.sync));
      else if (message.type === "stream") store.setStream(message.stream);
    };
    server = fakeServer();
    const fake = server;
    fake.transcript = (key) => TRANSCRIPTS[key] ?? [];

    const worker = new workerModule.Sync("device", "mac", false, undefined, () => clock);
    sync = worker;
    await worker.boot(null);
    fake.hello();
    fake.push({ type: "reset", epoch: fake.epoch, seq: 1, reason: "none", fleet: snapshot }, `${fake.epoch}:1`);
    await until("the fleet", () => store.state.fleet.threads[CHILD] !== undefined);
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

    // scrolled away: the lane lets go of both, and the parent stays on the stage. the panel reads as it did while they were held, from
    // what the layer kept of them, while their transcripts leave the store and cool in the worker
    view.data.seen("ses_child", null);
    view.data.seen("ses_gone", null);
    await until("the store lets the released children go", () => unwrapped()[CHILD] === undefined && unwrapped()[GONE] === undefined);
    await Bun.sleep(80);
    expect(panel()).toBe(heldPanel);
    clock += workerModule.COOL_AFTER_MS + 60_000;
    await worker.sweep();
    await Bun.sleep(80);
    expect(panel()).toBe(heldPanel);
    const cooled = (worker as unknown as { state: { cold: Record<string, unknown> } }).state;
    expect(cooled.cold[CHILD]).toBeDefined();
    expect(cooled.cold[GONE]).toBeDefined();

    // held again (its row back on screen): it is read again, and reads the same
    view.data.seen("ses_child", 100);
    await until("the child held again", () => unwrapped()[CHILD] !== undefined && view.data.children().get("ses_child")?.held === true);
    await Bun.sleep(60);
    expect(JSON.parse(panel()).agents).toEqual(JSON.parse(heldPanel).agents);
    view.data.seen("ses_child", null);
    await until("let go again", () => unwrapped()[CHILD] === undefined);
    expect(panel()).toBe(heldPanel);

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
