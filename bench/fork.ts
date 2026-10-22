/* the fork verb end to end (docs/thread.md, fork), against the dev daemon and the dev server the caller started:

     bun scripts/cmx2.ts &   bun scripts/dev.ts &   bun bench/fork.ts

   it never starts or stops anything. through the daemon, as another client would, it makes a thread of two short turns
   (the bench model's scripted words); through boxbox it forks that thread at its second turn and whole, and checks:

     1. the route answers 201 with the new thread's key, on the thread's own agent
     2. the daemon's new session holds the history up to the cut, and says where it came from (forkedFrom)
     3. the fleet carries the new thread with forkedFrom {thread, message} and no parent (a fork is not an agent)
     4. a whole fork carries forkedFrom with no message
     5. a cut the thread does not hold is 404 no-such-turn, a thread the agent does not have 404 no-such-session, an
        agent no source publishes 404 no-such-agent, and a body with a field no fork takes 4xx, none reaching the daemon

   BOXBOX_PORT moves the server (3001); BENCH_DIR the bench dir (.cmx2/bench: daemon.json, password,
   gate-password). exits 1 on the first check that fails. */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = process.env.BENCH_DIR ?? join(ROOT, ".cmx2", "bench");
const BOXBOX = `http://127.0.0.1:${process.env.BOXBOX_PORT ?? 3001}`;
const daemon = JSON.parse(readFileSync(join(BENCH, "daemon.json"), "utf8")) as { url: string };
const auth = `Basic ${Buffer.from(`cmx2:${readFileSync(join(BENCH, "password"), "utf8").trim()}`).toString("base64")}`;
const AGENT = "bench";
const started = performance.now();
let failed = false;

function log(line: string) {
  console.log(`[${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`);
}

function check(what: string, ok: boolean, detail = "") {
  log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
}

async function until(what: string, test: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await test()) return;
    await Bun.sleep(200);
  }
  throw new Error(`${what}: not within ${timeoutMs / 1000} s`);
}

