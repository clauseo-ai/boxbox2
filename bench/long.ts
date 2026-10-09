/* the long-thread budget run: what opening a very long thread costs, through
   the real ui against a real cmx2 dev daemon (docs/thread.md, budgets;
   docs/architecture.md, cold launch; docs/design.md, buttery as numbers).

   a real long thread has ~1,400 messages in ~300 turns (about 10 MB)
   and started ~66 agents of 100 to 1,000 messages each. a thread that size
   was unusably slow, and every fix is judged by this run, so it is the same
   run against any checkout:

   1. seed: one thread of `--turns` turns (150) shaped by the bench model's
      `[bench:long K A T]` marker (tool steps, `write` parts of 20 to 60 KB,
      reasoning, long markdown with code fences, a failing read now and then)
      which starts `--agents` agents (60 by default: more than the app's
      thread cap of 40, as a real thread's 66; 36 is under it, so a build that
      holds every agent can still open the thread) of 107 messages each
      through the spawn tool, and one small unrelated thread. seeding is slow
      once (4 to 6 minutes): the daemon's data dir (.cmx2/bench/data) keeps it,
      and a run that finds the thread complete skips this (a half-seeded
      thread is continued, `--reseed` makes a new one). one shape lives in a
      daemon at a time: asking for another archives the first (the daemon
      cannot unarchive), because a second long thread's agents are held by the
      wide layout and would be measured as part of the first.
   2. measure, at 390 and 1512 wide, in a fresh browser each (so its cache
      starts empty), through agent-browser, with a counting proxy in front of
      boxbox (the sync worker's requests are invisible to the page's own
      resource timing):
        boot         the app from an empty cache, then from the warm cache
                     the long thread left behind: perf.launch, first paint
        open         the long thread cold, then cached (a reload, then the tap
                     in the app): perf.thread (a thread already on stage at
                     the tap, as the wide layout leaves it, mounts no stage
                     and has no row: the time to its first rows or report
                     cards stands in), long tasks over 50 ms (count, total),
                     bytes and /messages requests
        small        a small unrelated thread opened after the long one:
                     still cached (its head and pages in indexeddb: boot
                     reads heads only, and a cold thread waits there until it
                     is opened), whether opening it asks for /messages, and
                     its perf.thread, with the cache cold and warm
        dom          elements, turns holding rows, js heap, with the long
                     thread on stage
   3. print one table and exit 1 when a budget check fails. the budgets are
      the docs' (each check says where from) and are never loosened to pass.

   needs the stack of bench/thread.ts, on ports of your own decade:
     just cmx2 --port 4960 --boxbox-port 3061
     BOXBOX_PORT=3061 just dev
     bun bench/long.ts [--boxbox http://127.0.0.1:3061] [--agents 60|36] [--only 390,1512] [--settle 45]
                        [--turns 150] [--seed-only] [--reseed] [--debug]
                        [--telemetry <dir>]
   against another worktree: copy this file and bench/model.ts into it
   (`git checkout perf-bench -- bench/long.ts bench/model.ts`), start its own
   stack on its own ports, and run it there. the daemon must run the bench
   model with the long markers: the seed checks its own shape and stops
   if the thread came out short. `just dev` serves unbundled modules through
   vite, which inflates perf.launch against a production build; `--boxbox`
   at a `just build` binary's port measures that instead. */

import { $ } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const BOXBOX = flag("--boxbox", `http://127.0.0.1:${process.env["BOXBOX_PORT"] ?? "3061"}`);
const TURNS = Number(flag("--turns", "150"));
/** the agents the long thread starts: 60 is over the app's thread cap of 40, as a real thread's 66 are; 36 is under it, so
    a build that holds every agent can still open the thread. one shape lives in the daemon at a time (see `seed`) */
const AGENTS = Number(flag("--agents", "60"));
/** the messages of an agent the bench model starts (`[bench:steps 105]`): a seeded agent holds at least this many */
const CHILD_STEPS = 105;
const ONLY = flag("--only", "390,1512").split(",").map(Number);
const SEED_ONLY = args.includes("--seed-only");
const DEBUG = args.includes("--debug");
/** how long a thread gets to come in before the run calls it never settled */
const SETTLE_MS = Number(flag("--settle", "45")) * 1000;
const RESEED = args.includes("--reseed");
const titleOf = (agents: number) => `long: bench thread, ${agents} agents`;
const SMALL_TITLE = "long: small thread";
/** where the server writes its telemetry rows: the bench config's data dir, unless the server under test runs on another */
const TELEMETRY = flag("--telemetry", join(ROOT, ".cmx2/bench/boxbox-data/telemetry"));

const daemon = JSON.parse(readFileSync(join(ROOT, ".cmx2/bench/daemon.json"), "utf8")) as { url: string };
const daemonPassword = readFileSync(join(ROOT, ".cmx2/bench/password"), "utf8").trim();
const gatePassword = readFileSync(join(ROOT, ".cmx2/bench/gate-password"), "utf8").trim();
const auth = `Basic ${Buffer.from(`cmx2:${daemonPassword}`).toString("base64")}`;

const log = (line = "") => console.log(line);

