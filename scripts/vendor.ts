/* the cmx2 contract, vendored from the one commit in cmx2.pin.

   `bun scripts/vendor.ts`         copies the files from the pinned commit
   `bun scripts/vendor.ts --check` proves the vendored bytes are the pin's

   the proof works without the cmx2 repo: vendor/cmx2/SOURCE records the
   git blob id of each file at the pin, and a blob id is the content's own
   address, so `git hash-object` of the vendored file must equal it. when
   the cmx2 repo is present (CMX2_REPO, default ../cmx2), the check also
   asks git for the blob ids at the pin, so a hand-edited SOURCE cannot
   pass either. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

try {
  if (process.argv.includes("--check")) check();
  else vendor();
} catch (error) {
  console.error(`vendor: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
