import { describe, expect, test } from "bun:test";
import { discardQuestion, patchLines, routeOf, sizeLine, statusOf, warningsOf } from "./card-words";
import type { Review } from "./model";

const review = (over: Partial<Review> = {}): Review => ({
  checkout: "site-fix",
  branch: "agent/site-fix",
  base: "main",
  baseRef: "refs/heads/main",
  commits: 3,
  dirty: false,
  mergeable: true,
  additions: 42,
  deletions: 7,
  files: [
    { path: "src/pricing/toggle.tsx", status: "modified", additions: 40, deletions: 7 },
    { path: "docs/pricing.md", status: "added", additions: 2, deletions: 0 },
  ],
  diff: "",
  truncated: false,
  ...over,
});

describe("what the card says of a checkout", () => {
  test("the route is the branch into its base, and the checkout's name when there is no branch", () => {
    expect(routeOf(review())).toEqual({ from: "agent/site-fix", to: "main" });
    expect(routeOf(review({ branch: null }))).toEqual({ from: "site-fix", to: "main" });
    const { branch: _branch, ...unnamed } = review({ checkout: null });
    expect(routeOf(unnamed)).toEqual({ from: "the checkout", to: "main" });
  });

  test("the size counts commits and files, with the singular where there is one", () => {
    expect(sizeLine(review())).toBe("3 commits, 2 files");
    expect(sizeLine(review({ commits: 1, files: [] }))).toBe("1 commit, 0 files");
  });

  test("a clean, mergeable checkout carries no warning", () => {
    expect(warningsOf(review())).toEqual([]);
  });

  test("a dirty checkout is warned of, and says the merge is refused", () => {
    expect(warningsOf(review({ dirty: true }))).toEqual(["the checkout has changes that are not committed. the merge is refused until the agent commits or drops them."]);
  });

  test("a checkout that will not merge cleanly says which base, and unknown mergeability says nothing", () => {
    expect(warningsOf(review({ mergeable: false }))[0]).toContain("main cleanly");
    expect(warningsOf(review({ mergeable: null }))).toEqual([]);
    const { mergeable: _mergeable, ...unsaid } = review();
    expect(warningsOf(unsaid)).toEqual([]);
  });

  test("a checkout with nothing in it says so", () => {
    expect(warningsOf(review({ commits: 0, files: [], additions: 0, deletions: 0 }))).toEqual(["nothing here differs from main yet."]);
  });
});

describe("file statuses", () => {
  test("words and letters both read as the same mark", () => {
    expect(statusOf("added")).toEqual({ mark: "A", word: "added" });
    expect(statusOf("A")).toEqual({ mark: "A", word: "added" });
    expect(statusOf("modified")).toEqual({ mark: "M", word: "modified" });
    expect(statusOf("D")).toEqual({ mark: "D", word: "deleted" });
    expect(statusOf("renamed")).toEqual({ mark: "R", word: "renamed" });
  });

  test("a status the card does not know is kept as it came, never dropped", () => {
    expect(statusOf("typechange")).toEqual({ mark: "T", word: "typechange" });
    expect(statusOf("")).toEqual({ mark: "M", word: "changed" });
  });
});

describe("the question before a discard", () => {
  test("the question before a discard says what leaves and what stays", () => {
    expect(discardQuestion(review())).toBe("discard this checkout? its 3 commits and 2 changed files leave with the checkout, and the agent's thread stays.");
    expect(discardQuestion(null)).toBe("discard this checkout? the checkout goes, and the agent's thread stays.");
  });
});

describe("the patch, cut for painting", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "--- a line that starts like a header but is a deletion",
    "diff --git a/b.md b/b.md",
    "new file mode 100644",
    "@@ -0,0 +1 @@",
    "+hello",
    "",
  ].join("\n");

  test("headers go, files and hunks stay, and changes keep their kind", () => {
    const { lines, left } = patchLines(diff);
    expect(left).toBe(0);
    expect(lines.map((l) => l.kind)).toEqual(["file", "hunk", "ctx", "del", "add", "del", "file", "hunk", "add"]);
    expect(lines[0]?.text).toBe("src/a.ts");
  });

  test("a patch longer than the limit is cut, and says how many lines it left", () => {
    const { lines, left } = patchLines(diff, 4);
    expect(lines).toHaveLength(4);
    expect(left).toBe(5);
  });

  test("no patch is no lines", () => {
    expect(patchLines("")).toEqual({ lines: [], left: 0 });
  });
});