/* ---------- the daemon ---------- */
async function daemonCall<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T; bytes: number }> {
  const res = await fetch(`${daemon.url}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T, bytes: text.length };
}

type SessionInfo = { id: string; title: string; parentID?: string | null };
type Part = { type: string; text?: string };
type Msg = { info: { id: string; role: string; mail?: unknown }; parts: Part[] };
type Status = Record<string, { type: string }>;

const sessions = async () => (await daemonCall<SessionInfo[]>("GET", "/session")).json;
const messagesOf = async (id: string) => await daemonCall<Msg[]>("GET", `/session/${id}/message`);
const childrenOf = async (id: string) => (await daemonCall<SessionInfo[]>("GET", `/session/${id}/children`)).json;
const busy = async (id: string) => ((await daemonCall<Status>("GET", "/session/status")).json[id]?.type ?? "idle") !== "idle";

/** the turn number K of the newest `[bench:long K]` prompt the thread holds, -1 for none */
function lastTurn(messages: Msg[]): number {
  let last = -1;
  for (const m of messages) {
    if (m.info.role !== "user") continue;
    const k = /\[bench:long (\d+)(?: \d+ \d+)?\]/.exec(m.parts.map((p) => p.text ?? "").join(" "))?.[1];
    if (k !== undefined) last = Number(k);
  }
  return last;
}

async function idle(id: string, ms = 120_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await busy(id))) return true;
    await Bun.sleep(150);
  }
  return false;
}

/** the ordinary turns the thread ends with, and the span before them the agents are spawned over: the bench model's
    `LONG_TAIL`. an agent's report lands in the parent as a turn of its own when the agent ends, so the seeder waits for the
    agents between blocks and the reports sit through the thread, not in a run at its end where nothing real is left to open */
const TAIL = 12;
const spawnSpan = (turns: number) => (turns > 2 * TAIL ? turns - TAIL : turns);
/** a block of turns after which the seeder waits for the agents to report */
const BLOCK = 15;

/** nothing running: the parent and its agents idle for three polls in a row (a report wakes the parent a moment after the agent ends) */
async function quiet(parent: string, ms = 300_000): Promise<boolean> {
  const t0 = Date.now();
  let calm = 0;
  while (Date.now() - t0 < ms) {
    const status = (await daemonCall<Status>("GET", "/session/status")).json;
    const ids = [parent, ...(await childrenOf(parent)).map((c) => c.id)];
    calm = ids.some((id) => (status[id]?.type ?? "idle") !== "idle") ? 0 : calm + 1;
    if (calm >= 3) return true;
    await Bun.sleep(600);
  }
  return false;
}

type Seeded = { parent: string; small: string; turns: number; messages: number; parentBytes: number; bytes: number; children: Array<{ id: string; messages: number }> };

/** reads what the thread holds; null when it is missing or short of the asked shape */
async function inspectSeed(agents: number): Promise<{ seeded: Seeded | null; why: string; parent: string | null; turnsDone: number; stale?: true }> {
  const all = await sessions();
  const parent = all.find((s) => s.title === titleOf(agents) && !s.parentID);
  const small = all.find((s) => s.title === SMALL_TITLE && !s.parentID);
  if (!parent) return { seeded: null, why: "no long thread yet", parent: null, turnsDone: 0 };
  const m = await messagesOf(parent.id);
  const turnsDone = lastTurn(m.json) + 1;
  const kids = await childrenOf(parent.id);
  const counts = await Promise.all(kids.map(async (c) => ({ id: c.id, messages: (await messagesOf(c.id)).json.length })));
  const longKids = counts.filter((c) => c.messages >= CHILD_STEPS);
  const bytes = m.bytes + (await Promise.all(kids.map(async (c) => (await messagesOf(c.id)).bytes))).reduce((a, b) => a + b, 0);
  if (turnsDone < TURNS) return { seeded: null, why: `${turnsDone} of ${TURNS} turns`, parent: parent.id, turnsDone };
  // an older seed left every agent's report at the end: the last turns must be the ordinary ones
  if (TURNS > 2 * TAIL) {
    const first = m.json.findIndex((x) => x.info.role === "user" && new RegExp(`\\[bench:long ${TURNS - TAIL}(?: \\d+ \\d+)?\\]`).test(x.parts.map((p) => p.text ?? "").join(" ")));
    const reports = first < 0 ? 0 : m.json.slice(first).filter((x) => x.info.mail).length;
    if (first < 0 || reports > 0) return { seeded: null, why: `the last ${TAIL} turns hold ${reports} reports (an older seed)`, parent: parent.id, turnsDone, stale: true };
  }
  if (longKids.length < agents) return { seeded: null, why: `${longKids.length} of ${agents} agents hold ${CHILD_STEPS}+ messages`, parent: parent.id, turnsDone };
  if (!small) return { seeded: null, why: "no small thread", parent: parent.id, turnsDone };
  return { seeded: { parent: parent.id, small: small.id, turns: turnsDone, messages: m.json.length, parentBytes: m.bytes, bytes, children: counts }, why: "", parent: parent.id, turnsDone };
}

/** archives threads and their agents (the daemon's DELETE: its listings leave them out, and nothing brings them back) */
async function archiveTree(roots: SessionInfo[]): Promise<void> {
  for (const root of roots) {
    for (const child of await childrenOf(root.id)) await daemonCall("DELETE", `/session/${child.id}`);
    await daemonCall("DELETE", `/session/${root.id}`);
  }
}

async function seed(agents: number): Promise<Seeded> {
  if (RESEED) await archiveTree((await sessions()).filter((x) => !x.parentID && x.title === titleOf(agents)));
  let state = await inspectSeed(agents);
  if (state.stale) {
    log(`seed ${agents}: ${state.why}; seeding it again`);
    await archiveTree((await sessions()).filter((x) => !x.parentID && x.title === titleOf(agents)));
    state = await inspectSeed(agents);
  }
  if (state.seeded) {
    log(`seed ${agents}: the thread is there (${state.seeded.turns} turns, ${state.seeded.messages} messages, ${state.seeded.children.length} agents)`);
    return state.seeded;
  }
  log(`seed ${agents}: ${state.why}; seeding${state.parent ? ` from turn ${state.turnsDone}` : ""}`);
  const parent = state.parent ?? (await daemonCall<{ id: string }>("POST", "/session", { title: titleOf(agents) })).json.id;
  const started = Date.now();
  for (let k = state.turnsDone; k < TURNS; k++) {
    const sent = await daemonCall("POST", `/session/${parent}/prompt_async`, { text: `[bench:long ${k} ${agents} ${TURNS}] turn ${k}: look around, write it down and tell me` });
    if (sent.status !== 202) throw new Error(`prompt ${k} answered ${sent.status}`);
    // the status flips to busy a moment after the 202: a turn is over once it has been seen busy and is idle again
    let seen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const b = await busy(parent);
      if (b) seen = true;
      if (!b && (seen || Date.now() - t0 > 3000)) break;
      await Bun.sleep(100);
    }
    // the agents of this block report now, in the middle of the thread; the last block's before the ordinary turns
    if (k % BLOCK === BLOCK - 1 || k === spawnSpan(TURNS) - 1) await quiet(parent);
    if (k % 10 === 9) log(`seed ${agents}: ${k + 1} of ${TURNS} turns, ${Math.round((Date.now() - started) / 1000)} s`);
  }
  await idle(parent);
  const small = (await sessions()).find((s) => s.title === SMALL_TITLE && !s.parentID)?.id ?? (await daemonCall<{ id: string }>("POST", "/session", { title: SMALL_TITLE })).json.id;
  if ((await messagesOf(small)).json.length === 0) {
    await daemonCall("POST", `/session/${small}/prompt_async`, { text: "[bench:words 40 5] a short note" });
    await Bun.sleep(1500);
    await idle(small);
  }
  // the agents run on after their parent's last turn: wait until every one is done
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    const kids = await childrenOf(parent);
    const working = (await Promise.all(kids.map((c) => busy(c.id)))).filter(Boolean).length;
    if (kids.length >= agents && working === 0) break;
    await Bun.sleep(1000);
  }
  state = await inspectSeed(agents);
  if (!state.seeded) throw new Error(`seeded thread is short: ${state.why} (does the daemon run bench/model.ts with the [bench:long] marker?)`);
  log(`seed ${agents}: done in ${Math.round((Date.now() - started) / 1000)} s`);
  return state.seeded;
}

const mb = (n: number) => (n / 1048576).toFixed(1);
const seeds: Seeded[] = [];
{
  /* a second long thread in the fleet is a second window with its agents: the wide layout mounts every window's thread
     and holds its agents, so the other shape's 60 agents were measured as part of this one's boot. an archived session
     cannot come back (the daemon has no unarchive), so changing the shape means seeding it again */
  for (const other of (await sessions()).filter((s) => !s.parentID && /^long: bench thread, \d+ agents$/.test(s.title) && s.title !== titleOf(AGENTS))) {
    log(`seed: archiving "${other.title}": one shape at a time, so the wide layout does not hold its agents too`);
    await archiveTree([other]);
  }
  const s = await seed(AGENTS);
  seeds.push(s);
  log(`seed ${AGENTS}: ${s.parent}: ${s.turns} turns, ${s.messages} messages, ${mb(s.parentBytes)} MB; ${s.children.length} agents, ${s.children.reduce((a, c) => a + c.messages, 0)} messages; ${mb(s.bytes)} MB of messages in all`);
}
if (SEED_ONLY) process.exit(0);

/* ---------- the counting proxy: every request the page and its sync worker make to boxbox ---------- */
type Hit = { path: string; status: number; bytes: number; at: number; kind: "messages" | "stream" | "api" | "page" };
const hits: Hit[] = [];
const kindOf = (path: string): Hit["kind"] => (/^\/api\/hosts\/[^/]+\/sessions\/[^/]+\/messages$/.test(path) ? "messages" : path === "/api/stream" ? "stream" : path.startsWith("/api/") ? "api" : "page");
const upstream = new URL(BOXBOX);
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("host", upstream.host);
    if (headers.has("origin")) headers.set("origin", upstream.origin);
    let res: Response;
    try {
      res = await fetch(`${upstream.origin}${url.pathname}${url.search}`, { method: req.method, headers, body: req.body, redirect: "manual", decompress: false } as RequestInit);
    } catch (error) {
      // boxbox down or the page gone: an answer the page can show, not an unhandled rejection per request
      return new Response(`the bench proxy could not reach ${upstream.origin}: ${String(error)}\n`, { status: 502 });
    }
    const hit: Hit = { path: url.pathname, status: res.status, bytes: 0, at: Date.now(), kind: kindOf(url.pathname) };
    hits.push(hit);
    if (!res.body) return new Response(null, { status: res.status, headers: res.headers });
    const reader = res.body.getReader();
    // a hand-written pass-through: bun 1.3.14 crashed (bus error) piping megabyte bodies through a TransformStream
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else {
          hit.bytes += value.byteLength;
          controller.enqueue(value);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(counted, { status: res.status, headers: res.headers });
  },
});
const ORIGIN = `http://127.0.0.1:${proxy.port}`;
type Traffic = { messages: number; messageBytes: number; apiBytes: number; streamBytes: number; requests: number };
function traffic(since: number): Traffic {
  const mine = hits.slice(since).filter((h) => h.kind !== "page");
  const sum = (kind: Hit["kind"]) => mine.filter((h) => h.kind === kind).reduce((a, h) => a + h.bytes, 0);
  return { messages: mine.filter((h) => h.kind === "messages").length, messageBytes: sum("messages"), apiBytes: sum("messages") + sum("api"), streamBytes: sum("stream"), requests: mine.length };
}

/* ---------- the browser ---------- */
const session = (await $`agent-browser session id --scope worktree --prefix long`.text()).trim();
const ab = (...a: string[]) => $`agent-browser --session ${session} ${a}`.quiet().nothrow();
async function evaluate<T>(js: string): Promise<T | null> {
  const out = (await ab("eval", js).text()).trim();
  try {
    const once = JSON.parse(out) as unknown;
    return (typeof once === "string" ? JSON.parse(once) : once) as T;
  } catch {
    return null;
  }
}
async function until(what: string, test: () => Promise<boolean>, ms = 15_000, every = 250): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await test()) return true;
    await Bun.sleep(every);
  }
  log(`     waited ${ms} ms for ${what}`);
  return false;
}
async function closeBrowser() {
  await ab("close");
  await Bun.sleep(1500);
}
/** the page's own clock keeps ticking only while it makes frames: a pump keeps a headless tab drawing */
const PUMP = "(() => { if (window.__pumped) return 1; window.__pumped = 1; const pump = () => requestAnimationFrame(pump); requestAnimationFrame(pump); return 1; })()";

