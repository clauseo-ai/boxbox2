/* the v1 world: boxbox v1's real server, exported from the v1 commit the
   board was frozen at, in front of a harness cmx serve whose model is the
   trace model. nothing here touches a fleet serve or v1's working tree:

     - v1 is `git archive`d at V1_COMMIT into .work/, installed and built
       once, and served in production mode on 3021.
     - the cmx serve runs the installed cmx binary on 4880 with its own
       home, config, data, cache and state dirs, from an allowlisted
       environment. a bare harness serve reads the machine's whole session
       db; this one sees only what the trace makes, and inherits no
       password and no provider key.
     - the trace model answers on 4881 in place of a provider.

   the ports are the harness's range (4880 to 4889, and 3021). */

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertFree, halt, launch, type Service, type Turn, type World, waitFor } from "./world";

export const V1_COMMIT = "18df8bd2977a2182e2dca4f88694cee56876ece3";
export const V1_REPO = process.env.BOXBOX_V1_REPO ? resolve(process.env.BOXBOX_V1_REPO) : "";
const CMX_BINARY = process.env.CMX_BINARY ?? join(homedir(), ".local/share/cmx/bin/opencode");
const WORK = resolve(import.meta.dir, ".work");
export const V1_EXPORT = join(WORK, `v1-${V1_COMMIT.slice(0, 7)}`);

const CMX_PORT = 4880;
const MODEL_PORT = 4881;
const BOXBOX_PORT = 3021;
const HOST = "h1";
const PASSWORD = "trace-bench";

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

function run(what: string, command: string, args: string[], cwd: string) {
  console.log(`world: ${what}`);
  const out = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  if (out.status !== 0) throw new Error(`${what} failed with exit ${out.status}`);
}

/** v1 at the frozen commit, installed and built, once */
export function prepareV1(): string {
  if (V1_REPO === "") {
    throw new Error("maintainer-only: recording and replaying against v1 needs a checkout of the private boxbox v1 repo. set BOXBOX_V1_REPO to its path. the recorded traces in board/trace/traces/ replay without it");
  }
  if (!existsSync(join(V1_EXPORT, ".next", "BUILD_ID"))) {
    rmSync(V1_EXPORT, { recursive: true, force: true });
    mkdirSync(V1_EXPORT, { recursive: true });
    const archive = spawnSync("git", ["-C", V1_REPO, "archive", V1_COMMIT], { maxBuffer: 1 << 30 });
    if (archive.status !== 0) throw new Error(`v1 has no commit ${V1_COMMIT} at ${V1_REPO}`);
    const untar = spawnSync("tar", ["-x", "-C", V1_EXPORT], { input: archive.stdout });
    if (untar.status !== 0) throw new Error("could not unpack the v1 export");
    run(`installing v1 ${V1_COMMIT.slice(0, 7)}`, "bun", ["install", "--frozen-lockfile"], V1_EXPORT);
    run(`building v1 ${V1_COMMIT.slice(0, 7)}`, "bun", ["run", "build"], V1_EXPORT);
  }
  return V1_EXPORT;
}

/** @param name the run's scratch dir under the system temp dir. never inside
    a git checkout: cmx takes a project's worktrees from git, so a scratch
    project inside this repo would make every sibling worktree on the
    machine part of the trace's project, and v1's reconcile would open
    instances in them. */
/** v1 mints its read state on first access and stamps its baseline then:
    everything updated before the baseline counts as read. on a real
    account that line is months old; here the daemon's first snapshot would
    draw it after the setup threads and mark them all read. so the world
    reads first, before anything is staged. */
async function mintReadState(origin: string) {
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = /bb_session=[^;]+/.exec(login.headers.get("set-cookie") ?? "")?.[0];
  if (!login.ok || !cookie) throw new Error(`could not log in to boxbox v1 (${login.status})`);
  const read = await fetch(`${origin}/api/read`, { headers: { cookie } });
  if (!read.ok) throw new Error(`boxbox v1 would not answer its read state (${read.status})`);
  await Bun.sleep(50);
}

