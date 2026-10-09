import { describe, expect, test } from "bun:test";
import type { BrainEvent } from "../../lib/server/brain";
import { FleetState } from "../src/state";

const T0 = Date.parse("2026-07-26T12:00:00Z");

function frame(host: string, type: string, properties: Record<string, unknown>): BrainEvent {
  return { kind: "frame", host, frame: { payload: { type, properties } } };
}

function busy(state: FleetState, host: string, sessionID: string) {
  state.applyBrain(frame(host, "session.status", { sessionID, status: { type: "busy" } }), T0);
}

describe("queue inference (scope-board §6: the light is not optional)", () => {
  test("a user message born while busy is a queued order", () => {
    const s = new FleetState();
    busy(s, "h1", "ses1");
    s.applyBrain(frame("h1", "message.updated", { info: { id: "m1", sessionID: "ses1", role: "user" } }), T0);
    s.applyBrain(frame("h1", "message.updated", { info: { id: "m2", sessionID: "ses1", role: "user" } }), T0);
    expect(s.queueDepth("h1:ses1")).toBe(2);
    expect(s.queuedSeats()).toEqual([{ key: "h1:ses1", depth: 2 }]);
  });

  test("the same message echoed twice counts once", () => {
    const s = new FleetState();
    busy(s, "h1", "ses1");
    const msg = frame("h1", "message.updated", { info: { id: "m1", sessionID: "ses1", role: "user" } });
    s.applyBrain(msg, T0);
    s.applyBrain(msg, T0);
    expect(s.queueDepth("h1:ses1")).toBe(1);
  });

  test("an assistant message consumes the queue", () => {
    const s = new FleetState();
    busy(s, "h1", "ses1");
    s.applyBrain(frame("h1", "message.updated", { info: { id: "m1", sessionID: "ses1", role: "user" } }), T0);
    s.applyBrain(frame("h1", "message.updated", { info: { id: "a1", sessionID: "ses1", role: "assistant" } }), T0);
    expect(s.queueDepth("h1:ses1")).toBe(0);
  });

  test("a user message on an IDLE session is not queued", () => {
    const s = new FleetState();
    s.applyBrain(frame("h1", "message.updated", { info: { id: "m1", sessionID: "ses1", role: "user" } }), T0);
    expect(s.queueDepth("h1:ses1")).toBe(0);
  });

  test("going idle clears the count", () => {
    const s = new FleetState();
    busy(s, "h1", "ses1");
    s.applyBrain(frame("h1", "message.updated", { info: { id: "m1", sessionID: "ses1", role: "user" } }), T0);
    s.applyBrain(frame("h1", "session.status", { sessionID: "ses1", status: { type: "idle" } }), T0);
    expect(s.queueDepth("h1:ses1")).toBe(0);
  });

  test("a snapshot resets every counter: the inference cannot survive a gap it did not see", () => {
    const s = new FleetState();
    busy(s, "h1", "ses1");
    s.applyBrain(frame("h1", "message.updated", { info: { id: "m1", sessionID: "ses1", role: "user" } }), T0);
    expect(s.queueDepth("h1:ses1")).toBe(1);
    s.applyBrain({ kind: "snapshot", hosts: [], pending: [], status: {}, read: { baselineAt: 0, readAt: {} }, bindings: { keys: {} } } as unknown as BrainEvent, T0);
    expect(s.queueDepth("h1:ses1")).toBe(0);
  });
});

describe("faults", () => {
  test("session.error raises, movement forgives", () => {
    const s = new FleetState();
    s.setSessions("h1", [{ id: "ses1", title: "t", time: { updated: T0 } }]);
    s.applyBrain(frame("h1", "session.error", { sessionID: "ses1" }), T0);
    expect(s.session("h1:ses1")?.fault).toEqual({ at: T0 });
    busy(s, "h1", "ses1");
    expect(s.session("h1:ses1")?.fault).toBeUndefined();
  });
});

