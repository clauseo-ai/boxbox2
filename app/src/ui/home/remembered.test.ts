import { describe, expect, test } from "bun:test";
import { FOCUS_KEY, INSPECTOR_KEY, readFocus, readInspector, readStrip, rememberFocus, rememberInspector, rememberStrip, STRIP_KEY } from "./remembered";

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

describe("the windows put away", () => {
  test("are shown until the person puts them away", () => {
    expect(readFocus(memory())).toBe("shown");
  });

  test("come back away after they were put away", () => {
    const store = memory();
    rememberFocus("hidden", store);
    expect(store.held.get(FOCUS_KEY)).toBe("hidden");
    expect(readFocus(store)).toBe("hidden");
  });

  test("ignore a value nobody wrote, and the rail's old fold", () => {
    expect(readFocus(memory({ [FOCUS_KEY]: "folded", "boxbox.rail": "folded" }))).toBe("shown");
  });

  test("survive storage that refuses to read or write, or none at all", () => {
    expect(readFocus(refusing)).toBe("shown");
    expect(() => rememberFocus("hidden", refusing)).not.toThrow();
    expect(readFocus(null)).toBe("shown");
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

describe("the strip", () => {
  test("is open until the person folds it, and apart from the rail", () => {
    const store = memory({ [FOCUS_KEY]: "hidden" });
    expect(readStrip(store)).toBe("open");
    rememberStrip("folded", store);
    expect(store.held.get(STRIP_KEY)).toBe("folded");
    expect(readStrip(store)).toBe("folded");
    expect(readStrip(refusing)).toBe("open");
  });
});
