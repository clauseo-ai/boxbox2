/* the openclaw gateway from the commit in openclaw.pin, as `just openclaw`
   (scripts/openclaw.ts) and the bench tools (bench/openclaw-*.ts) both run
   it: the mirror, the export and build, the fixture config that points the
   gateway at the scripted model, and the allowlisted environment. one
   place, so the two can never start the gateway differently
   (docs/openclaw.md, section 11).

   every function here throws an Error with a message fit to print; the
   callers decide how to stop. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mintPassword, ROOT } from "./pinned";

export { ROOT };

/** the four lines of openclaw.pin (docs/openclaw.md, 2.1) */
export interface OpenclawPin {
  commit: string;
  version: string;
  protocol: number;
  schema: string;
}

export function readPin(): OpenclawPin {
  const text = readFileSync(join(ROOT, "openclaw.pin"), "utf8");
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^(\w+) = (\S+)$/.exec(line.trim());
    if (match?.[1] && match[2]) fields.set(match[1], match[2]);
  }
  const commit = fields.get("commit") ?? "";
  const version = fields.get("version") ?? "";
  const protocol = Number(fields.get("protocol"));
  const schema = fields.get("schema") ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("openclaw.pin: `commit` must be one full commit sha");
  if (!/^\d{4}\.\d+\.\d+$/.test(version)) throw new Error("openclaw.pin: `version` must look like 2026.10.1");
  if (!Number.isInteger(protocol)) throw new Error("openclaw.pin: `protocol` must be a whole number");
  if (!schema.startsWith("sha512-")) throw new Error("openclaw.pin: `schema` must be an npm sha512 integrity");
  return { commit, version, protocol, schema };
}

export const PIN = readPin();
export const SOURCE = join(ROOT, ".openclaw", PIN.commit);
/** the default bench, for the gateway on 4740 */
export const BENCH = join(ROOT, ".openclaw", "bench");

/** where one bench gateway keeps everything: 4740's is .openclaw/bench, any other port's is
    .openclaw/bench-<port> (the pairing bench), so two gateways never share a state dir */
export function benchDir(port: number): string {
  return port === 4740 ? BENCH : join(ROOT, ".openclaw", `bench-${port}`);
}
export const MIRROR = process.env.OPENCLAW_MIRROR ?? join(homedir(), ".cache", "boxbox", "openclaw.git");
export const UPSTREAM = "https://github.com/openclaw/openclaw.git";
/** corepack left node's distribution at 25; this exact version runs the tree's `packageManager` pnpm */
export const COREPACK = "corepack@0.36.0";

/** the port rule (docs/openclaw.md, 11.3): the gateway on x0 to x5 of a decade from 4700 to 4830, the
    scripted model on the next port and the speech stub on the one after, so all three stay in x0 to x7.
    4740 is the default; never 4840 and up, which is cmx2's range */
export function checkPort(port: number) {
  if (!Number.isInteger(port) || port < 4700 || port > 4835 || port % 10 > 5) {
    throw new Error(
      `the gateway port must be x0 to x5 of a decade from 4700 to 4830 (the model takes the next port, the speech stub the one after), not ${port}`,
    );
  }
}

/** the ports one bench gateway uses */
export function benchPorts(port: number) {
  return { gateway: port, model: port + 1, speech: port + 2 };
}

/** true when something already accepts connections on the port */
export async function listening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[], cwd: string, env?: Record<string, string>) {
  const out = spawnSync(command, args, { cwd, stdio: "inherit", env: env ?? process.env });
  if (out.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd} (exit ${out.status ?? out.signal})`);
}

/** node must satisfy the tree's engines.node, `>=24.16.0 <25 || >=26.1.0` */
export function checkNode(): string {
  const out = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (out.status !== 0) throw new Error("node is not on the path: install node 24.16 or later in 24, or 26.1 or later");
  const version = out.stdout.trim();
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  const ok = (major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26;
  if (!ok) throw new Error(`node ${version} does not satisfy openclaw's engines (>=24.16.0 <25 || >=26.1.0); install one that does`);
  return version;
}

/** ffmpeg renders the speech stub's clip and serves the playback transcode (docs/openclaw.md, 8.4) */
export function checkFfmpeg() {
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("ffmpeg is not on the path; install it (brew install ffmpeg, or your distribution's package)");
  }
}

function mirrorHas(commit: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: MIRROR }).status === 0;
}

/** the bare mirror holds the pinned commit: created when missing, and one shallow fetch of exactly the
    pinned commit when it lacks it. not `git clone --mirror`: github serves every pull request's refs to a
    mirror clone, past 10 GiB for openclaw (docs/gotchas.md, the openclaw mirror), and `git archive` needs
    only the one tree */
