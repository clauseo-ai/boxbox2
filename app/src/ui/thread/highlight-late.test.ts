import { describe, expect, test } from "bun:test";
import { highlight, highlighterReady, loadHighlighter } from "./highlight";

/* this file is alone so that nothing has loaded the highlighter before its first test: the module's state is one per file */
describe("a fence that is shown before the highlighter has arrived", () => {
  test("is plain", () => {
    expect(highlighterReady()).toBe(false);
    expect(highlight("bash", "echo hi")).toBeUndefined();
  });

  test("asking for it again while it loads is the same load, and it is ready when that resolves", async () => {
    const first = loadHighlighter();
    expect(loadHighlighter()).toBe(first);
    await first;
    expect(highlighterReady()).toBe(true);
  });

  test("is painted from then on", () => {
    expect(highlight("bash", "echo hi")).toContain("hljs-");
  });
});