/** installed once per page, after it has loaded: long tasks (those from before it was installed are buffered), the first
    row of the thread the mark names (the stage carries its key), and the numbers read at the end */
/** screens either side of the view a painted turn may be in, and the turns at the end that are always mounted: the window's
    design (docs/thread.md, budgets: a turn outside two viewports is one empty box; the live turn and the last few stay) */
const SCREENS = 3;
const LAST_FEW = 4;
const PROBE = `(() => {
  if (window.__probe) return 1;
  const tasks = [];
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  let t0 = performance.now(), firstRow = null, target = '';
  /* a turn the stage has not filled is an empty box with no child; a filled one holds rows, a report card, the person's
     words or an answer, and a thread whose tail is nothing but reports is as painted as one that ends in rows */
  const rowsOf = () => document.querySelector('.thread-stage[data-thread="' + target + '"] section.turn > *');
  new MutationObserver(() => { if (firstRow === null && target && rowsOf()) firstRow = performance.now(); }).observe(document.body, { childList: true, subtree: true });
  /* the dom at its fullest while the thread comes in, read ten times a second in the page: a thread the worker lets go of
     right after it painted would be gone by the time the driver looked */
  let peak = null, sampler = 0, heap = null;
  const sample = () => {
    const stage = '.thread-stage[data-thread="' + target + '"]';
    const turns = [...document.querySelectorAll(stage + ' section.turn')];
    const mem = performance.memory ? performance.memory.usedJSHeapSize : null;
    if (mem !== null) heap = Math.max(heap ?? 0, mem);
    const cur = { elements: document.querySelectorAll('*').length, stageElements: document.querySelectorAll(stage + ' *').length, turns: turns.length, painted: turns.filter((t) => t.firstElementChild).length, turnsWithRows: turns.filter((t) => t.querySelector('.row')).length, rows: document.querySelectorAll(stage + ' .row').length };
    const fuller = !peak || cur.turnsWithRows > peak.turnsWithRows || (cur.turnsWithRows === peak.turnsWithRows && (cur.painted > peak.painted || (cur.painted === peak.painted && cur.elements > peak.elements)));
    if (fuller) peak = cur;
  };
  /* the turns at rest, with where they are: a painted turn is allowed where it is within SCREENS screens of the view or one of
     the last LAST_FEW (always mounted); the geometry is read once, at the end, so that reading it does not move the layout
     while the thread comes in */
  const census = () => {
    const stage = '.thread-stage[data-thread="' + target + '"]';
    const turns = [...document.querySelectorAll(stage + ' section.turn')];
    if (!turns.length) return { turns: 0, painted: 0, allowed: 0, outside: 0, rows: 0, atEnd: false };
    let sc = turns[0].parentElement;
    while (sc && sc !== document.body && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
    if (!sc || sc === document.body) sc = document.scrollingElement;
    const ch = sc === document.scrollingElement ? innerHeight : sc.clientHeight;
    const top0 = sc === document.scrollingElement ? 0 : sc.getBoundingClientRect().top;
    const near = (t, i) => { const r = t.getBoundingClientRect(); return (r.bottom - top0 >= -${SCREENS} * ch && r.top - top0 <= ch + ${SCREENS} * ch) || i >= turns.length - ${LAST_FEW}; };
    const painted = turns.filter((t) => t.firstElementChild);
    return { turns: turns.length, painted: painted.length, allowed: turns.filter(near).length, outside: painted.filter((t) => !near(t, turns.indexOf(t))).length, rows: document.querySelectorAll(stage + ' .row').length, atEnd: sc.scrollTop >= sc.scrollHeight - ch - 2 };
  };
  window.__probe = {
    mark(key) { t0 = performance.now(); target = key; firstRow = rowsOf() ? t0 : null; peak = null; heap = null; clearInterval(sampler); sampler = setInterval(sample, 100); return t0; },
    dom() { sample(); clearInterval(sampler); return { ...peak, heapMb: heap === null ? null : Math.round(heap / 104857.6) / 10, end: census() }; },
    read(upTo) {
      const end = upTo ?? Infinity;
      const inside = tasks.filter(([s]) => s >= t0 && s - t0 <= end);
      return { firstRowMs: firstRow === null ? null : Math.round(firstRow - t0), tasks: inside.length, taskMs: Math.round(inside.reduce((a, [, d]) => a + d, 0)), longest: Math.round(Math.max(0, ...inside.map(([, d]) => d))) };
    },
    all() { return tasks.map(([s, d]) => [Math.round(s), Math.round(d)]); },
  };
  return 1;
})()`;

