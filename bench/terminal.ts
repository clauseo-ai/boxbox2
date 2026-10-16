/* the terminal drive (docs/terminal.md; docs/verification.md, the full
   surface drive's terminal row), end to end against the pinned daemon.

     just build && bun bench/terminal.ts [step ...] [--hold]

   steps, in this order by default:
     rest     every rest route through boxbox: shells, create, list, one,
              rename, resize (checked with `stty size` in the shell), kill
     relay    a raw websocket through the relay: replay and meta, typing,
              a resume from a cursor, the relay redialling after its
              connection to the daemon is cut, and the exit close
     overflow a reader that stops reading while 10 mb streams: the relay
              lets go of the daemon at 256 kb and redials, rss sampled
     browser  the pane in agent-browser at phone, ipad and mac widths:
              open, pick a shell, type, see bytes, resize, cut and watch
              the redial replay, 10 mb of output with rss sampled, kill
   --hold starts everything, prints how to sign in, and waits for ctrl-c.

   it owns everything it runs and stops all of it at the end: the pinned
   daemon on 4890 (with the bench model on 4891, its home, data and logs
   under the system temp dir), the cutter (bench/cut.ts) on 4892 between boxbox and the
   daemon, and the release binary on 3031 pointed at the cutter. killing
   the cutter's connections is how "the relay's upstream drops" is made
   real: the relay sees exactly what a lost link looks like.

   refuses to start if any of its ports answer. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseEnv,
  basicAuth,
  daemonArgs,
  daemonDirs,
  daemonEnv,
  exportPin,
  mintPassword,
  modelArgs,
  ROOT,
  writeDaemonConfig,
} from "../scripts/pinned";

/** the harness world lives in the system temp dir, never inside a git checkout (AGENTS.md, scratch in /tmp) */
const BENCH = join(tmpdir(), "boxbox-term-bench");
const OUT = join(BENCH, "out");
/** the release binary; BOXBOX_BINARY points --hold at a debug build, which serves app/dist from disk */
const BINARY = process.env.BOXBOX_BINARY ?? join(ROOT, "target/release/boxbox");
const DAEMON_PORT = 4890;
const MODEL_PORT = 4891;
const CUT_PORT = 4892;
const BOXBOX_PORT = 3031;
const APP = `http://127.0.0.1:${BOXBOX_PORT}`;
const PORTS = [DAEMON_PORT, MODEL_PORT, CUT_PORT, BOXBOX_PORT];
const ALL = ["rest", "relay", "overflow", "browser"] as const;
type Step = (typeof ALL)[number];

const args = process.argv.slice(2);
const HOLD = args.includes("--hold");
const picked = args.filter((a): a is Step => (ALL as readonly string[]).includes(a));
const steps: readonly Step[] = picked.length > 0 ? picked : ALL;
const started = performance.now();
/** 10 mib of output: lines of 99 x's, then a marker the drive waits for */
const FLOOD = "head -c 10485760 /dev/zero | tr '\\0' x | fold -w 99; echo; echo flood-done";
/** after the overflow: 1 mib of fresh output (1,059,209 bytes with its newlines and the marker), more than cmx2-asks a14
    can swallow after a redial into dropped output, then a marker */
const AFTER = "head -c 1048576 /dev/zero | tr '\\0' y | fold -w 99; echo; echo after-$((40+2))";
const AFTER_BYTES = 1048576 + Math.ceil(1048576 / 99) * 2 + 1 + "after-42\r\n".length;

function log(line: string) {
  console.log(`[${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`);
}

function listening(port: number): boolean {
  return spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0;
}

async function until<T>(what: string, test: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20_000, everyMs = 100): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await test();
    if (value !== undefined && value !== false) return value;
    await Bun.sleep(everyMs);
  }
  throw new Error(`${what}: not within ${timeoutMs / 1000} s`);
}

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`failed: ${what}`);
  log(`ok: ${what}`);
}

/* —— the processes this run owns —— */

const owned = new Map<string, ChildProcess>();

