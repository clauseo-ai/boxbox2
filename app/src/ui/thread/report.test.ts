/* a report's chip in words (docs/thread.md, what started the turn): the outcome from its first word, its first line without its
   markdown, and the gist without an outcome word that only labels it */

import { describe, expect, test } from "bun:test";
import { firstLine, outcomeOf, reportOf, unlabelled } from "./report";

describe("a report's chip", () => {
  test("the outcome is read from the first word only", () => {
    expect(outcomeOf("ready to merge cd16978")).toBe("ready");
    expect(outcomeOf("Blocked: the zoom shots wait")).toBe("blocked");
    expect(outcomeOf("failed: the check")).toBe("failed");
    expect(outcomeOf("the build is ready")).toBe("none");
  });

  test("the first line with words, its markdown marks gone, fences and rules skipped", () => {
    expect(firstLine("\n\n## **Done**: all `green`\nmore")).toBe("Done: all green");
    expect(firstLine("```\ncode\n```")).toBe("code");
    expect(firstLine("---\n1. first item")).toBe("first item");
    expect(firstLine("> - quoted")).toBe("quoted");
  });

  test("an outcome word that only labels the line is dropped from the gist", () => {
    expect(unlabelled("blocked: the zoom shots wait")).toBe("the zoom shots wait");
    expect(unlabelled("failed - the check timed out")).toBe("the check timed out");
    expect(unlabelled("ready to merge cd16978")).toBe("ready to merge cd16978");
    expect(unlabelled("done.")).toBe("done.");
  });

  test("the chip said whole: whose, how it went, when, what", () => {
    const at = Date.UTC(2026, 9, 15, 0, 2);
    const r = reportOf({ from: "stepgroups", prompt: "blocked: the shots wait", at });
    expect(r).toMatchObject({ outcome: "blocked", gist: "the shots wait", verb: "reported", initial: "S" });
    expect(r.spoken).toMatch(/^report from stepgroups, blocked, \d\d:\d\d, the shots wait$/);
    expect(reportOf({ from: "worker_a", prompt: "see the fixture", at, note: true })).toMatchObject({ outcome: "none", verb: "wrote", initial: "W" });
  });
});