type Boot = { launchMs: number | null; fcp: number | null; tasks: number; taskMs: number };
type Census = { turns: number; painted: number; allowed: number; outside: number; rows: number; atEnd: boolean };
type Dom = { elements: number; stageElements: number; turns: number; painted: number; turnsWithRows: number; rows: number; heapMb: number | null; end: Census };
type Open = { heldBefore: boolean; stageMessages: number | null; firstRowMs: number | null; tasks: number; taskMs: number; longest: number; openTasks: number; settledMs: number | null; traffic: Traffic; startedAt: number; endedAt: number; held: number; heldMessages: number; dom: Dom | null };

const threadsHeld = () => evaluate<Array<{ key: string; status: string; messages: number }>>("JSON.stringify(window.boxbox ? window.boxbox.threads() : [])");

/** opens a thread in the app (the tap on its window) and watches until the worker has stopped bringing messages in */
async function openAndSettle(key: string, longThread: boolean): Promise<Open> {
  const startedAt = Date.now();
  const hitsAt = hits.length;
  const heldBefore = ((await threadsHeld()) ?? []).some((t) => t.key === key && t.messages > 0);
  await evaluate(`JSON.stringify((() => { window.__probe.mark(${JSON.stringify(key)}); window.boxbox.open(${JSON.stringify(key)}); return 1; })())`);
  let lastTotal = -1;
  let stableSince = Date.now();
  const t0 = Date.now();
  let settledMs: number | null = null;
  while (Date.now() - t0 < SETTLE_MS) {
    await Bun.sleep(250);
    const held = (await threadsHeld()) ?? [];
    const total = held.reduce((a, t) => a + t.messages, 0);
    const onStage = held.find((t) => t.key === key);
    if (DEBUG) log(`     +${Date.now() - t0} ms: ${held.length} threads, ${total} messages, this one ${onStage ? onStage.messages : "not held"}, ${(await evaluate<number>("JSON.stringify(document.querySelectorAll('.thread-stage .row').length)")) ?? "?"} rows`);
    if (total !== lastTotal) { lastTotal = total; stableSince = Date.now(); }
    // a long thread is settled when its agents are in and nothing has moved for 2.5 s; a short one when it is in
    if (onStage && onStage.messages > 0 && Date.now() - stableSince > (longThread ? 2500 : 800)) { settledMs = stableSince - t0; break; }
    // a thread the worker let go of while it was on stage (the cap) is not coming back: nothing has moved for 6 s
    if (!onStage && Date.now() - stableSince > 6000) break;
  }
  const probe = (await evaluate<{ firstRowMs: number | null; tasks: number; taskMs: number; longest: number }>("JSON.stringify(window.__probe.read())")) ?? { firstRowMs: null, tasks: 0, taskMs: 0, longest: 0 };
  // the open itself: from the tap to half a second after the first rows
  const openRead = await evaluate<{ tasks: number }>(`JSON.stringify(window.__probe.read(${(probe.firstRowMs ?? 0) + 500}))`);
  const held = (await threadsHeld()) ?? [];
  return { ...probe, heldBefore, stageMessages: held.find((t) => t.key === key)?.messages ?? null, openTasks: openRead?.tasks ?? probe.tasks, settledMs, traffic: traffic(hitsAt), startedAt, endedAt: Date.now(), held: held.length, heldMessages: held.reduce((a, t) => a + t.messages, 0), dom: await evaluate<Dom>("JSON.stringify(window.__probe.dom())") };
}