function start(name: string, command: string, argv: string[], env: Record<string, string>, cwd = ROOT, logFile?: string): ChildProcess {
  // a fresh file per run: the drive finds new lines by the file's length
  if (logFile) writeFileSync(logFile, "");
  const out = logFile ? Bun.file(logFile).writer() : undefined;
  const child = spawn(command, argv, { cwd, env, detached: true, stdio: ["ignore", out ? "pipe" : "ignore", out ? "pipe" : "inherit"] });
  if (out) {
    // flushed per chunk: the drive reads these logs while the processes run
    const write = (chunk: Buffer) => {
      out.write(chunk);
      out.flush();
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
  }
  owned.set(name, child);
  return child;
}

async function stop(name: string) {
  const child = owned.get(name);
  owned.delete(name);
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((done) => child.once("exit", () => done()));
  try {
    process.kill(-child.pid, "SIGTERM");
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

async function stopAll() {
  for (const name of ["server", "cut", "daemon", "model"]) await stop(name);
  const lsof = spawnSync("lsof", ["-nP", ...PORTS.flatMap((p) => [`-iTCP:${p}`])], { encoding: "utf8" });
  log(`lsof on ${PORTS.join(", ")} after stopping: ${lsof.stdout.trim() === "" ? "empty" : `\n${lsof.stdout}`}`);
}

let gatePassword = "";
let daemonPassword = "";

async function startAll() {
  for (const port of PORTS) {
    if (listening(port)) throw new Error(`port ${port} is taken; this drive never attaches to a process it did not start`);
  }
  exportPin((line) => log(`cmx2: ${line}`));
  mkdirSync(OUT, { recursive: true });
  const dirs = daemonDirs(BENCH);
  writeDaemonConfig(dirs, MODEL_PORT);
  daemonPassword = mintPassword(join(BENCH, "password"), "bench");
  gatePassword = mintPassword(join(BENCH, "gate-password"), "gate");
  const config = [
    "# written by bench/terminal.ts; never a real password",
    `listen = "127.0.0.1:${BOXBOX_PORT}"`,
    `data_dir = "${join(BENCH, "boxbox-data")}"`,
    `password = "${gatePassword}"`,
    "",
    "[cookie]",
    'name = "boxbox_term_session"',
    "secure = false",
    "",
    "[[host]]",
    'name = "bench"',
    `url = "http://127.0.0.1:${CUT_PORT}"`,
    `password = "${daemonPassword}"`,
  ];
  writeFileSync(join(BENCH, "boxbox.toml"), `${config.join("\n")}\n`, { mode: 0o600 });

  start("model", "bun", modelArgs(MODEL_PORT), baseEnv(), ROOT, join(OUT, "model.log"));
  start("daemon", "bun", daemonArgs(DAEMON_PORT), daemonEnv(dirs, daemonPassword), dirs.work, join(OUT, "daemon.log"));
  start("cut", "bun", [join(ROOT, "bench/cut.ts"), "--listen", String(CUT_PORT), "--to", String(DAEMON_PORT)], baseEnv(), ROOT, join(OUT, "cut.log"));
  await until("the daemon answers /global/health", async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/global/health`, { headers: { authorization: basicAuth(daemonPassword) } });
      return res.ok ? ((await res.json()) as { version: string }) : undefined;
    } catch {
      return undefined;
    }
  }).then((health) => log(`daemon on ${DAEMON_PORT}: cmx2 ${health.version}`));
  start("server", BINARY, ["serve", "--config", join(BENCH, "boxbox.toml")], { ...baseEnv(), HOME: process.env.HOME ?? "", RUST_LOG: "boxbox=info" }, ROOT, join(OUT, "server.log"));
  await until(`boxbox answers on ${BOXBOX_PORT}`, () => listening(BOXBOX_PORT));
  log(`boxbox on ${APP} (pid ${owned.get("server")?.pid}), the host "bench" through the cutter on ${CUT_PORT}`);
}

/** cuts every connection through the cutter: boxbox's event stream and every relay's upstream */
async function cut(): Promise<void> {
  const child = owned.get("cut");
  if (!child?.pid) throw new Error("the cutter is not running");
  const before = readFileSync(join(OUT, "cut.log"), "utf8").length;
  process.kill(child.pid, "SIGUSR2");
  const line = await until("the cutter reports the cut", () => readFileSync(join(OUT, "cut.log"), "utf8").slice(before).trim() || undefined, 5000);
  log(line);
}

/** stops the server and starts it again on the same config; its log continues in the same file */
async function restartServer(): Promise<void> {
  const child = owned.get("server");
  owned.delete("server");
  if (child?.pid) {
    const gone = new Promise<void>((done) => child.once("exit", () => done()));
    process.kill(child.pid, "SIGTERM");
    await gone;
  }
  await until(`port ${BOXBOX_PORT} is free`, () => !listening(BOXBOX_PORT));
  const next = spawn(BINARY, ["serve", "--config", join(BENCH, "boxbox.toml")], {
    cwd: ROOT,
    env: { ...baseEnv(), HOME: process.env.HOME ?? "", RUST_LOG: "boxbox=info" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // appended, so the log keeps what the last server wrote
  const append = (chunk: Buffer) => appendFileSync(join(OUT, "server.log"), chunk);
  next.stdout?.on("data", append);
  next.stderr?.on("data", append);
  owned.set("server", next);
  await until(`boxbox answers on ${BOXBOX_PORT} again`, () => listening(BOXBOX_PORT));
  log(`boxbox restarted (pid ${next.pid})`);
}

function serverLog(since = 0): string {
  return readFileSync(join(OUT, "server.log"), "utf8").slice(since);
}

function rssKb(): number {
  const pid = owned.get("server")?.pid;
  const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return Number(out.stdout.trim());
}

/* —— boxbox's api, signed in —— */

let cookie = "";

async function signIn() {
  const res = await fetch(`${APP}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: gatePassword }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  check(res.status === 200 && cookie.startsWith("boxbox_term_session="), `POST /api/login -> ${res.status}`);
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
  const t = performance.now();
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t);
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  log(`${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`} -> ${res.status} in ${ms} ms: ${JSON.stringify(json).slice(0, 220)}`);
  return { status: res.status, json, ms };
}

type Pty = { id: string; title: string; cwd: string; status: string; pid: number; command: string };

async function newTerminal(title: string): Promise<Pty> {
  const created = await call("POST", "/api/hosts/bench/pty", { title });
  check(created.status === 200, `a terminal opened: ${(created.json as Pty).id}`);
  return created.json as Pty;
}

/* —— a raw websocket through the relay, speaking docs/terminal.md —— */

type Frame = { kind: "text"; text: string } | { kind: "meta"; cursor: number } | { kind: "replay"; cursor: number | null } | { kind: "heartbeat" };

class Wire {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private socket: WebSocket;
  opened: Promise<void>;

  constructor(pty: string, cursor?: number) {
    const query = cursor === undefined ? "" : `?cursor=${cursor}`;
    this.socket = new WebSocket(`ws://127.0.0.1:${BOXBOX_PORT}/api/hosts/bench/pty/${pty}/connect${query}`, {
      headers: { cookie },
    } as unknown as string[]);
    this.socket.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("the websocket failed")));
    });
    this.socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.frames.push({ kind: "text", text: event.data });
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const body = new TextDecoder().decode(bytes.subarray(1));
      if (bytes[0] === 0) this.frames.push({ kind: "meta", cursor: (JSON.parse(body) as { cursor: number }).cursor });
      else if (bytes[0] === 1) this.frames.push({ kind: "replay", cursor: (JSON.parse(body) as { cursor: number | null }).cursor });
      else if (bytes[0] === 2) this.frames.push({ kind: "heartbeat" });
    });
    this.socket.addEventListener("close", (event: CloseEvent) => {
      this.closed = { code: event.code, reason: event.reason };
    });
  }

  /** read through a method, so an assertion that it was null earlier does not narrow it for good */
  closure(): { code: number; reason: string } | null {
    return this.closed;
  }

  send(text: string) {
    this.socket.send(text);
  }

  close() {
    this.socket.close(1000, "done");
  }

  /** everything typed out since frame `from`, as one string */
  text(from = 0): string {
    return this.frames
      .slice(from)
      .map((f) => (f.kind === "text" ? f.text : ""))
      .join("");
  }

  /** the cursor after everything received: the last meta plus the text after it */
  cursor(): number | null {
    let at: number | null = null;
    for (const f of this.frames) {
      if (f.kind === "meta") at = f.cursor;
      else if (f.kind === "text" && at !== null) at += f.text.length;
    }
    return at;
  }

  metas(): number[] {
    return this.frames.flatMap((f) => (f.kind === "meta" ? [f.cursor] : []));
  }
}

