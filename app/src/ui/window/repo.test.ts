import { describe, expect, test } from "bun:test";
import { ASSISTANT_COLOURS, assistantColour, type ColourMap, colourAssignment, colourOf, contrast, fnv1a, hashColour, REPO_COLOURS, repoColourNamed, repoKey, repoName } from "./repo";

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

describe("the hash colour, before the server has spoken", () => {
  test("the hash is stable: the same identity always gets the same colour", () => {
    expect(hashColour({ host: "desk", root: "/src/api" })).toBe(hashColour({ host: "desk", root: "/src/api" }));
  });

  // the server pins the same strings to the same values (server/src/fleet/colours.rs, fnv1a_agrees_with_the_apps): it
  // gives a free repo its hash colour, so the two must hash alike, utf-16 code units included
  test("fnv-1a agrees with the server's", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("desk:/work/api")).toBe(0xdfdf94d9);
    expect(fnv1a("desk:/")).toBe(0xc039e7ab);
    expect(fnv1a("laptop:/home/dev/src/notes")).toBe(0x8454d56a);
    expect(fnv1a("desk:/work/café")).toBe(0x8913ec0a);
    expect(fnv1a("desk:/work/日本語")).toBe(0xc9de67e4);
    expect(fnv1a("desk:/work/🦀")).toBe(0x54033c1d);
  });

  test("a repo's key is its host and root, and the hash is of the key", () => {
    expect(repoKey({ host: "desk", root: "/work/api" })).toBe("desk:/work/api");
    expect(hashColour({ host: "desk", root: "/work/api" })).toBe(REPO_COLOURS[0xdfdf94d9 % 10] as (typeof REPO_COLOURS)[number]);
  });

  test("the same path on two hosts is two repos, and may be two colours", () => {
    const hues = new Set(["desk", "vm", "studio", "laptop"].map((host) => hashColour({ host, root: "/src/api" }).name));
    expect(hues.size).toBeGreaterThan(1);
  });

  test("a hundred repos spread over every hue", () => {
    const used = new Set(Array.from({ length: 100 }, (_, i) => hashColour({ host: "h", root: `/src/repo-${i}` }).name));
    expect(used.size).toBe(10);
  });
});

describe("a repo's colour, as the server gave it", () => {
  const repo = { host: "desk", root: "/work/api" };
  const hash = hashColour(repo);
  // two names other than the hash's, so a test cannot pass by falling back
  const [given, picked] = REPO_COLOURS.filter((c) => c !== hash) as [(typeof REPO_COLOURS)[number], (typeof REPO_COLOURS)[number]];
  const assigned = (auto: string, chosen: string | null): ColourMap => ({ [repoKey(repo)]: { auto, chosen } });

  test("the person's choice wins over the one boxbox gave", () => {
    expect(colourOf(repo, assigned(given.name, picked.name))).toBe(picked);
    expect(colourAssignment(repo, assigned(given.name, picked.name))).toEqual({ shown: picked, auto: given, chosen: picked });
  });

  test("automatic shows the one boxbox gave", () => {
    expect(colourOf(repo, assigned(given.name, null))).toBe(given);
    expect(colourAssignment(repo, assigned(given.name, null))).toEqual({ shown: given, auto: given, chosen: null });
  });

  test("a repo the server has not spoken for wears its hash colour", () => {
    expect(colourOf(repo, {})).toBe(hash);
    expect(colourOf(repo, { [repoKey({ host: "laptop", root: "/work/api" })]: { auto: given.name, chosen: null } })).toBe(hash);
  });

  test("a name this build does not know falls back, an assistant's palette included", () => {
    expect(colourOf(repo, assigned("ultraviolet", null))).toBe(hash);
    expect(colourOf(repo, assigned("coral", null))).toBe(hash);
    // an unknown choice shows the hash colour too, as the server reads its own rows
    expect(colourOf(repo, assigned(given.name, "coral"))).toBe(hash);
    expect(colourAssignment(repo, assigned(given.name, "ultraviolet")).chosen).toBe(hash);
  });

  test("only the ten have names a repo can wear", () => {
    for (const colour of REPO_COLOURS) expect(repoColourNamed(colour.name)).toBe(colour);
    for (const colour of ASSISTANT_COLOURS) expect(repoColourNamed(colour.name)).toBeUndefined();
    expect(repoColourNamed(null)).toBeUndefined();
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
