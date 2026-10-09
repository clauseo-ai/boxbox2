/* `just cmx2`: the cmx2 dev daemon, built from the commit in cmx2.pin.

   - exports the pinned commit with `git archive` into .cmx2/<pin>/ and
     installs it (once); never runs anything from the cmx2 working tree.
   - starts the bench model (bench/model.ts) and points the daemon's
     anthropic provider at it, so no real key or provider is ever used.
   - starts the daemon on 127.0.0.1, port 4840 by default (--port or
     CMX2_PORT; a parallel worktree takes its own decade), with its own config dir, data dir and home under
     .cmx2/bench/, and a bench password minted once into
     .cmx2/bench/password. the environment is an allowlist, so nothing the
     shell holds (a real password, provider keys, the maintainer's config) can
     leak in.
   - waits for /global/health, prints it, and checks the version against
     the pinned source.
   - one process tree: ctrl-c or sigterm stops both children, and if either
     dies the other is stopped too. a daemon that exits cleanly, as
     `/global/restart` makes it, is started again, like an installed one.

   flags: --fresh wipes the bench data dir first; --port <n> moves the
   daemon (the model takes n + 1); --boxbox-port <n> is where the bench
   boxbox configs listen (3001 by default). */

import { type ChildProcess, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOXBOX_PORT as DEFAULT_BOXBOX_PORT,
  baseEnv,
  basicAuth,
  checkPort,
  daemonArgs,
  daemonDirs,
  daemonEnv,
  exportPin,
  mintPassword,
  modelArgs,
  PIN,
  pinnedVersion,
  ROOT,
  writeBoxboxConfigs,
  writeDaemonConfig,
} from "./pinned";

const BENCH = join(ROOT, ".cmx2", "bench");
/** the value after `--name`, if given */
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const PORT = Number(flag("--port") ?? process.env.CMX2_PORT ?? 4840);
const BOXBOX_PORT = Number(flag("--boxbox-port") ?? DEFAULT_BOXBOX_PORT);
const MODEL_PORT = PORT + 1;

function fail(message: string): never {
  console.error(`cmx2: ${message}`);
  process.exit(1);
}

function attempt<T>(step: () => T): T {
  try {
    return step();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function prepareBench(fresh: boolean) {
  if (fresh) rmSync(join(BENCH, "data"), { recursive: true, force: true });
  const dirs = daemonDirs(BENCH);
  writeDaemonConfig(dirs, MODEL_PORT);
  const notes = join(dirs.work, "notes.md");
  writeFileSync(notes, "# bench notes\n\ngreeting: hello\nthe scripted session reads and edits this file.\n");
  return { dirs, password: mintPassword(join(BENCH, "password"), "bench") };
}

const children: ChildProcess[] = [];
let stopping = false;

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  const deadline = setTimeout(() => {
    for (const child of children) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    process.exit(code);
  }, 3000);
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(() => {
    clearTimeout(deadline);
    process.exit(code);
  });
}

/** `supervised`: a clean exit (code 0, no signal) is started again, as launchd and systemd do for an
    installed daemon, because that is how `POST /global/restart` ends: the daemon aborts its turns, closes
    its streams and exits for its supervisor. any other exit stops the bench. */
function start(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  supervised = false,
) {
  /* detached: its own process group, so stopping it also stops what it spawned */
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    children.splice(children.indexOf(child), 1);
    if (supervised && code === 0 && signal === null) {
      console.log(`cmx2: ${name} exited cleanly (a restart); starting a fresh one`);
      start(name, command, args, cwd, env, supervised);
      return;
    }
    console.error(`cmx2: ${name} exited (${signal ?? code}); stopping the bench`);
    stop(1);
  });
  children.push(child);
}

async function waitForHealth(password: string): Promise<Record<string, unknown>> {
  const auth = basicAuth(password);
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/global/health`, { headers: { authorization: auth } });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  return fail(`the daemon did not answer /global/health on ${PORT} within 20 s`);
}

attempt(() => checkPort(PORT));
if (!Number.isInteger(BOXBOX_PORT) || BOXBOX_PORT < 1024 || BOXBOX_PORT > 65535) {
  fail(`--boxbox-port must be a port from 1024 to 65535, not ${flag("--boxbox-port")}`);
}
attempt(() => exportPin((line) => console.log(`cmx2: ${line}`)));
const { dirs, password } = attempt(() => prepareBench(process.argv.includes("--fresh")));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

start("the bench model", "bun", modelArgs(MODEL_PORT), ROOT, baseEnv());
start("the daemon", "bun", daemonArgs(PORT), dirs.work, daemonEnv(dirs, password), true);

writeBoxboxConfigs(BENCH, PORT, password, BOXBOX_PORT);
const health = await waitForHealth(password);
const pinned = attempt(pinnedVersion);
writeFileSync(
  join(BENCH, "daemon.json"),
  `${JSON.stringify({ url: `http://127.0.0.1:${PORT}`, pin: PIN, pids: children.map((c) => c.pid) }, null, 2)}\n`,
);
console.log(`cmx2: GET /global/health -> ${JSON.stringify(health)}`);
console.log(
  health.version === pinned
    ? `cmx2: dev daemon ready on http://127.0.0.1:${PORT}, version ${pinned} matches the pin ${PIN.slice(0, 7)}`
    : fail(`the daemon reports ${String(health.version)}, the pinned source says ${pinned}`),
);