async function stepRest() {
  log("—— rest: every route through boxbox, gate applied ——");
  const refused = await fetch(`${APP}/api/hosts/bench/pty`);
  check(refused.status === 401, `without the cookie GET /api/hosts/bench/pty -> ${refused.status}`);
  const shells = await call("GET", "/api/hosts/bench/pty/shells");
  check(shells.status === 200 && Array.isArray(shells.json) && shells.json.length > 0, "the host lists its shells");
  const pty = await newTerminal("rest check");
  const list = await call("GET", "/api/hosts/bench/pty");
  check((list.json as Pty[]).some((p) => p.id === pty.id), "the list holds it");
  const one = await call("GET", `/api/hosts/bench/pty/${pty.id}`);
  check((one.json as Pty).status === "running", "it is running");
  const renamed = await call("PUT", `/api/hosts/bench/pty/${pty.id}`, { title: "renamed" });
  check((renamed.json as Pty).title === "renamed", "rename took");
  const resized = await call("PUT", `/api/hosts/bench/pty/${pty.id}`, { size: { rows: 31, cols: 97 } });
  check(resized.status === 200, "resize took");
  const wire = new Wire(pty.id);
  await wire.opened;
  await until("the replay ends", () => wire.metas().length > 0);
  wire.send("stty size\r");
  const size = await until("stty answers", () => /\b31 97\b/.exec(wire.text())?.[0], 10_000);
  check(size === "31 97", `stty size in the shell says ${size}`);
  wire.close();
  const bad = await call("PUT", `/api/hosts/bench/pty/${pty.id}`, { size: { rows: 0, cols: 80 } });
  check(bad.status === 400, "a zero-row size is refused before the host sees it");
  const missing = await call("GET", "/api/hosts/bench/pty/pty_nope");
  check(missing.status === 404, "an unknown terminal is a 404 in boxbox's shape");
  const killed = await call("DELETE", `/api/hosts/bench/pty/${pty.id}`);
  check(killed.json === true, "kill answers true");
  const after = await call("GET", "/api/hosts/bench/pty");
  check(!(after.json as Pty[]).some((p) => p.id === pty.id), "the killed terminal left the list");
}

