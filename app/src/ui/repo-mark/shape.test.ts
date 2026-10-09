import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { declarations, evaluate, over, stripComments, toHex } from "../window/css-colour";
import { contrast, REPO_COLOURS } from "../window/repo";
import { PLATE_DARK, PLATE_LIGHT } from "./plate";
import { SQUIRCLE_N, squirclePath } from "./shape";

const CSS = readFileSync(join(import.meta.dir, "repo-mark.css"), "utf8");

function points(path: string): Array<[number, number]> {
  return [...path.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("the squircle", () => {
  const path = squirclePath();
  const pts = points(path);

  test("it is one closed path of points in a 100 box, touching all four edges", () => {
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(100);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(100);
  });

  test("every point is on the superellipse, which is what makes the corner continuous and not a circle's arc", () => {
    for (const [x, y] of pts) {
      const sum = (Math.abs(x - 50) / 50) ** SQUIRCLE_N + (Math.abs(y - 50) / 50) ** SQUIRCLE_N;
      expect(Math.abs(sum - 1)).toBeLessThan(0.02);
    }
  });

  test("the corner is squarer than a rounded rectangle of the same flat run, and rounder than a square", () => {
    // the diagonal point of a circle is at 0.707 of the radius, of a square at 1; a squircle sits between
    const corner = pts.reduce((best, p) => (Math.hypot(p[0] - 50, p[1] - 50) > best ? Math.hypot(p[0] - 50, p[1] - 50) : best), 0) / 50;
    expect(corner).toBeGreaterThan(1.1);
    expect(corner).toBeLessThan(Math.SQRT2);
  });

  test("it is symmetric about both axes", () => {
    const near = (x: number, y: number) => pts.some(([px, py]) => Math.abs(px - x) < 0.02 && Math.abs(py - y) < 0.02);
    for (const [x, y] of pts) {
      expect(near(100 - x, y)).toBe(true);
      expect(near(x, 100 - y)).toBe(true);
    }
  });

  test("repo-mark.css carries exactly this path, so the css cannot drift from the shape", () => {
    expect(CSS).toContain(`d='${path}'`);
  });
});

describe("the mark's colours", () => {
  test("the plates in the css are the plates the verdict is judged against", () => {
    expect(CSS).toContain(`background: ${PLATE_LIGHT};`);
    expect(CSS).toContain(`background: ${PLATE_DARK};`);
  });

  /* the tile is the windows plane's material in the repo's colour (styles.css, the plane block): the deep pair on dark, the
     light tone washed into white on light, with the plane's accent for the initials. the recipes are read from the css and
     evaluated as the browser does (css-colour.ts), so neither can drift from what is proved */
  const STYLES = stripComments(readFileSync(join(import.meta.dir, "..", "..", "styles.css"), "utf8"));
  const MARK = stripComments(CSS);
  const vars = (colour: (typeof REPO_COLOURS)[number], light: 0 | 1) =>
    new Map<string, string>([
      ...declarations(STYLES, ":root,\n.plane-window"),
      ...declarations(STYLES, ".plane-window,\n.win,\n.host"),
      ...declarations(MARK, ".rm {"),
      ["--L", String(light)],
      ["--c1", colour.top],
      ["--c2", colour.bottom],
      ["--hi", colour.light],
    ]);

  test("the tile is the plane's material and its initials the plane's accent, so the mark is a window at the size of a letter", () => {
    // the face's own rule (the mask rule above it shares the selector): the one that sets its inset
    expect(declarations(MARK, ".rm .rm-face {\n  inset: var(--rm-ring)").get("background")).toMatch(/var\(--rm-glow\)[\s\S]*linear-gradient\(165deg, var\(--win-1\), var\(--win-2\)\)/);
    expect(declarations(MARK, ".rm .rm-letters {").get("color")).toBe("var(--accent)");
  });

  for (const [light, label] of [[0, "dark"], [1, "light"]] as const) {
    test(`${label}: the initials hold 4.5:1 on the tile under its highlight, and at its foot, for every hue`, () => {
      // the highlight fades out by 62% of its ellipse; the letters' nearest corner (22% across, 30% down) is half way to the
      // edge of it (90% by 60% wide, centred at 20% across and the top), so it lifts them by what is left at that distance
      const reach = Math.max(0, 1 - Math.hypot((0.22 - 0.2) / 0.9, 0.3 / 0.6) / 0.62);
      for (const colour of REPO_COLOURS) {
        const v = vars(colour, light);
        const get = (name: string) => evaluate(`var(${name})`, v);
        const glow = get("--rm-glow");
        const top = over({ ...glow, a: glow.a * reach }, get("--win-1"));
        const letters = get("--accent");
        expect(contrast(toHex(letters), toHex(top)), `${colour.name}: on the lit top`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(toHex(letters), toHex(get("--win-2"))), `${colour.name}: at the foot`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test("dark: the tile is the repo's deep pair under white at 14% and the initials its light tone, as they were", () => {
    for (const colour of REPO_COLOURS) {
      const v = vars(colour, 0);
      expect(toHex(evaluate("var(--win-1)", v))).toBe(colour.top);
      expect(toHex(evaluate("var(--win-2)", v))).toBe(colour.bottom);
      expect(toHex(evaluate("var(--accent)", v))).toBe(colour.light);
      expect(evaluate("var(--rm-glow)", v).a).toBeCloseTo(0.14, 5);
    }
  });
});
