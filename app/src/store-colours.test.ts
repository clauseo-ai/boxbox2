/* what colour a repo wears, as every surface asks it (ui/window/colours.ts): the server's map, with the picker's preview
   over it */

import { afterEach, describe, expect, test } from "bun:test";
import { applyPatches, setColourPreview, state } from "./store";
import { colourMap, repoColour } from "./ui/window/colours";
import { hashColour, REPO_COLOURS, repoColourNamed } from "./ui/window/repo";

const api = { host: "desk", root: "/work/api" };
const notes = { host: "desk", root: "/work/notes" };
const named = (name: string) => repoColourNamed(name) as (typeof REPO_COLOURS)[number]; // the tests name only the ten

afterEach(() => {
  setColourPreview(null);
  applyPatches([{ path: ["fleet", "colours"], value: {} }]);
});

describe("a repo's colour on screen", () => {
  test("is the server's, as a colour frame patches it, and the hash colour before it has spoken", () => {
    expect(repoColour(api)).toBe(hashColour(api));
    applyPatches([{ path: ["fleet", "colours", "desk:/work/api"], value: { auto: "teal", chosen: null } }]);
    expect(repoColour(api)).toBe(named("teal"));
    applyPatches([{ path: ["fleet", "colours", "desk:/work/api"], value: { auto: "teal", chosen: "plum" } }]);
    expect(repoColour(api)).toBe(named("plum"));
  });

  test("the picker's preview wins for its repo alone, and leaves the server's map as it was", () => {
    applyPatches([{ path: ["fleet", "colours", "desk:/work/api"], value: { auto: "teal", chosen: "plum" } }]);
    setColourPreview({ ...api, name: "slate" });
    expect(repoColour(api)).toBe(named("slate"));
    expect(repoColour(notes)).toBe(hashColour(notes));
    expect(colourMap()["desk:/work/api"]).toEqual({ auto: "teal", chosen: "slate" });
    expect(state.fleet.colours["desk:/work/api"]).toEqual({ auto: "teal", chosen: "plum" });
    setColourPreview(null);
    expect(repoColour(api)).toBe(named("plum"));
  });

  test("a preview of a repo the server has not spoken for keeps its hash colour as automatic", () => {
    setColourPreview({ ...notes, name: "green" });
    expect(repoColour(notes)).toBe(named("green"));
    expect(colourMap()["desk:/work/notes"]).toEqual({ auto: hashColour(notes).name, chosen: "green" });
  });

  test("a preview of a name that is not one of the ten changes nothing", () => {
    setColourPreview({ ...api, name: "coral" });
    expect(repoColour(api)).toBe(hashColour(api));
  });
});
