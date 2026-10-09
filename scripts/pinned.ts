/* the cmx2 daemon from the commit in cmx2.pin, as `just cmx2`
   (scripts/cmx2.ts) and `just probes` (probes/run.ts) both run it: the
   export, the bench config that points its provider at the bench model,
   and the allowlisted environment. one place, so the two can never start
   the daemon differently.

   every function here throws an Error with a message fit to print; the
   callers decide how to stop. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const REPO = resolve(ROOT, process.env.CMX2_REPO ?? "../cmx2");
export const PIN = readFileSync(join(ROOT, "cmx2.pin"), "utf8").trim();
export const SOURCE = join(ROOT, ".cmx2", PIN);

/** the boxbox server's port: 3001 (AGENTS.md), or BOXBOX_PORT when 3001 belongs to something else on
    this machine; the bench configs, `just dev` and the bench tools all read it from here */
export const BOXBOX_PORT = Number(process.env.BOXBOX_PORT ?? 3001);

/** the port rule from AGENTS.md: the daemon on 4840 to 4848, the bench model
    on the next port. sessions working in parallel worktrees each take their
    own decade the same way (4850s to 4990s), so two benches never collide. */
export function checkPort(port: number) {
  const inDecade = port % 10 <= 8;
  if (!Number.isInteger(port) || port < 4840 || port > 4998 || !inDecade) {
    throw new Error(
      `the daemon port must be 4840 to 4848, or x0 to x8 of a later decade up to 4998 (the bench model takes the next port), not ${port}`,
    );
  }
}

function run(command: string, args: string[], cwd: string) {
  const out = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (out.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

/** exports the pinned commit with `git archive` and installs it, once; never runs the cmx2 working tree */
export function exportPin(log: (line: string) => void) {
  if (!/^[0-9a-f]{40}$/.test(PIN)) throw new Error("cmx2.pin must hold one full commit sha");
  if (existsSync(join(SOURCE, "node_modules"))) return;
  if (spawnSync("git", ["cat-file", "-e", `${PIN}^{commit}`], { cwd: REPO }).status !== 0) {
    throw new Error(`the cmx2 repo at ${REPO} does not have ${PIN}; set CMX2_REPO`);
  }
  log(`exporting ${PIN.slice(0, 7)} into .cmx2/${PIN.slice(0, 7)}...`);
  rmSync(SOURCE, { recursive: true, force: true });
  mkdirSync(SOURCE, { recursive: true });
  const archive = spawnSync("git", ["archive", "--format=tar", PIN], { cwd: REPO, maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error("git archive failed");
  const untar = spawnSync("tar", ["-x", "-C", SOURCE], { input: archive.stdout });
  if (untar.status !== 0) throw new Error("unpacking the archive failed");
  run("bun", ["install", "--frozen-lockfile"], SOURCE);
}

/** the VERSION the pinned server source declares, which /global/health must report. from 0.8 the
    line reads `VERSION: string = typeof CMX2_VERSION === "string" ? CMX2_VERSION : "0.8.1-dev"`: release
    builds stamp their own, and a source run like the bench's says the literal, which is the last one */
export function pinnedVersion(): string {
  const index = readFileSync(join(SOURCE, "packages/server/src/index.ts"), "utf8");
  const match = /^export const VERSION\b.*"([^"]+)";$/m.exec(index);
  if (!match?.[1]) throw new Error("cannot find VERSION in the pinned server source");
  return match[1];
}

/** a password minted once into `file` and reused, never an inherited one */
export function mintPassword(file: string, prefix: string): string {
  if (!existsSync(file)) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    writeFileSync(file, `${prefix}-${Buffer.from(bytes).toString("hex")}\n`, { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
}

/** where one daemon keeps everything: its config, data, home and working directory */
export interface DaemonDirs {
  config: string;
  data: string;
  home: string;
  work: string;
}

export function daemonDirs(base: string): DaemonDirs {
  const dirs = { config: join(base, "config"), data: join(base, "data"), home: join(base, "home"), work: join(base, "work") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

/** points the daemon's anthropic provider at the bench model, so no real key or provider is ever used */
export function writeDaemonConfig(dirs: DaemonDirs, modelPort: number) {
  const config = {
    model: "anthropic/claude-opus-5-5",
    providers: { anthropic: { baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "bench-model" } },
  };
  writeFileSync(join(dirs.config, "cmx2.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
}

/** path, locale and tmp: all the bench model and the daemon get from the shell */
export function baseEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp" };
}

/** an allowlist rather than unset names: nothing the shell holds (a real password, provider keys,
    the maintainer's config) can reach the daemon */
export function daemonEnv(dirs: DaemonDirs, password: string): Record<string, string> {
  return {
    ...baseEnv(),
    HOME: dirs.home,
    SHELL: "/bin/bash",
    CMX2_CONFIG_DIR: dirs.config,
    CMX2_DATA_DIR: dirs.data,
    CMX2_SERVER_PASSWORD: password,
    CMX2_CHECK_EVENTS: "1",
  };
}

export function daemonArgs(port: number): string[] {
  return [join(SOURCE, "packages/cli/src/index.ts"), "serve", "--port", String(port), "--hostname", "127.0.0.1"];
}

export function modelArgs(modelPort: number): string[] {
  return [join(ROOT, "bench/model.ts"), "--port", String(modelPort)];
}

export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`cmx2:${password}`).toString("base64")}`;
}

/** the boxbox bench configs: the release binary serves its embedded app
    (boxbox.toml), the dev server proxies vite (boxbox.dev.toml). both use
    the dev cookie name and a gate password minted once, never a real one.
    `just cmx2` writes them for the port it runs on; `just dev` writes them
    when they are missing, so the dev server can start before the daemon
    and pick up the daemon's rewrite (the server reloads host config when
    the file changes). */
export function writeBoxboxConfigs(bench: string, daemonPort: number, daemonPassword: string, boxboxPort = BOXBOX_PORT) {
  mkdirSync(bench, { recursive: true });
  const gate = mintPassword(join(bench, "gate-password"), "gate");
  const common = [
    "# written by `just cmx2` for the bench; never a real password",
    `listen = "127.0.0.1:${boxboxPort}"`,
    `data_dir = "${join(bench, "boxbox-data")}"`,
    `password = "${gate}"`,
    "",
    "[cookie]",
    'name = "boxbox_dev_session"',
    "secure = false",
    "",
    "[[host]]",
    'name = "bench"',
    `url = "http://127.0.0.1:${daemonPort}"`,
    `password = "${daemonPassword}"`,
  ];
  writeFileSync(join(bench, "boxbox.toml"), `${common.join("\n")}\n`, { mode: 0o600 });
  const dev = [...common, "", "[dev]", 'vite = "http://127.0.0.1:3002"'];
  writeFileSync(join(bench, "boxbox.dev.toml"), `${dev.join("\n")}\n`, { mode: 0o600 });
}