/** a page of home, loaded and past its first frame, with the probe in it; the launch is read from telemetry later */
async function boot(path = "/"): Promise<Boot & { startedAt: number; endedAt: number; traffic: Traffic }> {
  const startedAt = Date.now();
  const hitsAt = hits.length;
  await ab("open", `${ORIGIN}${path}`);
  await until("the app to come up", async () => (await evaluate<boolean>("JSON.stringify(!!window.boxbox)")) === true, 30_000);
  await ab("eval", PUMP);
  await ab("eval", PROBE);
  await until("the stream to go live", async () => (await evaluate<string>("JSON.stringify(window.boxbox.stream().state)")) === "live", 15_000);
  // the first frame's telemetry and the worker's cache writes settle in this time
  await Bun.sleep(2500);
  const read = await evaluate<{ fcp: number | null; tasks: number; taskMs: number }>(`JSON.stringify((() => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const all = window.__probe.all();
    return { fcp: fcp ? Math.round(fcp.startTime) : null, tasks: all.length, taskMs: all.reduce((a, [, d]) => a + d, 0) };
  })())`);
  return { launchMs: null, fcp: read?.fcp ?? null, tasks: read?.tasks ?? 0, taskMs: read?.taskMs ?? 0, startedAt, endedAt: Date.now(), traffic: traffic(hitsAt) };
}

async function signIn(): Promise<boolean> {
  let status: number | null = null;
  for (let attempt = 0; attempt < 4 && status !== 200; attempt++) {
    if (attempt) await Bun.sleep(1000);
    status = await evaluate<number>(`fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(gatePassword)}})}).then(r=>r.status)`);
  }
  return status === 200;
}

/** how many threads the browser's indexeddb holds: 0 for the empty cache a cold run needs */
async function cachedThreads(): Promise<number | null> {
  return evaluate<number>(`new Promise((resolve) => { const r = indexedDB.open('boxbox'); r.onerror = () => resolve(null); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('threads')) { db.close(); resolve(0); return; } const q = db.transaction('threads').objectStore('threads').getAllKeys(); q.onsuccess = () => { db.close(); resolve(JSON.stringify(q.result.filter((k) => String(k).endsWith('#head')).length)); }; q.onerror = () => { db.close(); resolve(null); }; }; })`);
}

/** what indexeddb holds of one thread: its head record and how many of the pages the head counts are there. a cold thread
    (boot reads heads only) lives here until it is opened; it is still cached while both are whole */
type CacheState = { head: boolean; pages: number; found: number };
async function cacheOf(key: string): Promise<CacheState> {
  const read = await evaluate<CacheState>(`new Promise((resolve) => { const none = JSON.stringify({ head: false, pages: 0, found: 0 }); const r = indexedDB.open('boxbox'); r.onerror = () => resolve(none); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('threads')) { db.close(); resolve(none); return; } const store = db.transaction('threads').objectStore('threads'); const get = (id) => new Promise((done) => { const q = store.get(id); q.onsuccess = () => done(q.result); q.onerror = () => done(undefined); }); get(${JSON.stringify(`${key}#head`)}).then(async (head) => { if (!head) { db.close(); resolve(none); return; } let found = 0; for (let page = 0; page < head.pages; page++) if ((await get(${JSON.stringify(key)} + '#' + page)) !== undefined) found++; db.close(); resolve(JSON.stringify({ head: true, pages: head.pages, found })); }); }; })`);
  return read ?? { head: false, pages: 0, found: 0 };
}
const whole = (c: CacheState) => c.head && c.pages > 0 && c.found === c.pages;

/* ---------- the telemetry the server wrote ---------- */
type Row = { at: number; kind: string; device_class: string; ok: number | null; ms: number | null; session?: string; props: Record<string, unknown> };
function telemetry(): Row[] {
  if (!existsSync(TELEMETRY)) return [];
  return readdirSync(TELEMETRY).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(TELEMETRY, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));
}
/** the page's own queue goes out when it hides and every ten seconds: a hidden tab flushes at once */
async function flushTelemetry() {
  await evaluate("JSON.stringify((async () => { await window.boxboxPerf.flush(); return 1; })())");
  await Bun.sleep(11_500);
}
const within = (rows: Row[], from: number, to: number, kind: string, pick: (r: Row) => boolean = () => true) => rows.filter((r) => r.kind === kind && r.at >= from - 200 && r.at <= to + 2000 && r.device_class === "automation" && pick(r));

