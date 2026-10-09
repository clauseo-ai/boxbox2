import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "../../sync/protocol";
import { EMPTY_FLEET, type Fleet } from "../../sync/reducer";
import { RECENT_MS, sameOrder, windowKeys } from "./membership";

const NOW = 1_800_000_000_000;

function session(id: string, updated: number, status: SessionEntry["status"] = null, parentID?: string): SessionEntry {
  return {
    key: `h:${id}`,
    host: "h",
    id,
    agents: 0,
    processes: 0,
    tail: [],
    needs: [],
    read: null,
    status,
    info: { id, projectID: "/r", directory: "/r", title: id, time: { created: 0, updated }, ...(parentID ? { parentID } : {}) } as SessionEntry["info"],
  };
}

function fleet(entries: SessionEntry[], order: string[], asks: Fleet["asks"] = {}): Fleet {
  return { ...EMPTY_FLEET, sessions: Object.fromEntries(entries.map((e) => [e.key, e])), order, asks };
}

describe("what gets a window", () => {
  test("the server's order is kept exactly", () => {
    const f = fleet([session("a", NOW), session("b", NOW), session("c", NOW)], ["h:c", "h:a", "h:b"]);
    expect(windowKeys(f, NOW)).toEqual(["h:c", "h:a", "h:b"]);
  });

  test("working, parked and asking threads have windows however old they are", () => {
    const old = NOW - 3 * RECENT_MS;
    const f = fleet(
      [session("busy", old, { type: "busy", since: old }), session("parked", old, { type: "idle", parked: { agents: 0, jobs: 1 } }), session("asks", old)],
      ["h:asks", "h:busy", "h:parked"],
      { "h:q1": { host: "h", id: "q1", key: "h:asks", kind: "question", request: {} } },
    );
    expect(windowKeys(f, NOW)).toEqual(["h:asks", "h:busy", "h:parked"]);
  });

  test("an idle thread keeps its window for 12 hours after it was touched, then lives in all threads", () => {
    const f = fleet([session("fresh", NOW - RECENT_MS + 1000), session("stale", NOW - RECENT_MS - 1000)], ["h:fresh", "h:stale"]);
    expect(windowKeys(f, NOW)).toEqual(["h:fresh"]);
  });

  test("a subagent is a tile on its parent, never a window of its own", () => {
    const f = fleet([session("parent", NOW, { type: "busy", since: 1 }), session("child", NOW, { type: "busy", since: 2 }, "parent")], ["h:parent", "h:child"]);
    expect(windowKeys(f, NOW)).toEqual(["h:parent"]);
  });

  test("a cleared thread has no window; once the server spends the mark it is back", () => {
    const cleared = { ...session("cleared", NOW), cleared: NOW - 1 };
    const back = session("cleared", NOW + 5);
    expect(windowKeys(fleet([cleared, session("kept", NOW)], ["h:cleared", "h:kept"]), NOW)).toEqual(["h:kept"]);
    expect(windowKeys(fleet([back, session("kept", NOW)], ["h:cleared", "h:kept"]), NOW)).toEqual(["h:cleared", "h:kept"]);
  });

  test("an order entry the sessions do not hold is skipped", () => {
    expect(windowKeys(fleet([session("a", NOW)], ["h:gone", "h:a"]), NOW)).toEqual(["h:a"]);
  });
});

describe("an order changed", () => {
  test("only when its members or their order did", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
  });
});
