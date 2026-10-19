import { describe, expect, test } from "bun:test";
import type { ColourMap } from "../window/repo";
import { REPO_COLOURS, repoColourNamed } from "../window/repo";
import {
  AUTOMATIC,
  autoLine,
  badgeOf,
  buttonsOf,
  colourLine,
  currentPick,
  heardBeforeRefused,
  holds,
  listOf,
  neighboursOf,
  noteOf,
  PICK_ORDER,
  type Pick,
  pickFor,
  previewFor,
  refusedLine,
  samePick,
  sentFor,
  shownBy,
  stepPick,
  swatchesOf,
} from "./picker-model";

const named = (name: string) => {
  const c = repoColourNamed(name);
  if (!c) throw new Error(`no colour ${name}`);
  return c;
};
const API = { host: "desk", root: "/src/api" };
const chose = (name: string): Pick => ({ kind: "chosen", name });

/* desk: api is cobalt by boxbox; ledger green, relay slate, docs plum (by hand). laptop's api is another repo */
const COLOURS: ColourMap = {
  "desk:/src/api": { auto: "cobalt", chosen: null },
  "desk:/src/ledger": { auto: "green", chosen: null },
  "desk:/src/relay": { auto: "teal", chosen: "slate" },
  "desk:/src/docs": { auto: "plum", chosen: null },
  "laptop:/src/api": { auto: "sunset", chosen: null },
};
const CHOSEN: ColourMap = { ...COLOURS, "desk:/src/api": { auto: "cobalt", chosen: "sunset" } };

describe("the current pick", () => {
  test("automatic when nothing is chosen, the chosen name otherwise", () => {
    expect(currentPick(API, COLOURS)).toEqual(AUTOMATIC);
    expect(currentPick(API, CHOSEN)).toEqual(chose("sunset"));
  });
  test("a repo the server has not spoken for is automatic", () => {
    expect(currentPick({ host: "desk", root: "/src/new" }, COLOURS)).toEqual(AUTOMATIC);
  });
  test("picks compare by kind and name", () => {
    expect(samePick(AUTOMATIC, { kind: "auto" })).toBe(true);
    expect(samePick(chose("teal"), chose("teal"))).toBe(true);
    expect(samePick(chose("teal"), chose("rose"))).toBe(false);
    expect(samePick(AUTOMATIC, chose("cobalt"))).toBe(false);
  });
  test("automatic shows what boxbox gave; a chosen name shows itself", () => {
    expect(shownBy(AUTOMATIC, named("cobalt")).name).toBe("cobalt");
    expect(shownBy(chose("sunset"), named("cobalt")).name).toBe("sunset");
    expect(shownBy(chose("coral"), named("cobalt")).name).toBe("cobalt");
  });
  test("use sends the name, or null for automatic", () => {
    expect(sentFor(chose("sunset"))).toBe("sunset");
    expect(sentFor(AUTOMATIC)).toBeNull();
  });
});

describe("the neighbours on the host", () => {
  test("the fleet's roots first, then every coloured repo on the host by name, never itself or another host", () => {
    const n = neighboursOf(API, COLOURS, ["/src/relay", "/src/api", "/src/relay"]);
    expect(n.map((x) => x.name)).toEqual(["relay", "docs", "ledger"]);
    expect(n.map((x) => x.colour.name)).toEqual(["slate", "plum", "green"]);
  });
  test("a machine with no other repo has none", () => {
    expect(neighboursOf({ host: "laptop", root: "/src/api" }, COLOURS, [])).toEqual([]);
  });
});

