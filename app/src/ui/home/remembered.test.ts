import { describe, expect, test } from "bun:test";
import { INSPECTOR_KEY, RAIL_KEY, readInspector, readRail, rememberInspector, rememberRail } from "./remembered";

function memory(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return { held, getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value) };
}

const refusing = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("the rail", () => {
  test("is open until the person folds it", () => {
    expect(readRail(memory())).toBe("open");
  });

  test("comes back folded after it was folded", () => {
    const store = memory();
    rememberRail("folded", store);
    expect(store.held.get(RAIL_KEY)).toBe("folded");
    expect(readRail(store)).toBe("folded");
  });

  test("ignores a value nobody wrote", () => {
    expect(readRail(memory({ [RAIL_KEY]: "collapsed" }))).toBe("open");
  });

  test("survives storage that refuses to read or write", () => {
    expect(readRail(refusing)).toBe("open");
    expect(() => rememberRail("folded", refusing)).not.toThrow();
  });

  test("survives there being no storage at all", () => {
    expect(readRail(null)).toBe("open");
    expect(() => rememberRail("folded", null)).not.toThrow();
  });
});

describe("the inspector", () => {
  test("shows the details until the person chooses otherwise", () => {
    expect(readInspector(memory())).toBe("details");
  });

  test("remembers each of its three states", () => {
    for (const state of ["details", "turns", "folded"] as const) {
      const store = memory();
      rememberInspector(state, store);
      expect(store.held.get(INSPECTOR_KEY)).toBe(state);
      expect(readInspector(store)).toBe(state);
    }
  });

  test("ignores a value nobody wrote", () => {
    expect(readInspector(memory({ [INSPECTOR_KEY]: "agents" }))).toBe("details");
  });

  test("survives storage that refuses to read or write", () => {
    expect(readInspector(refusing)).toBe("details");
    expect(() => rememberInspector("turns", refusing)).not.toThrow();
  });
});