type Dirs = { home: string; config: string; data: string; cache: string; state: string; project: string };

/** the harness serve, relaunched when it is born half-dead: v1's GOTCHAS
    record serves whose provider warmup dies at boot and answer
    /config/providers with an instant 499 forever while everything else
    works, and every turn on such a serve faults */
async function bootCmx(dirs: Dirs, base: Record<string, string>, scratch: string, url: string): Promise<Service> {
  for (let attempt = 1; ; attempt++) {
    const service = launch(
      "cmx serve",
      CMX_BINARY,
      ["serve", "--port", String(CMX_PORT), "--hostname", "127.0.0.1", "--log-level", "ERROR"],
      dirs.project,
      {
        ...base,
        HOME: dirs.home,
        SHELL: "/bin/bash",
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_CACHE_HOME: dirs.cache,
        XDG_STATE_HOME: dirs.state,
        OPENCODE_DISABLE_CHANNEL_DB: "true",
        OPENCODE_ENABLE_QUESTION_TOOL: "true",
      },
      join(scratch, `cmx-${attempt}.log`),
    );
    let seen = "no answer";
    try {
      await waitFor(
        "the cmx serve",
        async () => {
          const res = await fetch(`${url}/config/providers`, { signal: AbortSignal.timeout(2000) });
          seen = `providers ${res.status}`;
          return res.ok;
        },
        20_000,
      );
      return service;
    } catch (error) {
      await halt([service]);
      if (attempt === 3) throw new Error(`the cmx serve never came up healthy in 3 launches (last: ${seen})`, { cause: error });
      console.log(`world: cmx serve unhealthy (${seen}), relaunching`);
    }
  }
}

