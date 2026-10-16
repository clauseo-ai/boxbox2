/* the cmx2 contract, vendored from the one commit in cmx2.pin, and the
   openclaw gateway protocol schema, vendored from the published npm tarball
   at the version in openclaw.pin (docs/openclaw.md, 2.2).

   `bun scripts/vendor.ts`                 copies both
   `bun scripts/vendor.ts --only openclaw` copies only the openclaw schema
   `bun scripts/vendor.ts --check`         proves the vendored bytes are the pins'

   the proof works without the cmx2 repo: vendor/cmx2/SOURCE records the
   git blob id of each file at the pin, and a blob id is the content's own
   address, so `git hash-object` of the vendored file must equal it. when
   the cmx2 repo is present (CMX2_REPO, default ../cmx2), the check also
   asks git for the blob ids at the pin, so a hand-edited SOURCE cannot
   pass either.

   the openclaw schema is not in openclaw's repository at any commit (it is
   generated at prepack), so it comes from `npm pack`: the tarball's sha512
   must equal `schema` in openclaw.pin, and the copied file's sha256 is
   written to vendor/openclaw/protocol.schema.sha256, which the check
   recomputes with no network. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPin as readOpenclawPin } from "./openclaw-pinned";

const ROOT = resolve(import.meta.dir, "..");
const REPO = resolve(ROOT, process.env.CMX2_REPO ?? "../cmx2");
const SOURCE = join(ROOT, "vendor/cmx2/SOURCE");

/** upstream path at the pin, and where boxbox keeps it */
const FILES = [
  { upstream: "packages/client/openapi.json", vendored: "vendor/cmx2/openapi.json" },
  { upstream: "packages/contract/src/manifest.ts", vendored: "vendor/cmx2/manifest.ts" },
] as const;

function git(args: string[], cwd: string): string {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${out.stderr.trim()}`);
  }
  return out.stdout;
}

function readPin(): string {
  const pin = readFileSync(join(ROOT, "cmx2.pin"), "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error(`cmx2.pin must hold one full commit sha, found "${pin}"`);
  return pin;
}

function repoHasPin(pin: string): boolean {
  if (!existsSync(join(REPO, ".git"))) return false;
  return spawnSync("git", ["cat-file", "-e", `${pin}^{commit}`], { cwd: REPO }).status === 0;
}

function vendor(): void {
  const pin = readPin();
  if (!repoHasPin(pin)) {
    throw new Error(`the cmx2 repo at ${REPO} does not have commit ${pin}; set CMX2_REPO to a clone that does`);
  }
  const lines = [
    "# written by `just vendor`: the pinned commit, then one line per file:",
    "# <git blob id at the pin>  <path in cmx2>  <path here>",
    pin,
  ];
  for (const f of FILES) {
    const bytes = spawnSync("git", ["show", `${pin}:${f.upstream}`], { cwd: REPO }).stdout;
    writeFileSync(join(ROOT, f.vendored), bytes);
    const blob = git(["rev-parse", `${pin}:${f.upstream}`], REPO).trim();
    lines.push(`${blob}  ${f.upstream}  ${f.vendored}`);
    console.log(`vendored ${f.vendored} from ${pin.slice(0, 7)} (${bytes.length} bytes)`);
  }
  writeFileSync(SOURCE, `${lines.join("\n")}\n`);
}

function check(): void {
  const pin = readPin();
  const rows = readFileSync(SOURCE, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));
  const [recordedPin, ...entries] = rows;
  const failures: string[] = [];
  if (recordedPin !== pin) {
    failures.push(`vendor/cmx2/SOURCE is from ${recordedPin}, cmx2.pin says ${pin}: run \`just vendor\``);
  }
  const withRepo = repoHasPin(pin);
  for (const f of FILES) {
    const entry = entries.find((e) => e.split(/\s+/)[2] === f.vendored);
    if (!entry) {
      failures.push(`${f.vendored} has no line in vendor/cmx2/SOURCE: run \`just vendor\``);
      continue;
    }
    const blob = entry.split(/\s+/)[0];
    const actual = git(["hash-object", f.vendored], ROOT).trim();
    if (actual !== blob) failures.push(`${f.vendored} differs from the pinned commit (blob ${actual}, pin has ${blob})`);
    if (withRepo) {
      const atPin = git(["rev-parse", `${pin}:${f.upstream}`], REPO).trim();
      if (atPin !== blob) failures.push(`vendor/cmx2/SOURCE records ${blob} for ${f.upstream}, the pin has ${atPin}`);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`vendor: ${f}`);
    process.exit(1);
  }
  const how = withRepo ? `blob ids confirmed against ${REPO}` : "blob ids from vendor/cmx2/SOURCE (no cmx2 repo here)";
  console.log(`vendor: ${FILES.length} files match cmx2 ${pin.slice(0, 7)}, ${how}`);
}

