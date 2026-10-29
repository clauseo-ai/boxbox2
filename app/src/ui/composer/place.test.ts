import { describe, expect, test } from "bun:test";
import type { Draft } from "../../sync/outbox";
import { canonicalDirectory, directoryOfTyped, draftedPlaces, followDraft, isDrafted, looksLikePath, matchRepos, recentChips, recentRepos, repoRootOf, restoredDraft, splitPath } from "./place";

describe("the repo a thread belongs to", () => {
  test("a project root is the repo, not the worktree a thread runs in", () => {
    expect(repoRootOf({ projectID: "/code/api", directory: "/code/.worktrees/api-1" })).toBe("/code/api");
  });
  test("a project id that is not a path falls back to the directory", () => {
    expect(repoRootOf({ projectID: "prj_api", directory: "/code/api" })).toBe("/code/api");
  });
});

describe("repos by recency", () => {
  const sessions = [
    { host: "desk", root: "/code/api", at: 10 },
    { host: "desk", root: "/code/web", at: 30 },
    { host: "desk", root: "/code/api", at: 20 },
    { host: "mini", root: "/srv/other", at: 99 },
  ];
  test("your threads come first, newest first, one entry per repo, only on this machine", () => {
    expect(recentRepos(sessions, "desk", [])).toEqual(["/code/web", "/code/api"]);
  });
  test("the machine's other projects follow by their own activity and never repeat a repo you have threads in", () => {
    const projects = [
      { directory: "/code/api", updated: 500 },
      { directory: "/code/old", updated: 5 },
      { directory: "/code/new", updated: 50 },
      { directory: "/code/none", updated: null },
    ];
    expect(recentRepos(sessions, "desk", projects)).toEqual(["/code/web", "/code/api", "/code/new", "/code/old", "/code/none"]);
  });
  test("a machine with no threads lists its projects, and one with nothing lists nothing", () => {
    expect(recentRepos([], "desk", [{ directory: "/a", updated: 1 }])).toEqual(["/a"]);
    expect(recentRepos([], "desk", [])).toEqual([]);
  });
});

describe("the recent repos above home's field", () => {
  const name = (root: string) => root.slice(root.lastIndexOf("/") + 1);
  const sessions = [
    { host: "desk", root: "/code/api", at: 10 },
    { host: "mini", root: "/srv/infra", at: 40 },
    { host: "desk", root: "/code/web", at: 30 },
    { host: "desk", root: "/code/api", at: 50 },
    { host: "desk", root: "", at: 99 },
  ];
  test("your threads on every machine, newest first, one chip per repo and machine, a thread with no repo left out", () => {
    expect(recentChips(sessions, "desk", [], name, 5).map((c) => `${c.host}:${c.root}`)).toEqual(["desk:/code/api", "mini:/srv/infra", "desk:/code/web"]);
  });
  test("the field's machine's other recents fill the row up to the limit, never repeating a repo", () => {
    const chips = recentChips(sessions, "desk", ["/code/api", "/code/new", "/code/old", "/code/more"], name, 5);
    expect(chips.map((c) => c.root)).toEqual(["/code/api", "/srv/infra", "/code/web", "/code/new", "/code/old"]);
    expect(recentChips(sessions, "desk", [], name, 2)).toHaveLength(2);
    expect(recentChips([], "desk", [], name, 5)).toEqual([]);
  });
  test("only a repo on another machine says its machine, in its words and its name", () => {
    const [api, infra] = recentChips(sessions, "desk", [], name, 5);
    expect(api).toMatchObject({ repo: "api", machine: null, name: "start in api" });
    expect(infra).toMatchObject({ repo: "infra", machine: "mini", name: "start in infra on mini" });
    // the field moved to mini: now desk's repos are the elsewhere ones
    expect(recentChips(sessions, "mini", [], name, 5)[0]).toMatchObject({ machine: "desk", name: "start in api on desk" });
  });
  test("two repos of one name on one machine are told apart by their path, so every name is its own", () => {
    const twins = [
      { host: "desk", root: "/code/app", at: 2 },
      { host: "desk", root: "/fork/app", at: 1 },
      { host: "mini", root: "/code/app", at: 0 },
    ];
    expect(recentChips(twins, "desk", [], name, 5).map((c) => c.name)).toEqual(["start in app, /code/app", "start in app, /fork/app", "start in app on mini"]);
  });
});

describe("filtering repos", () => {
  const repos = ["/code/boxy-web", "/code/cmx2", "/work/boxes/site", "/code/northstar"];
  test("no word keeps every repo in order", () => {
    expect(matchRepos(repos, "  ")).toEqual(repos);
  });
  test("a word matches the name or the path, and a name that starts with it comes first", () => {
    expect(matchRepos(repos, "box")).toEqual(["/code/boxy-web", "/work/boxes/site"]);
    expect(matchRepos(repos, "work")).toEqual(["/work/boxes/site"]);
  });
  test("every word must match, in any order, case aside", () => {
    expect(matchRepos(repos, "CODE web")).toEqual(["/code/boxy-web"]);
    expect(matchRepos(repos, "nothing")).toEqual([]);
  });
});

