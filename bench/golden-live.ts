/* contract 1's live goldens: what boxbox answers on the routes that need a
   real cmx2 daemon behind it, recorded so a rewrite of the fleet pipeline
   can be held to the same answers (docs/verification.md, contract 1
   goldens).

     cargo build --locked && bun bench/golden-live.ts record   write server/goldens/contract1/live/*.json
     cargo build --locked && bun bench/golden-live.ts check    run the same session, compare, print a table

   one session, in this order, each step waiting for the daemon to settle so
   the answers do not depend on timing:

     hydration  a finished thread's transcript, one message, a page of each
                with its cursor, plain and gzipped; history and its pages
     prompt     the 202 of a first prompt, the 202 of its repeat, the 409 of
                its client id sent to another thread
     pty        a terminal running cat: dial, type, hang up, redial with the
                cursor, redial from the start
     review     three checkouts: one merged, one discarded, one refused
                (uncommitted work), with the review read of each first

   every answer is normalised before it is written or compared: cmx2's ids,
   times, seqs, shas and the world directory become placeholders numbered in
   the order a golden first shows them, and the machine's name is scrubbed
   (cmx2 writes it into a turn's context; AGENTS.md, public repo). everything else
   is kept byte for byte.

   it owns everything it runs and stops all of it on the way out: the pinned
   daemon on 4954 with the bench model on 4955, and a copy of the debug
   binary (or GOLDEN_LIVE_BINARY) on 4957, all under GOLDEN_LIVE_WORLD (default under /tmp; AGENTS.md,
   scratch in /tmp); GOLDEN_LIVE_PORTS moves the three ports. it refuses to start if any of its ports answer. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { baseEnv, basicAuth, daemonArgs, daemonDirs, daemonEnv, exportPin, mintPassword, modelArgs, writeDaemonConfig } from "../scripts/pinned";

const ROOT = resolve(import.meta.dir, "..");
const GOLDENS = join(ROOT, "server/goldens/contract1/live");
const SCRATCH = process.env.GOLDEN_LIVE_WORLD ?? "/tmp/boxbox-agents-build/goldens/live/world";
/** the server under test: the debug build, or GOLDEN_LIVE_BINARY when target/debug holds a build with other features */
const BUILT = process.env.GOLDEN_LIVE_BINARY ?? join(ROOT, "target/debug/boxbox");
/** a parallel lane runs it on its own ports (docs/gotchas.md, parallel lanes): GOLDEN_LIVE_PORTS="daemon,model,boxbox" */
const [DAEMON_PORT, MODEL_PORT, BOXBOX_PORT] = ports(process.env.GOLDEN_LIVE_PORTS, [4954, 4955, 4957]);
const APP = `http://127.0.0.1:${BOXBOX_PORT}`;
const HOST = "bench";
/** this machine's name, as cmx2 writes it into a turn's context */
const MACHINE = hostname().replace(/\.local$/, "");

const started = performance.now();
function log(line: string): void {
  console.log(`[${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`);
}

function ports(text: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!text) return fallback;
  const parsed = text.split(",").map(Number);
  const [daemon, model, boxbox] = parsed;
  if (parsed.length !== 3 || daemon === undefined || model === undefined || boxbox === undefined || parsed.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)) {
    throw new Error(`GOLDEN_LIVE_PORTS is "${text}"; give three ports, daemon,model,boxbox`);
  }
  return [daemon, model, boxbox];
}

function listening(port: number): boolean {
  return spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0;
}

async function until(what: string, test: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await test()) return;
    await Bun.sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/* —— normalising —— */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** the patterns that vary from run to run, each with the placeholder family it maps into */