export function ensureMirror(log: (line: string) => void) {
  if (!existsSync(join(MIRROR, "HEAD"))) {
    log(`creating the bare mirror ${MIRROR} for ${UPSTREAM}...`);
    mkdirSync(MIRROR, { recursive: true });
    run("git", ["init", "--quiet", "--bare"], MIRROR);
    run("git", ["remote", "add", "origin", UPSTREAM], MIRROR);
  }
  if (!mirrorHas(PIN.commit)) {
    log(`the mirror lacks ${PIN.commit.slice(0, 9)}; fetching that commit (depth 1)...`);
    run("git", ["fetch", "--quiet", "--depth=1", "origin", PIN.commit], MIRROR);
  }
  if (!mirrorHas(PIN.commit)) throw new Error(`${UPSTREAM} has no commit ${PIN.commit}; check openclaw.pin`);
}

const STAMP = () => join(SOURCE, ".built");

export function isBuilt(): boolean {
  return existsSync(STAMP()) && readFileSync(STAMP(), "utf8").trim() === PIN.commit;
}

/** pnpm through corepack, so the tree's exact `packageManager` version runs; nice and three jobs, so a
    build shares the machine (lane rules) */
function pnpm(args: string[]) {
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "1" };
  run("nice", ["-n", "10", "npx", "--yes", COREPACK, "pnpm", ...args], SOURCE, env);
}

/** export with `git archive`, install, build and regenerate the schema, once per commit; a tree without
    the `.built` stamp is redone from scratch */
