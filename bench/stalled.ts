/* the stalled reader (docs/verification.md, m2): a client that opens
   boxbox's stream and stops reading while the fleet streams. the server
   must close it at the 512 kb outbound cap, its rss must stay flat, and
   the client must resume cleanly from the last id it had read.

     bun bench/stalled.ts [--minutes 10] [--load]

   it signs in to the boxbox server on 3001 (BOXBOX_PORT moves it) with the bench gate password,
   opens GET /api/stream on a raw socket and never reads. every 10 s it
   prints the server's rss (from ps, by the pid listening on 3001). with
   --load it adds one bulk burst through the dev daemon at the start, so
   the bytes owed to the stalled socket pass every buffer between the
   server and it at once; more would push the journal past its 16 mb cap
   within the run, and the resume would rightly be a reset rather than a
   replay. at the end it
   reads what the socket holds, checks the stream had been closed, and
   reconnects with Last-Event-ID from the last id it received: the first
   entry after hello must be the next seq, not a reset. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = join(ROOT, ".cmx2", "bench");
const PORT = Number(process.env.BOXBOX_PORT ?? 3001);
const minutesAt = process.argv.indexOf("--minutes");
const MINUTES = minutesAt >= 0 ? Number(process.argv[minutesAt + 1]) : 10;
const LOAD = process.argv.includes("--load");
const started = performance.now();

function log(line: string) {
  console.log(`[${((performance.now() - started) / 1000).toFixed(0).padStart(4)}s] stalled: ${line}`);
}

function serverRssKb(): number {
  const pid = spawnSync("lsof", ["-t", "-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
  if (!pid) return 0;
  return Number(spawnSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).stdout.trim()) || 0;
}

async function signIn(): Promise<string> {
  const password = readFileSync(join(BENCH, "gate-password"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!res.ok || !cookie) throw new Error(`sign in answered ${res.status}`);
  return cookie;
}

function openRaw(cookie: string, lastEventId?: string): Promise<Socket> {
  return new Promise((ok, fail) => {
    const socket = connect({ host: "127.0.0.1", port: PORT }, () => {
      const cursor = lastEventId ? `Last-Event-ID: ${lastEventId}\r\n` : "";
      socket.write(`GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nCookie: ${cookie}\r\nAccept: text/event-stream\r\n${cursor}\r\n`);
      ok(socket);
    });
    socket.once("error", fail);
  });
}

/** the daemon, driven directly the way bench/session.ts does, to keep the fleet streaming */
async function load(stop: AbortSignal) {
  const daemon = JSON.parse(readFileSync(join(BENCH, "daemon.json"), "utf8")) as { url: string };
  const auth = `Basic ${Buffer.from(`cmx2:${readFileSync(join(BENCH, "password"), "utf8").trim()}`).toString("base64")}`;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${daemon.url}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const session = (await (await call("POST", "/session", { title: "stalled reader load" })).json()) as { id: string };
  if (stop.aborted) return;
  await call("POST", `/session/${session.id}/prompt_async`, { text: "[bench:bulk 2000 200] stalled load" });
  log(`load: one burst of 2000 x 200 bytes in ${session.id}`);
}

const cookie = await signIn();
const socket = await openRaw(cookie);
socket.pause();
let closedAt: number | null = null;
socket.once("close", () => {
  closedAt = performance.now();
});
log(`opened GET /api/stream and stopped reading; server rss ${serverRssKb()} kb`);
const stopLoad = new AbortController();
const loading = LOAD ? load(stopLoad.signal) : Promise.resolve();

const samples: number[] = [];
const deadline = started + MINUTES * 60_000;
while (performance.now() < deadline) {
  await Bun.sleep(10_000);
  const rss = serverRssKb();
  samples.push(rss);
  log(`server rss ${rss} kb`);
}
stopLoad.abort();
await loading;

let received = "";
socket.on("data", (chunk: Buffer) => {
  received += chunk.toString("utf8");
});
socket.resume();
await new Promise<void>((done) => {
  if (socket.destroyed) return done();
  const timer = setTimeout(done, 5000);
  socket.once("close", () => {
    clearTimeout(timer);
    done();
  });
});
const ids = [...received.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]);
const last = ids.at(-1);
const min = Math.min(...samples);
const max = Math.max(...samples);
log(`read ${(received.length / 1024).toFixed(0)} kb that had been queued for it, ${ids.length} entries, last id ${last ?? "none"}`);
log(`the server closed the stream: ${closedAt !== null || socket.destroyed ? "yes" : "no"}`);
log(`server rss over ${samples.length} samples: min ${min} kb, max ${max} kb, spread ${max - min} kb`);

if (last) {
  const again = await openRaw(cookie, last);
  let text = "";
  again.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  await Bun.sleep(1500);
  again.destroy();
  const frames = text.split("\n\n").filter((f) => f.includes("data: "));
  const bodies = frames.map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6).split("\n")[0] ?? "{}") as { type?: string; seq?: number });
  const [hello, first] = bodies;
  const expected = Number(last.split(":")[1]) + 1;
  log(`resumed with Last-Event-ID ${last}: ${hello?.type}, then ${first?.type} seq ${first?.seq} (expected seq ${expected}, not a reset)`);
  log(first?.type !== "reset" && first?.seq === expected ? "resume: clean" : "resume: NOT clean");
}
socket.destroy();
process.exit(0);