const IDS: Array<[RegExp, string]> = [
  [/\b(?:ses|msg|prt|pty|job|per|que|call|toolu|evt|cmp)_[A-Za-z0-9]{8,}(?:_\d+)*\b/g, "id"],
  [/\b[0-9a-f]{40}\b/g, "sha"],
];
/** keys whose numbers are durations; a time is told by its size (a ms stamp), since a key like compactAt is not one */
const DURATION_KEY = /^(?:ms|.*Ms|.*_ms|duration|elapsed|latency.*)$/;
const SEQ_KEY = /^(?:seq|epoch|head|lastSeq|fromSeq|toSeq)$/;
/** keys whose strings are random words */
const SLUG_KEY = /^slug$/;

/** one golden's placeholders: each distinct value gets the next number of its family, in first-seen order */
class Scrub {
  private readonly seen = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private readonly world: string[];
  private readonly secrets: Array<[string, string]>;

  /** `secrets` are the run's minted passwords, by the name they are shown under */
  constructor(world: string, secrets: Record<string, string>) {
    // macos resolves /tmp to /private/tmp, and cmx2 reports real paths
    this.world = [`/private${world}`, world];
    this.secrets = Object.entries(secrets).filter(([, v]) => v.length > 0);
  }

  private place(family: string, raw: string): string {
    const known = this.seen.get(raw);
    if (known) return known;
    const n = (this.counts.get(family) ?? 0) + 1;
    this.counts.set(family, n);
    const placeholder = `<${family} ${n}>`;
    this.seen.set(raw, placeholder);
    return placeholder;
  }

  /** a short sha; git's all-zero one (a file that did not exist) stays */
  private short(sha: string): string {
    return /^0+$/.test(sha) ? sha : this.place("short", sha);
  }

  text(raw: string): string {
    let out = raw;
    for (const [name, secret] of this.secrets) out = out.replaceAll(secret, `<${name}>`);
    for (const world of this.world) out = out.replaceAll(world, "<world>");
    out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (match) => this.place("uuid", match));
    out = out.replaceAll(homedir(), "<home>").replaceAll(MACHINE, "bench-host");
    for (const [pattern, family] of IDS) {
      out = out.replace(pattern, (match) => this.place(family === "id" ? (match.split("_")[0] ?? "id") : family, match));
    }
    // a checkout's home names its project with a hash: <data>/worktree/<repo>-<hash>/<name>
    out = out.replace(/(\/worktree\/[\w.]+-)([0-9a-f]{6,})(?=\/)/g, (_, lead: string, hash: string) => `${lead}${this.place("project", hash)}`);
    // short shas where git prints them: a diff's index line, a commit's first line, a one-line log
    out = out.replace(/\bindex ([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/g, (_, from: string, to: string) => `index ${this.short(from)}..${this.short(to)}`);
    out = out.replace(/(^|\n|\[[\w/.-]+ )([0-9a-f]{7,12})(?= )/g, (_, lead: string, sha: string) => `${lead}${this.short(sha)}`);
    // anywhere else, seven or more hex digits with a digit and a letter, standing alone
    out = out.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b/g, (match) => (match.startsWith("<") ? match : this.place("short", match)));
    out = out.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<date>");
    out = out.replace(/\b1[5-9]\d{11}\b/g, "<time>");
    return out;
  }

  value(value: Json, key = ""): Json {
    if (typeof value === "number") {
      if (SEQ_KEY.test(key)) return "<seq>";
      if (DURATION_KEY.test(key)) return "<ms>";
      if (value > 1.5e12 && value < 2e12) return "<time>";
      return value;
    }
    if (typeof value === "string") {
      if (SEQ_KEY.test(key)) return "<epoch>";
      return SLUG_KEY.test(key) ? this.place("slug", value) : this.text(value);
    }
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (value && typeof value === "object") {
      const out: { [key: string]: Json } = {};
      for (const [k, v] of Object.entries(value)) out[this.text(k)] = this.value(v, k);
      return out;
    }
    return value;
  }
}

/* —— the world —— */

class World {
  private children: ChildProcess[] = [];
  private stopping = false;
  password = "";
  gate = "";
  cookie = "";
  repo = "";
  private prompts = 0;

