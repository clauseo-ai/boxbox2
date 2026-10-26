import { describe, expect, test } from "bun:test";
import { composing, exactRow, firstActive, menuKey, type Row } from "./keys";

const repo = (root: string): Row => ({ kind: "repo", host: "mini", root, note: "" });
const other: Row = { kind: "other" };
const REPOS: Row[] = [repo("/w/ledger"), repo("/w/ledger-web"), repo("/w/strand"), other];
const MACHINES: Row[] = [{ kind: "machine", name: "mini" }, { kind: "machine", name: "vm-a" }];
const MODELS: Row[] = [{ kind: "model", id: "anthropic/claude-opus-5-5", efforts: [] }, { kind: "model", id: "openai/gpt-5.2-codex", efforts: [] }];
const press = (key: string, extra: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) => ({ key, shiftKey: false, ...extra });

describe("what is highlighted as a menu opens", () => {
  test("a typed menu highlights nothing unless the word names a row exactly", () => {
    expect(firstActive(REPOS, "typed", "led")).toBeNull();
    expect(firstActive(REPOS, "typed", "alice")).toBeNull();
    expect(firstActive(REPOS, "typed", "")).toBeNull();
    expect(firstActive(REPOS, "typed", "ledger")).toBe(0);
    expect(firstActive(REPOS, "typed", "Strand")).toBe(2);
  });

  test("an exact machine name, model name or model id is a match; a part of one is not", () => {
    expect(exactRow(MACHINES, "vm-a")).toBe(1);
    expect(exactRow(MACHINES, "vm")).toBeNull();
    expect(exactRow(MODELS, "opus-5.5")).toBe(0);
    expect(exactRow(MODELS, "claude-opus-5-5")).toBe(0);
    expect(exactRow(MODELS, "gpt-5.2-codex")).toBe(1);
    expect(exactRow(MODELS, "opus")).toBeNull();
  });

  test("a typed path is never taken by itself, even with its use row there", () => {
    const rows: Row[] = [{ kind: "use", host: "mini", dir: "/etc/hosts" }, { kind: "folder", host: "mini", dir: "/etc/hosts.d", name: "hosts.d", repo: false }];
    expect(firstActive(rows, "typed", "/etc/hosts")).toBeNull();
  });

  test("a menu opened by a tap highlights its first row that is not other folder", () => {
    expect(firstActive(REPOS, "tap", "")).toBe(0);
    expect(firstActive([other, repo("/w/a")], "tap", "")).toBe(1);
  });

  test("other folder is never highlighted by itself, typed or tapped", () => {
    expect(firstActive([other], "tap", "")).toBeNull();
    expect(firstActive([other], "typed", "other")).toBeNull();
    expect(firstActive([other], "typed", "")).toBeNull();
  });
});

describe("the keys over an open menu", () => {
  test("return with nothing highlighted passes to the composer, which sends the words as typed", () => {
    expect(menuKey(press("Enter"), REPOS.length, null, false)).toEqual({ kind: "pass" });
  });

  test("return with a row highlighted picks it; shift and return is a new line", () => {
    expect(menuKey(press("Enter"), REPOS.length, 2, false)).toEqual({ kind: "choose", index: 2 });
    expect(menuKey(press("Enter", { shiftKey: true }), REPOS.length, 2, false)).toEqual({ kind: "pass" });
  });

  test("tab picks a highlighted row and otherwise does what tab does", () => {
    expect(menuKey(press("Tab"), REPOS.length, 0, false)).toEqual({ kind: "choose", index: 0 });
    expect(menuKey(press("Tab"), REPOS.length, null, false)).toEqual({ kind: "pass" });
  });

  test("the arrows set the highlight: from none, down is the first row and up the last, and they wrap", () => {
    expect(menuKey(press("ArrowDown"), 4, null, false)).toEqual({ kind: "move", to: 0 });
    expect(menuKey(press("ArrowUp"), 4, null, false)).toEqual({ kind: "move", to: 3 });
    expect(menuKey(press("ArrowDown"), 4, 3, false)).toEqual({ kind: "move", to: 0 });
    expect(menuKey(press("ArrowUp"), 4, 0, false)).toEqual({ kind: "move", to: 3 });
    expect(menuKey(press("ArrowDown"), 0, null, false)).toEqual({ kind: "pass" });
  });

  test("return in the finder with nothing highlighted is held there, with nothing to send", () => {
    expect(menuKey(press("Enter"), 1, null, true)).toEqual({ kind: "hold" });
    expect(menuKey(press("Tab"), 1, null, true)).toEqual({ kind: "pass" });
  });

  test("escape closes the menu", () => {
    expect(menuKey(press("Escape"), 3, null, false)).toEqual({ kind: "close" });
  });

  test("the right arrow looks inside a highlighted folder from the end of the finder, and is the caret's anywhere else", () => {
    expect(menuKey(press("ArrowRight"), 3, 1, true, true)).toEqual({ kind: "look", index: 1 });
    expect(menuKey(press("ArrowRight"), 3, 1, true, false)).toEqual({ kind: "pass" });
    expect(menuKey(press("ArrowRight"), 3, 1, false, true)).toEqual({ kind: "pass" });
  });

  test("keys while an input method composes are the composition's: return, tab and escape pick and close nothing", () => {
    expect(composing({ isComposing: true })).toBe(true);
    expect(composing({ keyCode: 229 })).toBe(true);
    expect(composing({ isComposing: false, keyCode: 13 })).toBe(false);
    for (const key of ["Enter", "Tab", "Escape", "ArrowDown"]) {
      expect(menuKey(press(key, { isComposing: true }), 3, 0, false)).toEqual({ kind: "pass" });
      expect(menuKey(press(key, { keyCode: 229 }), 3, 0, true)).toEqual({ kind: "pass" });
    }
  });
});
