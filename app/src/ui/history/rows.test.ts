import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "../../sync/protocol";
import { appendRows, collisionSuffixes, emptyWords, type HistoryApiRow, rowView, unreachedWords, whenOf } from "./rows";

const NOW = new Date("2026-10-01T12:00:00").getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function row(id: string, updated: number, overrides: Partial<HistoryApiRow> = {}, title = id): HistoryApiRow {
  return {
    key: `desk:${id}`,
    host: "desk",
    cleared: false,
    info: { id, projectID: "/work/ledger", directory: "/work/ledger", title, time: { created: 0, updated } } as unknown as HistoryApiRow["info"],
    ...overrides,
  };
}

function held(r: HistoryApiRow, extra: Partial<SessionEntry> = {}): SessionEntry {
  return { key: r.key, host: "desk", id: r.key.split(":")[1] as string, agents: 0, processes: 0, tail: [], needs: [], read: null, status: null, info: r.info as never, ...extra };
}

describe("names that would be the same", () => {
  test("rows with a name of their own get no suffix", () => {
    const rows = [row("ses_aaaa1111", NOW, {}, "one"), row("ses_bbbb2222", NOW, {}, "two")];
    expect(collisionSuffixes(rows).size).toBe(0);
  });

  test("rows sharing repo, title, machine and minute are told apart by the shortest id ending that differs", () => {
    const rows = [row("ses_aaaa1111", NOW, {}, "ok"), row("ses_bbbb2222", NOW + 5000, {}, "ok"), row("ses_cccc3333", NOW, {}, "other")];
    const suffixes = collisionSuffixes(rows);
    expect(suffixes.get("desk:ses_aaaa1111")).toBe(", 1111");
    expect(suffixes.get("desk:ses_bbbb2222")).toBe(", 2222");
    expect(suffixes.has("desk:ses_cccc3333")).toBe(false);
  });

  test("ids that share a long ending grow the suffix until every name is unique", () => {
    const rows = Array.from({ length: 30 }, (_, n) => row(`ses_${String(n).padStart(2, "0")}0000abcd`, NOW, {}, "ok"));
    const names = rows.map((r) => rowView(r, undefined, [], {}, NOW, collisionSuffixes(rows).get(r.key) ?? "").name);
    expect(new Set(names).size).toBe(30);
  });

  test("a minute apart is already a different name", () => {
    const rows = [row("ses_aaaa1111", NOW, {}, "ok"), row("ses_bbbb2222", NOW - 2 * MIN, {}, "ok")];
    expect(collisionSuffixes(rows).size).toBe(0);
  });
});

describe("last activity", () => {
  test("reads as a person says it", () => {
    expect(whenOf(NOW - 20_000, NOW)).toBe("just now");
    expect(whenOf(NOW + 5000, NOW)).toBe("just now");
    expect(whenOf(NOW - 5 * MIN, NOW)).toBe("5 min ago");
    expect(whenOf(NOW - 3 * HOUR, NOW)).toBe("3 h ago");
    expect(whenOf(NOW - 30 * HOUR, NOW)).toBe("yesterday");
    expect(whenOf(NOW - 9 * DAY, NOW)).toMatch(/^22 Sep/);
  });

  test("a date in another year carries the year", () => {
    expect(whenOf(new Date("2025-03-04T10:00:00").getTime(), NOW)).toBe("4 Mar 2025");
  });
});

describe("a row", () => {
  test("a thread the fleet does not hold is idle, with its repo, machine and time", () => {
    const view = rowView(row("a", NOW - 3 * HOUR, {}, "fix the rate limiter"), undefined, [], {}, NOW);
    expect(view).toMatchObject({ repo: "ledger", title: "fix the rate limiter", state: "idle", words: "idle", cleared: false, when: "3 h ago", host: "desk" });
  });

  test("an empty title reads as untitled", () => {
    expect(rowView(row("a", NOW, {}, "  "), undefined, [], {}, NOW).title).toBe("untitled");
  });

  test("a thread the fleet holds shows the fleet's state, not the page's", () => {
    const r = row("a", NOW - MIN);
    const working = held(r, { status: { type: "busy", since: NOW - MIN } });
    expect(rowView(r, working, [], {}, NOW)).toMatchObject({ state: "working", words: "working" });
    const unseen = held(r, { needs: [{ kind: "done", body: "" } as never] });
    expect(rowView(r, unseen, [], {}, NOW).words).toBe("done");
  });

  test("cleared follows the live entry when the fleet holds the thread, the page otherwise", () => {
    const r = row("a", NOW - MIN, { cleared: true });
    expect(rowView(r, undefined, [], {}, NOW).cleared).toBe(true);
    expect(rowView(r, held(r), [], {}, NOW).cleared).toBe(false);
    expect(rowView(row("b", NOW), held(row("b", NOW), { cleared: NOW - 1 }), [], {}, NOW).cleared).toBe(true);
  });

  test("the name is unique per thread and says what a sighted person reads", () => {
    const a = rowView(row("a", NOW - HOUR, { cleared: true }, "same title"), undefined, [], {}, NOW);
    const b = rowView(row("b", NOW - 2 * HOUR, {}, "same title"), undefined, [], {}, NOW);
    expect(a.name).not.toBe(b.name);
    expect(a.name).toContain("ledger: same title, idle, cleared, desk");
  });
});

describe("pages", () => {
  test("a thread that moved between pages is listed once", () => {
    const a = row("a", 3);
    const b = row("b", 2);
    expect(appendRows([a, b], [b, row("c", 1)]).map((r) => r.key)).toEqual(["desk:a", "desk:b", "desk:c"]);
  });
});

describe("the words for nothing", () => {
  test("a search, a machine, no machine answering, and a fleet with no threads", () => {
    expect(emptyWords({ searching: true, machine: null, unreached: 0 })).toBe("nothing matches that.");
    expect(emptyWords({ searching: true, machine: "desk", unreached: 0 })).toBe("nothing on desk matches that.");
    expect(emptyWords({ searching: false, machine: "desk", unreached: 0 })).toBe("desk has no threads yet.");
    expect(emptyWords({ searching: false, machine: null, unreached: 2 })).toBe("no machine answered. check they are running, then try again.");
    expect(emptyWords({ searching: false, machine: null, unreached: 0 })).toBe("no threads yet. start one from the plus.");
  });

  test("machines that did not answer are named", () => {
    expect(unreachedWords([])).toBeNull();
    expect(unreachedWords(["desk"])).toBe("desk did not answer, so its threads are missing here.");
    expect(unreachedWords(["desk", "vm"])).toBe("desk and vm did not answer, so their threads are missing here.");
  });
});