  async start(): Promise<void> {
    for (const port of [DAEMON_PORT, MODEL_PORT, BOXBOX_PORT]) {
      if (listening(port)) throw new Error(`port ${port} is taken; the goldens start their own daemon, model and server`);
    }
    if (!existsSync(BUILT)) throw new Error("no debug binary; run `cargo build --locked` first");
    exportPin((line) => log(`cmx2: ${line}`));
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    // a copy, so a rebuild of target/debug under the run cannot swap the binary
    const binary = join(SCRATCH, "boxbox");
    copyFileSync(BUILT, binary);
    const dirs = daemonDirs(join(SCRATCH, "daemon"));
    writeDaemonConfig(dirs, MODEL_PORT);
    this.password = mintPassword(join(SCRATCH, "password"), "bench");
    this.repo = join(SCRATCH, "repos", "ledger");
    makeRepo(this.repo);
    this.spawn("model", "bun", modelArgs(MODEL_PORT), ROOT, baseEnv());
    this.spawn("daemon", "bun", daemonArgs(DAEMON_PORT), dirs.work, daemonEnv(dirs, this.password));
    await until("the daemon's health", async () => (await this.daemon("GET", "/global/health").catch(() => null))?.ok === true);
    const boxbox = join(SCRATCH, "boxbox-config");
    mkdirSync(boxbox, { recursive: true });
    this.gate = mintPassword(join(boxbox, "gate-password"), "gate");
    // the gate's cookie keeps v1's name, bb_session, which the board's client read when it was a bun daemon
    const config = [
      "# written by bench/golden-live.ts; never a real password",
      `listen = "127.0.0.1:${BOXBOX_PORT}"`,
      `data_dir = "${join(boxbox, "data")}"`,
      `password = "${this.gate}"`,
      "",
      "[cookie]",
      'name = "bb_session"',
      "secure = false",
      "",
      "[[host]]",
      `name = "${HOST}"`,
      `url = "http://127.0.0.1:${DAEMON_PORT}"`,
      `password = "${this.password}"`,
    ];
    writeFileSync(join(boxbox, "boxbox.toml"), `${config.join("\n")}\n`, { mode: 0o600 });
    this.spawn("boxbox", binary, ["serve", "--config", join(boxbox, "boxbox.toml")], ROOT, { ...baseEnv(), RUST_LOG: "warn" });
    await until(`boxbox on ${BOXBOX_PORT}`, () => listening(BOXBOX_PORT));
    const login = await fetch(`${APP}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: this.gate }) });
    if (!login.ok) throw new Error(`boxbox refused the gate password (${login.status})`);
    this.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    log(`world up: daemon ${DAEMON_PORT}, model ${MODEL_PORT}, boxbox ${APP}`);
  }

  daemon(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${DAEMON_PORT}${path}`, {
      method,
      headers: { authorization: basicAuth(this.password), "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async session(directory: string, title: string): Promise<string> {
    const created = await this.daemon("POST", "/session", { directory, title });
    if (!created.ok) throw new Error(`POST /session answered ${created.status}: ${await created.text()}`);
    return ((await created.json()) as { id: string }).id;
  }

  async prompt(id: string, text: string): Promise<void> {
    this.prompts += 1;
    const sent = await this.daemon("POST", `/session/${id}/prompt_async`, { text, clientID: `golden-world-${this.prompts}` });
    if (!sent.ok) throw new Error(`prompt_async on ${id} answered ${sent.status}: ${await sent.text()}`);
  }

  /** every session idle, and staying idle for `quietMs`: a helper that reports after its lead's turn wakes the lead */
  async settled(quietMs = 2000, timeoutMs = 90_000): Promise<void> {
    let quietSince = 0;
    await until(
      "every session to settle",
      async () => {
        const status = (await (await this.daemon("GET", "/session/status?parked=true")).json()) as Record<string, { type?: string }>;
        const busy = Object.values(status).some((s) => s.type !== undefined && s.type !== "idle");
        if (busy) {
          quietSince = 0;
          return false;
        }
        if (!quietSince) quietSince = performance.now();
        return performance.now() - quietSince >= quietMs;
      },
      timeoutMs,
    );
  }

  /** the fleet holds the session: boxbox's routes that read its info can find it */
  async held(id: string): Promise<void> {
    await until(`the fleet to hold ${id}`, async () => (await (await this.app("GET", "/api/fleet")).text()).includes(id));
  }

  app(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${APP}${path}`, {
      method,
      headers: { cookie: this.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      decompress: false,
    });
  }

  private spawn(name: string, command: string, argv: string[], cwd: string, env: Record<string, string>) {
    const out = Bun.file(join(SCRATCH, `${name}.log`)).writer();
    const child = spawn(command, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => out.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => out.write(chunk));
    child.once("exit", (code, signal) => {
      void out.end();
      if (!this.stopping) log(`${name} exited (${signal ?? code}); see ${SCRATCH}/${name}.log`);
    });
    log(`started ${name} (pid ${child.pid})`);
    this.children.push(child);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const child of this.children) {
      if (!child.pid || child.exitCode !== null) continue;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await Promise.race([Promise.all(this.children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))), Bun.sleep(5000)]);
    for (const child of this.children) {
      if (!child.pid || child.exitCode !== null) continue;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* it went while we waited */
      }
    }
    const still = [DAEMON_PORT, MODEL_PORT, BOXBOX_PORT].filter(listening);
    log(`stopped; listening on ${DAEMON_PORT}, ${MODEL_PORT}, ${BOXBOX_PORT}: ${still.join(", ") || "nothing"}`);
  }
}

/** a scratch repo with one commit, made with the caller's git config kept out */
function makeRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# ledger\n\na scratch repo for boxbox's contract goldens.\n");
  writeFileSync(join(dir, "notes.md"), "# notes\n\ngreeting: hello\n");
  const env = { ...baseEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${out.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "scratch");
}

/* —— recording an answer —— */

/** the headers a golden keeps: the ones the contract names */
const KEPT = ["content-type", "content-encoding", "vary", "x-cmx2-seq", "x-next-cursor", "x-cmx2-repeat"];

type Golden = { golden: string; proves: string; [key: string]: Json };

async function answer(res: Response): Promise<{ status: number; headers: Record<string, string>; body: Json }> {
  const headers: Record<string, string> = {};
  for (const name of KEPT) {
    const value = res.headers.get(name);
    if (value === null) continue;
    // the seq is `<epoch>:<seq>` and the cursor a number: their presence and shape are the contract, not their values
    if (name === "x-cmx2-seq") headers[name] = value.replace(/^[0-9a-z]+:\d+$/, "<epoch>:<seq>");
    else if (name === "x-next-cursor") headers[name] = value.replace(/^\d+$/, "<cursor>");
    else headers[name] = value;
  }
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (res.headers.get("content-encoding") === "gzip") bytes = Bun.gunzipSync(bytes);
  const text = new TextDecoder().decode(bytes);
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    body = text;
  }
  return { status: res.status, headers, body };
}

type Request = { method: string; path: string; body?: Json; gzip?: boolean };

/** one request through boxbox, kept as a golden */
async function exchange(world: World, golden: string, proves: string, request: Request): Promise<Golden> {
  const headers: Record<string, string> = request.gzip ? { "accept-encoding": "gzip" } : { "accept-encoding": "identity" };
  const res = await world.app(request.method, request.path, request.body, headers);
  const got = await answer(res);
  // shown decoded, so an id inside a cursor maps like any other
  const shown: Json = { method: request.method, path: decodeURIComponent(request.path), "accept-encoding": headers["accept-encoding"] ?? null, ...(request.body === undefined ? {} : { body: request.body }) };
  return { golden, proves, request: shown, status: got.status, headers: got.headers, body: got.body };
}

/* —— the session —— */

const DEVICE = { device: "golden-phone", deviceClass: "iphone" };

async function hydration(world: World, out: Golden[]): Promise<{ a: string; p: string; q: string }> {
  const a = await world.session(world.repo, "hydrate the transcript");
  await world.prompt(a, "[bench:work 40 1 notes.md] tidy the notes");
  await world.settled();
  await world.held(a);
  const base = `/api/hosts/${HOST}/sessions/${a}`;
  out.push(await exchange(world, "transcript-gzipped", "the whole transcript, gzipped when asked, with the daemon's seq and no cursor when it is all there", { method: "GET", path: `${base}/messages`, gzip: true }));
  out.push(await exchange(world, "transcript-plain", "the same transcript without gzip when the client does not ask for it", { method: "GET", path: `${base}/messages` }));
  const page = await exchange(world, "transcript-last-page", "a page of one message, newest last, with x-next-cursor naming the page before it", { method: "GET", path: `${base}/messages?limit=1`, gzip: true });
  out.push(page);
  const raw = await world.app("GET", `${base}/messages?limit=1`, undefined, { "accept-encoding": "identity" });
  const cursor = raw.headers.get("x-next-cursor");
  await raw.arrayBuffer();
  if (cursor) out.push(await exchange(world, "transcript-page-before", "the page before, read with the cursor the last page gave", { method: "GET", path: `${base}/messages?limit=1&before=${cursor}`, gzip: true }));
  const list = (await (await world.app("GET", `${base}/messages`, undefined, { "accept-encoding": "identity" })).json()) as Array<{ info: { id: string; role: string } }>;
  const assistant = list.find((m) => m.info.role === "assistant");
  if (!assistant) throw new Error("the transcript has no assistant message");
  out.push(await exchange(world, "message-one-gzipped", "one message, {info, parts}, gzipped, with the daemon's seq", { method: "GET", path: `${base}/messages/${assistant.info.id}`, gzip: true }));
  out.push(await exchange(world, "message-unknown", "a message the daemon does not have is the daemon's own 404, passed through as it wrote it", { method: "GET", path: `${base}/messages/msg_doesnotexist0000`, gzip: true }));
  out.push(await exchange(world, "transcript-bad-id", "an id that could step out of its path segment is refused before the daemon hears it", { method: "GET", path: `/api/hosts/${HOST}/sessions/bad%2Fid/messages`, gzip: true }));
  out.push(await exchange(world, "transcript-unknown-host", "a host boxbox does not know is a 404 naming it", { method: "GET", path: `/api/hosts/nowhere/sessions/${a}/messages`, gzip: true }));

  // the prompt route, on two more threads
  const p = await world.session(world.repo, "the prompt route");
  const q = await world.session(world.repo, "another thread");
  await world.held(p);
  await world.held(q);
  const prompt = { ...DEVICE, clientID: "golden-prompt-1", text: "[bench:words 4 1] say four words" };
  out.push(await exchange(world, "prompt-accepted", "a prompt is 202 with the daemon's {messageID, queued} and repeat false", { method: "POST", path: `/api/hosts/${HOST}/sessions/${p}/prompt`, body: prompt, gzip: true }));
  await world.settled();
  out.push(await exchange(world, "prompt-repeat", "the same client id again is 202 with the first answer and repeat true; nothing new runs", { method: "POST", path: `/api/hosts/${HOST}/sessions/${p}/prompt`, body: prompt, gzip: true }));
  out.push(await exchange(world, "prompt-client-id-taken", "a client id already used on another thread is 409; today boxbox reads the daemon's ConflictError as settled, by someone", { method: "POST", path: `/api/hosts/${HOST}/sessions/${q}/prompt`, body: prompt, gzip: true }));
  out.push(await exchange(world, "prompt-not-a-device", "a prompt without a device class boxbox knows is 400 before the daemon hears it", { method: "POST", path: `/api/hosts/${HOST}/sessions/${p}/prompt`, body: { ...prompt, deviceClass: "toaster", clientID: "golden-prompt-2" }, gzip: true }));
  await world.settled();

  out.push(await exchange(world, "history-first-page", "history, newest first, every thread of the host, gzipped", { method: "GET", path: "/api/history", gzip: true }));
  const first = await world.app("GET", "/api/history?limit=2", undefined, { "accept-encoding": "identity" });
  const next = ((await first.json()) as { next?: string }).next;
  out.push(await exchange(world, "history-page-of-two", "a page of two threads with the cursor of the next", { method: "GET", path: "/api/history?limit=2", gzip: true }));
  if (next) out.push(await exchange(world, "history-next-page", "the page after, read with the cursor as it came", { method: "GET", path: `/api/history?limit=2&before=${encodeURIComponent(next)}`, gzip: true }));
  out.push(await exchange(world, "history-search", "a search matches a title, any case", { method: "GET", path: "/api/history?q=PROMPT", gzip: true }));
  return { a, p, q };
}

type Frame = { kind: "text"; text: string } | { kind: "meta"; cursor: number } | { kind: "replay"; cursor: number | null } | { kind: "heartbeat" } | { kind: "closed"; code: number; reason: string };

/** a raw websocket through the relay, speaking docs/terminal.md */
class Wire {
  readonly frames: Frame[] = [];
  private socket: WebSocket;
  opened: Promise<void>;
  closedAt: Promise<void>;

  constructor(cookie: string, pty: string, cursor?: number) {
    const query = cursor === undefined ? "" : `?cursor=${cursor}`;
    this.socket = new WebSocket(`ws://127.0.0.1:${BOXBOX_PORT}/api/hosts/${HOST}/pty/${pty}/connect${query}`, { headers: { cookie } } as unknown as string[]);
    this.socket.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("the websocket failed")));
    });
    this.closedAt = new Promise((resolve) => this.socket.addEventListener("close", () => resolve()));
    this.socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        // text arrives in whatever pieces the pump made; one run of it is one frame here
        const last = this.frames.at(-1);
        if (last?.kind === "text") last.text += event.data;
        else this.frames.push({ kind: "text", text: event.data });
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const body = new TextDecoder().decode(bytes.subarray(1));
      if (bytes[0] === 0) this.frames.push({ kind: "meta", cursor: (JSON.parse(body) as { cursor: number }).cursor });
      else if (bytes[0] === 1) this.frames.push({ kind: "replay", cursor: (JSON.parse(body) as { cursor: number | null }).cursor });
      else if (bytes[0] !== 2) this.frames.push({ kind: "text", text: `<binary ${bytes[0]}>` });
    });
    this.socket.addEventListener("close", (event: CloseEvent) => this.frames.push({ kind: "closed", code: event.code, reason: event.reason }));
  }

  send(text: string) {
    this.socket.send(text);
  }

  async close(): Promise<void> {
    this.socket.close(1000, "done");
    await Promise.race([this.closedAt, Bun.sleep(3000)]);
  }

  text(): string {
    return this.frames.map((f) => (f.kind === "text" ? f.text : "")).join("");
  }

  /** the cursor after everything received: the last meta plus the text after it, in utf-16 units */
  cursor(): number | null {
    let at: number | null = null;
    for (const f of this.frames) {
      if (f.kind === "meta") at = f.cursor;
      else if (f.kind === "text" && at !== null) at += f.text.length;
    }
    return at;
  }
}

