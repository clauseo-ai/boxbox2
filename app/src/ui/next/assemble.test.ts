import { describe, expect, test } from "bun:test";
import { thread } from "../../sync/fixtures/neutral";
import { type WindowView, windowView } from "../window/view";
import { agoWords, nextUp, type NextInput } from "./assemble";

const place = (root: string) => ({ directory: root, root, name: root.slice(root.lastIndexOf("/") + 1) });
const idle = (key: string, root: string, title: string) => thread(key, { title, place: place(root) } as Parameters<typeof thread>[1]);

/* one view per state the list cares about, and two it leaves to the windows and the fold */
const done = windowView(idle("a:1", "/code/site", "fix the og images"), [], {}, { seen: false });
const seen = windowView(idle("a:2", "/code/notes", "tidy the notes"), [], {}, { seen: true });
const failed = windowView(idle("a:3", "/code/ledger", "migrate the invoices table"), [], {}, { failure: "bun test invoices, 3 failed" });
const working = windowView(thread("a:4", { activity: { state: "busy", since: 1 } }), [], {});
const wants: WindowView = {
  ...windowView(idle("a:5", "/code/boxbox", "home composer mockups"), [], {}),
  state: "wants",
  need: { eyebrow: "font", line: "lexend 22 for the hero prompt, or keep mona?", detail: "2 options", questions: 1, permissions: 0, asks: 1 },
};

const views: Record<string, WindowView> = { "a:1": done, "a:2": seen, "a:3": failed, "a:4": working, "a:5": wants };

const input = (over: Partial<NextInput> = {}): NextInput => ({
  order: ["a:5", "a:3", "a:1", "a:2", "a:4"],
  viewOf: (key) => views[key] ?? null,
  fold: { working: 0, waiting: 0 },
  host: "mini",
  repos: ["/code/boxbox", "/code/ledger", "/code/site", "/code/notes", "/code/dotfiles"],
  lastAt: (_host, root) => (root === "/code/boxbox" ? 1_000 : null),
  now: 1_000 + 2 * 3_600_000,
  repoLimit: 3,
  ...over,
});

describe("the threads that need you", () => {
  test("come in the server's order, never re-ranked: the order is the inbox", () => {
    expect(nextUp(input()).needs.map((row) => row.key)).toEqual(["a:5", "a:3", "a:1"]);
    // the same threads in another order come out in that order: nothing here sorts them
    expect(nextUp(input({ order: ["a:1", "a:3", "a:5"] })).needs.map((row) => row.key)).toEqual(["a:1", "a:3", "a:5"]);
  });

  test("are only the ones that want you, stopped, or finished unseen: a seen idle thread and a working one are not", () => {
    const states = nextUp(input()).needs.map((row) => row.state);
    expect(states).toEqual(["wants", "failed", "done"]);
  });

  test("each carries the one verb that already exists for it: answer an ask, open the rest", () => {
    const [ask, stop, finish] = nextUp(input()).needs;
    expect(ask).toMatchObject({ verb: "answer", head: "lexend 22 for the hero prompt, or keep mona?", detail: "boxbox · home composer mockups", name: "answer boxbox: home composer mockups" });
    expect(stop).toMatchObject({ verb: "open", head: "stopped: bun test invoices, 3 failed", name: "open ledger: migrate the invoices table, stopped" });
    expect(finish).toMatchObject({ verb: "open", head: "fix the og images", detail: "site · done", name: "open site: fix the og images, done" });
  });

  test("a key the views no longer hold (it left between the order and the read) is skipped, not drawn empty", () => {
    expect(nextUp(input({ order: ["gone", "a:3"] })).needs.map((row) => row.key)).toEqual(["a:3"]);
  });
});

describe("the working fold", () => {
  test("is one row when anything is in it, and none when nothing is", () => {
    expect(nextUp(input()).fold).toBeNull();
    expect(nextUp(input({ fold: { working: 3, waiting: 1 } })).fold).toEqual({ working: 3, waiting: 1 });
  });
});

describe("the repos to start in", () => {
  test("keep the new-thread path's recency order and stop at the room there is", () => {
    const repos = nextUp(input()).repos;
    expect(repos.map((row) => row.repo)).toEqual(["boxbox", "ledger", "site"]);
    expect(repos[0]).toMatchObject({ host: "mini", root: "/code/boxbox", detail: "mini · 2 hours ago", name: "start in boxbox on mini" });
    expect(repos[1]?.detail).toBe("mini");
  });

  test("no room is no repos", () => {
    expect(nextUp(input({ repoLimit: 0 })).repos).toEqual([]);
  });
});

describe("how long ago", () => {
  test("in the fewest plain words", () => {
    expect(agoWords(20_000)).toBe("just now");
    expect(agoWords(60_000)).toBe("a minute ago");
    expect(agoWords(4 * 60_000)).toBe("4 minutes ago");
    expect(agoWords(3_600_000)).toBe("an hour ago");
    expect(agoWords(5 * 3_600_000)).toBe("5 hours ago");
    expect(agoWords(30 * 3_600_000)).toBe("yesterday");
    expect(agoWords(3 * 24 * 3_600_000)).toBe("3 days ago");
  });
});
