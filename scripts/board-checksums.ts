/* the board is frozen (decisions 1, 11, 14, 21): every file under board/ is
   v1's, byte for byte, except
     - client.ts, which is ported to v2's api (m6) and not held here;
     - files scrubbed of the maintainer's machine names and tailnet origin
       (decision 21), whose bytes are v1's after the substitutions below;
     - the type-only extractions of v1 modules whose runtime stays behind
       (brain.ts, term-pins.ts, watcher.ts), whose every declaration is
       verbatim from v1.

   board/CHECKSUMS records the v1 commit and, per file, its sha256, its mode
   and its v1 path. `bun scripts/board-checksums.ts` rewrites it from v1 (the
   repo at BOXBOX_V1_REPO); board/checksums.test.ts holds the tree to it.

   maintainer-only: rewriting needs the boxbox v1 repo, which is not public,
   and a private substitution file. the test runs anywhere and checks the
   recorded hashes. */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const ROOT = resolve(import.meta.dir, "..");
export const BOARD = join(ROOT, "board");
export const V1_REPO = process.env.BOXBOX_V1_REPO ? resolve(ROOT, process.env.BOXBOX_V1_REPO) : "";
export const V1_COMMIT = "18df8bd2977a2182e2dca4f88694cee56876ece3";

export type Mode = "verbatim" | "scrubbed" | "extracted" | "ported";

/** v2 path (under board/) to its v1 path */
export function v1PathOf(path: string): string {
  if (path.startsWith("daemon/")) return `board/${path.slice("daemon/".length)}`;
  if (path.startsWith("lib/")) return path;
  throw new Error(`${path} has no v1 counterpart`);
}

const PORTED = new Set(["daemon/src/client.ts"]);
const EXTRACTED = new Set(["lib/server/brain.ts", "lib/server/term-pins.ts", "lib/fleet/watcher.ts"]);
/** not carried from v1: the proof itself, and the trace harness that holds
    the board to v1's behaviour (board/trace/, its tests in board/test/) */
const OWN = new Set(["CHECKSUMS", "checksums.test.ts"]);
const OWN_DIRS = ["trace/", "test/"];

/** decision 21: files carried with the maintainer's machine names and tailnet
    origin replaced by placeholders. the substitutions themselves name what
    they remove, so they live in private/board-scrubs.json (gitignored) as
    `{path: [[pattern, flags, replacement], ...]}`, and re-deriving these
    files from v1 runs only where that file exists. */
export const SCRUBBED = new Set([
  "daemon/install.sh",
  "daemon/src/config.ts",
  "daemon/test/controller.test.ts",
  "daemon/test/scenes.test.ts",
  "daemon/test/state.test.ts",
  "lib/fleet/watcher.ts",
]);

const SCRUB_FILE = join(ROOT, "private/board-scrubs.json");

export function scrubsAvailable(): boolean {
  return existsSync(SCRUB_FILE);
}

function scrubRules(): Record<string, [string, string, string][]> {
  return JSON.parse(readFileSync(SCRUB_FILE, "utf8")) as Record<string, [string, string, string][]>;
}

export function modeOf(path: string): Mode {
  if (PORTED.has(path)) return "ported";
  if (EXTRACTED.has(path)) return "extracted";
  if (SCRUBBED.has(path)) return "scrubbed";
  return "verbatim";
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function scrub(path: string, text: string): string {
  const rules = scrubRules()[path] ?? [];
  return rules.reduce((out, [pattern, flags, replacement]) => out.replace(new RegExp(pattern, flags), replacement), text);
}

/** every file the board tree holds, relative to board/ */
export function boardFiles(dir = BOARD): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === ".DS_Store") return [];
      return statSync(path).isDirectory() ? boardFiles(path) : [relative(BOARD, path)];
    })
    .filter((path) => !OWN.has(path) && !OWN_DIRS.some((dir) => path.startsWith(dir)))
    .sort();
}

export function v1HasCommit(): boolean {
  return (
    V1_REPO !== "" &&
    existsSync(join(V1_REPO, ".git")) &&
    spawnSync("git", ["cat-file", "-e", `${V1_COMMIT}^{commit}`], { cwd: V1_REPO }).status === 0
  );
}

export function v1File(path: string): string {
  const out = spawnSync("git", ["show", `${V1_COMMIT}:${path}`], { cwd: V1_REPO, encoding: "utf8", maxBuffer: 1 << 26 });
  if (out.status !== 0) throw new Error(`v1 has no ${path} at ${V1_COMMIT.slice(0, 7)}`);
  return out.stdout;
}

/** each top-level `export type` declaration in a file, as written */
export function typeDeclarations(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("export type ")) continue;
    if (line.endsWith(";")) {
      blocks.push(line);
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i] !== "};") i++;
    blocks.push(lines.slice(start, i + 1).join("\n"));
  }
  return blocks;
}

export type Entry = { sha: string; mode: Mode; path: string; v1: string };

export function readChecksums(): { commit: string; entries: Entry[] } {
  const lines = readFileSync(join(BOARD, "CHECKSUMS"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  const [commit = "", ...rows] = lines;
  const entries = rows.map((row) => {
    const [sha = "", mode = "", path = "", v1 = ""] = row.split(/\s+/);
    return { sha, mode: mode as Mode, path, v1 };
  });
  return { commit, entries };
}

function write() {
  if (!v1HasCommit()) throw new Error(`maintainer-only: this needs a checkout of the private boxbox v1 repo that has commit ${V1_COMMIT}. set BOXBOX_V1_REPO to its path. board/CHECKSUMS is checked without it by \`bun test board\``);
  if (!scrubsAvailable()) throw new Error("maintainer-only: private/board-scrubs.json is missing, so the scrubbed files cannot be re-derived");
  const rows = boardFiles().map((path) => {
    const mode = modeOf(path);
    const sha = sha256(readFileSync(join(BOARD, path)));
    return `${sha}  ${mode.padEnd(9)}  ${path}  ${v1PathOf(path)}`;
  });
  const header = [
    "# the frozen board (decisions 1, 11, 14, 21), written by `bun scripts/board-checksums.ts`.",
    "# the v1 commit, then: <sha256>  <mode>  <path under board/>  <path in v1>",
    "# verbatim: v1's bytes. scrubbed: v1's bytes after decision 21's substitutions.",
    "# extracted: type-only, every declaration verbatim from v1. ported: rewritten for v2, not held.",
  ];
  writeFileSync(join(BOARD, "CHECKSUMS"), `${[...header, V1_COMMIT, ...rows].join("\n")}\n`);
  console.log(`board: ${rows.length} files recorded against v1 ${V1_COMMIT.slice(0, 7)}`);
}

if (import.meta.main) {
  try {
    write();
  } catch (error) {
    console.error(`board: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
