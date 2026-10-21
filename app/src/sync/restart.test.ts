/* a server that restarts and loses its journal (a new epoch, a head from 0) while a read is out: the read lands between the
   drop and the next hello, stamped with the new epoch, and is never weighed against an H of the old one (docs/protocol.md,
   no gap at a switch) */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FakeServer, fakeServer } from "./fixtures/server";
import { snapshot, thread } from "./fixtures/neutral";
import type { Message } from "./protocol";
import type { SyncState } from "./reducer";
import { Sync } from "./worker";

const A = "bench:ses_a",
  B = "bench:ses_b";
const message = (id: string): Message => ({ info: { id, role: "assistant", created: 1 }, parts: [{ type: "text", id: `prt_${id}`, messageID: id, text: `words of ${id}` }] });
let server: FakeServer;
let sync: Sync | null = null;
const scope = globalThis as unknown as Record<string, unknown>;
// the worker runs with no cache here; what the file found is put back for the files that run after it
const found = { indexedDB: scope["indexedDB"], postMessage: scope["postMessage"] };
async function until(what: string, ok: () => boolean, ms = 3_000) {
  const s = Date.now();
  while (!ok()) {
    if (Date.now() - s > ms) throw new Error(`waited for ${what}`);
    await Bun.sleep(2);
  }
}
const state = (): SyncState => (sync as unknown as { state: SyncState }).state;
beforeEach(() => {
  scope["indexedDB"] = undefined;
  scope["postMessage"] = () => {};
  server = fakeServer();
  server.transcript = (key) => [message(`msg_${key.slice(10)}_1`)];
});
afterEach(() => {
  sync?.stop();
  sync = null;
  server.restore();
  scope["indexedDB"] = found.indexedDB;
  scope["postMessage"] = found.postMessage;
});

/** A open at H 500 with its read held, the stream dropped and dialled again with no hello yet, and the server restarted as
    epoch j2 at head 3; then the read is let go */
async function restartedDuringRead(): Promise<Sync> {
  const inner = globalThis.fetch;
  let gate: (() => void) | null = null;
  let blockNext = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (blockNext && String(input).includes("/threads/ses_a/messages")) {
      blockNext = false;
      await new Promise<void>((r) => (gate = r));
    }
    await new Promise((r) => setTimeout(r, 2));
    return inner(input, init);
  }) as typeof fetch;
  const s = new Sync("device", "mac");
  sync = s;
  await s.boot(null);
  await until("dial", () => server.dials.length === 1);
  server.head = 5;
  server.hello();
  server.push({ type: "reset", seq: 5, epoch: "j1", reason: "none", fleet: snapshot([thread(A), thread(B)]) }, "j1:5");
  await until("reset", () => state().cursor?.seq === 5);
  server.push({ seq: 500, type: "thread.patch", key: B, set: { updated: 3 } }, "j1:500");
  await until("500", () => state().cursor?.seq === 500);
  blockNext = true;
  await s.open(A);
  s.show(A);
  await until("read out", () => gate !== null);
  expect(state().interest.entered[A]).toBe(500);
  // the server restarts: the stream drops and dials again, no hello yet; the new journal starts over
  await s.pause();
  s.resume();
  await until("redial", () => server.dials.length === 2);
  server.epoch = "j2";
  server.head = 3;
  (gate as unknown as () => void)();
  return s;
}

test("a read answered by a restarted server (new epoch, low head) before the new hello is not taken again in a loop", async () => {
  await restartedDuringRead();
  const before = server.reads.length;
  await Bun.sleep(200);
  expect(server.reads.length - before).toBeLessThan(5);
  expect(server.rows.filter((row) => row.kind === "sync.fault").length).toBe(0);
  // its messages show, and it keeps the `left` the drop gave it: the next connect still says where it was
  expect(state().threads[A]?.status).toBe("live");
  expect(state().threads[A]?.left).toBe(500);
});

test("the new server's hello and reset read the thread again, once", async () => {
  await restartedDuringRead();
  await until("landed", () => state().threads[A]?.status === "live");
  const before = server.reads.length;
  server.hello({ thread: A, under: [], holds: [] });
  server.push({ type: "reset", seq: 3, epoch: "j2", reason: "epoch", fleet: snapshot([thread(A), thread(B)]) }, "j2:3");
  await until("read again", () => server.reads.length > before && state().threads[A]?.status === "live");
  await Bun.sleep(50);
  expect(server.reads.length - before).toBe(1);
  expect(state().threads[A]?.left).toBeUndefined();
});
