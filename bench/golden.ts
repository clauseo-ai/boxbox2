/* the contract 1 recording (docs/plan.md, m9's gate; docs/verification.md,
   contract 1 goldens): a scripted session against a real cmx2 dev daemon,
   watched by a boxbox built with the `record` feature, which writes every
   input its fleet actor takes, with the clock it took it at, to a tape.

     bun bench/golden.ts record

   it owns everything it runs and stops all of it at the end: the pinned
   daemon on 4950 with the bench model on 4951 (GOLDEN_DAEMON_PORT moves
   them within the port rule) and the server on 3051 (GOLDEN_BOXBOX_PORT).
   the world lives under /tmp/boxbox-golden (GOLDEN_WORLD): the daemon's
   dirs, two scratch repos, boxbox's config, data and logs. it refuses to
   start if any of its ports answer.

   the session, in order:
     350 threads made before boxbox starts, so its first read of the host
       holds the newest 300 and the rest are history;
     a question asked and answered through boxbox with a device looking;
     a turn that ends with nobody looking (done), marked read, cleared;
     two permissions and two questions in one step, answered through boxbox;
     a turn parked on a background job;
     a long reply streaming while a device has its window in view (tails
       flush on the clock);
     a checkout whose agent asks for review, answered through boxbox,
       then discarded;
     an old thread opened from history (adopt);
     750 more threads, past the 1000 the fleet holds (eviction) and far past
       the 300 the order keeps, and 40 short turns among them (windows);
     streams opened from no cursor, a cursor inside the journal, one ahead
       of it, one from another epoch and one that does not parse;
     `/api/fleet` and `/api/needs` read along the way;
     the whole journal read from cursor 0 once the fleet is quiet.

   it writes server/goldens/contract1/tape.jsonl.gz (the tape) and
   live.json.gz (what the live server sent), with the machine's name
   replaced by a placeholder of the same length (cmx2 writes it into a
   turn's context; this is a public repo). then
   `BOXBOX_GOLDENS=write cargo test protocol3` writes server/goldens/protocol3/
   from the replay, and `cargo test fleet::replay` holds both. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  baseEnv,
  basicAuth,
  checkPort,
  daemonArgs,
  daemonDirs,
  daemonEnv,
  exportPin,
  mintPassword,
  modelArgs,
  writeBoxboxConfigs,
  writeDaemonConfig,
} from "../scripts/pinned";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "server/goldens/contract1");
const WORLD = process.env.GOLDEN_WORLD ?? "/tmp/boxbox-golden";
const DAEMON_PORT = Number(process.env.GOLDEN_DAEMON_PORT ?? 4950);
const BOXBOX_PORT = Number(process.env.GOLDEN_BOXBOX_PORT ?? 3051);
const APP = `http://127.0.0.1:${BOXBOX_PORT}`;
const HOST = "bench";
const BINARY = join(WORLD, "boxbox-record");
const TAPE = join(WORLD, "tape.jsonl");

/** this machine's name as cmx2 writes it, and a placeholder of the same length, so nothing that counts characters moves */
const MACHINE = hostname().replace(/\.local$/, "");
const MACHINE_PLACEHOLDER = `bench-host-${"x".repeat(Math.max(0, MACHINE.length))}`.slice(0, MACHINE.length);

const PHONE = { device: "golden-phone", deviceClass: "iphone" };
const MAC = { device: "golden-mac", deviceClass: "mac" };

const started = performance.now();
function log(line: string): void {
  console.log(`[${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`);
}

function listening(port: number): boolean {
  return spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0;
}