export async function startV1World(name: string): Promise<World> {
  for (const port of [CMX_PORT, MODEL_PORT, BOXBOX_PORT]) await assertFree(port);
  const v1 = prepareV1();
  const scratch = join(realpathSync(tmpdir()), "boxbox-board-trace", name);
  rmSync(scratch, { recursive: true, force: true });
  const dirs = {
    home: join(scratch, "cmx/home"),
    config: join(scratch, "cmx/config"),
    data: join(scratch, "cmx/data"),
    cache: join(scratch, "cmx/cache"),
    state: join(scratch, "cmx/state"),
    project: join(scratch, "project"),
    boxbox: join(scratch, "boxbox"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp", TZ: "UTC" };
  mkdirSync(join(dirs.config, "opencode"), { recursive: true });
  writeFileSync(
    join(dirs.config, "opencode", "opencode.json"),
    `${JSON.stringify(
      {
        model: "anthropic/claude-sonnet-4-5",
        small_model: "anthropic/claude-sonnet-4-5",
        provider: { anthropic: { options: { baseURL: `http://127.0.0.1:${MODEL_PORT}/v1`, apiKey: "trace-model" } } },
        permission: { bash: "ask" },
        share: "disabled",
        autoupdate: false,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dirs.project, "README.md"), "a scratch project for the board traces\n");
  /* its own repo with one commit: cmx names a project by its root commit,
     and with none the project-scoped session list v1 reconciles from comes
     back empty. the caller's git config (identity, signing) stays out. */
  const gitEnv = { ...base, HOME: dirs.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const args of [
    ["init", "-q"],
    ["add", "README.md"],
    ["-c", "user.name=trace", "-c", "user.email=trace@localhost", "commit", "-q", "-m", "scratch project"],
  ]) {
    const git = spawnSync("git", args, { cwd: dirs.project, env: gitEnv });
    if (git.status !== 0) throw new Error(`git ${args.join(" ")} failed in the scratch project: ${git.stderr.toString()}`);
  }

  const services: Service[] = [];
  const cmxUrl = `http://127.0.0.1:${CMX_PORT}`;
  const origin = `http://127.0.0.1:${BOXBOX_PORT}`;
  try {
    services.push(
      launch("trace model", "bun", [resolve(import.meta.dir, "model.ts"), "--port", String(MODEL_PORT)], scratch, base, join(scratch, "model.log")),
    );
    services.push(await bootCmx(dirs, base, scratch, cmxUrl));
    services.push(
      launch(
        "boxbox v1",
        "bun",
        ["server.ts", "--port", String(BOXBOX_PORT), "--hostname", "127.0.0.1"],
        v1,
        {
          ...base,
          HOME: dirs.boxbox,
          NODE_ENV: "production",
          NEXT_TELEMETRY_DISABLED: "1",
          BOXBOX_DATA_DIR: dirs.boxbox,
          BOXBOX_PASSWORD: PASSWORD,
          BOXBOX_HOSTS: JSON.stringify([{ id: HOST, name: HOST, url: cmxUrl }]),
        },
        join(scratch, "boxbox.log"),
      ),
    );
    /* any answer from the login route means next has booted */
    await waitFor("boxbox v1", async () => (await fetch(`${origin}/api/login`, { method: "POST", body: "{}", signal: AbortSignal.timeout(2000) })).status > 0);
    await mintReadState(origin);
  } catch (error) {
    await halt(services);
    throw error;
  }

  const ids = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const cmx = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${cmxUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-opencode-directory": dirs.project },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`cmx ${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : ((await res.json()) as unknown);
  };
  const prompts = new Map<string, number>();
  const prompt = async (alias: string, turn: Turn) => {
    const id = byAlias.get(alias);
    if (!id) throw new Error(`no thread named ${alias}`);
    prompts.set(alias, (prompts.get(alias) ?? 0) + 1);
    await cmx(`/session/${id}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: marker(turn) }] }) });
  };

  return {
    origin,
    password: PASSWORD,
    machineOrder: [HOST],
    async open(alias, turn) {
      const created = (await cmx("/session", { method: "POST", body: JSON.stringify({ title: alias }) })) as { id: string };
      ids.set(created.id, alias);
      byAlias.set(alias, created.id);
      await prompt(alias, turn);
    },
    prompt,
    async settled(alias) {
      const id = byAlias.get(alias);
      if (!id) throw new Error(`no thread named ${alias}`);
      const turns = prompts.get(alias) ?? 0;
      /* status alone is not enough: right after prompt_async the session
         is not busy yet, and reads as idle. the turn is over when the
         thread holds every prompt sent and its last message is a finished
         assistant reply, or when it is waiting on an ask */
      await waitFor(`${alias} to settle`, async () => {
        const asks = [...((await cmx("/permission")) as { sessionID: string }[]), ...((await cmx("/question")) as { sessionID: string }[])];
        if (asks.some((ask) => ask.sessionID === id)) return true;
        const status = (await cmx("/session/status")) as Record<string, unknown>;
        if (status[id] !== undefined) return false;
        const messages = (await cmx(`/session/${id}/message`)) as { info: { role: string; time?: { completed?: number } } }[];
        const users = messages.filter((m) => m.info.role === "user").length;
        const last = messages.at(-1)?.info;
        return users >= turns && last?.role === "assistant" && last.time?.completed !== undefined;
      });
    },
    async quiet() {
      const status = (await cmx("/session/status")) as Record<string, unknown>;
      const busy = Object.keys(status);
      if (busy.length === 0) return true;
      const asks = [...((await cmx("/permission")) as { sessionID: string }[]), ...((await cmx("/question")) as { sessionID: string }[])];
      return busy.every((id) => asks.some((ask) => ask.sessionID === id));
    },
    aliases: () => new Map(ids),
    redactions: () => [
      [dirs.project, "<project>"],
      [scratch, "<world>"],
      [homedir(), "<home>"],
    ],
    stop: () => halt(services),
  };
}