async function pty(world: World, out: Golden[]): Promise<void> {
  const created = await world.app("POST", `/api/hosts/${HOST}/pty`, { title: "golden terminal", command: "/bin/cat", cwd: world.repo });
  const info = (await answer(created)).body as { id?: string };
  if (!info.id) throw new Error(`the terminal did not open: ${JSON.stringify(info)}`);
  const id = info.id;
  const steps: Json[] = [];
  const first = new Wire(world.cookie, id);
  await first.opened;
  await until("the first dial's meta frame", () => first.frames.some((f) => f.kind === "meta"), 10_000);
  first.send("golden one\r");
  await until("the echo of the first line", () => first.text().split("golden one").length >= 3, 10_000);
  const cursor = first.cursor();
  await first.close();
  steps.push({ step: "dial with no cursor, type a line, hang up", sent: "golden one\\r", frames: first.frames as unknown as Json, cursor });

  const resumed = new Wire(world.cookie, id, cursor ?? 0);
  await resumed.opened;
  await until("the redial's meta frame", () => resumed.frames.some((f) => f.kind === "meta"), 10_000);
  resumed.send("golden two\r");
  await until("the echo of the second line", () => resumed.text().split("golden two").length >= 3, 10_000);
  const after = resumed.cursor();
  await resumed.close();
  steps.push({ step: "redial with that cursor: nothing replayed, then type again", cursor: cursor ?? null, sent: "golden two\\r", frames: resumed.frames as unknown as Json, after });

  const replay = new Wire(world.cookie, id, 0);
  await replay.opened;
  await until("the full replay's meta frame", () => replay.frames.some((f) => f.kind === "meta"), 10_000);
  await Bun.sleep(300);
  await replay.close();
  steps.push({ step: "redial from 0: everything retained, then the meta frame", cursor: 0, frames: replay.frames as unknown as Json });

  const live = new Wire(world.cookie, id, -1);
  await live.opened;
  await until("the live-only dial's meta frame", () => live.frames.some((f) => f.kind === "meta"), 10_000);
  await Bun.sleep(300);
  await live.close();
  steps.push({ step: "redial with -1: only what comes next", cursor: -1, frames: live.frames as unknown as Json });

  const bad = await fetch(`${APP}/api/hosts/${HOST}/pty/${id}/connect?cursor=-2`, {
    headers: { cookie: world.cookie, connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "Z29sZGVuLWtleS0wMDAwMA==" },
  });
  const refused = await answer(bad);
  steps.push({ step: "a websocket dial with a cursor below -1 is refused before the upgrade", status: refused.status, body: refused.body });
  await (await world.app("DELETE", `/api/hosts/${HOST}/pty/${id}`)).arrayBuffer();
  out.push({ golden: "pty-redial", proves: "a terminal's relay: the first dial ends its replay with a meta cursor, a redial with that cursor replays nothing and carries on, a redial from 0 replays everything, -1 replays nothing", steps });
}