describe("verdicts (the victory lap's source)", () => {
  function hostsEvent(checkouts: { directory: string; phase: string; requested?: { at: number } }[]): BrainEvent {
    return {
      kind: "hosts",
      hosts: [{ id: "h1", name: "h1", url: "", reachable: true, pendingCount: 0, liveDirectories: [], projects: [], checkouts }],
    } as unknown as BrainEvent;
  }

  test("a ready+requested checkout disappearing is a verdict", () => {
    const s = new FleetState();
    s.applyBrain(hostsEvent([{ directory: "/wt/a", phase: "ready", requested: { at: T0 } }]), T0);
    expect(s.drainVerdicts()).toBe(0);
    s.applyBrain(hostsEvent([]), T0);
    expect(s.drainVerdicts()).toBe(1);
    expect(s.drainVerdicts()).toBe(0); /* drained means drained */
  });

  test("a preparing checkout vanishing is NOT a verdict", () => {
    const s = new FleetState();
    s.applyBrain(hostsEvent([{ directory: "/wt/a", phase: "preparing" }]), T0);
    s.applyBrain(hostsEvent([]), T0);
    expect(s.drainVerdicts()).toBe(0);
  });

  test("a snapshot rebuilds the watch list without minting verdicts", () => {
    const s = new FleetState();
    s.applyBrain(hostsEvent([{ directory: "/wt/a", phase: "ready", requested: { at: T0 } }]), T0);
    s.applyBrain({ kind: "snapshot", hosts: [], pending: [], status: {}, read: { baselineAt: 0, readAt: {} }, bindings: { keys: {} } } as unknown as BrainEvent, T0);
    expect(s.drainVerdicts()).toBe(0);
  });
});

describe("sessions from the reconcile", () => {
  test("union, never replace: a child from an earlier fetch survives", () => {
    const s = new FleetState();
    s.setSessions("h1", [{ id: "child", parentID: "root", time: { updated: T0 } }]);
    s.setSessions("h1", [{ id: "root", time: { updated: T0 } }]);
    expect(s.session("h1:child")).not.toBeUndefined();
    expect(s.session("h1:root")).not.toBeUndefined();
  });

  test("deletion is explicit, via the frame", () => {
    const s = new FleetState();
    s.setSessions("h1", [{ id: "ses1", time: { updated: T0 } }]);
    s.applyBrain(frame("h1", "session.deleted", { info: { id: "ses1" } }), T0);
    expect(s.session("h1:ses1")).toBeUndefined();
  });

  test("a BUSY session we hold no row for is reported for backfill, NEVER synthesized", () => {
    /* the reconcile is project-scoped and session.status carries no row.
       a made-up row would have no parentID and the board would seat
       subagents as threads — so the daemon fetches the real one. */
    const s = new FleetState();
    busy(s, "h1", "ghost");
    expect(s.unknownBusy()).toEqual([{ host: "h1", sessionID: "ghost" }]);
    expect(s.seatInput().sessions.find((x) => x.key === "h1:ghost")).toBeUndefined();
  });

  test("once the row lands, it stops being unknown", () => {
    const s = new FleetState();
    busy(s, "h1", "ses1");
    s.setSessions("h1", [{ id: "ses1", title: "the real title", time: { updated: T0 } }]);
    expect(s.unknownBusy()).toEqual([]);
    expect(s.session("h1:ses1")?.title).toBe("the real title");
  });
});

describe("activity", () => {
  test("deltas pulse the session and the host, and decay", () => {
    const s = new FleetState();
    s.applyBrain(frame("h1", "message.part.delta", { sessionID: "ses1" }), T0);
    expect(s.deltaAge("h1:ses1", T0 + 100)).toBe(100);
    expect(s.hostActivity("h1")).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) s.decay();
    expect(s.hostActivity("h1")).toBe(0);
  });
});