/** a small thread opened after the long one: what was left of it in the store and in indexeddb at the tap, and what the open did */
/** a thread's first paint from the telemetry: perf.thread ms and its cached flag, `atBoot` when the row is from the page's
    boot (the stage mounted the thread then) */
type Paint = { ms: number | null; cached: number | null; atBoot: boolean };

type SmallAfter = { heldBefore: boolean; cache: CacheState; requests: number; ms: number | null; cached: number | null };

/* ---------- the drive, one width ---------- */
type Result = {
  width: number;
  agents: number;
  bootEmpty: Boot & { traffic: Traffic };
  bootWarm: Boot & { traffic: Traffic };
  smallCold: { ms: number | null; cached: number | null };
  longCold: Open & { perf: Paint };
  smallAfterCold: SmallAfter;
  longCached: Open & { perf: Paint };
  smallAfterWarm: SmallAfter;
  cachedEmpty: number | null;
  cachedWarm: number | null;
  errors: string[];
};

async function drive(width: number, height: number, seeded: Seeded): Promise<Result> {
  const smallKey = `bench:${seeded.small}`;
  const longKey = `bench:${seeded.parent}`;
  log(`\n— ${width} wide, ${seeded.children.length} agents`);
  await closeBrowser();
  await ab("open", `${ORIGIN}/`);
  await ab("set", "viewport", String(width), String(height));
  if (!(await signIn())) throw new Error("the gate refused the bench password");
  const cachedEmpty = await cachedThreads();
  log(`     a fresh browser holds ${cachedEmpty} cached threads`);
  const marks: Record<string, [number, number]> = {};
  const span = <T extends { startedAt: number; endedAt: number }>(name: string, x: T): T => { marks[name] = [x.startedAt, x.endedAt]; return x; };

  // 1. boot, empty cache (the sign-in page load did not paint the app: this is the first launch with a session)
  const bootEmpty = span("bootEmpty", await boot("/"));
  // 2. a small thread, cold
  const smallColdOpen = span("smallCold", await openAndSettle(smallKey, false));
  // 3. the long thread, cold
  const longCold = span("longCold", await openAndSettle(longKey, true));
  // 4. the small thread again: is it still cached after the long one came in
  const cacheBefore1 = await cacheOf(smallKey);
  const smallAfterColdOpen = span("smallAfterCold", await openAndSettle(smallKey, false));
  // the worker writes the cache a moment after a thread settles
  await Bun.sleep(4000);
  const cachedWarm = await cachedThreads();
  // 5. boot again, warm: a reload of home with everything cached
  const bootWarm = span("bootWarm", await boot("/"));
  // 6. the long thread, cached
  const longCached = span("longCached", await openAndSettle(longKey, true));
  // 7. the small thread, after the long one, with the cache warm
  const cacheBefore2 = await cacheOf(smallKey);
  const smallAfterWarmOpen = span("smallAfterWarm", await openAndSettle(smallKey, false));
  const errors = (await ab("console").text()).split("\n").filter((l) => l.startsWith("[error]") && !/vite|hmr|websocket/i.test(l));
  await flushTelemetry();

  const rows = telemetry();
  /** the thread's perf.thread row from one span; with `earlier`, a span to look in when the span itself has none: the wide
      layout restores the thread on stage while the page boots, so the tap finds it painted and no stage mounts for it */
  const thread = (name: string, key: string, earlier?: string): Paint => {
    const [from, to] = marks[name] ?? [0, 0];
    const pick = (a: number, b: number) => within(rows, a, b, "perf.thread", (r) => r.props["what"] === "thread" && (r.session === undefined || r.session === key || r.session.endsWith(key))).at(-1);
    const own = pick(from, to);
    const row = own ?? (earlier ? pick(marks[earlier]?.[0] ?? from, to) : undefined);
    return { ms: row?.ms ?? null, cached: typeof row?.props["cached"] === "number" ? (row.props["cached"] as number) : null, atBoot: row !== undefined && own === undefined };
  };
  const launch = (name: string) => {
    const [from, to] = marks[name] ?? [0, 0];
    return within(rows, from, to, "perf.launch").at(-1);
  };
  const launchEmpty = launch("bootEmpty");
  const launchWarm = launch("bootWarm");
  return {
    width,
    agents: seeded.children.length,
    bootEmpty: { ...bootEmpty, launchMs: launchEmpty?.ms ?? null },
    bootWarm: { ...bootWarm, launchMs: launchWarm?.ms ?? null },
    smallCold: thread("smallCold", smallKey),
    longCold: { ...longCold, perf: thread("longCold", longKey) },
    smallAfterCold: { heldBefore: smallAfterColdOpen.heldBefore, cache: cacheBefore1, requests: smallAfterColdOpen.traffic.messages, ...thread("smallAfterCold", smallKey) },
    longCached: { ...longCached, perf: thread("longCached", longKey, "bootWarm") },
    smallAfterWarm: { heldBefore: smallAfterWarmOpen.heldBefore, cache: cacheBefore2, requests: smallAfterWarmOpen.traffic.messages, ...thread("smallAfterWarm", smallKey) },
    cachedEmpty,
    cachedWarm,
    errors,
  };
  void smallColdOpen;
}

