/* the documents a streaming reply is held to (markdown-stream.ts): every one is streamed in small seeded chunks, and after each chunk
   the units it was painted in must make the html of the whole text so far, by the test in bun (markdown-stream.test.ts, marked) and in
   the browser (the said-streaming-equivalence story, marked, the sanitiser and the painter's dom). they are the code stories' answers,
   the replies in the fixtures (`textsOf`), and shapes written here to catch a cut in the wrong place: markdown whose meaning a later
   line changes, and the sanitiser's edge cases. */

import { ANSWER_WITH_CODE, FENCES_OF_ALL_SHAPES, GITHUB_READING, HOSTILE_MARKUP, REPLY_IN_A_FENCE, REPLY_IN_A_LIST, REPORT_WITH_CODE } from "./code-sample";

const lines = (...l: string[]): string => l.join("\n");

/** markdown whose meaning reaches across a blank line, or that the sanitiser has to be right about */
export const EDGES: readonly string[] = [
  // raw html: a tag left open holds what follows it, an html block of the kinds that run past blank lines, comments, scripts
  lines("first para.", "", "a <b>bold that never closes", "", "second para.", "", "third, still in it?"),
  lines("intro.", "", "<div>", "", "inside a div *with markdown*", "", "</div>", "", "after the div."),
  lines("one.", "", "<!-- a comment", "", "that spans a blank line -->", "", "two."),
  lines("one.", "", "<pre>", "raw pre", "", "with a blank line", "</pre>", "", "two."),
  lines("one.", "", "<script>alert(1)</script>", "", "two <img src=x onerror=alert(1)> three.", "", "<style>p{color:red}</style>", "", "four."),
  lines("<details><summary>open me</summary>", "", "hidden words", "", "</details>", "", "after."),
  lines("a <span class=\"copy-btn\" data-copy=\"x\" onclick=\"x()\">fake</span> control.", "", "<button>press</button> and <form><input></form>", "", "end."),
  lines("text with `inline <T>` code and Vec<u8> outside.", "", "a < b and c > d.", "", "<https://example.com/auto> link."),
  // links and images: reference definitions before and after their use, in a list and a quote, a label over two lines
  lines("see [the docs][d] and [other].", "", "more prose.", "", "[d]: https://example.com/docs \"title\"", "", "[other]: https://example.com/other"),
  lines("[d]: https://example.com/first", "", "a ref to [d].", "", "another [d] here."),
  lines("a [ref] in prose.", "", "- item", "", "  [ref]: https://example.com/in-list", "", "after."),
  lines("a [ref] in prose.", "", "> [ref]: https://example.com/in-quote", "", "after."),
  lines("a [two\nline] label.", "", "[two", "line]: https://example.com/two"),
  lines("[from /root/agent]: done. tests pass.", "", "## files", "", "**1. `a.ts`**", "- `:12` a change", "", "**2. `b.ts`**", "- `:40` another"),
  lines("an ![image](https://example.com/x.png \"t\") and ![alt words](javascript:alert(1)).", "", "[a link](https://example.com) [bad](javascript:alert(1)) [mail](mailto:a@example.com) [rel](/relative)."),
  // tables
  lines("| a | b |", "|---|:-:|", "| 1 | 2 |", "| 3 | 4 |", "", "after the table.", "", "x | y", "--|--", "5 | 6", "", "| lone |"),
  // lists: loose and tight, nested, ordered, a fence inside, a paragraph after
  lines("- one", "- two", "", "- three, loose now", "", "after."),
  lines("1. first", "2. second", "   - nested", "     - deeper", "", "   more of second", "", "3. third", "", "10) other kind", "", "plain."),
  lines("- item with code:", "", "  ```ts", "  const a = 1;", "", "  const b = 2;", "  ```", "", "- next", "", "end."),
  lines("1. ```", "   x", "   ```", "", "```", "code", "", "foo", "```", "", "after."),
  lines("- a", "", "  ```", "  inside", "", "foo", "  ```", "", "bar."),
  lines("-", "", "- empty item above", "", "2024 was a year.", "", "1999", "", "* star", "", "**bold para**", "", "-not a list"),
  // fences: opened and never closed, other markers, longer runs, closers with extras, indented, in a quote
  lines("prose.", "", "```ts", "const open = 1;", "", "still code", "", "## not a heading"),
  lines("~~~", "tilde", "", "```", "not a close", "~~~", "", "````md", "```", "inner", "```", "````", "", "after."),
  lines("```", "a", "``` x", "still code", "```~~", "", "out?", "", "```\t", "", "and?"),
  lines("   ```", "indented three", "   ```", "", "    ```", "    indented four", "", "after."),
  lines("> ```", "> in a quote", "", "outside", "", "```", "late", "```"),
  lines("``` not `a` fence", "", "para."),
  // quotes, setext, rules, emphasis across a blank line, escapes, footnotes, tabs, carriage returns
  lines("> quoted", "lazy line", "", "> another quote", "", "plain."),
  lines("Title", "=====", "", "Sub", "---", "", "---", "", "***", "", "___", "", "after rules."),
  lines("*starts", "", "ends*", "", "**a", "", "b**", "", "\\*escaped\\* and &amp; &lt;tag&gt;."),
  lines("a note[^1] and another[^n].", "", "more.", "", "[^1]: the note", "[^n]: the other"),
  lines("tab\tinside.", "", "\tindented by a tab", "", "after."),
  "windows\r\nlines\r\n\r\nsecond\r\n",
  lines("#", "", "# heading", "", "####### seven", "", "## heading ##"),
  // a run too long to lay out, outside and inside a fence
  lines(`a ${"x".repeat(2500)} run.`, "", "```", "y".repeat(2600), "```", "", "after."),
];

/** a text of `bytes` or more: prose, fences and lists, long enough to be cut into pieces (big-text.ts) */
export function long(bytes: number): string {
  const out: string[] = [];
  for (let i = 0; out.join("\n").length < bytes; i++) {
    out.push(`## part ${i}`, "", `a paragraph of prose number ${i} with \`code\` and **bold** words, long enough to read like a real one.`, "");
    if (i % 3 === 0) out.push("```ts", `const a${i} = ${i};`, "", `const b${i} = a${i} * 2;`, "```", "");
    if (i % 4 === 1) out.push("- one", "- two", "", "- three", "");
    if (i % 5 === 2) out.push("| a | b |", "|---|---|", `| ${i} | ${i + 1} |`, "");
  }
  return out.join("\n");
}

export const SAMPLES: readonly string[] = [ANSWER_WITH_CODE, REPORT_WITH_CODE, REPLY_IN_A_FENCE, REPLY_IN_A_LIST, FENCES_OF_ALL_SHAPES, HOSTILE_MARKUP, GITHUB_READING];

/** every text part in a recorded session (the fixtures), once each */
export function textsOf(json: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o["type"] === "text" && typeof o["text"] === "string") found.add(o["text"]);
    for (const x of Object.values(o)) walk(x);
  };
  walk(json);
  return [...found];
}

/** a seeded generator, so a failing chunking can be run again */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the ends of the chunks a text streams in: from 1 to `most` characters each, the last at its end */
export function chunkEnds(text: string, random: () => number, most: number): number[] {
  const ends: number[] = [];
  for (let at = 0; at < text.length;) {
    at = Math.min(text.length, at + 1 + Math.floor(random() * most));
    ends.push(at);
  }
  return ends;
}