describe("a typed folder", () => {
  test("a path starts at the root or at home; a word is a filter", () => {
    expect(looksLikePath("/Users/dev")).toBe(true);
    expect(looksLikePath("~")).toBe(true);
    expect(looksLikePath("~/code")).toBe(true);
    expect(looksLikePath("code")).toBe(false);
    expect(looksLikePath("~code")).toBe(false);
  });
  test("it splits at its last slash into the folder to read and what is still being typed", () => {
    expect(splitPath("/Users/dev/co")).toEqual({ dir: "/Users/dev", prefix: "co" });
    expect(splitPath("/Users/dev/")).toEqual({ dir: "/Users/dev", prefix: "" });
    expect(splitPath("/co")).toEqual({ dir: "/", prefix: "co" });
    expect(splitPath("~")).toEqual({ dir: "~", prefix: "" });
    expect(splitPath("~/co")).toEqual({ dir: "~", prefix: "co" });
  });
  test("it becomes a directory to start in: absolute as written, ~ from the machine's home, nothing for a word", () => {
    expect(directoryOfTyped("/code/new/", "/home/dev")).toBe("/code/new");
    expect(directoryOfTyped("/", "/home/dev")).toBe("/");
    expect(directoryOfTyped("~", "/home/dev")).toBe("/home/dev");
    expect(directoryOfTyped("~/code/x", "/home/dev/")).toBe("/home/dev/code/x");
    expect(directoryOfTyped("~/code", null)).toBeNull();
    expect(directoryOfTyped("code", "/home/dev")).toBeNull();
  });
});

const draft = (text: string, extra: Partial<Draft> = {}): Draft => ({ text, photos: [], model: null, effort: null, at: 1, ...extra });

describe("words follow every pick", () => {
  test("what you typed goes to the place you pick, and the place you left is cleared", () => {
    const moved = followDraft(draft("fix the build"), undefined, 9);
    expect(moved.arriving).toEqual(draft("fix the build", { at: 9 }));
    expect(moved.clearLeaving).toBe(true);
  });
  test("a machine switch then the repo it auto-picks carries the words through both moves", () => {
    // desk:/code/a -> bench:(none) -> bench:/srv/x, each move the same rule
    const first = followDraft(draft("fix the build", { model: "m", effort: "high" }), undefined, 2);
    const second = followDraft(first.arriving, undefined, 3);
    expect(second.arriving).toEqual(draft("fix the build", { model: "m", effort: "high", at: 3 }));
  });
  test("an empty draft moves nothing and leaves the place's own alone", () => {
    const own = draft("kept");
    expect(followDraft(draft("  "), own, 5)).toEqual({ arriving: own, clearLeaving: false });
    expect(followDraft(undefined, own, 5)).toEqual({ arriving: own, clearLeaving: false });
  });
  test("a picked model alone is a draft worth moving", () => {
    expect(isDrafted(draft("", { model: "m" }))).toBe(true);
    expect(isDrafted(draft(""))).toBe(false);
  });
});

describe("a refused first message goes back to the draft", () => {
  test("its words come back as the draft, with the pick it carried", () => {
    expect(restoredDraft(undefined, { text: "start here", model: "m", effort: null }, 7)).toEqual(draft("start here", { model: "m", at: 7 }));
  });
  test("a draft the place holds now keeps its words after the refused ones", () => {
    expect(restoredDraft(draft("newer"), { text: "older", model: null, effort: null }, 7).text).toBe("older\n\nnewer");
  });
});

describe("a folder by the name the host knows its repo under", () => {
  const sessions = [{ host: "desk", directory: "/tmp/site", root: "/private/tmp/site" }];
  test("a folder a thread already runs in becomes that thread's repo, so there is one chip for it", () => {
    expect(canonicalDirectory("/tmp/site", sessions, "desk")).toBe("/private/tmp/site");
  });
  test("another machine's folder of the same name, and a folder no thread has run in, stay as they are", () => {
    expect(canonicalDirectory("/tmp/site", sessions, "mini")).toBe("/tmp/site");
    expect(canonicalDirectory("/tmp/new", sessions, "desk")).toBe("/tmp/new");
  });
});

describe("places where words wait", () => {
  test("a sheet draft on this machine names its folder; another machine's, a thread's and an empty one do not", () => {
    const keys = ["new:desk:/code/a", "new:mini:/srv/b", "desk:ses_1", "new:desk:", "new:desk:/code/empty"];
    expect(draftedPlaces(keys, "desk", (key) => !key.endsWith("empty"))).toEqual(["/code/a"]);
  });
});