async function stepRelay() {
  log("—— relay: replay, typing, resume, redial after a cut, exit ——");
  const pty = await newTerminal("relay check");
  const first = new Wire(pty.id);
  await first.opened;
  await until("the first replay ends", () => first.metas().length > 0);
  log(`first dial: ${first.frames.length} frames, meta cursor ${first.metas()[0]}`);
  first.send("echo relay-$((6*7))\r");
  await until("the shell answers", () => first.text().includes("relay-42"), 10_000);
  check(true, "typed input reached the shell and its output came back: relay-42");
  const cursor = first.cursor();
  check(cursor !== null && cursor > 0, `the browser-side cursor is ${cursor}`);
  first.close();
  await Bun.sleep(200);

  const resumed = new Wire(pty.id, cursor ?? 0);
  await resumed.opened;
  await until("the resume's replay ends", () => resumed.metas().length > 0);
  const replayedText = resumed.text();
  check(resumed.metas()[0] === cursor && replayedText === "", `a resume from ${cursor} replays nothing new (meta ${resumed.metas()[0]}, ${replayedText.length} units)`);

  // output that keeps coming while the relay's upstream is cut: the redial must replay what it missed,
  // exactly once, in order
  const logAt = serverLog().length;
  const textAt = resumed.frames.length;
  resumed.send("for i in $(seq 1 60); do echo tick-$i; sleep 0.05; done; echo ticks-$((1000+1))\r");
  await until("the ticks start", () => resumed.text(textAt).includes("tick-10"), 10_000);
  await cut();
  const redialLine = await until("the relay logs its redial", () => serverLog(logAt).split("\n").find((l) => l.includes("terminal redialled")), 15_000);
  const lostLine = serverLog(logAt).split("\n").find((l) => l.includes("terminal lost its host")) ?? "";
  log(`server: ${lostLine.trim()}`);
  log(`server: ${redialLine.trim()}`);
  await until("the ticks finish", () => resumed.text(textAt).includes("ticks-1001"), 15_000);
  const ticks = [...resumed.text(textAt).matchAll(/^tick-(\d+)\r$/gm)].map((m) => Number(m[1]));
  const inOrder = ticks.length === 60 && ticks.every((n, i) => n === i + 1);
  check(inOrder, `every tick arrived exactly once and in order across the cut (${ticks.length} of 60, first ${ticks[0]}, last ${ticks.at(-1)})`);
  const replayed = Number(/replayed=(\d+)/.exec(redialLine)?.[1] ?? 0);
  check(replayed > 0, `the redial replayed ${replayed} units the daemon wrote while the relay was cut off`);
  const notice = resumed.frames.find((f) => f.kind === "replay");
  check(notice?.kind === "replay" && notice.cursor !== null, `the browser was told the replay restarts from cursor ${notice?.kind === "replay" ? notice.cursor : "?"}`);
  check(resumed.closed === null, "the browser's socket stayed open through the cut");
  check(resumed.metas().length === 2, `a second meta closed the redial's replay at ${resumed.metas()[1]}`);

  resumed.send("exit\r");
  const exited = await until("the relay closes on exit", () => resumed.closure() ?? undefined, 10_000);
  check(exited.code === 1000, `exit closes with ${exited.code} "${exited.reason}"`);
  const gone = new Wire(pty.id);
  await gone.opened.catch(() => undefined);
  await until("a dial to the exited terminal closes", () => gone.closed ?? undefined, 10_000);
  // cmx2 keeps an exited terminal's output until it forgets it: a dial replays it and closes 1000, later ones 4404
  check(gone.closed?.code === 1000 || gone.closed?.code === 4404, `dialling it again closes with ${gone.closed?.code} "${gone.closed?.reason}"`);
}

