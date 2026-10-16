/* the checked-in traces: each is the scenario it claims to be, reads as a
   real session (frames, calls, the pit's answers), and names nothing on
   the machine it was recorded on (AGENTS.md, public repo). replaying them needs the
   world; reading them does not. */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize } from "../trace/normalize";
import { SCENARIOS } from "../trace/scenarios";
import { readTrace } from "../trace/trace";

const TRACES = join(import.meta.dir, "..", "trace", "traces");
const files = readdirSync(TRACES).filter((f) => f.endsWith(".json")).sort();

describe("the recorded traces", () => {
  test("there is one per scenario, and no stray", () => {
    expect(files).toEqual(SCENARIOS.map((s) => `${s.name}.json`).sort());
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const path = join(TRACES, `${scenario.name}.json`);
      const trace = readTrace(path);
      const view = normalize(trace.steps);

      test("was recorded from this script, against v1", () => {
        expect(trace.steps.slice(1).map((s) => s.label)).toEqual(scenario.steps.map((s) => s.label));
        expect(trace.recorded.against).toStartWith("boxbox v1 ");
      });

      test("opens with the connect burst and keeps the board fed", () => {
        expect(view.steps[0]?.leds[0]).toBe("hello proto 1");
        expect(view.steps[0]?.board).toContain("hello-ack fw 5 proto 1 mode 0");
        expect(view.keepaliveGapMs).toBeLessThan(1000);
      });

      test("names nothing on the machine it was recorded on", () => {
        const text = readFileSync(path, "utf8");
        expect(text).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/var\/folders|bb_session|ses_[0-9a-zA-Z]{20}|per_[0-9a-zA-Z]{20}|que_[0-9a-zA-Z]{20}/);
      });
    });
  }

  test("the pit answers with the digits: once, reject, always, and the second option", () => {
    const calls = normalize(readTrace(join(TRACES, "permission-pit.json")).steps).steps.flatMap((s) => s.calls);
    const replies = calls.filter((c) => c.startsWith("reply"));
    expect(replies.map((c) => /"reply":"(\w+)"|"answers":(\[\["\w+"\]\])/.exec(c)?.slice(1).find(Boolean))).toEqual(["once", "reject", "always", '[["two"]]']);
    expect(replies.every((c) => c.endsWith("-> ok"))).toBe(true);
  });

  test("thread switching focuses threads on both pages and marks the top call read", () => {
    const calls = normalize(readTrace(join(TRACES, "thread-switching.json")).steps).steps.flatMap((s) => s.calls);
    expect(calls.filter((c) => c.startsWith("focus"))).toEqual([
      'focus {"session":"h1:<alpha>"} -> ok',
      'focus {"session":"h1:<echo>"} -> ok',
      'focus {"session":"h1:<kilo>"} -> ok',
      'focus {"session":"h1:<charlie>"} -> ok',
    ]);
    expect(calls).toContain('markRead {"session":"h1:<alpha>"} -> ok');
  });

  test("the talk key opens the meter on every press and reads back aloud", () => {
    const radio = normalize(readTrace(join(TRACES, "talk-key.json")).steps).steps.flatMap((s) => s.radio);
    expect(radio.filter((r) => r === "sox start").length).toBe(radio.filter((r) => r === "sox stop").length);
    expect(radio.filter((r) => r.startsWith("say "))).toHaveLength(2);
  });
});
