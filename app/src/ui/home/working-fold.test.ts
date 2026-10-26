import { describe, expect, test } from "bun:test";
import type { components } from "../../api/boxbox";
import { thread } from "../../sync/fixtures/neutral";
import { foldHint, foldLines, foldName, foldOf, foldWords, leaverOf } from "./working-fold";

type Need = components["schemas"]["Need"];

const need = (kind: Need["kind"], servedAt: number | null = null): Need => ({ id: `${kind}:a:1`, kind, key: "a:1", rank: 3, raisedAt: 1, title: "t", body: "b", servedAt });

const busy = thread("a:1", { activity: { state: "busy", since: 1 } });
const parkedJobs = thread("a:2", { activity: { state: "parked", agents: 0, jobs: 1, since: 1 } });
const parkedAgents = thread("a:3", { activity: { state: "parked", agents: 2, jobs: 0, since: 1 } });

describe("who folds", () => {
  test("a working thread with nothing wrong folds as working, retrying and queued too", () => {
    expect(foldOf(busy, 0, false)).toBe("working");
    expect(foldOf(thread("a:4", { activity: { state: "retry", attempt: 1, message: "rate limited", next: 2 } }), 0, false)).toBe("working");
    expect(foldOf({ ...busy, queued: 3 }, 0, false)).toBe("working");
  });

  test("a thread parked with its agents at work folds as working; one parked on jobs alone folds as waiting", () => {
    expect(foldOf(parkedAgents, 0, false)).toBe("working");
    expect(foldOf(parkedJobs, 0, false)).toBe("waiting");
  });

  test("an ask keeps a window: the thread leaves the fold the moment it asks", () => {
    expect(foldOf(busy, 1, false)).toBeNull();
    expect(foldOf(parkedJobs, 1, false)).toBeNull();
  });

  test("any open need keeps a window: a fault, a review, a done", () => {
    for (const kind of ["fault", "review", "done", "question", "permission"] as const) expect(foldOf({ ...busy, needs: [need(kind)] }, 0, false)).toBeNull();
  });

  test("a served need is no need", () => {
    expect(foldOf({ ...busy, needs: [need("review", 5)] }, 0, false)).toBe("working");
  });

  test("a job notice keeps a window only when job notices count as needs", () => {
    const noticed = { ...parkedJobs, needs: [need("job")] };
    expect(foldOf(noticed, 0, false)).toBe("waiting");
    expect(foldOf(noticed, 0, true)).toBeNull();
  });

  test("a finished, failed or idle thread never folds, nor does a subagent", () => {
    expect(foldOf(thread("a:5"), 0, false)).toBeNull();
    expect(foldOf(thread("a:6", { activity: { state: "failed", message: "x" } }), 0, false)).toBeNull();
    expect(foldOf({ ...busy, parent: "a:1" }, 0, false)).toBeNull();
  });
});

describe("the capsule's words", () => {
  test("both kinds, or either alone", () => {
    expect(foldWords(4, 2)).toBe("4 working, 2 waiting on a job");
    expect(foldWords(4, 0)).toBe("4 working");
    expect(foldWords(0, 1)).toBe("1 waiting on a job");
  });

  test("the second line names who just left, else says nothing is wrong", () => {
    expect(foldHint(null)).toBe("nothing wrong, tap to see");
    expect(foldHint("lantern")).toBe("lantern just left");
  });

  test("on the capsule, both kinds split over its two lines, and news of a leaver takes the second while it is news", () => {
    expect(foldLines(4, 2, null)).toEqual({ first: "4 working", second: "2 waiting on a job", waiting: true });
    expect(foldLines(4, 2, "lantern")).toEqual({ first: "4 working", second: "lantern just left", waiting: false });
    expect(foldLines(4, 0, null)).toEqual({ first: "4 working", second: "nothing wrong, tap to see", waiting: false });
    expect(foldLines(0, 1, null)).toEqual({ first: "1 waiting on a job", second: "nothing wrong, tap to see", waiting: false });
  });

  test("the name says what a press does", () => {
    expect(foldName(3, 1, false)).toBe("3 working, 1 waiting on a job. show the list");
    expect(foldName(3, 0, true)).toBe("3 working. hide the list");
  });

  test("a thread that left the fold and is still on home is news; one that left home is not", () => {
    const repos: Record<string, string> = { "a:1": "harbor", "a:2": "lantern" };
    const onHome = (key: string) => (key === "a:2" ? repos[key] ?? null : null);
    expect(leaverOf(["a:1", "a:2", "a:3"], ["a:3"], onHome)).toBe("lantern");
    expect(leaverOf(["a:1"], [], onHome)).toBeNull();
    expect(leaverOf(["a:3"], ["a:3", "a:2"], onHome)).toBeNull();
  });
});