const OPENCLAW_SCHEMA = "vendor/openclaw/protocol.schema.json";
const OPENCLAW_SHA = "vendor/openclaw/protocol.schema.sha256";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function vendorOpenclaw(): void {
  const pin = readOpenclawPin();
  const pkg = `@openclaw/gateway-protocol@${pin.version}`;
  mkdirSync("/tmp/boxbox-vendor", { recursive: true });
  const dir = mkdtempSync("/tmp/boxbox-vendor/openclaw-");
  try {
    const pack = spawnSync("npm", ["pack", pkg, "--json", "--pack-destination", dir], { cwd: dir, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack ${pkg} failed: ${pack.stderr.trim()}`);
    const [info] = JSON.parse(pack.stdout) as { filename: string; integrity: string }[];
    if (!info) throw new Error(`npm pack ${pkg} printed no tarball`);
    const tarball = join(dir, info.filename.replace(/^@/, "").replace("/", "-"));
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    if (integrity !== pin.schema) throw new Error(`${pkg} has integrity ${integrity}, openclaw.pin says ${pin.schema}`);
    const untar = spawnSync("tar", ["-xzf", tarball, "-C", dir, "package/protocol.schema.json"]);
    if (untar.status !== 0) throw new Error(`${info.filename} has no package/protocol.schema.json`);
    const bytes = readFileSync(join(dir, "package/protocol.schema.json"));
    mkdirSync(join(ROOT, "vendor/openclaw"), { recursive: true });
    writeFileSync(join(ROOT, OPENCLAW_SCHEMA), bytes);
    writeFileSync(
      join(ROOT, OPENCLAW_SHA),
      `# written by \`just vendor\` from ${pkg} (${pin.schema})\n${sha256(bytes)}  protocol.schema.json\n`,
    );
    console.log(`vendored ${OPENCLAW_SCHEMA} from ${pkg} (${bytes.length} bytes, sha256 ${sha256(bytes)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkOpenclaw(): void {
  const pin = readOpenclawPin();
  const lines = readFileSync(join(ROOT, OPENCLAW_SHA), "utf8").split("\n");
  const header = lines.find((l) => l.startsWith("#")) ?? "";
  const recorded = lines.find((l) => l && !l.startsWith("#"))?.split(/\s+/)[0];
  const failures: string[] = [];
  if (!header.includes(`@${pin.version} (${pin.schema})`)) {
    failures.push(`${OPENCLAW_SHA} is not from @openclaw/gateway-protocol@${pin.version} (${pin.schema}): run \`just vendor\``);
  }
  const actual = sha256(readFileSync(join(ROOT, OPENCLAW_SCHEMA)));
  if (actual !== recorded) failures.push(`${OPENCLAW_SCHEMA} has sha256 ${actual}, ${OPENCLAW_SHA} records ${recorded}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`vendor: ${f}`);
    process.exit(1);
  }
  console.log(`vendor: ${OPENCLAW_SCHEMA} matches @openclaw/gateway-protocol@${pin.version}, sha256 ${actual.slice(0, 12)}`);
}

try {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
  if (process.argv.includes("--check")) {
    check();
    checkOpenclaw();
  } else if (only === "openclaw") vendorOpenclaw();
  else if (only === "cmx2") vendor();
  else if (only !== undefined) throw new Error(`--only takes cmx2 or openclaw, not ${only}`);
  else {
    vendor();
    vendorOpenclaw();
  }
} catch (error) {
  console.error(`vendor: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