async function review(world: World, out: Golden[]): Promise<void> {
  const checkouts: Record<string, { directory: string; session: string }> = {};
  for (const name of ["golden-merge", "golden-discard", "golden-refused"]) {
    const made = await world.daemon("POST", "/experimental/worktree", { name, wait: true }, { "x-cmx2-directory": world.repo });
    if (!made.ok) throw new Error(`POST /experimental/worktree answered ${made.status}: ${await made.text()}`);
    const { directory } = (await made.json()) as { directory: string };
    const session = await world.session(directory, `review ${name.slice(7)}`);
    checkouts[name] = { directory, session };
  }
  // one at a time, so each checkout's helper and review need land in the same order every run
  for (const name of ["golden-merge", "golden-discard"]) {
    const c = checkouts[name];
    if (!c) continue;
    await world.prompt(c.session, `[bench:review ${name.slice(7)}.txt] add the file`);
    await world.settled(2500);
  }
  const refused = checkouts["golden-refused"];
  if (!refused) throw new Error("no refused checkout");
  await world.prompt(refused.session, "[bench:review refused.txt] add the file");
  await world.settled(2500);
  writeFileSync(join(refused.directory, "uncommitted.txt"), "work nobody committed\n");
  for (const c of Object.values(checkouts)) await world.held(c.session);

  const at = (name: string) => `/api/hosts/${HOST}/sessions/${checkouts[name]?.session}/review`;
  out.push(await exchange(world, "review-read-merge", "a checkout's review: the branch beyond its base, files with counts, the patch, and the open review need's checkout name", { method: "GET", path: at("golden-merge"), gzip: true }));
  out.push(await exchange(world, "review-read-refused", "a checkout with uncommitted work reads as dirty", { method: "GET", path: at("golden-refused"), gzip: true }));
  out.push(await exchange(world, "review-merge", "a merge squashes the branch into its base: the daemon's answer as it came", { method: "POST", path: `${at("golden-merge")}/merge`, body: { message: "add merge.txt from the checkout" }, gzip: true }));
  out.push(await exchange(world, "review-discard", "a discard removes the checkout, keeping its last state under a ref", { method: "POST", path: `${at("golden-discard")}/discard`, gzip: true }));
  out.push(await exchange(world, "review-merge-refused", "a merge the daemon refuses (uncommitted work) is 409 with the flat CheckoutRefusal", { method: "POST", path: `${at("golden-refused")}/merge`, gzip: true }));
  out.push(await exchange(world, "review-merge-gone", "the merged checkout's review again: the daemon no longer has it", { method: "GET", path: at("golden-merge"), gzip: true }));
  const base = spawnSync("git", ["log", "--format=%s", "main"], { cwd: world.repo, encoding: "utf8", env: { ...baseEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  out.push({ golden: "review-base-after", proves: "the base branch holds the squash commit and nothing of the discarded or refused checkouts", log: base.stdout.trim().split("\n") });
}

/* —— record and check —— */

function normalise(golden: Golden, world: World): string {
  const scrub = new Scrub(SCRATCH, { "gate password": world.gate, "daemon password": world.password });
  return `${JSON.stringify(scrub.value(golden as unknown as Json), null, 2)}\n`;
}

/** the first place two goldens differ, as a line number and the two lines */
function firstDifference(want: string, got: string): string | null {
  if (want === got) return null;
  const a = want.split("\n");
  const b = got.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: golden ${JSON.stringify(a[i] ?? "<end>").slice(0, 120)} / now ${JSON.stringify(b[i] ?? "<end>").slice(0, 120)}`;
  }
  return "differs";
}

async function session(world: World): Promise<Golden[]> {
  const out: Golden[] = [];
  await hydration(world, out);
  log(`hydration and prompt: ${out.length} goldens`);
  await pty(world, out);
  log("pty: redial recorded");
  await review(world, out);
  log("review: merge, discard, refusal recorded");
  await world.settled();
  return out;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "record" && mode !== "check") {
    console.error("usage: bun bench/golden-live.ts record | check");
    process.exit(2);
  }
  const world = new World();
  let code = 0;
  const onSignal = () => void world.stop().then(() => process.exit(130));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await world.start();
    const goldens = await session(world);
    const written = goldens.map((g) => ({ name: g.golden, text: normalise(g, world) }));
    for (const { text } of written) {
      if (text.includes(MACHINE)) throw new Error("a golden still names this machine after scrubbing; refusing to go on");
    }
    if (mode === "record") {
      rmSync(GOLDENS, { recursive: true, force: true });
      mkdirSync(GOLDENS, { recursive: true });
      for (const { name, text } of written) writeFileSync(join(GOLDENS, `${name}.json`), text);
      log(`recorded ${written.length} goldens into ${GOLDENS.slice(ROOT.length + 1)}`);
    } else {
      const want = new Map(existsSync(GOLDENS) ? readdirSync(GOLDENS).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), readFileSync(join(GOLDENS, f), "utf8")] as const) : []);
      const rows: Array<[string, string]> = [];
      for (const { name, text } of written) {
        const golden = want.get(name);
        want.delete(name);
        rows.push([name, golden === undefined ? "missing: no golden recorded" : (firstDifference(golden, text) ?? "match")]);
      }
      for (const name of want.keys()) rows.push([name, "missing: this run did not produce it"]);
      const width = Math.max(...rows.map(([n]) => n.length));
      console.log(`\n${"golden".padEnd(width)}  result`);
      for (const [name, result] of rows) console.log(`${name.padEnd(width)}  ${result}`);
      const failed = rows.filter(([, r]) => r !== "match").length;
      console.log(`\n${rows.length - failed} of ${rows.length} match`);
      if (failed) code = 1;
    }
  } catch (error) {
    console.error(`golden-live: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    code = 1;
  } finally {
    await world.stop();
  }
  process.exit(code);
}
