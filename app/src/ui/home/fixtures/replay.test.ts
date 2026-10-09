/* the recorded journal holds every window state the daemon can produce
   today, and the reducer takes all of it exactly once */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { windowView } from "../../window/view";
import { windowKeys } from "../membership";
import { endOf, keyOf, parseJournal, replay, TITLES } from "./replay";

const recorded = parseJournal(readFileSync(join(import.meta.dir, "journal.ndjson"), "utf8"));
const { state } = replay(recorded);
const now = endOf(recorded);
const asksOf = (key: string) => Object.values(state.fleet.asks).filter((a) => a.key === key);
const view = (title: string) => {
  const key = keyOf(state, title);
  const entry = state.fleet.sessions[key];
  if (!entry) throw new Error(`no session ${key}`);
  return windowView(entry, asksOf(key));
};

describe("the recorded journal", () => {
  test("applies exactly once: no duplicates, no gaps", () => {
    expect(state.counters.duplicates).toBe(0);
    expect(state.counters.gaps).toBe(0);
    expect(state.counters.applied).toBe(recorded.filter((r) => r.frame.type !== "hello" && r.frame.type !== "reset").length);
  });

  test("holds five threads across two repos, all with windows, in the server's order", () => {
    const keys = windowKeys(state.fleet, now);
    expect(keys.length).toBe(5);
    expect(new Set(keys.map((k) => view(state.fleet.sessions[k]?.info.title ?? "").repo))).toEqual(new Set(["ledger", "site"]));
    expect(keys[0]).toBe(keyOf(state, TITLES.wants));
  });

  test("each thread ended in the state it was recorded for", () => {
    expect(view(TITLES.working).state).toBe("working");
    expect(view(TITLES.wants).state).toBe("wants");
    expect(view(TITLES.wants).ask).toMatchObject({ header: "greeting", text: "which greeting should the notes use?", waiting: "2 options" });
    expect(view(TITLES.done).state).toBe("done");
    expect(view(TITLES.queued).state).toBe("queued");
    expect(view(TITLES.queued).queued).toBe(1);
    expect(view(TITLES.parked).state).toBe("parked");
    expect(view(TITLES.parked).jobs).toBe(1);
  });

  test("a working window's tail reads in the grammar: reads, an edit, a command", () => {
    const lines = view(TITLES.working).tail;
    expect(lines.some((l) => l.kind === "reads")).toBe(true);
    expect(lines.some((l) => l.kind === "tool" && l.verb === "edit" && l.object === "invoices.md")).toBe(true);
    expect(lines.some((l) => l.kind === "tool" && l.verb === "run" && l.object === "wc -l invoices.md")).toBe(true);
  });
});
