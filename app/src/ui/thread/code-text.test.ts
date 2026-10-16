/* beds that open to their whole length (docs/thread.md, code and copying): every line a read returned from its output, the words a
   bed and the reader say of what they hold, and an output opened whole up to the cap */

import { describe, expect, test } from "bun:test";
import { fileFacts, readerEnd, showAllWords, wholeFile } from "./code-text";
import { readLines, wholeLines } from "./evidence";

const opencode = "<path>/r/a.ts</path>\n<type>file</type>\n<content>\n85: const a = 1\n86: \n87:   return a\n\n(Showing lines 85-87 of 300. Use offset=88 to continue.)\n</content>";
const cmx2 = "     1\t# notes\n     2\t\n     3\tgreeting: pending";

describe("the lines a read returned", () => {
  test("opencode's wrapper, numbers and note come off, and the first number is where the lines start", () => {
    expect(readLines(opencode)).toEqual({ lines: ["const a = 1", "", "  return a"], from: 85 });
  });

  test("cmx2's tab-numbered lines read the same", () => {
    expect(readLines(cmx2)).toEqual({ lines: ["# notes", "", "greeting: pending"], from: 1 });
  });

  test("an unnumbered line among them is the tail of the one before; output that is not numbered lines is not a file", () => {
    expect(readLines("1: a very\nlong line\n2: b")).toEqual({ lines: ["a very\nlong line", "b"], from: 1 });
    expect(readLines("<path>/r</path>\n<type>directory</type>\n<entries>\n.git/\nsrc/\n</entries>")).toBeNull();
    expect(readLines("just words")).toBeNull();
    expect(readLines("")).toBeNull();
  });
});

describe("a file's bed and the reader", () => {
  const preview = { path: "/r/a.ts", lines: ["const a = 1", "", "  return a"].slice(0, 2), from: 85, total: 300 };

  test("with the read's output the bed holds every line it returned", () => {
    const whole = wholeFile({ ...preview, raw: opencode, read: 3 });
    expect(whole.lines).toHaveLength(3);
    expect(whole.kept).toBeUndefined();
    expect(fileFacts(whole)).toBe("lines 85 to 87 of 300");
    expect(readerEnd(whole)).toBe("the read stopped at line 87 of 300");
  });

  test("without it, the preview is all there is, and the reader says the thread keeps only that much", () => {
    const kept = wholeFile({ ...preview, read: 40 });
    expect(kept.kept).toBe(true);
    expect(readerEnd(kept)).toBe("the thread keeps only the first 2 lines of the 40 read");
  });

  test("a preview that is the whole read is not called kept", () => {
    expect(wholeFile({ ...preview, read: 2 }).kept).toBeUndefined();
    expect(wholeFile(preview).kept).toBeUndefined();
  });

  test("the facts and the end of a whole file", () => {
    const all = { path: "/r/b", lines: ["a", "b", "c"], from: 1, total: 3 };
    expect(fileFacts(all)).toBe("the end of the file, 3 lines");
    expect(readerEnd(all)).toBe("the end of what was read");
    expect(fileFacts({ path: "/r/b", lines: ["a"], from: 1 })).toBe("1 line");
    expect(fileFacts({ path: "/r/b", lines: ["a", "b"], from: 9 })).toBe("lines 9 to 10");
  });

  test("the control says how many lines it opens to", () => {
    expect(showAllWords(2610, false)).toBe("show all 2,610 lines");
    expect(showAllWords(300, true)).toBe("show the whole diff, 300 lines");
  });
});

describe("an output opened whole", () => {
  test("every line under the cap; past it, the lines left out are counted", () => {
    expect(wholeLines("a\nb\nc")).toEqual({ lines: ["a", "b", "c"], rest: 0 });
    expect(wholeLines("aaaa\nbbbb\ncccc\ndddd", 10)).toEqual({ lines: ["aaaa", "bbbb"], rest: 2 });
  });

  test("a first line longer than the cap is still shown, so the bed is never empty", () => {
    expect(wholeLines("x".repeat(50) + "\ny", 10)).toEqual({ lines: ["x".repeat(50)], rest: 1 });
  });
});
