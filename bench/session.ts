/* the scripted session (docs/verification.md), driven against the cmx2 dev
   daemon that `just cmx2` runs. it talks to the daemon directly, the way a
   person's other client would, while boxbox watches the same daemon.

     1. a prompt that calls tools: a read, an edit, a shell command
     2. a question the agent asks, which the bench answers
     3. while the agent waits on it: two prompts queued, the second unsent
     4. the answer; the reply streams; run now (abort, then the queue runs)
     5. a long reply, aborted mid-stream

   `--words N` instead streams one reply of N words (N delta events), for
   the memory run.

   it prints each step and, at the end, the events it saw by type. the
   daemon's url and password come from .cmx2/bench/ (written by
   scripts/cmx2.ts). */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = join(ROOT, ".cmx2", "bench");
const daemon = JSON.parse(readFileSync(join(BENCH, "daemon.json"), "utf8")) as { url: string };
const password = readFileSync(join(BENCH, "password"), "utf8").trim();
const auth = `Basic ${Buffer.from(`cmx2:${password}`).toString("base64")}`;

type Payload = { id: string; type: string; properties: Record<string, unknown> };

const seen = new Map<string, number>();
const waiters: { match: (p: Payload) => boolean; resolve: (p: Payload) => void }[] = [];
const started = performance.now();

function log(line: string) {
  console.log(`[${((performance.now() - started) / 1000).toFixed(2).padStart(6)}s] ${line}`);
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  log(`${method} ${path} -> ${res.status} ${text.slice(0, 160)}`);
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return text.length > 0 ? JSON.parse(text) : null;
}

function next(match: (p: Payload) => boolean, what: string, timeoutMs = 20_000): Promise<Payload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${what} within ${timeoutMs} ms`)), timeoutMs);
    waiters.push({
      match,
      resolve: (p) => {
        clearTimeout(timer);
        resolve(p);
      },
    });
  });
}

/** reads the daemon's /global/event for the whole run */
async function watch(signal: AbortSignal) {
  const res = await fetch(`${daemon.url}/global/event`, { headers: { authorization: auth }, signal });
  if (!res.body) throw new Error("no event stream");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const payload = (JSON.parse(data) as { payload: Payload }).payload;
      seen.set(payload.type, (seen.get(payload.type) ?? 0) + 1);
      for (const [i, w] of waiters.entries()) {
        if (w.match(payload)) {
          waiters.splice(i, 1);
          w.resolve(payload);
          break;
        }
      }
    }
  }
}

const forSession = (id: string) => (p: Payload) => p.properties.sessionID === id;
/** a turn ends in `session.idle` when it finishes, and in a `session.status`
    of type idle when it is aborted */
const idleOf = (id: string) => (p: Payload) =>
  forSession(id)(p) &&
  (p.type === "session.idle" ||
    (p.type === "session.status" && (p.properties.status as { type?: string } | undefined)?.type === "idle"));

/* every wait is armed before the call that causes it: the daemon answers
   fast enough that an event can arrive before the http reply does */
async function scripted(session: string) {
  log("1. a prompt that calls tools");
  const asked = next((p) => p.type === "question.asked" && forSession(session)(p), "question.asked");
  await call("POST", `/session/${session}/prompt`, { text: "[bench:tools] set the greeting in notes.md" });

  log("2. the agent asks a question");
  const question = (await asked).properties as { id: string };

  log("3. two prompts queued while it waits; the second unsent");
  await call("POST", `/session/${session}/prompt`, { text: "[bench:words 30 20] queued: add a closing line" });
  const second = (await call("POST", `/session/${session}/prompt`, {
    text: "[bench:words 30 20] queued: this one is taken back",
  })) as { queued?: string };
  if (!second.queued) throw new Error("the second prompt was not queued");
  await call("DELETE", `/session/${session}/message/${second.queued}`);

  log("4. the answer; the reply streams; run now");
  const replying = next((p) => p.type === "message.part.delta" && forSession(session)(p), "the reply's first delta");
  await call("POST", `/question/${question.id}/reply`, { answers: [["hi"]] });
  await replying;
  await call("POST", `/session/${session}/abort`);
  const queuedRan = next(idleOf(session), "idle after the queued prompt ran", 30_000);
  await call("POST", `/session/${session}/loop`);
  await queuedRan;

  log("5. a long reply, aborted mid-stream");
  let deltas = 0;
  const streaming = next(
    (p) => p.type === "message.part.delta" && forSession(session)(p) && ++deltas >= 20,
    "twenty streamed deltas",
  );
  await call("POST", `/session/${session}/prompt`, { text: "[bench:words 400 20] a long answer to abort" });
  await streaming;
  const stopped = next(idleOf(session), "idle after the abort");
  await call("POST", `/session/${session}/abort`);
  await stopped;
}

async function words(session: string, count: number) {
  log(`one reply of ${count} words`);
  const finished = next(idleOf(session), "idle after the long reply", 120_000);
  await call("POST", `/session/${session}/prompt`, { text: `[bench:words ${count} 2] the memory run` });
  await finished;
}

const controller = new AbortController();
const connected = next((p) => p.type === "server.connected", "server.connected");
const watching = watch(controller.signal).catch((e: unknown) => {
  if (!controller.signal.aborted) throw e;
});
await connected;
const nonce = Math.random().toString(36).slice(2, 8);
const session = ((await call("POST", "/session", { title: `bench ${nonce}` })) as { id: string }).id;
const wordsAt = process.argv.indexOf("--words");
try {
  if (wordsAt >= 0) await words(session, Number(process.argv[wordsAt + 1] ?? 1000));
  else await scripted(session);
  await Bun.sleep(500);
} finally {
  controller.abort();
  await watching;
}
const total = [...seen.values()].reduce((a, b) => a + b, 0);
log(`done: session ${session}, ${total} events seen by the driver`);
for (const [type, n] of [...seen.entries()].sort()) console.log(`  ${String(n).padStart(5)}  ${type}`);