async function stepOverflow() {
  log("—— overflow: a reader that stops reading while 10 mb streams ——");
  const pty = await newTerminal("overflow check");
  const logAt = serverLog().length;
  const samples: number[] = [rssKb()];
  // bench/stall.py: a real stalled reader (4 kb receive buffer, no reads for 10 s)
  const reader = spawn(
    "python3",
    [join(ROOT, "bench/stall.py"), "--port", String(BOXBOX_PORT), "--pty", pty.id, "--cookie", cookie, "--line", FLOOD, "--stall", "10", "--then", AFTER, "--marker", "after-42"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
  );
  let said = "";
  reader.stdout?.on("data", (chunk: Buffer) => {
    said += chunk.toString();
    for (const line of chunk.toString().trim().split("\n")) log(line);
  });
  const finished = new Promise<number>((resolve) => reader.once("exit", (code) => resolve(code ?? 1)));
  const sampler = setInterval(() => samples.push(rssKb()), 1000);
  const code = await finished;
  clearInterval(sampler);
  samples.push(rssKb());
  const lines = serverLog(logAt).split("\n");
  const lost = lines.filter((l) => l.includes("cause=\"overflow\""));
  const redials = lines.filter((l) => l.includes("terminal redialled"));
  check(lost.length > 0, `live output found the 256 kb queue full and the relay let go of the daemon ${lost.length} time(s): ${lost[0]?.trim()}`);
  check(redials.length >= lost.length, `and redialled from its cursor each time; last: ${redials.at(-1)?.trim()}`);
  check(code === 0 && said.includes("after-42 arrived"), "after the overflow and the redial the terminal is live: a line typed afterwards came back");
  const replayed = /replayed=(\d+) dropped=(\d+)/.exec(redials.at(-1) ?? "");
  if (replayed && Number(replayed[1]) === 0 && Number(replayed[2]) > 0) {
    log(`known cmx2 gap a14: the redial into dropped output replayed nothing (dropped=${replayed[2]}); the retained tail should have come (docs/cmx2-asks.md)`);
  }
  const after = Number(/(\d+) of them after the next line/.exec(said)?.[1] ?? 0);
  if (after < AFTER_BYTES) {
    log(`known cmx2 gap a14: of about ${AFTER_BYTES} bytes the next command printed (framing aside), ${after} arrived; the daemon swallowed about ${AFTER_BYTES - after} bytes of live output after the redial`);
  }
  log(`server rss (kb), every second, stalled then reading: ${samples.join(" ")}`);
  const peak = Math.max(...samples);
  const base = samples[0] ?? 0;
  check(peak - base < 8 * 1024, `rss stayed within 8 mb of where it started (start ${base} kb, peak ${peak} kb)`);
  await call("DELETE", `/api/hosts/bench/pty/${pty.id}`);
}

/* —— the browser: agent-browser's cli —— */

function browser(...argv: string[]): string {
  const out = spawnSync("agent-browser", argv, { encoding: "utf8", timeout: 60_000 });
  if (out.status !== 0) throw new Error(`agent-browser ${argv[0]} failed: ${out.stderr.trim() || out.stdout.trim()}`);
  return out.stdout.trim();
}

async function stepBrowser() {
  log("—— browser: see bench/terminal-browser.ts ——");
  const { driveBrowser } = await import("./terminal-browser");
  await driveBrowser({ browser, log, check, until, cut, restartServer, serverLog, rssKb, gatePassword, app: APP, out: OUT, flood: FLOOD, root: ROOT });
}

const RUN: Record<Step, () => Promise<void>> = { rest: stepRest, relay: stepRelay, overflow: stepOverflow, browser: stepBrowser };

let failed = false;
try {
  await startAll();
  await signIn();
  if (HOLD) {
    log(`holding: sign in at ${APP} with the password in ${join(BENCH, "gate-password")}; ctrl-c stops everything`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } else {
    for (const step of steps) await RUN[step]();
  }
} catch (e) {
  failed = true;
  log(e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await stopAll();
}
log(failed ? "the terminal drive FAILED" : `the terminal drive passed: ${HOLD ? "held" : steps.join(", ")}`);
process.exit(failed ? 1 : 0);
