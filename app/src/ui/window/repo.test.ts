import { describe, expect, test } from "bun:test";
import { ASSISTANT_COLOURS, assistantColour, colourOf, contrast, fnv1a, REPO_COLOURS, repoName } from "./repo";

/** the text colour of the dark ground (design.md), which windows use for body text */
const TEXT = "#f4f4f6";
const RED = "#ff6b6b";

describe("the ten repo colours", () => {
  test("there are ten, each named once", () => {
    expect(REPO_COLOURS.length).toBe(10);
    expect(new Set(REPO_COLOURS.map((c) => c.name)).size).toBe(10);
  });

  for (const colour of REPO_COLOURS) {
    test(`${colour.name}: body text holds 4.5:1 at both ends of the gradient`, () => {
      expect(contrast(TEXT, colour.top)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(TEXT, colour.bottom)).toBeGreaterThanOrEqual(4.5);
    });
    test(`${colour.name}: the light tone reads as text on the top colour, and the bottom reads on the light tone`, () => {
      expect(contrast(colour.light, colour.top)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colour.bottom, colour.light)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("no light tone can be mistaken for the one red", () => {
    for (const colour of REPO_COLOURS) expect(colour.light.toLowerCase()).not.toBe(RED);
  });
});

describe("the five assistant palettes", () => {
  test("there are five, coral first, none sharing a name with a repo hue", () => {
    expect(ASSISTANT_COLOURS.map((c) => c.name)).toEqual(["coral", "lime", "jade", "lagoon", "orchid"]);
    const repo = new Set(REPO_COLOURS.map((c) => c.name));
    for (const colour of ASSISTANT_COLOURS) expect(repo.has(colour.name)).toBe(false);
  });

  // the three proofs the ten hold (design.md, agents: who a window belongs to)
  for (const colour of ASSISTANT_COLOURS) {
    test(`${colour.name}: body text at both ends, the light tone on the top, the bottom on the light tone`, () => {
      expect(contrast(TEXT, colour.top)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(TEXT, colour.bottom)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colour.light, colour.top)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colour.bottom, colour.light)).toBeGreaterThanOrEqual(4.5);
      expect(colour.light.toLowerCase()).not.toBe(RED);
    });
  }

  test("a slot is found by its name, and a name this build does not know is coral", () => {
    expect(assistantColour("jade").name).toBe("jade");
    expect(assistantColour("ultraviolet").name).toBe("coral");
    expect(assistantColour(null).name).toBe("coral");
  });
});

describe("a repo keeps its colour", () => {
  test("the hash is stable: the same identity always gets the same colour", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(colourOf({ host: "desk", root: "/src/api" })).toBe(colourOf({ host: "desk", root: "/src/api" }));
  });

  test("the same path on two hosts is two repos, and may be two colours", () => {
    const hues = new Set(["desk", "vm", "studio", "laptop"].map((host) => colourOf({ host, root: "/src/api" }).name));
    expect(hues.size).toBeGreaterThan(1);
  });

  test("a hundred repos spread over every hue", () => {
    const used = new Set(Array.from({ length: 100 }, (_, i) => colourOf({ host: "h", root: `/src/repo-${i}` }).name));
    expect(used.size).toBe(10);
  });
});

describe("a repo's name", () => {
  test("is the last segment of its root", () => {
    expect(repoName("/home/me/src/api")).toBe("api");
    expect(repoName("/home/me/src/api/")).toBe("api");
    expect(repoName("C:\\src\\site")).toBe("site");
    expect(repoName("/")).toBe("/");
  });
});
