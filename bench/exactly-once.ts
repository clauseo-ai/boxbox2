/* the exactly-once suite (docs/verification.md, m2), driven end to end.

     just build && bun bench/exactly-once.ts [case ...] [--hidden-minutes 10] [--with-stalled]

   cases, in this order by default: drops, server, daemon, hidden, reload.

   it owns everything it runs and stops all of it at the end: the pinned
   dev daemon (`bun scripts/cmx2.ts`, 4840 with the bench model on 4841),
   the release boxbox binary on 3001 (BOXBOX_PORT moves it) with the
   bench config, and the relay (bench/cut.ts) two ports above it, which
   the browser loads the app through. the
   browser is agent-browser's, driven by its cli.

   for each case: a fresh session is opened in the app (the worker
   hydrates it), a scripted reply streams into it through the daemon, the
   disruption happens mid-stream, and once the daemon says the session is
   idle the worker's transcript (window.boxbox.transcript) is compared
   with the server's translated read of the thread,
   GET /api/agents/{agent}/threads/{thread}/messages, every page from the
   newest back (docs/protocol.md section 11): the worker holds protocol 3
   messages, never cmx2's shapes. equal means the same json with keys
   sorted; whether the bytes match too is printed beside it. the worker's
   reducer counters are printed; duplicates must be 0.

   refuses to start if any of its ports answer: it never attaches to a
   daemon or server it did not start, except with CMX2_ATTACH=1, which
   uses the daemon named in the bench dir's daemon.json, started by the
   caller (never a fleet daemon), and leaves it running; the daemon case
   needs a daemon of its own and is refused then. BENCH_DIR moves the
   bench dir (daemon.json, password, gate-password, boxbox.toml) from
   .cmx2/bench; RELAY_PORT moves the relay from two above the server. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = process.env.BENCH_DIR ?? join(ROOT, ".cmx2", "bench");
const ATTACH = process.env.CMX2_ATTACH === "1";
const OUT = join(ROOT, ".cmx2", "exactly-once");
const BINARY = join(ROOT, "target/release/boxbox");
/** the server's port and the relay's, two above it (3003 beside the default 3001) */
const PORT = Number(process.env.BOXBOX_PORT ?? 3001);
const RELAY = Number(process.env.RELAY_PORT ?? PORT + 2);
const APP = `http://127.0.0.1:${RELAY}`;
const ALL = ["drops", "server", "daemon", "hidden", "reload"] as const;
/** diagnostic cases, run only when named */
const EXTRA = ["long"] as const;
type Case = (typeof ALL)[number] | (typeof EXTRA)[number];

const args = process.argv.slice(2);
const minutesAt = args.indexOf("--hidden-minutes");
const HIDDEN_MINUTES = minutesAt >= 0 ? Number(args[minutesAt + 1]) : 10;
const WITH_STALLED = args.includes("--with-stalled");
const cases = args.filter((a): a is Case => ([...ALL, ...EXTRA] as readonly string[]).includes(a));
const selected: readonly Case[] = cases.length > 0 ? cases : ALL;
const started = performance.now();

function log(line: string) {
  console.log(`[${((performance.now() - started) / 1000).toFixed(1).padStart(7)}s] ${line}`);
}

function listening(port: number): boolean {
  return spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0;
}

async function until(what: string, test: () => boolean | Promise<boolean>, timeoutMs = 30_000, everyMs = 250) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await test()) return;
    await Bun.sleep(everyMs);
  }
  throw new Error(`${what}: not within ${timeoutMs / 1000} s`);
}

/* —— the processes this run owns —— */

const owned = new Map<string, ChildProcess>();

