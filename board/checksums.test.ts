/* the board checksum test: every file under board/ is v1's (decisions 1,
   11, 14, 21). the recorded hashes hold everywhere; with the v1 repo
   present, each hash is also re-derived from v1's commit, so CHECKSUMS
   itself cannot drift from v1 either. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOARD,
  V1_COMMIT,
  boardFiles,
  modeOf,
  readChecksums,
  scrub,
  scrubsAvailable,
  sha256,
  typeDeclarations,
  v1File,
  v1HasCommit,
  v1PathOf,
} from "../scripts/board-checksums";

const { commit, entries } = readChecksums();
const byPath = new Map(entries.map((e) => [e.path, e]));

describe("the frozen board", () => {
  test("is recorded against the v1 commit it was copied from", () => {
    expect(commit).toBe(V1_COMMIT);
  });

  test("records every file it holds, and holds every file it records", () => {
    expect(entries.map((e) => e.path).sort()).toEqual(boardFiles());
  });

  test("every file matches its recorded bytes, except the ported client", () => {
    const drifted = entries
      .filter((e) => e.mode !== "ported")
      .filter((e) => sha256(readFileSync(join(BOARD, e.path))) !== e.sha)
      .map((e) => e.path);
    expect(drifted).toEqual([]);
  });

  test("each file's mode is the one the rules give it", () => {
    for (const entry of entries) expect(`${entry.path}: ${entry.mode}`).toBe(`${entry.path}: ${modeOf(entry.path)}`);
    expect(byPath.get("daemon/src/client.ts")?.mode).toBe("ported");
  });
});

/* re-deriving needs v1's repo and the private substitutions, so it runs on
   the maintainer's machine; elsewhere the recorded hashes above are the proof */
describe.if(v1HasCommit() && scrubsAvailable())(`against v1 ${V1_COMMIT.slice(0, 7)}`, () => {
  test("verbatim files are v1's bytes and scrubbed files are v1's after the substitutions", () => {
    const mismatched: string[] = [];
    for (const entry of entries.filter((e) => e.mode === "verbatim" || e.mode === "scrubbed")) {
      const v1 = v1File(v1PathOf(entry.path));
      const expected = entry.mode === "scrubbed" ? scrub(entry.path, v1) : v1;
      if (sha256(expected) !== entry.sha) mismatched.push(entry.path);
    }
    expect(mismatched).toEqual([]);
  });

  test("a scrub changes something, so none is a stale rule", () => {
    for (const entry of entries.filter((e) => e.mode === "scrubbed")) {
      const v1 = v1File(v1PathOf(entry.path));
      expect(scrub(entry.path, v1) === v1 ? `${entry.path} unchanged` : "changed").toBe("changed");
    }
  });

  test("every declaration in an extraction is verbatim from its v1 module", () => {
    const missing: string[] = [];
    for (const entry of entries.filter((e) => e.mode === "extracted")) {
      const source = scrub(entry.path, v1File(v1PathOf(entry.path)));
      const declarations = typeDeclarations(readFileSync(join(BOARD, entry.path), "utf8"));
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        if (!source.includes(declaration)) missing.push(`${entry.path}: ${declaration.split("\n")[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