const results: Result[] = [];
const SIZES: Record<number, number> = { 390: 844, 1512: 945 };
for (const s of seeds) for (const width of ONLY) results.push(await drive(width, SIZES[width] ?? 900, s));
log("\n— drives done; closing the browser");
await closeBrowser();
log("— browser closed");

/* ---------- the table, and the budgets ---------- */
const cell = (v: number | string | null | undefined, unit = "") => (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? "n/a" : `${v}${unit}`);
const table: Array<[string, ...string[]]> = [["", ...results.map((r) => `${r.width}, ${r.agents} agents`)]];
/** the page's numbers with the long thread on stage: from the cached open, or the cold one when the cached one never painted */
const stageDom = (r: Result): Dom | null => ((r.longCached.dom?.turns ?? 0) > 0 ? r.longCached.dom : r.longCold.dom);
const row = (name: string, f: (r: Result) => string) => table.push([name, ...results.map(f)]);
const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);
const traf = (t: Traffic) => `${kb(t.apiBytes)} api, ${t.messages} /messages (${kb(t.messageBytes)}), ${kb(t.streamBytes)} stream`;

row("boot, empty cache: perf.launch", (r) => cell(r.bootEmpty.launchMs, " ms"));
row("boot, empty cache: first contentful paint", (r) => cell(r.bootEmpty.fcp, " ms"));
row("boot, empty cache: long tasks", (r) => `${r.bootEmpty.tasks} (${Math.round(r.bootEmpty.taskMs)} ms)`);
row("boot, empty cache: fetched", (r) => traf(r.bootEmpty.traffic));
row("boot, warm cache: perf.launch", (r) => cell(r.bootWarm.launchMs, " ms"));
row("boot, warm cache: first contentful paint", (r) => cell(r.bootWarm.fcp, " ms"));
row("boot, warm cache: long tasks", (r) => `${r.bootWarm.tasks} (${Math.round(r.bootWarm.taskMs)} ms)`);
row("boot, warm cache: fetched", (r) => traf(r.bootWarm.traffic));
/** how a thread's first paint reads: its perf.thread row, or, with none (it was on stage already), the time to its first rows */
const paintCell = (o: Open & { perf: Paint }) => (o.perf.ms !== null ? `${o.perf.ms} ms (cached=${o.perf.cached}${o.perf.atBoot ? ", row from the boot" : ""})` : o.heldBefore ? `held at the tap, rows in ${cell(o.firstRowMs, " ms")}` : "n/a");
row("long thread, cold: perf.thread", (r) => paintCell(r.longCold));
row("long thread, cold: already held at the tap", (r) => String(r.longCold.heldBefore));
row("long thread, cold: first rows or cards", (r) => cell(r.longCold.firstRowMs, " ms"));
row("long thread, cold: long tasks to first paint+0.5s", (r) => `${r.longCold.openTasks}`);
row("long thread, cold: long tasks to settled", (r) => `${r.longCold.tasks} (${r.longCold.taskMs} ms, longest ${r.longCold.longest})`);
row("long thread, cold: settled", (r) => `${cell(r.longCold.settledMs, " ms")}; ${r.longCold.held} threads held, ${r.longCold.heldMessages} messages; it holds ${r.longCold.stageMessages ?? "nothing (evicted)"}`);
row("long thread, cold: fetched", (r) => traf(r.longCold.traffic));
row("long thread, cached: perf.thread", (r) => paintCell(r.longCached));
row("long thread, cached: already held at the tap", (r) => String(r.longCached.heldBefore));
row("long thread, cached: first rows or cards", (r) => cell(r.longCached.firstRowMs, " ms"));
row("long thread, cached: long tasks to first paint+0.5s", (r) => `${r.longCached.openTasks}`);
row("long thread, cached: long tasks to settled", (r) => `${r.longCached.tasks} (${r.longCached.taskMs} ms, longest ${r.longCached.longest})`);
row("long thread, cached: settled", (r) => `${cell(r.longCached.settledMs, " ms")}; ${r.longCached.held} threads held, ${r.longCached.heldMessages} messages; it holds ${r.longCached.stageMessages ?? "nothing (evicted)"}`);
row("long thread, cached: fetched", (r) => traf(r.longCached.traffic));
row("small thread, cold cache (before the long one)", (r) => cell(r.smallCold.ms, ` ms (cached=${r.smallCold.cached})`));
const cacheCell = (c: CacheState) => (whole(c) ? `yes, ${c.found} of ${c.pages} pages` : c.head ? `no, ${c.found} of ${c.pages} pages` : "no, no head");
const smallCell = (s: SmallAfter) => `${cell(s.ms, " ms")} (cached=${s.cached}), ${s.requests} /messages, in the store: ${s.heldBefore}`;
row("small thread after the long one, cold: still cached in indexeddb", (r) => cacheCell(r.smallAfterCold.cache));
row("small thread after the long one, cold: opening it", (r) => smallCell(r.smallAfterCold));
row("small thread after the long one, warm: still cached in indexeddb", (r) => cacheCell(r.smallAfterWarm.cache));
row("small thread after the long one, warm: opening it", (r) => smallCell(r.smallAfterWarm));
row("dom with the long thread on stage (fullest read): elements", (r) => cell(stageDom(r)?.elements));
row("dom: elements in the stage", (r) => cell(stageDom(r)?.stageElements));
row("dom: turns / turns painted / turns holding rows / rows", (r) => `${cell(stageDom(r)?.turns)} / ${cell(stageDom(r)?.painted)} / ${cell(stageDom(r)?.turnsWithRows)} / ${cell(stageDom(r)?.rows)}`);
row("dom at rest: turns painted / allowed / outside / rows", (r) => { const e = stageDom(r)?.end; return e ? `${e.painted} / ${e.allowed} / ${e.outside} / ${e.rows}${e.atEnd ? "" : " (the view is not at the end)"}` : "n/a"; });
row("js heap (page, not the worker)", (r) => cell(stageDom(r)?.heapMb, " MB"));
row("threads in indexeddb: fresh browser / after the opens", (r) => `${cell(r.cachedEmpty)} / ${cell(r.cachedWarm)}`);

