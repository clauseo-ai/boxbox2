import { describe, expect, test } from "bun:test";
import { turnsOf } from "../thread/model";
import type { WireMessage } from "../thread/wire";
import { BTW_GONE, markerTarget, parentMarkerName } from "./marker";

/* the "from a btw" marker's data: a promoted user message carries the btw's id (`AgentMessage.btw`), and its turn keeps it */

const T0 = 1_790_000_000_000;
const message = (info: Record<string, unknown>): WireMessage => ({ info: { created: T0, ...info }, parts: [{ id: `${String(info["id"])}_p`, type: "text", text: "why is it slow?\n\nthe health check waits 30 s per machine." }] }) as unknown as WireMessage;

describe("a message added to the thread from a btw", () => {
  test("its turn carries the btw's id", () => {
    const [turn] = turnsOf([message({ id: "u1", role: "user", btw: "btw_1" })], "/");
    expect(turn?.btw).toBe("btw_1");
    expect(turn?.by).toBe("you");
  });

  test("a message typed in the composer carries none", () => {
    const [turn] = turnsOf([message({ id: "u1", role: "user" })], "/");
    expect(turn !== undefined && "btw" in turn).toBe(false);
  });
});

/* where the marker goes: its card here, else, in a fork, the parent's card (the fork copied the message, never the btw) */
describe("the marker's target", () => {
  const placed = new Map([["btw_own", "u3"]]);
  const turnOf = (id: string) => placed.get(id);
  const lineage = { key: "desk:ses_parent", title: "plan the release", cut: "msg_9" };

  test("a card this thread holds is the target, fork or not", () => {
    expect(markerTarget("btw_own", turnOf, null)).toEqual({ kind: "here", turn: "u3" });
    expect(markerTarget("btw_own", turnOf, lineage)).toEqual({ kind: "here", turn: "u3" });
  });

  test("in a fork, a btw it does not hold is the parent's card, with the cut to land on if the card is gone", () => {
    expect(markerTarget("btw_copied", turnOf, lineage)).toEqual({ kind: "parent", key: "desk:ses_parent", title: "plan the release", cut: "msg_9", btw: "btw_copied" });
  });

  test("a whole fork has no cut to fall back on, and the parent's title may be unknown", () => {
    expect(markerTarget("btw_copied", turnOf, { key: "desk:ses_parent", title: null, cut: null })).toEqual({ kind: "parent", key: "desk:ses_parent", title: null, cut: null, btw: "btw_copied" });
  });

  test("outside a fork, a btw the thread does not hold goes nowhere", () => {
    expect(markerTarget("btw_gone", turnOf, null)).toEqual({ kind: "none" });
  });

  test("its name says the card is in the parent, apart from the marker of a card here", () => {
    expect(parentMarkerName("plan the release")).toBe("from a btw, with its answer: go to the btw in plan the release");
    expect(parentMarkerName(null)).toBe("from a btw, with its answer: go to the btw in the thread this was forked from");
    expect(BTW_GONE).not.toMatch(/[\u2013\u2014]/);
  });
});
