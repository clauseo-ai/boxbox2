/* the v2 world: boxbox v2 built from this checkout, with `[board]`
   configured, in front of the cmx2 daemon from the pin (the export `just
   cmx2` makes), whose model is the trace model. nothing here touches a dev
   daemon, a dev server or the fleet:

     - cmx2 runs from .cmx2/<pin>/ on BOARD_TRACE_CMX2_PORT (4884 by
       default, in the harness's range), with its own config, data, home and
       work dirs, from an allowlisted environment (scripts/pinned.ts). its
       anthropic provider is the trace model on the next port, speaking
       cmx2's shell tool (`shell`, its argument `command`), and its config
       asks before every shell command, so a permission turn waits on the
       board as v1's did.
     - boxbox is target/release/boxbox (BOXBOX_BINARY to use another),
       built once with cargo, on BOARD_TRACE_BOXBOX_PORT (3022 by default),
       with one host `h1` (so thread keys read `h1:<session>` and the one
       machine is `h1`, as in the traces) and `[board] machines = ["h1"]`.
     - an app window: a stream on /api/stream?board=1 from this machine,
       held open for the run, so a focus or a compose has a window on the
       board's mac to land in. its frames go to app-window.log.
     - the scratch repo, every data dir and every log live under the system
       temp dir (docs/gotchas.md, the board trace harness), and `stop`
       stops every process the world started, by its process group.

   what v1's world needed to be faithful, here:
     - one commit in the scratch repo: cmx2 names a project by its root
       commit too, so the repo still gets one (bench/windows.ts does the
       same).
     - minting v1's read baseline before setup: boxbox v2 keeps read state
       per thread from the moment it first sees one, so threads made after
       it starts are unread with nothing to mint. `--smoke` checks it: the
       setup threads must show as unread news. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { baseEnv, basicAuth, checkPort, daemonArgs, daemonDirs, daemonEnv, exportPin, mintPassword, PIN, ROOT } from "../../scripts/pinned";
import { BOARD_MAC } from "./proxy";
import { assertFree, exited, halt, launch, type Service, type Turn, type World, waitFor } from "./world";

const CMX2_PORT = Number(process.env.BOARD_TRACE_CMX2_PORT ?? 4884);
const MODEL_PORT = CMX2_PORT + 1;
const BOXBOX_PORT = Number(process.env.BOARD_TRACE_BOXBOX_PORT ?? 3022);
const BOXBOX_BINARY = process.env.BOXBOX_BINARY ? resolve(process.env.BOXBOX_BINARY) : join(ROOT, "target/release/boxbox");
const HOST = "h1";

function marker(turn: Turn): string {
  switch (turn.kind) {
    case "reply":
      return "[trace:reply]";
    case "permission":
      return "[trace:permission]";
    case "question":
      return `[trace:question ${turn.options}]`;
    case "work":
      return `[trace:work ${turn.words} ${turn.everyMs}]`;
  }
}

/** the pinned cmx2 exported and installed, and boxbox built from this checkout, once each */
export function prepareV2(): { binary: string } {
  exportPin((line) => console.log(`world: cmx2 ${line}`));
  if (!process.env.BOXBOX_BINARY) {
    console.log("world: building boxbox (cargo build --release --bin boxbox)");
    const out = spawnSync("cargo", ["build", "--release", "--locked", "--bin", "boxbox"], { cwd: ROOT, stdio: "inherit" });
    if (out.status !== 0) throw new Error(`cargo build --release --bin boxbox failed with exit ${out.status}`);
  }
  if (!existsSync(BOXBOX_BINARY)) throw new Error(`no boxbox binary at ${BOXBOX_BINARY}`);
  return { binary: BOXBOX_BINARY };
}

function makeRepo(dir: string, home: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "a scratch project for the board traces\n");
  const env = { ...baseEnv(), HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "README.md"],
    ["-c", "user.name=trace", "-c", "user.email=trace@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "scratch project"],
  ]) {
    const git = spawnSync("git", args, { cwd: dir, env });
    if (git.status !== 0) throw new Error(`git ${args.join(" ")} failed in the scratch project: ${git.stderr.toString()}`);
  }
}

export type V2Options = {
  /** write `[board]` into boxbox.toml. off only for --smoke against a server that has no board channel yet */
  board?: boolean;
};

export type V2World = World & {
  /** a signed-in call to the world's boxbox */
  boxbox: (method: string, path: string, body?: unknown) => Promise<Response>;
};

