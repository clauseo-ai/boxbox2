/* a press on a window (client.ts, pressThread) shows the thread ahead of the click that may follow; the interest is what the
   person opened (docs/protocol.md, interest), so a press alone posts nothing, and the click's open makes the thread the
   stage and, once covered, a layer */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FakeServer, fakeServer } from "./fixtures/server";
import { snapshot, thread } from "./fixtures/neutral";
import type { Message } from "./protocol";
import type { SyncState } from "./reducer";
import { Sync } from "./worker";

const A = "bench:ses_a",
  B = "bench:ses_b",
  C = "bench:ses_c";
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
const settled = () => state().interest.posts.length === 0;
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

async function started(): Promise<Sync> {
  const s = new Sync("device", "mac");
  sync = s;
  await s.boot(null);
  await until("dial", () => server.dials.length === 1);
  server.head = 5;
  server.hello();
  server.push({ type: "reset", seq: 5, epoch: "j1", reason: "none", fleet: snapshot([thread(A), thread(B), thread(C)]) }, "j1:5");
  await until("reset", () => state().cursor?.seq === 5);
  return s;
}

test("a press on the window of a thread opened before, with no click after, posts no interest", async () => {
  const s = await started();
  await s.open(A);
  s.show(A);
  await until("A", () => settled() && state().threads[A]?.status === "live");
  // back home: the stage closes
  s.hide(A);
  await until("home", () => settled());
  const before = server.posts.length;
  // a mouse press on A's window: shown with press, then no click, hidden with press
  s.show(A, true);
  await Bun.sleep(30);
  s.hide(A, true);
  await Bun.sleep(30);
  expect(server.posts.length - before).toBe(0);
});

test("a press the click follows is the stage, and a layer once another thread opens over it", async () => {
  const s = await started();
  s.show(A, true);
  await s.open(A);
  await until("A on stage", () => settled() && state().interest.confirmed.thread === A && state().threads[A]?.status === "live");
  await s.open(B);
  s.show(B);
  await until("B over A", () => settled() && state().interest.confirmed.thread === B);
  expect(server.posts.at(-1)?.body).toMatchObject({ thread: B, under: [A] });
});
