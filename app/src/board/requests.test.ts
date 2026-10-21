import { describe, expect, test } from "bun:test";
import { thread } from "../sync/fixtures/neutral";
import { EMPTY_FLEET, type Fleet } from "../sync/reducer";
import { composeHost, focusable, focusPlan, holdsWords } from "./requests";

/** a sheet's fields and photos, as much of an element as holdsWords reads */
const sheet = (values: string[], photo = false) => ({
  querySelectorAll: () => Object.assign(values.map((value) => ({ value })), { item: (i: number) => ({ value: values[i] }) }) as unknown as NodeListOf<HTMLTextAreaElement>,
  querySelector: () => (photo ? ({} as Element) : null),
});

describe("a board focus and the sheets over home", () => {
  test("a sheet holds words when a field has text or a photo waits in it", () => {
    expect(holdsWords(null)).toBe(false);
    expect(holdsWords(sheet([]))).toBe(false);
    expect(holdsWords(sheet(["", "   \n"]))).toBe(false);
    expect(holdsWords(sheet(["", "half a thought"]))).toBe(true);
    expect(holdsWords(sheet([], true))).toBe(true);
  });

  test("a sheet with words keeps the screen and its caret; the thread opens behind it", () => {
    expect(focusPlan("words", "none")).toEqual({ closeNewThread: false, closeAnswer: false, caret: false });
    expect(focusPlan("none", "words")).toEqual({ closeNewThread: false, closeAnswer: false, caret: false });
    expect(focusPlan("empty", "words")).toEqual({ closeNewThread: false, closeAnswer: false, caret: false });
  });

  test("an empty sheet is put away and the caret goes to the thread", () => {
    expect(focusPlan("empty", "none")).toEqual({ closeNewThread: true, closeAnswer: false, caret: true });
    expect(focusPlan("none", "empty")).toEqual({ closeNewThread: false, closeAnswer: true, caret: true });
    expect(focusPlan("none", "none")).toEqual({ closeNewThread: false, closeAnswer: false, caret: true });
  });
});

describe("which requests the app can take", () => {
  const now = 1_800_000_000_000;
  // a thread at rest (idle, no status in cmx2), its parent's key when it is a child
  const entry = (key: string, updated: number, parent?: string) => thread(key, { updated, activity: { state: "idle" }, ...(parent ? { parent } : {}) });
  const fleet: Fleet = {
    ...EMPTY_FLEET,
    order: ["desk:a", "desk:child", "desk:old"],
    threads: { "desk:a": entry("desk:a", now - 1000), "desk:child": entry("desk:child", now - 1000, "a"), "desk:old": entry("desk:old", now - 13 * 3600_000) },
  };

  test("a focus needs a window home draws for its key", () => {
    expect(focusable(fleet, "desk:a", now)).toBe(true);
    expect(focusable(fleet, "desk:child", now)).toBe(false);
    expect(focusable(fleet, "desk:old", now)).toBe(false);
    expect(focusable(fleet, "desk:nowhere", now)).toBe(false);
  });

  test("a machine light maps to the host the sheet composes on, or to nothing", () => {
    expect(composeHost(["desk", "vm"], "vm")).toBe("vm");
    expect(composeHost(["desk", "vm"], "mini")).toBeNull();
    expect(composeHost([], "desk")).toBeNull();
  });
});
