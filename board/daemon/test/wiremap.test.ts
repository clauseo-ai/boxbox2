/* the three-way golden: the spec's WIRE_TO_LED table, the firmware's
   copy in keymap.c, and the truth derived from keyboard.json's
   rgb_matrix.layout — all three must agree or a donor swap / upstream
   reorder lights the wrong key with no error (docs/scope-board.md §3).

   the qmk tree lives outside this repo, so this test reads it when
   present (this mac, where flashing happens) and skips loudly when not
   (ci, someone else's checkout). */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KEY_COUNT, WIRE_TO_LED } from "../src/protocol";

const KB_DIR = join(homedir(), "qmk_firmware", "keyboards", "magic_force", "mf17");
const KEYBOARD_JSON = join(KB_DIR, "keyboard.json");
const KEYMAP_C = join(KB_DIR, "keymaps", "boxbox", "keymap.c");

/** wire order as (row, col) matrix positions — the sim's reading order,
    from the spec §3 table. this is the one hand-written link. */
const WIRE_TO_MATRIX: [number, number][] = [
  [0, 0], [0, 1], [0, 2], [0, 3],
  [1, 0], [1, 1], [1, 2], [2, 3],
  [2, 0], [2, 1], [2, 2],
  [3, 0], [3, 1], [3, 2], [4, 3],
  [4, 1], [4, 2],
];

const present = existsSync(KEYBOARD_JSON) && existsSync(KEYMAP_C);

describe.if(present)("the three coordinate systems", () => {
  test("spec table == truth derived from keyboard.json", () => {
    const kb = JSON.parse(readFileSync(KEYBOARD_JSON, "utf8")) as {
      rgb_matrix: { layout: { matrix: [number, number] }[] };
    };
    const layout = kb.rgb_matrix.layout;
    expect(layout.length).toBe(KEY_COUNT);

    /* led index i sits at matrix position layout[i].matrix; invert to
       matrix→led, then walk wire order through it */
    const matrixToLed = new Map<string, number>();
    layout.forEach((entry, led) => {
      matrixToLed.set(entry.matrix.join(","), led);
    });
    const derived = WIRE_TO_MATRIX.map(([r, c]) => {
      const led = matrixToLed.get(`${r},${c}`);
      expect(led).not.toBeUndefined();
      return led as number;
    });
    expect(derived).toEqual([...WIRE_TO_LED]);
  });

  test("firmware's WIRE_TO_LED matches the spec's", () => {
    const src = readFileSync(KEYMAP_C, "utf8");
    const match = src.match(/WIRE_TO_LED\[KEY_COUNT\]\s*=\s*\{([^}]+)\}/);
    expect(match).not.toBeNull();
    const fw = (match as RegExpMatchArray)[1]
      .replace(/\/\*[\s\S]*?\*\//g, "") /* the table carries C comments */
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    expect(fw).toEqual([...WIRE_TO_LED]);
  });

  test("firmware's MATRIX_TO_WIRE inverts the spec's wire→matrix", () => {
    const src = readFileSync(KEYMAP_C, "utf8");
    const match = src.match(/MATRIX_TO_WIRE\[MATRIX_ROWS\]\[MATRIX_COLS\]\s*=\s*\{([\s\S]+?)\n\};/);
    expect(match).not.toBeNull();
    const rows = (match as RegExpMatchArray)[1]
      .split("\n")
      .map((line) => line.match(/\{([^}]+)\}/)?.[1])
      .filter((s): s is string => s !== undefined)
      .map((s) =>
        s.split(",").map((tok) => {
          const t = tok.trim();
          return t === "NO_WIRE" ? 0xff : Number.parseInt(t, 10);
        }),
      );
    expect(rows.length).toBe(5);
    for (const [wire, [r, c]] of WIRE_TO_MATRIX.entries()) {
      expect(rows[r][c]).toBe(wire);
    }
    /* the three dead matrix cells stay dead */
    expect(rows[1][3]).toBe(0xff);
    expect(rows[3][3]).toBe(0xff);
    expect(rows[4][0]).toBe(0xff);
  });
});

test.if(!present)("qmk tree absent — golden skipped, run it on the mac", () => {
  expect(true).toBe(true);
});