async function toDaemon(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${daemon.url}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const gate = readFileSync(join(BENCH, "gate-password"), "utf8").trim();
const login = await fetch(`${BOXBOX}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: gate }) });
if (!login.ok) {
  console.log(`fork: boxbox at ${BOXBOX} did not sign in (${login.status})`);
  process.exit(1);
}
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function toBoxbox(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BOXBOX}${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  // axum answers a body it cannot read in plain words, not json
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { text };
  }
  return { status: res.status, json };
}

type Message = { info: { id: string; role: string } };
const messagesOf = async (session: string): Promise<Message[]> => (await (await toDaemon("GET", `/session/${session}/message`)).json()) as Message[];
const idle = async (session: string): Promise<boolean> => {
  const status = (await (await toDaemon("GET", "/session/status?parked=true")).json()) as Record<string, { type?: string }>;
  return status[session] === undefined || status[session]?.type === "idle";
};
type FleetThread = { key: string; parent?: string; forkedFrom?: { thread: string; message?: string } };
const fleetThread = async (key: string): Promise<FleetThread | undefined> => {
  const fleet = (await toBoxbox("GET", "/api/fleet")).json as { threads: FleetThread[] | Record<string, FleetThread> };
  const threads = Array.isArray(fleet.threads) ? fleet.threads : Object.values(fleet.threads);
  return threads.find((t) => t.key === key);
};
const device = { device: "bench-fork", deviceClass: "mac" };
const fork = (thread: string, extra: Record<string, unknown> = {}) => toBoxbox("POST", `/api/agents/${AGENT}/threads/${thread}/fork`, { ...device, clientID: crypto.randomUUID(), ...extra });

/* —— a thread of two turns —— */
const made = (await (await toDaemon("POST", "/session", { title: "fork bench" })).json()) as { id: string };
const source = made.id;
log(`made ${AGENT}:${source}`);
for (const words of [12, 9]) {
  const sent = await toDaemon("POST", `/session/${source}/prompt_async`, { text: `[bench:words ${words} 5] turn of ${words} words` });
  if (sent.status !== 202) throw new Error(`prompt_async answered ${sent.status}`);
  await Bun.sleep(300);
  await until("the turn ends", () => idle(source));
}
const history = await messagesOf(source);
const prompts = history.filter((m) => m.info.role === "user").map((m) => m.info.id);
check("the thread holds two turns", prompts.length === 2, `${history.length} messages, prompts ${prompts.join(", ")}`);
await until("the fleet holds the thread", async () => (await fleetThread(`${AGENT}:${source}`)) !== undefined);

/* —— 1 to 3: fork through the first turn, cut before the second turn's prompt —— */
const cut = prompts[1] as string;
const atTurn = await fork(source, { before: cut });
check("the route answers 201 with the new thread", atTurn.status === 201 && typeof atTurn.json["key"] === "string", JSON.stringify(atTurn.json));
const forkedKey = String(atTurn.json["key"]);
const forkedId = String(atTurn.json["thread"]);
check("the new thread is on the thread's own agent", forkedKey === `${AGENT}:${forkedId}`, forkedKey);
const info = (await (await toDaemon("GET", `/session/${forkedId}`)).json()) as { title: string; forkedFrom?: { sessionID: string; messageID?: string }; parentID?: string };
check("the daemon's new session says where it came from", info.forkedFrom?.sessionID === source && info.forkedFrom.messageID === cut, JSON.stringify(info.forkedFrom));
const held = await messagesOf(forkedId);
const upTo = history.findIndex((m) => m.info.id === cut);
check("the fork holds the history up to, not including, the cut", held.length === upTo, `${held.length} of ${history.length}, cut at ${upTo}`);
await until("the fleet holds the fork", async () => (await fleetThread(forkedKey)) !== undefined, 10_000);
const inFleet = await fleetThread(forkedKey);
check("the fleet carries forkedFrom with the cut", inFleet?.forkedFrom?.thread === source && inFleet.forkedFrom.message === cut, JSON.stringify(inFleet?.forkedFrom));
check("a fork is not an agent of its source", inFleet?.parent === undefined, String(inFleet?.parent));

/* —— 4: the whole thread —— */
const whole = await fork(source);
check("a whole fork answers 201", whole.status === 201, JSON.stringify(whole.json));
const wholeKey = String(whole.json["key"]);
await until("the fleet holds the whole fork", async () => (await fleetThread(wholeKey)) !== undefined, 10_000);
const wholeThread = await fleetThread(wholeKey);
check("a whole fork carries forkedFrom with no message", wholeThread?.forkedFrom?.thread === source && wholeThread.forkedFrom.message === undefined, JSON.stringify(wholeThread?.forkedFrom));
check("a whole fork holds every message", (await messagesOf(String(whole.json["thread"]))).length === history.length);

/* —— 5: refusals —— */
const noTurn = await fork(source, { before: "msg_notathing" });
check("a cut the thread does not hold is 404 no-such-turn", noTurn.status === 404 && (noTurn.json["error"] as { code?: string } | undefined)?.code === "no-such-turn", JSON.stringify(noTurn.json));
const noThread = await fork("ses_notathing");
check("a thread the agent does not have is 404 no-such-session", noThread.status === 404 && (noThread.json["error"] as { code?: string } | undefined)?.code === "no-such-session", JSON.stringify(noThread.json));
const noAgent = await toBoxbox("POST", `/api/agents/nobody/threads/${source}/fork`, { ...device, clientID: crypto.randomUUID() });
check("an agent no source publishes is 404 no-such-agent", noAgent.status === 404, JSON.stringify(noAgent.json));
const odd = await fork(source, { at: 2 });
check("a field no fork takes is refused", odd.status >= 400 && odd.status < 500, String(odd.status));

/* the bench's threads are archived, so the dev fleet does not fill with them */
for (const id of [source, forkedId, String(whole.json["thread"])]) await toDaemon("PATCH", `/session/${id}`, { time: { archived: Date.now() } });
log(failed ? "fork: FAILED" : "fork: every check passed");
process.exit(failed ? 1 : 0);