function start(name: string, command: string, argv: string[], quiet = false): ChildProcess {
  const child = spawn(command, argv, { cwd: ROOT, detached: true, stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"] });
  owned.set(name, child);
  return child;
}

async function stop(name: string, signal: NodeJS.Signals = "SIGTERM") {
  const child = owned.get(name);
  owned.delete(name);
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((done) => child.once("exit", () => done()));
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
  const killer = setTimeout(() => {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 4000);
  await gone;
  clearTimeout(killer);
}

async function startDaemon() {
  if (!ATTACH) start("daemon", "bun", ["scripts/cmx2.ts"], true);
  await until("the daemon answers /global/health", async () => {
    try {
      return (await daemonCall("GET", "/global/health")).ok;
    } catch {
      return false;
    }
  });
}

async function startServer() {
  start("server", BINARY, ["serve", "--config", join(BENCH, "boxbox.toml")], true);
  await until(`boxbox answers on ${PORT}`, () => listening(PORT));
}

/* —— the daemon, directly —— */

function daemonAuth(): { url: string; auth: string } {
  const daemon = JSON.parse(readFileSync(join(BENCH, "daemon.json"), "utf8")) as { url: string };
  const password = readFileSync(join(BENCH, "password"), "utf8").trim();
  return { url: daemon.url, auth: `Basic ${Buffer.from(`cmx2:${password}`).toString("base64")}` };
}

function daemonCall(method: string, path: string, body?: unknown): Promise<Response> {
  const { url, auth } = daemonAuth();
  return fetch(`${url}${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function busy(session: string): Promise<boolean> {
  const status = (await (await daemonCall("GET", "/session/status?parked=true")).json()) as Record<string, { type?: string }>;
  return status[session]?.type === "busy" || status[session]?.type === "retry";
}

/* —— the server's translated read —— */

let cookie = "";

async function signIn(): Promise<number> {
  const gate = readFileSync(join(BENCH, "gate-password"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: gate }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return res.status;
}

type Page = { messages: unknown[]; older: string | null };

/** every page of the thread, newest first as the server pages it, joined oldest first */
async function serverRead(key: string): Promise<unknown[]> {
  const colon = key.indexOf(":");
  const route = `http://127.0.0.1:${PORT}/api/agents/${encodeURIComponent(key.slice(0, colon))}/threads/${encodeURIComponent(key.slice(colon + 1))}/messages`;
  if (!cookie) await signIn();
  let messages: unknown[] = [];
  let before: string | null = null;
  for (let pages = 0; pages < 1000; pages++) {
    const url = `${route}?turns=64${before ? `&before=${encodeURIComponent(before)}` : ""}`;
    let res = await fetch(url, { headers: { cookie, "accept-encoding": "gzip" } });
    if (res.status === 401) {
      // a restarted server may not know the session: sign in again, once
      await signIn();
      res = await fetch(url, { headers: { cookie, "accept-encoding": "gzip" } });
    }
    if (!res.ok) throw new Error(`GET ${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as Page;
    messages = [...page.messages, ...messages];
    if (!page.older) return messages;
    before = page.older;
  }
  throw new Error(`${route}: more than 1000 pages`);
}

/** json with every object's keys sorted, so two writers' key orders compare equal */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/* —— the browser —— */

function browser(...argv: string[]): string {
  const out = spawnSync("agent-browser", argv, { encoding: "utf8", timeout: 60_000 });
  if (out.status !== 0) throw new Error(`agent-browser ${argv[0]} failed: ${out.stderr.trim() || out.stdout.trim()}`);
  return out.stdout.trim();
}

/** runs an async expression in the app tab and returns its value. the page answers `{"v": value}` as
    json, so a string value can never be confused with the cli quoting the answer once more */
function evaluate<T>(expression: string): T {
  let raw = browser("eval", `(async () => JSON.stringify({ v: await (${expression}) }))()`);
  if (raw.startsWith('"')) raw = JSON.parse(raw) as string;
  return (JSON.parse(raw) as { v: T }).v;
}

interface Counters {
  applied: number;
  duplicates: number;
  covered: number;
  /** contract 1 counted gaps; the protocol 3 worker has none to count */
  gaps?: number;
  resets: number;
  refetches: number;
  cursor: number;
  epoch: string;
  resumes: number;
  replayed: number;
  maxDownMs: number;
}

async function openThread(key: string) {
  browser("open", `${APP}/?thread=${encodeURIComponent(key)}`);
  await until("the app exposes window.boxbox", () => evaluate<boolean>("Promise.resolve(typeof window.boxbox === 'object')"));
  await until("the stream is live", () => evaluate<string>("Promise.resolve(window.boxbox.stream().state)") === "live");
}

/* —— one case —— */

interface Outcome {
  name: Case;
  bytes: number;
  equal: boolean;
  counters: Counters;
}

async function compare(name: Case, session: string, key: string): Promise<Outcome> {
  await until(`${name}: the daemon settles the session`, async () => !(await busy(session)), 20 * 60_000, 1000);
  // the last deltas and the final part updates reach the worker within a frame or two; give it a moment
  await Bun.sleep(3000);
  const server = await serverRead(key);
  const worker = evaluate<string>(`window.boxbox.transcript(${JSON.stringify(key)})`);
  const counters = evaluate<Counters>("window.boxbox.counters()");
  mkdirSync(OUT, { recursive: true });
  const serverJson = canonical(server);
  const workerJson = canonical(JSON.parse(worker) as unknown);
  writeFileSync(join(OUT, `${name}.server.json`), serverJson);
  writeFileSync(join(OUT, `${name}.worker.json`), workerJson);
  const equal = serverJson === workerJson;
  const written = JSON.stringify(server) === worker;
  log(
    `${name}: server read ${serverJson.length} bytes (${server.length} messages), worker ${workerJson.length} bytes, keys sorted ${equal ? "equal" : "DIFFERENT"}, as written ${written ? "equal" : "different"}`,
  );
  if (!equal) {
    const pretty = spawnSync("bash", ["-c", `diff <(jq . '${OUT}/${name}.server.json') <(jq . '${OUT}/${name}.worker.json') | head -40`], { encoding: "utf8" });
    log(`${name}: first differences (server <, worker >), pretty-printed:\n${pretty.stdout}`);
  }
  log(`${name}: reducer counters ${JSON.stringify(counters)}`);
  return { name, bytes: serverJson.length, equal, counters };
}

async function newThread(name: Case): Promise<{ session: string; key: string }> {
  const created = (await (await daemonCall("POST", "/session", { title: `exactly-once ${name}` })).json()) as { id: string };
  const key = `bench:${created.id}`;
  await openThread(key);
  log(`${name}: opened ${key} in the app`);
  return { session: created.id, key };
}

async function stream(session: string, words: number, everyMs: number) {
  const res = await daemonCall("POST", `/session/${session}/prompt_async`, { text: `[bench:words ${words} ${everyMs}] exactly-once` });
  if (res.status !== 202) throw new Error(`prompt_async answered ${res.status}`);
  await until("the reply starts streaming", () => busy(session), 10_000);
  await Bun.sleep(1500);
}

async function run(name: Case): Promise<Outcome> {
  log(`—— ${name} ——`);
  const { session, key } = await newThread(name);
  switch (name) {
    case "drops": {
      await stream(session, 1500, 20);
      for (let i = 1; i <= 20; i++) {
        await Bun.sleep(300 + Math.random() * 1200);
        const relay = owned.get("relay");
        if (relay?.pid) process.kill(relay.pid, "SIGUSR2");
      }
      log("drops: 20 cuts made while the reply streamed");
      break;
    }
    case "server": {
      await stream(session, 1500, 20);
      await stop("server");
      log("server: boxbox stopped mid-stream");
      await Bun.sleep(1000);
      await startServer();
      log("server: boxbox started again (a new journal epoch)");
      break;
    }
    case "daemon": {
      await stream(session, 1500, 20);
      await stop("daemon");
      log("daemon: cmx2 stopped mid-stream");
      await Bun.sleep(1000);
      await startDaemon();
      log("daemon: cmx2 started again from the same store");
      await until("the interrupted turn is over", async () => !(await busy(session)), 30_000, 500);
      await stream(session, 300, 10);
      log("daemon: a second reply streams after the restart");
      break;
    }
    case "hidden": {
      const everyMs = 20;
      const words = Math.ceil((HIDDEN_MINUTES * 60_000 + 20_000) / everyMs);
      await stream(session, words, everyMs);
      const stalled = WITH_STALLED ? start("stalled", "bun", ["bench/stalled.ts", "--minutes", String(HIDDEN_MINUTES), "--load"]) : undefined;
      // tab ids are stable (`t1`, `t2`, ...) and the list marks the active one with an arrow: remember
      // the app's before another tab covers it
      const appTab = /→ \[(t\d+)\]/.exec(browser("tab", "list"))?.[1];
      if (!appTab) throw new Error("hidden: cannot find the app's tab id in `agent-browser tab list`");
      browser("tab", "new", "about:blank");
      log(`hidden: the app's tab is behind another for ${HIDDEN_MINUTES} minutes while ${words} words stream`);
      // agent-browser shuts its browser down after a few idle minutes (a fresh profile then answers 401
      // everywhere, which first read like the tab being killed); a tab list each minute keeps it up
      // and does not touch the app's tab
      for (let waited = 0; waited < HIDDEN_MINUTES * 60_000; waited += 60_000) {
        await Bun.sleep(Math.min(60_000, HIDDEN_MINUTES * 60_000 - waited));
        browser("tab", "list");
      }
      browser("tab", appTab);
      log(`hidden: the app's tab (${appTab}) is in front again`);
      // a tab left behind another may have been frozen or discarded by the browser. a discarded tab
      // reloads when a person returns to it; cdp's switch does not, so the driver does what the
      // browser would, and the app cold-launches from indexeddb and resumes from its cursor
      const back = evaluate<{ app: boolean; url: string; title: string; text: number }>(
        "Promise.resolve({ app: typeof window.boxbox === 'object', url: location.href, title: document.title, text: document.body?.innerText.length ?? 0 })",
      );
      log(`hidden: on return the tab holds ${back.app ? "the running app" : `no app (url ${back.url}, title "${back.title}", ${back.text} characters of text)`}`);
      if (!back.app) throw new Error("hidden: the app's tab no longer holds the app; the browser was restarted or the page killed");
      await until("the app answers again", () => evaluate<boolean>("Promise.resolve(typeof window.boxbox === 'object')"), 30_000, 250);
      const page = evaluate<{ discarded: boolean; ageMs: number; url: string }>(
        "Promise.resolve({ discarded: Boolean(document.wasDiscarded), ageMs: Math.round(performance.now()), url: location.href })",
      );
      log(`hidden: page discarded ${page.discarded}, page age ${(page.ageMs / 1000).toFixed(0)} s, at ${page.url}`);
      if (stalled) await new Promise<void>((done) => (stalled.exitCode !== null ? done() : stalled.once("exit", () => done())));
      break;
    }
    case "long": {
      // the hidden case's reply with the tab in front, sampled, to tell a long stream from a hidden tab
      await stream(session, 31_000, 20);
      for (let t = 20; t <= 300; t += 20) {
        await Bun.sleep(20_000);
        const sample = evaluate<{ heap: number; painted: number; state: string; nodes: number }>(
          "Promise.resolve({ heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576), painted: window.boxbox.painted(), state: window.boxbox.stream().state, nodes: document.getElementsByTagName('*').length })",
        );
        log(`long: ${t} s heap ${sample.heap} MB, painted ${sample.painted}, dom nodes ${sample.nodes}, stream ${sample.state}`);
      }
      await daemonCall("POST", `/session/${session}/abort`);
      break;
    }
    case "reload": {
      await stream(session, 1500, 20);
      await Bun.sleep(4000);
      const before = evaluate<number>("Promise.resolve(window.boxbox.painted())");
      const reloadAt = performance.now();
      browser("reload");
      let painted = 0;
      let firstPaintMs = -1;
      let stateAtPaint = "";
      await until("the reloaded page paints the thread", () => {
        const probe = evaluate<{ painted: number; state: string } | null>(
          "Promise.resolve(window.boxbox ? { painted: window.boxbox.painted(), state: window.boxbox.stream().state } : null)",
        );
        if (probe && probe.painted > 0) {
          painted = probe.painted;
          stateAtPaint = probe.state;
          firstPaintMs = performance.now() - reloadAt;
          return true;
        }
        return false;
      }, 10_000, 20);
      log(`reload: ${before} characters painted before the reload; the reloaded page painted ${painted} at ${firstPaintMs.toFixed(0)} ms, stream ${stateAtPaint}`);
      await Bun.sleep(1500);
      const after = evaluate<number>("Promise.resolve(window.boxbox.painted())");
      log(`reload: 1.5 s later ${after} characters painted (the reply continues)`);
      break;
    }
  }
  return compare(name, session, key);
}

/* —— the run —— */

async function main(): Promise<number> {
  for (const port of ATTACH ? [PORT, RELAY] : [PORT, RELAY, 4840, 4841]) {
    if (listening(port)) throw new Error(`port ${port} is taken; this suite starts its own daemon, server and relay`);
  }
  if (ATTACH && selected.includes("daemon")) throw new Error("the daemon case restarts the daemon, so it needs one of its own: run it without CMX2_ATTACH");
  if (!existsSync(BINARY)) throw new Error("no release binary; run `just build` first");
  log(`boxbox ${BINARY} built ${statSync(BINARY).mtime.toISOString()}`);
  await startDaemon();
  log(ATTACH ? "cmx2 dev daemon attached (started by the caller)" : "cmx2 dev daemon up from the pin");
  await startServer();
  start("relay", "bun", ["bench/cut.ts", "--listen", String(RELAY), "--to", String(PORT)]);
  await until(`the relay listens on ${RELAY}`, () => listening(RELAY));
  const gate = readFileSync(join(BENCH, "gate-password"), "utf8").trim();
  log(`signed in to the server's reads: ${await signIn()}`);
  browser("open", `${APP}/`);
  const signedIn = evaluate<number>(
    `fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(gate)} }) }).then((r) => r.status)`,
  );
  log(`signed in through the relay: ${signedIn}`);

  const outcomes: Outcome[] = [];
  for (const name of selected) outcomes.push(await run(name));

  console.log("\ncase     bytes    diff   duplicates  gaps  resets  resumes  replayed  covered  refetches  maxDownMs");
  for (const o of outcomes) {
    const c = o.counters;
    console.log(
      `${o.name.padEnd(8)} ${String(o.bytes).padStart(7)}  ${(o.equal ? "empty" : "DIFF").padEnd(6)} ${String(c.duplicates).padStart(10)}  ${String(c.gaps ?? "-").padStart(4)}  ${String(c.resets).padStart(6)}  ${String(c.resumes).padStart(7)}  ${String(c.replayed).padStart(8)}  ${String(c.covered).padStart(7)}  ${String(c.refetches).padStart(9)}  ${String(c.maxDownMs).padStart(9)}`,
    );
  }
  return outcomes.every((o) => o.equal && o.counters.duplicates === 0) ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  log(`stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try {
    browser("close");
  } catch {
    /* no browser to close */
  }
  for (const name of [...owned.keys()].reverse()) await stop(name);
  log("stopped everything this run started");
}
process.exit(code);