export function buildPin(log: (line: string) => void) {
  if (isBuilt()) return;
  ensureMirror(log);
  const started = Date.now();
  log(`exporting ${PIN.commit.slice(0, 9)} into .openclaw/${PIN.commit.slice(0, 9)}...`);
  rmSync(SOURCE, { recursive: true, force: true });
  mkdirSync(SOURCE, { recursive: true });
  /* streamed through a pipe: the tree is too large to buffer in one spawnSync */
  const exported = spawnSync("bash", ["-o", "pipefail", "-c", 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', "export", MIRROR, PIN.commit, SOURCE], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (exported.status !== 0) throw new Error(`git archive ${PIN.commit} from ${MIRROR} into ${SOURCE} failed`);
  log("pnpm install --frozen-lockfile...");
  pnpm(["install", "--frozen-lockfile"]);
  log("pnpm build...");
  pnpm(["build"]);
  log("pnpm protocol:gen, compared with vendor/openclaw/protocol.schema.json...");
  checkGeneratedSchema();
  writeFileSync(STAMP(), `${PIN.commit}\n`);
  log(`built ${PIN.commit.slice(0, 9)} in ${Math.round((Date.now() - started) / 1000)} s`);
}

/** the schema regenerated from the exported tree must equal the vendored one (docs/openclaw.md, 2.2) */
export function checkGeneratedSchema() {
  mkdirSync(BENCH, { recursive: true });
  const out = join(BENCH, "protocol.schema.generated.json");
  pnpm(["protocol:gen", "--out", out]);
  const generated = readFileSync(out);
  const vendored = readFileSync(join(ROOT, "vendor/openclaw/protocol.schema.json"));
  if (!generated.equals(vendored)) {
    throw new Error(
      `the schema generated from ${PIN.commit.slice(0, 9)} (${generated.length} bytes, ${out}) differs from vendor/openclaw/protocol.schema.json (${vendored.length} bytes): the published tarball drifted from its tree`,
    );
  }
}

/** the bench token, minted once into <bench>/token (mode 0600) and never an inherited one */
export function benchToken(bench = BENCH): string {
  mkdirSync(bench, { recursive: true });
  return mintPassword(join(bench, "token"), "bench");
}

/** a 4x4 png */
export const DOT_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4EaABRwzEcQASUhQBFGG4BQAAAABJRU5ErkJggg==";

export const MODEL_ID = "gpt-5.6-luna";
export const MODEL_REF = `mock-openai/${MODEL_ID}`;
export const AGENTS = [
  { id: "main", name: "assistant" },
  { id: "helper", name: "helper" },
] as const;

/** the dirs of one bench: home (HOME and OPENCLAW_HOME), state (OPENCLAW_STATE_DIR), the config file,
    one workspace per agent, the scripted model's control file and request log */
export interface BenchPaths {
  root: string;
  home: string;
  state: string;
  config: string;
  work: Record<string, string>;
  control: string;
  requestLog: string;
}

export function benchPaths(bench: string): BenchPaths {
  const work = Object.fromEntries(AGENTS.map((a) => [a.id, join(bench, "work", a.id)]));
  return {
    root: bench,
    home: join(bench, "home"),
    state: join(bench, "state"),
    config: join(bench, "openclaw.json"),
    work,
    control: join(bench, "script.json"),
    requestLog: join(bench, "model-requests.jsonl"),
  };
}

export interface BenchOptions {
  port: number;
  token: string;
  /** `--pairing manual`: silent local pairing off, so a device must be approved by hand */
  manualPairing: boolean;
  /** session.maintenance.archiveDashboardAfter, e.g. "1m" for the auto-archive test; the tree's 7 day default when unset */
  archiveDashboardAfter?: string;
}

/** the fixture config (docs/openclaw.md, 11.6), written on every start; shape from the tree's
    gateway-concurrent-streams.test.ts and scripts/e2e/lib/fixtures/mock-openai-config.mjs */
export function writeBenchConfig(paths: BenchPaths, options: BenchOptions) {
  const ports = benchPorts(options.port);
  for (const dir of [paths.home, paths.state, ...Object.values(paths.work)]) mkdirSync(dir, { recursive: true });
  for (const dir of Object.values(paths.work)) {
    writeFileSync(join(dir, "notes.md"), "# bench notes\n\ngreeting: hello\nthe scripted turns read this file.\n");
    /* the picture the image scenario attaches with `MEDIA: ./dot.png` (a data: url in a MEDIA line stays text) */
    writeFileSync(join(dir, "dot.png"), Buffer.from(DOT_PNG, "base64"));
  }
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const config = {
    gateway: {
      mode: "local",
      port: options.port,
      auth: { mode: "token", token: options.token },
      controlUi: { enabled: false },
      ...(options.manualPairing ? { nodes: { pairing: { autoApproveLocal: false } } } : {}),
    },
    hooks: { enabled: false },
    agents: {
      defaults: {
        skipBootstrap: true,
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" }, params: { transport: "sse", openaiWsWarmup: false } } },
        modelPolicy: { allow: [MODEL_REF] },
        /* the default agent at 2026.10.1: explicit ownership names the owner of each surface, where older
           trees took `default: true` on an entry (`openclaw doctor --fix` writes this shape) */
        systemAgent: { agentId: "main" },
      },
      entries: Object.fromEntries(AGENTS.map((a) => [a.id, { name: a.name, workspace: paths.work[a.id] }])),
      ownership: "explicit",
    },
    talk: { agentId: "main" },
    models: {
      mode: "replace",
      providers: {
        "mock-openai": {
          baseUrl: `http://127.0.0.1:${ports.model}/v1`,
          apiKey: "bench",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            { id: MODEL_ID, name: MODEL_ID, api: "openai-responses", reasoning: true, input: ["text", "image"], cost, contextWindow: 128000, maxTokens: 4096 },
          ],
        },
      },
    },
    tools: { exec: { mode: "ask", host: "gateway" } },
    plugins: { slots: { memory: "none" }, entries: { openai: { enabled: true } } },
    tts: {
      auto: "tagged",
      provider: "openai",
      providers: { openai: { baseUrl: `http://127.0.0.1:${ports.speech}/v1`, apiKey: "bench", model: "gpt-4o-mini-tts", speakerVoice: "alloy" } },
    },
    update: { checkOnStart: false },
    /* the log file defaults to /tmp/openclaw/openclaw-<date>.log, shared by every gateway on the machine */
    logging: { file: join(paths.root, "logs", "openclaw.log") },
    ...(options.archiveDashboardAfter ? { session: { maintenance: { archiveDashboardAfter: options.archiveDashboardAfter } } } : {}),
  };
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** path, locale and tmp from the shell, and nothing else */
function baseEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp" };
}

/** the gateway's environment: an allowlist (docs/openclaw.md, 11.4), so no real token, key or config in
    the shell reaches it. never VITEST, NODE_ENV=test or OPENCLAW_SKIP_CRON */
export function gatewayEnv(paths: BenchPaths): Record<string, string> {
  return {
    ...baseEnv(),
    HOME: paths.home,
    OPENCLAW_HOME: paths.home,
    OPENCLAW_STATE_DIR: paths.state,
    OPENCLAW_CONFIG_PATH: paths.config,
    OPENCLAW_GATEWAY_PORT: "",
    OPENCLAW_GATEWAY_TOKEN: "",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin",
  };
}

export function gatewayArgs(port: number, bind: "loopback" | "lan"): string[] {
  return [join(SOURCE, "dist/index.js"), "gateway", "run", "--port", String(port), "--bind", bind, "--allow-unconfigured"];
}

/** the scripted model: the pinned tree's own mock, run from the export */
export function modelArgs(): string[] {
  return [join(SOURCE, "scripts/e2e/mock-openai-server.mjs")];
}

export function modelEnv(paths: BenchPaths, port: number): Record<string, string> {
  return {
    ...baseEnv(),
    HOME: paths.home,
    MOCK_PORT: String(benchPorts(port).model),
    MOCK_BIND_HOST: "127.0.0.1",
    MOCK_RESPONSE_CONTROL: paths.control,
    MOCK_REQUEST_LOG: paths.requestLog,
  };
}

export function speechArgs(port: number, paths: BenchPaths): string[] {
  return [join(ROOT, "bench/openclaw-speech.ts"), "--port", String(benchPorts(port).speech), "--dir", join(paths.root, "speech")];
}

/** the openclaw cli from the export, under the bench's state dir (devices approve, cron) */
export function cliArgs(args: string[]): string[] {
  return [join(SOURCE, "dist/index.js"), ...args];
}
