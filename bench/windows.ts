/* the windows world: five live threads across two repos on a real cmx2
   daemon, watched by a real boxbox. home's fixtures are recorded from it
   and its budget run (bench/home.ts) drives the app against it.

     just build && bun bench/windows.ts capture   record the journal fixture
     just build && bun bench/windows.ts up        keep the world streaming until ctrl-c

   it owns everything it runs and stops all of it on the way out: the
   pinned daemon (4940, WINDOWS_DAEMON_PORT moves it within the port rule)
   with the bench model on the next port, and the release binary on 3071
   (WINDOWS_BOXBOX_PORT). the world lives under /tmp (AGENTS.md, scratch in /tmp):
   the daemon's dirs, boxbox's config and data, and two scratch repos with
   one commit each, made with the caller's git config kept out
   (docs/gotchas.md, the board trace harness). it refuses to start if any
   of its ports answer: it never attaches to something it did not start.

   the threads, by repo:

     ledger  move invoices to the new ledger   reads, an edit, a command, then prose streaming
     ledger  set the greeting in the notes     asks a question and waits: wants you
     ledger  summarise the changelog           a one-line answer: done
     site    pricing table on mobile           streaming, with a prompt queued behind it
     site    rebuild the search index          parked on a background job */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
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
const BINARY = join(ROOT, "target/release/boxbox");
/** the world's directory under /tmp; a lane running its own world names its own (WINDOWS_WORLD) */
export const WORLD = process.env.WINDOWS_WORLD ?? "/tmp/boxbox-m5-windows";
const FIXTURE = join(ROOT, "app/src/ui/home/fixtures/journal.ndjson");
/** this machine's name, as cmx2 writes it into a turn's context */
const MACHINE = hostname().replace(/\.local$/, "");

export const DAEMON_PORT = Number(process.env.WINDOWS_DAEMON_PORT ?? 4940);
export const BOXBOX_PORT = Number(process.env.WINDOWS_BOXBOX_PORT ?? 3071);
export const APP = `http://127.0.0.1:${BOXBOX_PORT}`;

const started = performance.now();
export function log(line: string): void {
  console.log(`[${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s] ${line}`);
}

export function listening(port: number): boolean {
  return spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0;
}