async function until<T>(what: string, test: () => T | undefined | Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const got = await test();
    if (got !== undefined && got !== false) return got;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/* the world: daemon, model and the recording server, all ours */

const children: Array<{ name: string; child: ChildProcess }> = [];
let stopping = false;
let password = "";
let cookie = "";

function start(name: string, command: string, argv: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const out = Bun.file(join(WORLD, `${name}.log`)).writer();
  const child = spawn(command, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => out.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => out.write(chunk));
  child.once("exit", (code, signal) => {
    void out.end();
    if (!stopping && name !== "boxbox") log(`${name} exited (${signal ?? code}); see ${WORLD}/${name}.log`);
  });
  children.push({ name, child });
  log(`${name} started, pid ${child.pid}`);
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([new Promise((r) => child.once("exit", r)), Bun.sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* it went while we waited */
    }
  }
}

async function stopAll(): Promise<void> {
  stopping = true;
  for (const { child } of children.toReversed()) await stopChild(child);
  const ports = [DAEMON_PORT, DAEMON_PORT + 1, BOXBOX_PORT];
  log(`stopped; listening on ${ports.join(", ")}: ${ports.filter(listening).join(", ") || "nothing"}`);
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${dir.split("/").pop()}\n\na scratch repo for boxbox's contract 1 recording.\n`);
  writeFileSync(join(dir, "notes.md"), "# notes\n\ngreeting: hello\n");
  writeFileSync(join(dir, "one.env"), "ONE=1\n");
  writeFileSync(join(dir, "two.env"), "TWO=2\n");
  for (const file of ["pricing.md", "changelog.md"]) writeFileSync(join(dir, file), `# ${file}\n\nstatus: draft\n`);
  const env = { ...baseEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${out.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "scratch");
}

function daemon(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${DAEMON_PORT}${path}`, {
    method,
    headers: { authorization: basicAuth(password), "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function daemonJson<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await daemon(method, path, body, headers);
  const text = await res.text();
  if (!res.ok) throw new Error(`daemon ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function boxbox(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function expect(what: string, method: string, path: string, body: unknown, status: number): Promise<string> {
  const got = await boxbox(method, path, body);
  log(`${what}: ${method} ${path} -> ${got.status} ${got.text.slice(0, 100)}`);
  if (got.status !== status) throw new Error(`${what} answered ${got.status}, not ${status}: ${got.text.slice(0, 300)}`);
  return got.text;
}

/* what the live server sent, kept for live.json */

type Need = { id: string; kind: string; key: string; ask?: string | null };
const live = {
  epoch: "",
  build: "",
  journal: "",
  streams: [] as Array<string | null>,
  fleet: [] as string[],
  needs: [] as Array<{ body: string; seq: string }>,
};

async function fleet(): Promise<{ sessions: Array<{ key: string }>; order: string[] }> {
  const got = await boxbox("GET", "/api/fleet");
  if (got.status !== 200) throw new Error(`/api/fleet answered ${got.status}`);
  live.fleet.push(got.text);
  return JSON.parse(got.text) as { sessions: Array<{ key: string }>; order: string[] };
}

async function needs(): Promise<{ open: Need[]; served: Need[] }> {
  const got = await boxbox("GET", "/api/needs");
  if (got.status !== 200) throw new Error(`/api/needs answered ${got.status}`);
  live.needs.push({ body: got.text, seq: got.headers.get("x-boxbox-seq") ?? "" });
  return JSON.parse(got.text) as { open: Need[]; served: Need[] };
}

function needOf(key: string, kind: string): Promise<Need> {
  return until(`a ${kind} need on ${key}`, async () => (await needs()).open.find((n) => n.key === key && n.kind === kind));
}

/** one sse stream, kept whole as it arrived; `index` is its place in live.streams */
class Stream {
  text = "";
  readonly ids: string[] = [];
  private readonly abort = new AbortController();
  private reading: Promise<void> = Promise.resolve();
  private index = -1;

  async open(cursor: string | null): Promise<void> {
    const query = cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`;
    const res = await fetch(`${APP}/api/stream${query}`, { headers: { cookie, accept: "text/event-stream" }, signal: this.abort.signal });
    if (!res.ok || !res.body) throw new Error(`GET /api/stream${query} answered ${res.status}`);
    this.index = live.streams.push("") - 1;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    this.reading = (async () => {
      // the part of the last line a chunk ended in, so an id split across chunks is still seen
      let partial = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
        if (done || value === undefined) return;
        this.text += value;
        const lines = (partial + value).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) if (line.startsWith("id: ")) this.ids.push(line.slice(4));
      }
    })();
  }

  /** the frames read so far, heartbeats left out */
  frames(): string[] {
    return this.text.split("\n\n").filter((f) => f.length > 0 && !f.startsWith(":")).map((f) => `${f}\n\n`);
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.reading;
    live.streams[this.index] = this.text;
  }
}

function lastSeq(stream: Stream): number {
  const id = stream.ids.at(-1) ?? "";
  return Number(id.slice(id.lastIndexOf(":") + 1));
}

/** the journal's head now: `/api/needs` says where it stands in `x-boxbox-seq` */
async function head(): Promise<number> {
  await needs();
  const seq = live.needs.at(-1)?.seq ?? "";
  return Number(seq.slice(seq.lastIndexOf(":") + 1));
}

/* the session's pieces */

async function thread(directory: string, title: string): Promise<{ id: string; key: string }> {
  const { id } = await daemonJson<{ id: string }>("POST", "/session", { directory, title });
  return { id, key: `${HOST}:${id}` };
}

async function status(): Promise<Record<string, { type?: string }>> {
  return daemonJson<Record<string, { type?: string }>>("GET", "/session/status?parked=true");
}

async function idle(key: string, timeoutMs = 90_000): Promise<void> {
  const id = key.slice(HOST.length + 1);
  await until(`${key} to be idle`, async () => ((await status())[id] === undefined ? true : undefined), timeoutMs);
}

async function lastReply(key: string): Promise<{ id: string; created: number }> {
  const id = key.slice(HOST.length + 1);
  const messages = await daemonJson<Array<{ info: { id: string; role: string; time: { created: number } } }>>("GET", `/session/${id}/message`);
  const reply = messages.findLast((m) => m.info.role === "assistant");
  if (!reply) throw new Error(`${key} has no reply`);
  return { id: reply.info.id, created: reply.info.time.created };
}

async function prompt(key: string, text: string, from = PHONE): Promise<void> {
  const id = key.slice(HOST.length + 1);
  await expect("prompt", "POST", `/api/hosts/${HOST}/sessions/${id}/prompt`, { ...from, clientID: crypto.randomUUID(), text }, 202);
}

async function presence(from: { device: string }, thread: string | null, windowsInView: string[] = []): Promise<void> {
  await expect("presence", "POST", "/api/presence", { device: from.device, visible: true, focused: true, thread, windowsInView }, 204);
}

async function hidden(from: { device: string }): Promise<void> {
  await expect("presence", "POST", "/api/presence", { device: from.device, visible: false, focused: false, thread: null, windowsInView: [] }, 204);
}

async function inBatches<T>(items: T[], size: number, each: (item: T, n: number) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += size) {
    await Promise.all(items.slice(at, at + size).map((item, n) => each(item, at + n)));
  }
}

async function record(): Promise<void> {
  checkPort(DAEMON_PORT);
  for (const port of [DAEMON_PORT, DAEMON_PORT + 1, BOXBOX_PORT]) {
    if (listening(port)) throw new Error(`port ${port} is taken; the recording starts its own daemon, model and server`);
  }
  rmSync(WORLD, { recursive: true, force: true });
  mkdirSync(WORLD, { recursive: true });

  log("building boxbox with the record feature");
  const build = spawnSync("nice", ["-n", "10", "cargo", "build", "--locked", "--features", "record"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "3" },
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("cargo build --features record failed");
  copyFileSync(join(ROOT, "target/debug/boxbox"), BINARY);
  spawnSync("chmod", ["+x", BINARY]);

  exportPin((line) => log(`cmx2: ${line}`));
  const dirs = daemonDirs(join(WORLD, "daemon"));
  writeDaemonConfig(dirs, DAEMON_PORT + 1);
  password = mintPassword(join(WORLD, "password"), "bench");
  const ledger = join(WORLD, "repos", "ledger");
  const site = join(WORLD, "repos", "site");
  makeRepo(ledger);
  makeRepo(site);
  start("model", "bun", modelArgs(DAEMON_PORT + 1), ROOT, baseEnv());
  start("daemon", "bun", daemonArgs(DAEMON_PORT), dirs.work, daemonEnv(dirs, password));
  await until("the daemon's health", async () => ((await daemon("GET", "/global/health").catch(() => null))?.ok ? true : undefined));

  // history: the first read holds the newest 300 of these, the oldest 50 are older than the fleet
  log("350 threads before boxbox starts");
  const early: Array<{ id: string; key: string }> = [];
  await inBatches([...Array(350).keys()], 25, async (n) => {
    early[n] = await thread(site, `early thread ${n}`);
  });

  writeBoxboxConfigs(join(WORLD, "boxbox"), DAEMON_PORT, password, BOXBOX_PORT);
  const gate = mintPassword(join(WORLD, "boxbox", "gate-password"), "gate");
  start("boxbox", BINARY, ["serve", "--config", join(WORLD, "boxbox", "boxbox.toml")], ROOT, {
    ...baseEnv(),
    RUST_LOG: process.env.GOLDEN_RUST_LOG ?? "warn,boxbox::fleet=info",
    BOXBOX_RECORD: TAPE,
  });
  await until(`boxbox on ${BOXBOX_PORT}`, () => (listening(BOXBOX_PORT) ? true : undefined));
  const login = await fetch(`${APP}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: gate }) });
  if (!login.ok) throw new Error(`boxbox refused the bench gate password (${login.status})`);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  // the first connection: hello, then the snapshot
  const watch = new Stream();
  await watch.open(null);
  await until("hello and reset on the first stream", () => (watch.frames().length >= 2 ? true : undefined));
  await watch.close();
  const hello = JSON.parse(watch.frames()[0]!.replace(/^data: /, "")) as { epoch: string; build: string }; // two frames, checked above
  live.epoch = hello.epoch;
  live.build = hello.build;
  log(`journal epoch ${live.epoch}, build ${live.build}`);
  await until("the host's first read", async () => ((await fleet()).sessions.length >= 300 ? true : undefined));

  // a question, answered through boxbox while the phone looks at the thread
  const asked = await thread(ledger, "set the greeting in the notes");
  await presence(PHONE, asked.key);
  await prompt(asked.key, "[bench:tools] set the greeting in notes.md");
  const question = await needOf(asked.key, "question");
  await expect("answer", "POST", `/api/hosts/${HOST}/questions/${question.ask}`, { ...PHONE, clientID: crypto.randomUUID(), answers: [["hello"]] }, 200);
  await idle(asked.key);
  await hidden(PHONE);

  // a turn that ends with nobody looking: done; then read, then cleared
  const done = await thread(ledger, "summarise the changelog");
  await daemon("POST", `/session/${done.id}/prompt_async`, { text: "summarise the changelog in one line", clientID: crypto.randomUUID() });
  await needOf(done.key, "done");
  await idle(done.key);
  const reply = await lastReply(done.key);
  await expect("mark read", "POST", "/api/read", { ...MAC, key: done.key, message: reply.id, at: reply.created }, 204);
  await expect("clear", "POST", "/api/clear", { ...MAC, keys: [done.key], source: "window" }, 200);
  await needs();

  // two permissions and two questions at once
  const many = await thread(ledger, "read both env files");
  await prompt(many.key, "[bench:asks] read one.env and two.env", MAC);
  for (let answered = 0; answered < 4; ) {
    const open = (await until("an ask on the env thread", async () => {
      const list = (await needs()).open.filter((n) => n.key === many.key && n.ask);
      return list.length > 0 ? list : undefined;
    })) as Need[];
    for (const need of open) {
      const route = need.kind === "permission" ? `/api/hosts/${HOST}/permissions/${need.ask}` : `/api/hosts/${HOST}/questions/${need.ask}`;
      const body =
        need.kind === "permission"
          ? { ...MAC, clientID: crypto.randomUUID(), reply: answered === 0 ? "once" : "reject" }
          : { ...MAC, clientID: crypto.randomUUID(), answers: [[answered % 2 ? "bye" : "hi"]] };
      const got = await boxbox("POST", route, body);
      log(`answer ${need.kind} ${need.ask}: ${got.status} ${got.text.slice(0, 80)}`);
      answered += 1;
    }
    await Bun.sleep(500);
  }
  await idle(many.key);

  // parked on a background job
  const parked = await thread(site, "rebuild the search index");
  await daemon("POST", `/session/${parked.id}/prompt_async`, { text: "[bench:park] rebuild the search index", clientID: crypto.randomUUID() });

  // a long reply streaming into a window in view
  const streaming = await thread(site, "pricing table on mobile");
  await presence(MAC, null, [streaming.key]);
  await daemon("POST", `/session/${streaming.id}/prompt_async`, { text: "[bench:work 120 40 pricing.md] the pricing table breaks on small phones", clientID: crypto.randomUUID() });
  await fleet();

  // a checkout whose agent asks for review: answered through boxbox, then discarded
  const checkout = await daemonJson<{ directory: string }>("POST", "/experimental/worktree", { name: "golden-review", wait: true }, { "x-cmx2-directory": ledger });
  const review = await thread(checkout.directory, "add the review note");
  await daemon("POST", `/session/${review.id}/prompt_async`, { text: "[bench:review review.txt] add a review note", clientID: crypto.randomUUID() });
  await needOf(review.key, "review");
  await idle(review.key);
  await prompt(review.key, "looks good, one more line please", PHONE);
  await idle(review.key);
  const discard = await boxbox("POST", `/api/hosts/${HOST}/sessions/${review.id}/review/discard`, {});
  log(`review discard: ${discard.status} ${discard.text.slice(0, 120)}`);
  await idle(streaming.key, 120_000);
  await hidden(MAC);

  // an old thread opened from history
  const old = early[0]!; // 350 made above
  await expect("adopt", "POST", `/api/hosts/${HOST}/sessions/${old.id}/adopt`, undefined, 204);
  await needs();

  // past the caps: 750 more threads, then 40 short turns among them
  log("750 more threads");
  const bulk: Array<{ id: string; key: string }> = [];
  await inBatches([...Array(750).keys()], 25, async (n) => {
    bulk[n] = await thread(n % 2 ? site : ledger, `bulk thread ${n}`);
  });
  const view = await fleet();
  log(`the fleet holds ${view.sessions.length} sessions, the order ${view.order.length}`);
  log("40 short turns");
  await inBatches(bulk.slice(-40), 10, async (t, n) => {
    await daemon("POST", `/session/${t.id}/prompt_async`, { text: `say hello to bulk thread ${n}`, clientID: crypto.randomUUID() });
  });
  for (const t of bulk.slice(-40)) await idle(t.key);
  await needs();
  await fleet();

  // streams from a cursor: inside the journal, ahead of it, another epoch, one that does not parse
  const now = await head();
  const inside = new Stream();
  await inside.open(`${live.epoch}:${now - 10}`);
  await until("the resumed stream to reach the head", () => (inside.ids.length >= 10 ? true : undefined));
  await inside.close();
  for (const cursor of [`${live.epoch}:${now + 50}`, `000000000000:5`, "not a cursor"]) {
    const reset = new Stream();
    await reset.open(cursor);
    await until(`a reset for ${cursor}`, () => (reset.frames().length >= 2 ? true : undefined));
    await reset.close();
  }

  // quiet: every turn over and nothing journaled for three seconds
  await daemon("POST", `/session/${parked.id}/abort`, {});
  await until("every session idle", async () => (Object.keys(await status()).length === 0 ? true : undefined), 120_000);
  for (let quiet = await head(), since = performance.now(); performance.now() - since < 3000; ) {
    await Bun.sleep(500);
    const seq = await head();
    if (seq !== quiet) {
      quiet = seq;
      since = performance.now();
    }
  }
  await fleet();

  // the whole journal, from cursor 0
  const final = await head();
  const whole = new Stream();
  await whole.open(`${live.epoch}:0`);
  await until("the journal from cursor 0", () => (lastSeq(whole) >= final ? true : undefined), 120_000);
  await Bun.sleep(1000);
  await whole.close();
  const after = await head();
  if (after !== final || lastSeq(whole) !== final) throw new Error(`the journal moved while it was read (${final}, then ${lastSeq(whole)} and ${after}); record again`);
  live.journal = whole.frames().slice(1).join("");
  log(`journal: ${whole.frames().length - 1} frames, head ${final}`);

  // the server stops before the tape is read, so its last line is on disk
  const server = children.find((c) => c.name === "boxbox")?.child;
  if (server) await stopChild(server);
}

function scrub(text: string, what: string): string {
  const out = MACHINE.length > 0 ? text.replaceAll(MACHINE, MACHINE_PLACEHOLDER) : text;
  const user = userInfo().username;
  for (const leak of [user, "/Users/", "/home/"]) {
    if (leak.length > 2 && out.includes(leak)) throw new Error(`${what} carries "${leak}"; this is a public repo (AGENTS.md, public repo). find where it came from before recording`);
  }
  return out;
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "record";
  let code = 0;
  const onSignal = () => void stopAll().then(() => process.exit(130));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    if (mode !== "record") throw new Error(`unknown mode ${mode}; use record`);
    await record();
    if (!existsSync(TAPE)) throw new Error("the server wrote no tape; was it built with --features record?");
    const tape = scrub(readFileSync(TAPE, "utf8"), "the tape");
    const liveText = scrub(JSON.stringify(live), "what the server sent");
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "tape.jsonl.gz"), gzipSync(tape, { level: 9 }));
    writeFileSync(join(OUT, "live.json.gz"), gzipSync(liveText, { level: 9 }));
    log(`tape: ${tape.split("\n").length - 1} steps, ${tape.length} bytes; live: ${live.streams.length} streams, ${live.fleet.length} fleets, ${live.needs.length} needs`);
    log(`wrote ${OUT}/tape.jsonl.gz and live.json.gz; now: BOXBOX_GOLDENS=write cargo test goldens && cargo test fleet::replay`);
  } catch (error) {
    console.error(`golden: ${error instanceof Error ? error.message : String(error)}`);
    code = 1;
  } finally {
    await stopAll();
  }
  process.exit(code);
}