/** @param name the run's scratch dir under the system temp dir, never inside a git checkout */
export async function startV2World(name: string, options: V2Options = {}): Promise<V2World> {
  checkPort(CMX2_PORT);
  for (const port of [CMX2_PORT, MODEL_PORT, BOXBOX_PORT]) await assertFree(port);
  const { binary } = prepareV2();
  const scratch = join(realpathSync(tmpdir()), "boxbox-board-trace", name);
  rmSync(scratch, { recursive: true, force: true });
  const dirs = daemonDirs(join(scratch, "cmx2"));
  const project = join(scratch, "project");
  const boxboxDir = join(scratch, "boxbox");
  mkdirSync(boxboxDir, { recursive: true });
  makeRepo(project, dirs.home);
  writeFileSync(
    join(dirs.config, "cmx2.jsonc"),
    `${JSON.stringify(
      {
        model: "anthropic/claude-opus-5-5",
        providers: { anthropic: { baseUrl: `http://127.0.0.1:${MODEL_PORT}`, apiKey: "trace-model" } },
        permission: { shell: "ask" },
      },
      null,
      2,
    )}\n`,
  );
  const daemonPassword = mintPassword(join(scratch, "cmx2-password"), "trace");
  const gate = mintPassword(join(boxboxDir, "gate-password"), "trace-gate");
  const toml = [
    "# written by board/trace/world-v2.ts for one traced run; never a real password",
    `listen = "127.0.0.1:${BOXBOX_PORT}"`,
    `data_dir = ${JSON.stringify(join(boxboxDir, "data"))}`,
    `password = ${JSON.stringify(gate)}`,
    "",
    "[cookie]",
    'name = "boxbox_trace_session"',
    "secure = false",
    "",
    "[[host]]",
    `name = "${HOST}"`,
    `url = "http://127.0.0.1:${CMX2_PORT}"`,
    `password = ${JSON.stringify(daemonPassword)}`,
    ...(options.board === false ? [] : ["", "[board]", `machines = ["${HOST}"]`]),
    "",
  ];
  writeFileSync(join(boxboxDir, "boxbox.toml"), toml.join("\n"), { mode: 0o600 });

  const services: Service[] = [];
  const cmx2Url = `http://127.0.0.1:${CMX2_PORT}`;
  const origin = `http://127.0.0.1:${BOXBOX_PORT}`;
  const auth = basicAuth(daemonPassword);
  let cookie = "";
  const window = new AbortController();
  try {
    services.push(
      launch(
        "trace model",
        "bun",
        [resolve(import.meta.dir, "model.ts"), "--port", String(MODEL_PORT), "--shell-tool", "shell", "--shell-arg", "command", "--end-ms", "300"],
        scratch,
        baseEnv(),
        join(scratch, "model.log"),
      ),
    );
    const cmx2Log = join(scratch, "cmx2.log");
    const cmx2Service = launch("cmx2", "bun", daemonArgs(CMX2_PORT), dirs.work, daemonEnv(dirs, daemonPassword), cmx2Log);
    services.push(cmx2Service);
    await waitFor(
      "cmx2's health",
      async () => (await fetch(`${cmx2Url}/global/health`, { headers: { authorization: auth }, signal: AbortSignal.timeout(2000) })).ok,
      30_000,
      exited(cmx2Service, cmx2Log),
    );
    const boxboxLog = join(scratch, "boxbox.log");
    const boxboxService = launch("boxbox", binary, ["serve", "--config", join(boxboxDir, "boxbox.toml")], ROOT, { ...baseEnv(), RUST_LOG: process.env.BOARD_TRACE_RUST_LOG ?? "info" }, boxboxLog);
    services.push(boxboxService);
    await waitFor(
      `boxbox on ${BOXBOX_PORT}`,
      async () => {
        const login = await fetch(`${origin}/api/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: gate }),
          signal: AbortSignal.timeout(2000),
        });
        cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        return login.ok && cookie !== "";
      },
      30_000,
      exited(boxboxService, boxboxLog),
    );
    await openAppWindow(origin, cookie, window.signal, join(scratch, "app-window.log"));
  } catch (error) {
    window.abort();
    await halt(services);
    throw error;
  }

  const ids = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const prompts = new Map<string, number>();
  const cmx2 = async (path: string, init?: { method?: string; body?: unknown }) => {
    const res = await fetch(`${cmx2Url}${path}`, {
      method: init?.method ?? "GET",
      headers: { authorization: auth, "content-type": "application/json", "x-cmx2-directory": project },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`cmx2 ${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : ((await res.json()) as unknown);
  };
  const asks = async () => [...((await cmx2("/permission")) as { sessionID: string }[]), ...((await cmx2("/question")) as { sessionID: string }[])];
  const prompt = async (alias: string, turn: Turn) => {
    const id = byAlias.get(alias);
    if (!id) throw new Error(`no thread named ${alias}`);
    prompts.set(alias, (prompts.get(alias) ?? 0) + 1);
    await cmx2(`/session/${id}/prompt_async`, { method: "POST", body: { text: marker(turn), clientID: crypto.randomUUID() } });
  };

  return {
    origin,
    password: gate,
    machineOrder: [HOST],
    async open(alias, turn) {
      const created = (await cmx2("/session", { method: "POST", body: { directory: project, title: alias } })) as { id: string };
      ids.set(created.id, alias);
      byAlias.set(alias, created.id);
      await prompt(alias, turn);
    },
    prompt,
    async settled(alias) {
      const id = byAlias.get(alias);
      if (!id) throw new Error(`no thread named ${alias}`);
      const turns = prompts.get(alias) ?? 0;
      /* as v1's world: right after prompt_async the session is not busy
         yet, so the turn is over when the thread holds every prompt sent
         and its last message is a finished assistant reply, or when it is
         waiting on an ask */
      await waitFor(`${alias} to settle`, async () => {
        if ((await asks()).some((ask) => ask.sessionID === id)) return true;
        const status = (await cmx2("/session/status")) as Record<string, unknown>;
        if (status[id] !== undefined) return false;
        const messages = (await cmx2(`/session/${id}/message`)) as { info: { role: string; queued?: boolean; time?: { completed?: number } } }[];
        const users = messages.filter((m) => m.info.role === "user" && m.info.queued !== true).length;
        const last = messages.at(-1)?.info;
        return users >= turns && last?.role === "assistant" && last.time?.completed !== undefined;
      });
    },
    async quiet() {
      const status = (await cmx2("/session/status")) as Record<string, unknown>;
      const busy = Object.keys(status);
      if (busy.length === 0) return true;
      const open = await asks();
      return busy.every((id) => open.some((ask) => ask.sessionID === id));
    },
    aliases: () => new Map(ids),
    redactions: () => [
      [project, "<project>"],
      [scratch, "<world>"],
      [homedir(), "<home>"],
    ],
    boxbox: (method, path, body) =>
      fetch(`${origin}${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    stop: async () => {
      window.abort();
      await halt(services);
    },
  };
}

/** an app window on the board's mac: a stream that asks for board frames, read until the world stops */
async function openAppWindow(origin: string, cookie: string, signal: AbortSignal, logPath: string) {
  /* from the board's mac, as the proxy says the daemon is (proxy.ts, BOARD_MAC) */
  const res = await fetch(`${origin}/api/stream?board=1`, { headers: { cookie, accept: "text/event-stream", "x-forwarded-for": BOARD_MAC }, signal });
  if (!res.ok || !res.body) throw new Error(`the app window's stream answered ${res.status}`);
  const log = Bun.file(logPath).writer();
  const body = res.body;
  void (async () => {
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        log.write(value);
      }
    } catch {
      /* the world stopped */
    } finally {
      await log.end();
    }
  })();
}

/* --smoke [--board]: stage the world, three threads, a permission and a
   question, check what the board's view will be built from, and stop. it
   runs against a server without the board channel (leave out --board), so
   the world can be proven before the board routes land. */
if (import.meta.main && process.argv.includes("--smoke")) {
  const world = await startV2World("smoke-v2", { board: process.argv.includes("--board") });
  let failed = false;
  try {
    for (const alias of ["alpha", "bravo", "charlie"]) {
      await world.open(alias, { kind: "reply" });
      await world.settled(alias);
    }
    await world.prompt("bravo", { kind: "permission" });
    await world.settled("bravo");
    await world.prompt("charlie", { kind: "question", options: 3 });
    await world.settled("charlie");
    const needs = (await (await world.boxbox("GET", "/api/needs")).json()) as { open: { kind: string; key: string }[] };
    const names = new Map([...world.aliases()].map(([id, alias]) => [`${HOST}:${id}`, alias]));
    const seen = needs.open.map((n) => `${names.get(n.key) ?? n.key} ${n.kind}`).sort();
    console.log(`smoke: open needs: ${seen.join(", ")}`);
    const want = ["alpha done", "bravo permission", "charlie question"];
    for (const line of want) {
      if (!seen.includes(line)) {
        console.log(`smoke: missing "${line}"`);
        failed = true;
      }
    }
    console.log(`smoke: quiet ${await world.quiet()} (every busy thread waits on an ask), pin ${PIN.slice(0, 7)}`);
    if (process.argv.includes("--board")) {
      const stream = await world.boxbox("GET", "/api/board/stream?protocol=1&device=board-smoke000&addrs=127.0.0.1");
      console.log(`smoke: GET /api/board/stream -> ${stream.status}`);
      await stream.body?.cancel();
      if (stream.status !== 200) failed = true;
    }
  } finally {
    await world.stop();
  }
  process.exit(failed ? 1 : 0);
}