const widths = [Math.max(...table.map((t) => t[0].length)), ...results.map((_, i) => Math.max(...table.map((t) => (t[i + 1] ?? "").length)))];
for (const s of seeds) log(`\nthe long thread, ${s.children.length} agents: ${s.turns} turns, ${s.messages} messages (${mb(s.parentBytes)} MB), its agents ${Math.min(...s.children.map((c) => c.messages))}+ messages each, ${mb(s.bytes)} MB in all`);
log(`boxbox at ${BOXBOX}\n`);
for (const [i, t] of table.entries()) {
  log(t.map((c, j) => c.padEnd(widths[j] ?? 0)).join("  ").trimEnd());
  if (i === 0) log(widths.map((w) => "-".repeat(w)).join("  "));
}

type Check = { ok: boolean; what: string; detail: string };
const checks: Check[] = [];
const check = (ok: boolean, what: string, detail: string) => checks.push({ ok, what, detail });
for (const r of results) {
  const at = `${r.width}/${r.agents}`;
  check(r.cachedEmpty === 0, `${at}: the cold runs start from an empty cache`, `${r.cachedEmpty} threads cached`);
  // design.md, buttery as numbers: cold launch to the last screen painted from cache, p90 700 ms
  check(r.bootWarm.launchMs !== null && r.bootWarm.launchMs <= 700, `${at}: warm launch paints in 700 ms (design.md, buttery: p90 700 ms)`, cell(r.bootWarm.launchMs, " ms"));
  // telemetry/schema.ts perf.thread: ok = a thread from cache in 300 ms, uncached in 1500 ms
  // a thread already on stage at the tap mounts no stage and emits no row: its first rows read in the row's place
  const paintMs = (o: Open & { perf: Paint }) => o.perf.ms ?? (o.heldBefore ? o.firstRowMs : null);
  const fromCache = (o: Open & { perf: Paint }) => (o.perf.ms === null ? o.heldBefore : o.perf.cached === 1);
  const cachedPaint = paintMs(r.longCached);
  check(fromCache(r.longCached) && cachedPaint !== null && cachedPaint <= 300, `${at}: the long thread from cache paints in 300 ms (schema.ts perf.thread)`, paintCell(r.longCached));
  const coldPaint = paintMs(r.longCold);
  check(coldPaint !== null && coldPaint <= 1500, `${at}: the long thread cold paints in 1500 ms (schema.ts perf.thread)`, paintCell(r.longCold));
  // thread.md, budgets: opening a thread with no long task over 50 ms
  check(r.longCold.firstRowMs !== null && r.longCold.openTasks === 0, `${at}: opening the long thread cold paints rows or cards with no long task (thread.md, budgets)`, `${cell(r.longCold.firstRowMs, " ms to first paint")}, ${r.longCold.openTasks} over 50 ms`);
  check(r.longCached.firstRowMs !== null && r.longCached.openTasks === 0, `${at}: opening the long thread from cache paints rows or cards with no long task (thread.md, budgets)`, `${cell(r.longCached.firstRowMs, " ms to first paint")}, ${r.longCached.openTasks} over 50 ms`);
  // what is painted is the live turn and the last few, and the turns within the screens around the view (the thread opens at
  // its end; the design that replaced "at most three turns of rows" in thread.md, budgets). the seed ends in ordinary turns,
  // so a build that paints the right turns paints real rows, and a thread that never came on stage paints none and fails
  const bounded = (d: Dom | null) => d !== null && d.end.painted > 0 && d.end.rows > 0 && d.end.outside === 0;
  const boundedDetail = (d: Dom | null) => (d ? `${d.end.painted} turns painted, ${d.end.allowed} allowed (the last ${LAST_FEW}, within ${SCREENS} screens of the view), ${d.end.outside} outside, ${d.end.rows} rows${d.end.atEnd ? "" : ", the view is not at the end"}` : "n/a");
  check(bounded(r.longCached.dom), `${at}: the long thread opened at its end paints only the turns the window allows (thread.md, budgets)`, boundedDetail(r.longCached.dom));
  check(bounded(r.longCold.dom), `${at}: ... also after the cold open`, boundedDetail(r.longCold.dom));
  // architecture.md, cold launch: the cache answers; a small thread must not be pushed out by a long one
  // a cold thread lives in indexeddb until it is opened: still cached is its head and pages there, and an open that makes
  // no /messages request and paints as cached
  const stillCached = (s: SmallAfter) => whole(s.cache) && s.cached === 1 && s.requests === 0;
  const stillDetail = (s: SmallAfter) => `indexeddb: ${cacheCell(s.cache)}; perf.thread cached=${s.cached}, ${cell(s.ms, " ms")}; ${s.requests} /messages on open`;
  check(stillCached(r.smallAfterCold), `${at}: a small thread stays cached after the long one was opened`, stillDetail(r.smallAfterCold));
  check(stillCached(r.smallAfterWarm), `${at}: ... and when the long thread came from the cache`, stillDetail(r.smallAfterWarm));
  check(r.smallAfterWarm.ms !== null && r.smallAfterWarm.ms <= 300, `${at}: ... and paints in 300 ms (schema.ts perf.thread)`, cell(r.smallAfterWarm.ms, " ms"));
  // design.md, buttery: client memory under 150 mb heap
  const heap = stageDom(r)?.heapMb;
  if (heap != null) check(heap <= 150, `${at}: js heap under 150 MB with the long thread open (design.md, buttery)`, `${heap} MB`);
  check(r.errors.length === 0, `${at}: no page errors`, r.errors[0]?.slice(0, 160) ?? "");
}
log("");
for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} ${c.what}: ${c.detail}`);
const failed = checks.filter((c) => !c.ok).length;
log(`\n${failed ? `${failed} of ${checks.length} checks failed` : "every check passed"}`);
proxy.stop(true);
process.exit(failed ? 1 : 0);