export async function until(what: string, test: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await test()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export type Thread = { repo: "ledger" | "site"; title: string; prompt: string; queue?: string };

/** the five threads the fixture records; `words` sets how long the two streams run */
export function threads(words: number, everyMs: number): Thread[] {
  return [
    { repo: "ledger", title: "move invoices to the new ledger", prompt: `[bench:work ${words} ${everyMs} invoices.md] write the migration and dry run it` },
    { repo: "ledger", title: "set the greeting in the notes", prompt: "[bench:tools] set the greeting in notes.md" },
    { repo: "ledger", title: "summarise the changelog", prompt: "summarise the changelog in one line" },
    {
      repo: "site",
      title: "pricing table on mobile",
      prompt: `[bench:work ${words} ${everyMs} pricing.md] the pricing table breaks on small phones, fix it`,
      queue: "then check the checkout page at the same widths",
    },
    { repo: "site", title: "rebuild the search index", prompt: "[bench:park] rebuild the search index in the background" },
  ];
}

/** every thread streaming for the budget run: the same repos, all five busy for `seconds` */
export function streaming(seconds: number, everyMs: number): Thread[] {
  const words = Math.round((seconds * 1000) / everyMs);
  const titles: Array<[Thread["repo"], string, string]> = [
    ["ledger", "move invoices to the new ledger", "invoices.md"],
    ["ledger", "set the greeting in the notes", "greeting.md"],
    ["ledger", "summarise the changelog", "changelog.md"],
    ["site", "pricing table on mobile", "pricing.md"],
    ["site", "rebuild the search index", "search.md"],
  ];
  return titles.map(([repo, title, file]) => ({ repo, title, prompt: `[bench:work ${words} ${everyMs} ${file}] ${title}` }));
}

export class World {
  private children: ChildProcess[] = [];
  private names: string[] = [];
  /** children killed on purpose, whose exit is not news */
  private readonly cutting = new Set<ChildProcess>();
  private stopping = false;
  password = "";
  gate = "";
  cookie = "";
  readonly sessions: Array<{ id: string; key: string; thread: Thread }> = [];

  async start(): Promise<void> {
    checkPort(DAEMON_PORT);
    for (const port of [DAEMON_PORT, DAEMON_PORT + 1, BOXBOX_PORT]) {
      if (listening(port)) throw new Error(`port ${port} is taken; the windows world starts its own daemon, model and server`);
    }
    if (!existsSync(BINARY)) throw new Error("no release binary; run `just build` first");
    exportPin((line) => log(`cmx2: ${line}`));
    rmSync(WORLD, { recursive: true, force: true });
    const dirs = daemonDirs(join(WORLD, "daemon"));
    writeDaemonConfig(dirs, DAEMON_PORT + 1);
    this.password = mintPassword(join(WORLD, "password"), "bench");
    for (const repo of ["ledger", "site"]) makeRepo(join(WORLD, "repos", repo));
    this.spawn("model", "bun", modelArgs(DAEMON_PORT + 1), ROOT, baseEnv());
    this.spawn("daemon", "bun", daemonArgs(DAEMON_PORT), dirs.work, daemonEnv(dirs, this.password));
    await until("the daemon's health", async () => (await this.daemon("GET", "/global/health").catch(() => null))?.ok === true);
    writeBoxboxConfigs(join(WORLD, "boxbox"), DAEMON_PORT, this.password, BOXBOX_PORT);
    this.gate = mintPassword(join(WORLD, "boxbox", "gate-password"), "gate");
    await this.serve();
    const login = await fetch(`${APP}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: this.gate }) });
    if (!login.ok) throw new Error(`boxbox refused the bench gate password (${login.status})`);
    this.cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    log(`world up: daemon ${DAEMON_PORT}, model ${DAEMON_PORT + 1}, boxbox ${APP}, repos under ${WORLD}/repos`);
  }

  daemon(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${DAEMON_PORT}${path}`, {
      method,
      headers: { authorization: basicAuth(this.password), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** creates each thread in its repo and sends its prompt; a thread with a queue gets it once it is busy */
  async run(list: Thread[]): Promise<void> {
    for (const thread of list) {
      const directory = join(WORLD, "repos", thread.repo);
      const created = await this.daemon("POST", "/session", { directory, title: thread.title });
      if (!created.ok) throw new Error(`POST /session answered ${created.status}: ${await created.text()}`);
      const { id } = (await created.json()) as { id: string };
      this.sessions.push({ id, key: `bench:${id}`, thread });
      const sent = await this.daemon("POST", `/session/${id}/prompt_async`, { text: thread.prompt, clientID: crypto.randomUUID() });
      log(`${thread.repo.padEnd(6)} ${thread.title.padEnd(34)} ${id} prompt -> ${sent.status}`);
    }
    for (const { id, thread } of this.sessions) {
      if (!thread.queue) continue;
      await until(`${thread.title} to be busy`, async () => (await this.status())[id]?.type === "busy");
      const queued = await this.daemon("POST", `/session/${id}/prompt`, { text: thread.queue, clientID: crypto.randomUUID() });
      log(`${thread.repo.padEnd(6)} ${thread.title.padEnd(34)} queued -> ${queued.status} ${(await queued.text()).trim().slice(0, 80)}`);
    }
  }

  /** starts boxbox against the world's config; its cookie secret is in the data dir, so signed-in pages stay signed in across a restart */
  async serve(): Promise<void> {
    this.spawn("boxbox", BINARY, ["serve", "--config", join(WORLD, "boxbox", "boxbox.toml")], ROOT, { ...baseEnv(), RUST_LOG: process.env.WINDOWS_RUST_LOG ?? "warn" });
    await until(`boxbox on ${BOXBOX_PORT}`, () => listening(BOXBOX_PORT));
  }

  /** kills boxbox the way a dropped connection does, with no goodbye: the page's stream and posts fail mid-flight */
  async cut(): Promise<void> {
    const boxbox = this.boxbox();
    if (!boxbox?.pid) throw new Error("the world's boxbox is not running");
    this.cutting.add(boxbox);
    process.kill(-boxbox.pid, "SIGKILL");
    await until(`boxbox off ${BOXBOX_PORT}`, () => !listening(BOXBOX_PORT), 10_000);
  }

  private boxbox(): ChildProcess | undefined {
    return this.children.findLast((child, n) => this.names[n] === "boxbox" && child.exitCode === null && child.signalCode === null);
  }

  async status(): Promise<Record<string, { type?: string }>> {
    return (await (await this.daemon("GET", "/session/status?parked=true")).json()) as Record<string, { type?: string }>;
  }

  private spawn(name: string, command: string, argv: string[], cwd: string, env: Record<string, string>) {
    // a restarted child writes its own log, so the first run's is kept
    const runs = this.names.filter((n) => n === name).length;
    const file = runs ? `${name}-${runs + 1}.log` : `${name}.log`;
    const out = Bun.file(join(WORLD, file)).writer();
    const child = spawn(command, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => out.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => out.write(chunk));
    child.once("exit", (code, signal) => {
      void out.end();
      if (!this.stopping && !this.cutting.has(child)) log(`${name} exited (${signal ?? code}); see ${WORLD}/${file}`);
    });
    this.children.push(child);
    this.names.push(name);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const child of this.children) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    await Promise.race([
      Promise.all(this.children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))),
      Bun.sleep(5000),
    ]);
    for (const child of this.children) {
      if (!child.pid || child.exitCode !== null) continue;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* it went while we waited */
      }
    }
    log(`stopped; listening on ${DAEMON_PORT}, ${DAEMON_PORT + 1}, ${BOXBOX_PORT}: ${[DAEMON_PORT, DAEMON_PORT + 1, BOXBOX_PORT].filter(listening).join(", ") || "nothing"}`);
  }
}

/** a scratch repo with the files the bench scripts read and edit, and one commit, so cmx2 gives it a project */
function makeRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${dir.split("/").pop()}\n\na scratch repo for boxbox's windows bench.\n`);
  writeFileSync(join(dir, "notes.md"), "# notes\n\ngreeting: hello\n");
  for (const file of ["invoices.md", "greeting.md", "changelog.md", "pricing.md", "search.md"]) {
    writeFileSync(join(dir, file), `# ${file}\n\nstatus: draft\n`);
  }
  const env = { ...baseEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${out.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "scratch");
}

/** records every frame of boxbox's `/api/stream` from the first connection, as `{"id", "frame"}` lines */
async function capture(world: World, seconds: number): Promise<number> {
  const lines: string[] = [];
  const abort = new AbortController();
  const res = await fetch(`${APP}/api/stream`, { headers: { cookie: world.cookie, accept: "text/event-stream" }, signal: abort.signal });
  if (!res.ok || !res.body) throw new Error(`GET /api/stream answered ${res.status}`);
  const reading = (async () => {
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader(); // checked above
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += value;
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const id = block.split("\n").find((l) => l.startsWith("id:"))?.slice(3).trim() ?? null;
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        // cmx2 writes the machine's name into each turn's context; this is a public repo (AGENTS.md, public repo)
        if (data) lines.push(JSON.stringify({ id, frame: JSON.parse(data) }).replaceAll(MACHINE, "bench-host"));
      }
    }
  })();
  await Bun.sleep(300);
  await world.run(threads(500, 45));
  await Bun.sleep(seconds * 1000);
  abort.abort();
  await reading;
  mkdirSync(join(FIXTURE, ".."), { recursive: true });
  writeFileSync(FIXTURE, `${lines.join("\n")}\n`);
  return lines.length;
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "capture";
  const world = new World();
  let code = 0;
  const onSignal = () => void world.stop().then(() => process.exit(0));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await world.start();
    if (mode === "capture") {
      const count = await capture(world, 16);
      log(`captured ${count} frames into ${FIXTURE}`);
      for (const [id, status] of Object.entries(await world.status())) log(`daemon status ${id}: ${JSON.stringify(status)}`);
    } else if (mode === "up") {
      await world.run(streaming(600, 60));
      log(`sign in at ${APP} with the gate password in ${WORLD}/boxbox/gate-password; ctrl-c stops everything`);
      await new Promise(() => undefined);
    } else {
      throw new Error(`unknown mode ${mode}; use capture or up`);
    }
  } catch (error) {
    console.error(`windows: ${error instanceof Error ? error.message : String(error)}`);
    code = 1;
  } finally {
    await world.stop();
  }
  process.exit(code);
}