describe("the swatches", () => {
  const neighbours = neighboursOf(API, COLOURS, []);
  test("ten, in slot order", () => {
    expect(swatchesOf(AUTOMATIC, named("cobalt"), neighbours).map((s) => s.colour.name)).toEqual(REPO_COLOURS.map((c) => c.name));
  });
  test("automatic current: nothing ticked, automatic's swatch ringed and marked auto", () => {
    const s = swatchesOf(AUTOMATIC, named("cobalt"), neighbours);
    expect(s.filter((x) => x.picked)).toEqual([]);
    expect(s.filter((x) => x.shown).map((x) => x.colour.name)).toEqual(["cobalt"]);
    expect(s.filter((x) => x.auto).map((x) => x.colour.name)).toEqual(["cobalt"]);
  });
  test("a chosen colour is ringed and ticked; auto stays under automatic's swatch", () => {
    const s = swatchesOf(chose("sunset"), named("cobalt"), neighbours);
    expect(s.filter((x) => x.picked).map((x) => x.colour.name)).toEqual(["sunset"]);
    expect(s.filter((x) => x.shown).map((x) => x.colour.name)).toEqual(["sunset"]);
    expect(s.find((x) => x.auto)?.colour.name).toBe("cobalt");
  });
  test("a swatch another repo wears carries its initial and says who in its name", () => {
    const s = swatchesOf(AUTOMATIC, named("cobalt"), neighbours);
    const slate = s.find((x) => x.colour.name === "slate");
    expect(slate?.wearers).toEqual(["relay"]);
    expect(slate?.badge).toBe("r");
    expect(slate?.label).toBe("slate, worn by relay");
    expect(s.find((x) => x.colour.name === "cobalt")?.label).toBe("cobalt, automatic");
    expect(s.find((x) => x.colour.name === "rose")?.label).toBe("rose");
  });
  test("a swatch two repos share counts them", () => {
    const shared: ColourMap = { ...COLOURS, "desk:/src/web": { auto: "green", chosen: null } };
    const green = swatchesOf(AUTOMATIC, named("cobalt"), neighboursOf(API, shared, [])).find((x) => x.colour.name === "green");
    expect(green?.badge).toBe("2");
    expect(green?.label).toBe("green, worn by ledger and web");
  });
  test("every swatch's name is its own", () => {
    const labels = swatchesOf(chose("slate"), named("cobalt"), neighbours).map((x) => x.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  test("badges and lists", () => {
    expect(badgeOf([])).toBeNull();
    expect(badgeOf(["relay"])).toBe("r");
    expect(listOf(["a"])).toBe("a");
    expect(listOf(["a", "b"])).toBe("a and b");
    expect(listOf(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("the note", () => {
  const neighbours = neighboursOf(API, COLOURS, ["/src/relay"]);
  test("trying a colour another repo wears: who, the others, and that sharing is allowed", () => {
    expect(noteOf("desk", named("slate"), neighbours)).toBe("slate is relay's on desk. ledger has green, docs has plum. you can still share one; their windows would look alike.");
  });
  test("a free colour says so and names the rest", () => {
    expect(noteOf("desk", named("sunset"), neighbours)).toBe("sunset is free on desk. ledger has green, docs has plum, relay has slate.");
  });
  test("two wearers of the shown colour", () => {
    const shared: ColourMap = { ...COLOURS, "desk:/src/web": { auto: "slate", chosen: null } };
    expect(noteOf("desk", named("slate"), neighboursOf(API, shared, []))).toBe("slate is relay's and web's on desk. ledger has green, docs has plum. you can still share one; their windows would look alike.");
  });
  test("past three other colours, the rest are counted", () => {
    const many: ColourMap = {
      "desk:/a": { auto: "green", chosen: null },
      "desk:/b": { auto: "violet", chosen: null },
      "desk:/c": { auto: "rose", chosen: null },
      "desk:/d": { auto: "blue", chosen: null },
      "desk:/e": { auto: "teal", chosen: null },
    };
    expect(noteOf("desk", named("sunset"), neighboursOf(API, many, []))).toBe("sunset is free on desk. a has green, b has violet, c has rose, 2 more repos have other colours.");
  });
  test("no other repo on the machine: no note", () => {
    expect(noteOf("laptop", named("sunset"), [])).toBeNull();
  });
});

describe("the automatic row", () => {
  test("names the colour boxbox gave, not a path", () => {
    expect(autoLine("api", named("cobalt"), true)).toBe("cobalt, picked by boxbox. every device agrees.");
  });
  test("a repo the server has not spoken for says the colour is for now", () => {
    expect(autoLine("api", named("teal"), false)).toBe("teal for now. boxbox picks api's own when a thread runs there.");
  });
});

describe("the buttons", () => {
  const cobalt = named("cobalt");
  test("automatic current, nothing tried: keep it, nothing to use", () => {
    expect(buttonsOf(AUTOMATIC, AUTOMATIC, cobalt)).toEqual({ keep: "keep cobalt", use: null });
  });
  test("a chosen colour current, nothing tried", () => {
    expect(buttonsOf(chose("sunset"), chose("sunset"), cobalt)).toEqual({ keep: "keep sunset", use: null });
  });
  test("trying another", () => {
    expect(buttonsOf(AUTOMATIC, chose("sunset"), cobalt)).toEqual({ keep: "keep cobalt", use: "use sunset" });
    expect(buttonsOf(chose("sunset"), chose("slate"), cobalt)).toEqual({ keep: "keep sunset", use: "use slate" });
  });
  test("trying automatic from a chosen colour", () => {
    expect(buttonsOf(chose("sunset"), AUTOMATIC, cobalt)).toEqual({ keep: "keep sunset", use: "use automatic" });
  });
  test("choosing automatic's own colour by hand never reads like keeping it", () => {
    expect(buttonsOf(AUTOMATIC, chose("cobalt"), cobalt)).toEqual({ keep: "keep automatic", use: "use cobalt" });
  });
  test("a choice the server heard and could not keep: use stays to send it again, though the stream made it current", () => {
    expect(buttonsOf(chose("sunset"), chose("sunset"), cobalt, chose("sunset"))).toEqual({ keep: "keep sunset", use: "use sunset" });
    expect(buttonsOf(AUTOMATIC, AUTOMATIC, cobalt, AUTOMATIC)).toEqual({ keep: "keep cobalt", use: "use automatic" });
    // another pick is offered as any other
    expect(buttonsOf(chose("sunset"), chose("slate"), cobalt, chose("sunset"))).toEqual({ keep: "keep sunset", use: "use slate" });
    // back on the server's own pick with nothing unkept: nothing to use
    expect(buttonsOf(chose("sunset"), chose("sunset"), cobalt, chose("slate"))).toEqual({ keep: "keep sunset", use: null });
  });
});

describe("sending and settling", () => {
  test("a pick belongs to the repo it was made for: another repo gets its own current pick", () => {
    const held = { key: "desk:/src/api", pick: chose("sunset") };
    expect(pickFor(held, "desk:/src/api", AUTOMATIC)).toEqual(chose("sunset"));
    expect(pickFor(held, "desk:/src/relay", chose("slate"))).toEqual(chose("slate"));
    expect(pickFor(held, "laptop:/src/api", AUTOMATIC)).toEqual(AUTOMATIC);
    expect(pickFor(null, "desk:/src/api", chose("plum"))).toEqual(chose("plum"));
    // and so the preview for the other repo is nothing until the person picks there
    expect(previewFor({ host: "desk", root: "/src/relay" }, chose("slate"), pickFor(held, "desk:/src/relay", chose("slate")), named("teal"))).toBeNull();
  });
  test("the preview is set only while the pick differs from the server's", () => {
    expect(previewFor(API, AUTOMATIC, AUTOMATIC, named("cobalt"))).toBeNull();
    expect(previewFor(API, AUTOMATIC, chose("sunset"), named("cobalt"))).toEqual({ host: "desk", root: "/src/api", name: "sunset" });
    expect(previewFor(API, chose("sunset"), AUTOMATIC, named("cobalt"))).toEqual({ host: "desk", root: "/src/api", name: "cobalt" });
  });
  test("the map holds a pick once its frame lands", () => {
    expect(holds(API, COLOURS, chose("sunset"))).toBe(false);
    expect(holds(API, CHOSEN, chose("sunset"))).toBe(true);
    expect(holds(API, CHOSEN, AUTOMATIC)).toBe(false);
    expect(holds(API, COLOURS, AUTOMATIC)).toBe(true);
    expect(holds({ host: "desk", root: "/src/new" }, COLOURS, AUTOMATIC)).toBe(false);
  });
  test("only store-down is a choice every device heard and the server could not keep; any other code, a 503 included, changed nothing", () => {
    expect(heardBeforeRefused("store-down")).toBe(true);
    expect(heardBeforeRefused("stopping")).toBe(false);
    expect(heardBeforeRefused("bad-request")).toBe(false);
    // a proxy's 503 has no body, so no code; and a server that did not answer has no status either
    expect(heardBeforeRefused(null)).toBe(false);
    expect(heardBeforeRefused(undefined)).toBe(false);
  });
  test("a 503 that is not store-down says the colour did not change, in the server's words or the usual line", () => {
    expect(refusedLine("api", "boxbox is stopping. try again once it is back")).toBe("api's colour did not change. boxbox is stopping. try again once it is back.");
    expect(refusedLine("api", "the server answered 503. try again.")).toBe("api's colour did not change. the server answered 503. try again.");
  });
  test("an unkept choice says every device shows it, that it goes back at a restart, and to try again", () => {
    expect(refusedLine("api", "the server's store is not answering; try again in a moment", "sunset")).toBe(
      "every device shows sunset now, but the server could not keep it, so it goes back when the server restarts. try again in a moment.",
    );
  });
  test("a refusal says what happened and passes on what to do", () => {
    expect(refusedLine("api", "the boxbox server is not answering. check it is running, then try again.")).toBe("api's colour did not change. the boxbox server is not answering. check it is running, then try again.");
    expect(refusedLine("api", "unknown colour")).toBe("api's colour did not change. unknown colour.");
    expect(refusedLine("api", "boxbox has no thread in /src/api on desk; a repo gets a colour once a thread works there", null)).toBe(
      "api's colour did not change. boxbox has no thread in /src/api on desk; a repo gets a colour once a thread works there.",
    );
  });
});

describe("the menu's line", () => {
  test("automatic or chosen, with the colour shown", () => {
    expect(colourLine(API, COLOURS)).toMatchObject({ automatic: true, text: "cobalt · automatic" });
    expect(colourLine(API, CHOSEN)).toMatchObject({ automatic: false, text: "sunset · chosen" });
    expect(colourLine(API, CHOSEN).colour.name).toBe("sunset");
  });
});

describe("the radio group's arrows", () => {
  test("automatic first, then the ten", () => {
    expect(PICK_ORDER.length).toBe(11);
    expect(PICK_ORDER[0]).toEqual(AUTOMATIC);
  });
  test("steps and wraps", () => {
    expect(stepPick(AUTOMATIC, 1)).toEqual(chose("green"));
    expect(stepPick(AUTOMATIC, -1)).toEqual(chose("slate"));
    expect(stepPick(chose("slate"), 1)).toEqual(AUTOMATIC);
    expect(stepPick(chose("violet"), -1)).toEqual(chose("green"));
  });
});
