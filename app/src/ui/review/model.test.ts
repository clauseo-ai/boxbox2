import { describe, expect, test } from "bun:test";
import { discardedLine, GONE_LINE, mergedLine, problemOf } from "./model";

describe("the lines a merge or a discard leaves", () => {
  const merged = { merged: true, commit: "abc123", base: "main", branch: "agent/site-fix", commits: 3, stopped: [] };

  test("a merge reads \"merged into\" the base, never the path the server ran it in", () => {
    expect(mergedLine(merged)).toBe("merged into main");
    expect(mergedLine({ ...merged, into: "/work/ledger" })).toBe("merged into main");
  });

  test("a merge says what it stopped on the way", () => {
    expect(mergedLine({ ...merged, stopped: ["dev server"] })).toBe("merged into main, stopped 1 process");
    expect(mergedLine({ ...merged, stopped: ["a", "b"] })).toBe("merged into main, stopped 2 processes");
  });

  test("a discard says where the work was kept, when the server kept it", () => {
    expect(discardedLine({ discarded: true, stopped: [] })).toBe("discarded");
    expect(discardedLine({ discarded: true, ref: "refs/boxbox/site-fix", stopped: [] })).toBe("discarded. the work is kept at refs/boxbox/site-fix");
    expect(discardedLine({ discarded: true, snapshot: "ab12", stopped: ["x"] })).toBe("discarded. the work is kept at ab12, stopped 1 process");
  });
});

describe("a refusal in words", () => {
  test("a busy checkout says the agent is mid-turn, and names the action", () => {
    const merge = problemOf(409, { error: "busy", message: "a turn runs" });
    expect(merge.kind).toBe("busy");
    expect(merge.text).toBe("the agent is mid-turn. let it finish or stop it, then merge again.");
    expect(problemOf(409, { error: "busy" }, "discard").text).toContain("then discard again");
  });

  test("a conflict lists its files, in either shape of body", () => {
    const flat = problemOf(409, { error: "conflict", message: "x", files: ["src/a.ts", "src/b.ts"] });
    expect(flat).toEqual({ kind: "conflict", text: "the merge stopped on a conflict in 2 files. nothing was merged.", files: ["src/a.ts", "src/b.ts"] });
    const nested = problemOf(409, { error: { code: "conflict", message: "x", files: ["src/a.ts"] } });
    expect(nested.files).toEqual(["src/a.ts"]);
    expect(nested.text).toContain("1 file.");
  });

  test("a conflict that names no files still says it stopped", () => {
    expect(problemOf(409, { error: "conflict" }).text).toBe("the merge stopped on a conflict. nothing was merged.");
  });

  test("a refusal gives the daemon's message when there is no known reason, then the reason itself", () => {
    expect(problemOf(409, { error: "refused", message: "the checkout is detached" }).text).toBe("the checkout is detached");
    expect(problemOf(409, { error: "refused", reason: "locked" }).text).toBe("locked");
    expect(problemOf(409, { error: "refused" }).text).toBe("the merge was refused.");
  });

  test("a refusal's reason code reads as what to do, and an unknown reason is kept", () => {
    expect(problemOf(409, { error: "refused", reason: "dirty", message: "m" }).text).toContain("commit or drop");
    expect(problemOf(409, { error: "refused", reason: "nothing", message: "m" }).text).toContain("nothing to merge");
    expect(problemOf(409, { error: "refused", reason: "detached", message: "m" }).text).toContain("not on a branch");
    expect(problemOf(409, { error: "refused", reason: "target_dirty", message: "m" }).text).toContain("merges into");
    expect(problemOf(409, { error: "refused", reason: "odd", message: "the daemon's words" }).text).toBe("the daemon's words");
  });

  test("a checkout the daemon no longer has is gone, not an error", () => {
    const gone = problemOf(404, { error: { code: "no-such-checkout", message: "x" } });
    expect(gone).toEqual({ kind: "gone", text: "this checkout is gone. it was merged or discarded already.", files: [] });
    expect(GONE_LINE).toBe("this checkout is gone");
  });

  test("a thread that is gone says it may have been archived", () => {
    const gone = problemOf(404, null);
    expect(gone.kind).toBe("other");
    expect(gone.text).toContain("archived");
  });

  test("anything else says what the server said, or its status", () => {
    expect(problemOf(502, { error: { code: "host-unreachable", message: "the host did not answer" } }).text).toBe("the host did not answer");
    expect(problemOf(500, undefined).text).toBe("the server answered 500. try again.");
  });
});
