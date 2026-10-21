/* a text of megabytes is painted in bounded time (big-text.ts): the whole of a long real part, the head and the tail of a huge one, and
   marked, which grows with the square of what it is given, only ever given pieces of about 16 KB */

import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import { CHUNK, HEAD, PLAIN_HEAD, PLAIN_TAIL, RUN_HEAD, RUN_MAX, TAIL, boundedPlain, boundedText, cutHtml, cutRuns, hasLongRun, NEWEST_STEP, newestOf, notShown, openLabel } from "./big-text";
import { chunksOf } from "./big-pieces";

const prose = "this is a paragraph of the agent's prose with `code` and **bold** words, long enough to read like a real one. ";
const paragraphs = (bytes: number): string => { let s = ""; let i = 0; while (s.length < bytes) s += `${prose.repeat(3)}${i++}\n\n`; return s; };
const fences = (n: number): string => Array.from({ length: n }, (_, i) => `text before ${i}\n\n\`\`\`ts\nconst a${i} = 1;\nconst b${i} = 2;\n\`\`\`\n\nand after ${i}\n\n`).join("");
const openFences = (s: string): number => (s.match(/^ {0,3}(```|~~~)/gm) ?? []).length;

describe("a long part is shown whole up to what the longest real ones reach", () => {
  test("64 KB and the 16 KB beside it are not touched", () => {
    const text = paragraphs(HEAD + TAIL).slice(0, HEAD + TAIL);
    expect(boundedText(text).hidden).toBe(0);
    expect(boundedText(text).shown).toBe(text);
  });
  test("a short text is its own piece", () => {
    expect(chunksOf("a short answer")).toEqual(["a short answer"]);
    expect(chunksOf(paragraphs(CHUNK))).toHaveLength(1);
  });
});

describe("a text past that shows its head and its tail", () => {
  const text = paragraphs(6 * 1024 * 1024);
  const { shown, hidden } = boundedText(text);
  test("is bounded however long the text, and says how much is not shown", () => {
    expect(shown.length).toBeLessThan(HEAD + TAIL + 200);
    expect(hidden).toBeGreaterThan(6 * 1024 * 1024 - HEAD - TAIL - 4096);
    expect(shown).toContain(`*${notShown(hidden)}*`);
  });
  test("keeps the start and the end of what was written", () => {
    expect(shown.startsWith(text.slice(0, 200))).toBe(true);
    expect(shown.endsWith(text.slice(-200))).toBe(true);
  });
  test("cuts at the end of a block, not inside a word", () => {
    const head = shown.slice(0, shown.indexOf("\n\n*"));
    expect(head.endsWith("\n\n") || /\d$/.test(head.trimEnd())).toBe(true);
  });
  test("a text with no breaks at all is cut at a word", () => {
    const flat = prose.repeat(60_000);
    const out = boundedText(flat);
    expect(out.shown.length).toBeLessThan(HEAD + TAIL + 200);
    expect(out.shown.slice(0, out.shown.indexOf("\n\n*")).endsWith(" ")).toBe(true);
  });
  test("a fenced block the cut falls in is closed in the head and opened again in the tail", () => {
    const code = `\`\`\`ts\n${"const x = 1;\n".repeat(20_000)}\`\`\`\n`;
    const out = boundedText(`intro\n\n${code}`);
    expect(openFences(out.shown) % 2).toBe(0);
    expect(out.shown.length).toBeLessThan(HEAD + TAIL + 200);
  });
});

describe("pieces for marked", () => {
  test("each aims at 16 KB and ends where a block ends", () => {
    const text = paragraphs(HEAD);
    const pieces = chunksOf(text);
    expect(pieces.length).toBeGreaterThanOrEqual(4);
    expect(pieces.join("")).toBe(text);
    for (const p of pieces) { expect(p.length).toBeLessThan(CHUNK * 2); expect(p.endsWith("\n\n")).toBe(true); }
  });
  test("a fence is never split between pieces without being closed and opened again", () => {
    const pieces = chunksOf(fences(2000));
    expect(pieces.length).toBeGreaterThan(3);
    for (const p of pieces) expect(openFences(p) % 2).toBe(0);
    expect(pieces.join("")).toBe(fences(2000));
  });
  test("one fence longer than a piece is cut at a line, closed and opened again", () => {
    const code = `\`\`\`ts\n${"const x = 1;\n".repeat(6000)}\`\`\`\n`;
    const pieces = chunksOf(code);
    expect(pieces.length).toBeGreaterThan(2);
    for (const p of pieces) { expect(openFences(p) % 2).toBe(0); expect(p.length).toBeLessThan(CHUNK * 2 + 20); }
    expect(pieces.every((p) => p.trimStart().startsWith("```ts"))).toBe(true);
  });
  test("one paragraph with no breaks is cut at words", () => {
    const pieces = chunksOf(prose.repeat(2000));
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.join("")).toBe(prose.repeat(2000));
    for (const p of pieces) expect(p.length).toBeLessThan(CHUNK * 2 + 200);
  });
});

describe("the time it takes", () => {
  test("a 6 MB part is parsed, in the pieces it is shown in, in a second", () => {
    const text = paragraphs(6 * 1024 * 1024);
    const t = performance.now();
    const html = chunksOf(boundedText(text).shown).map((p) => String(marked.parse(p, { async: false, gfm: true }))).join("");
    const ms = performance.now() - t;
    expect(html.length).toBeLessThan(400_000);
    expect(ms).toBeLessThan(2500);
  });
  test("a 6 MB part with code in it, and one that is a single paragraph, the same", () => {
    for (const text of [fences(60_000), prose.repeat(60_000), `${"- an item of a list of the agent's\n".repeat(200_000)}`]) {
      const t = performance.now();
      chunksOf(boundedText(text).shown).forEach((p) => marked.parse(p, { async: false, gfm: true }));
      expect(performance.now() - t).toBeLessThan(2500);
    }
  });
  test("the part is cut in time that grows with its length, not with its square", () => {
    const time = (mb: number) => { const text = paragraphs(mb * 1024 * 1024); const t = performance.now(); boundedText(text); return performance.now() - t; };
    time(1);
    expect(time(8)).toBeLessThan(500);
  });
});

describe("plain words that are long", () => {
  test("a prompt up to 40 KB is shown whole", () => {
    const text = "x ".repeat(PLAIN_HEAD / 2);
    expect(boundedPlain(text)).toEqual({ shown: text, hidden: 0 });
  });
  test("a 6 MB prompt is its head and its tail, with the words that say how much is between, not in markdown", () => {
    const text = paragraphs(6 * 1024 * 1024);
    const { shown, hidden } = boundedPlain(text);
    expect(shown.length).toBeLessThan(PLAIN_HEAD + PLAIN_TAIL + 200);
    expect(shown).toContain(`\n\n${notShown(hidden)}\n\n`);
    expect(shown).not.toContain(`*${notShown(hidden)}*`);
    expect(shown.endsWith(text.slice(-100))).toBe(true);
  });
  test("a box that follows the newest line of a long thought shows the last of it, from a word", () => {
    const text = prose.repeat(100_000);
    const newest = newestOf(text);
    expect(newest.length).toBeLessThanOrEqual(PLAIN_TAIL + NEWEST_STEP);
    expect(text.endsWith(newest)).toBe(true);
    expect(text[text.length - newest.length - 1]).toBe(" ");
    expect(newestOf("a short thought")).toBe("a short thought");
  });
  /* the box appends what carries on from what it shows and repaints whole what does not (thread.tsx, Streamed). a start that moved with
     every delta made nearly every frame past 16 KB a whole repaint of 8 KB, and the words there stopped fading in */
  test("a thought streamed past 16 KB carries on from what the box shows, all but a few times", () => {
    const words = prose.split(" ");
    let text = "";
    let shown = newestOf(text);
    let whole = 0;
    let appends = 0;
    for (let i = 0; text.length < 40_000; i++) {
      text += `${words[i % words.length]} `;
      const next = newestOf(text);
      if (next === shown) continue;
      if (next.startsWith(shown)) appends++;
      else whole++;
      shown = next;
      expect(text.endsWith(next)).toBe(true);
      if (text.length > PLAIN_TAIL * 2) expect(next.length).toBeGreaterThanOrEqual(PLAIN_TAIL - 200);
    }
    expect(appends).toBeGreaterThan(1000);
    expect(whole).toBeLessThan(50);
  });
});

describe("what opens a long prompt says what it opens", () => {
  test("all of it, when all of it is what opens", () => {
    expect(openLabel(1234)).toBe("show all 1,234 characters");
    expect(openLabel(PLAIN_HEAD + PLAIN_TAIL)).toBe(`show all ${notShown(PLAIN_HEAD + PLAIN_TAIL).replace(" characters not shown", "")} characters`);
  });
  test("the start and the end, past 40 KB, where what opens is cut", () => {
    expect(openLabel(PLAIN_HEAD + PLAIN_TAIL + 1)).toBe("show the start and the end of 40,961 characters");
    expect(boundedPlain("w ".repeat(30_000)).hidden).toBeGreaterThan(0);
  });
});

describe("a fence the cut falls in is closed as it was opened", () => {
  const html = (md: string): string => String(marked.parse(md, { async: false, gfm: true }));
  const log = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i} of the log, some words here`).join("\n");
  test("a ~~~ fence cut in the head is closed with ~~~, so the line that says what is not shown is not code", () => {
    const md = `intro\n\n~~~\n${log(6000)}\n~~~\n\nafter the log`;
    const out = html(boundedText(md).shown);
    expect(out).not.toMatch(/<code>[^<]*characters not shown/);
    expect(out).toContain("characters not shown");
    expect(out).toContain("after the log");
  });
  test("a ~~~ fence open where the tail starts is opened again with ~~~", () => {
    const md = `intro\n\n~~~\n${log(6000)}\n~~~\n\nafter`;
    const { shown } = boundedText(md);
    const tail = shown.slice(shown.indexOf("characters not shown"));
    expect(tail.split("\n").filter((l) => l.startsWith("```")).length).toBe(0);
  });
  test("a longer fence closes with its own length, and a ``` line inside a ~~~ fence is code, not a fence", () => {
    const md = `\`\`\`\`md\n${log(3000)}\n\`\`\`js\nlet a = 1;\n\`\`\`\n${log(3000)}\n\`\`\`\`\n\nafter`;
    const out = html(boundedText(md).shown);
    expect(out).not.toMatch(/<code[^>]*>[^<]*characters not shown/);
    const nested = `~~~\n${log(2000)}\n\`\`\`\n${log(2000)}\n~~~\n\nbetween\n\n${paragraphs(70_000)}`;
    for (const piece of chunksOf(nested)) expect((html(piece).match(/<pre>/g) ?? []).length).toBeLessThanOrEqual(1);
  });
  test("pieces of a text with a ~~~ fence longer than a piece are parsed as the whole is", () => {
    const md = `~~~\n${log(2500)}\n~~~\n\nafter ${paragraphs(2000)}`;
    const pieces = chunksOf(md, 4096);
    expect(pieces.length).toBeGreaterThan(2);
    const joined = pieces.map(html).join("");
    expect((joined.match(/<pre>/g) ?? []).length).toBe(pieces.filter((p) => p.includes("line ")).length);
    expect(joined).toContain("after");
    expect(joined.replace(/<pre>[\s\S]*?<\/pre>/g, "")).not.toContain("line 2400");
  });
});

describe("pieces keep what reaches across them", () => {
  const html = (md: string): string => String(marked.parse(md, { async: false, gfm: true }));
  const links = (h: string): number => (h.match(/<a /g) ?? []).length;
  test("a reference link finds its definition in whatever piece it is in", () => {
    const body = Array.from({ length: 900 }, (_, i) => `paragraph ${i} with some words in it, see [the spec][spec].`).join("\n\n");
    const md = `${body}\n\n[spec]: https://example.com/spec\n`;
    const pieces = chunksOf(md);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.map(html).reduce((n, h) => n + links(h), 0)).toBe(links(html(md)));
    expect(links(html(md))).toBe(900);
  });
  test("a definition above its use, with an angle-bracket url and a title, is shared too", () => {
    const body = Array.from({ length: 1500 }, (_, i) => `see [a${i}][a] and [b][B] and [c].`).join("\n\n");
    expect(chunksOf(`${body}`).length).toBeGreaterThan(1);
    const md = `[a]: <https://example.com/a> "title"\n[B]: https://example.com/b\n\n${body}\n\n[c]: /c\n`;
    expect(chunksOf(md).map(html).reduce((n, h) => n + links(h), 0)).toBe(links(html(md)));
  });
  test("a text with no definition has pieces that hold nothing but its own words", () => {
    const md = paragraphs(60_000);
    expect(chunksOf(md).join("")).toBe(md);
  });
  test("what is shared is bounded: a thousand definitions are not copied into every piece", () => {
    const defs = Array.from({ length: 5000 }, (_, i) => `[d${i}]: https://example.com/${"p".repeat(40)}/${i}`).join("\n");
    const md = `${paragraphs(60_000)}\n\n${defs}\n`;
    for (const piece of chunksOf(md)) expect(piece.length).toBeLessThan(CHUNK * 3);
  });
});

describe("a run too long to lay out is cut for display, and nothing else is touched", () => {
  const blob = "A".repeat(2500);
  const html = (md: string): string => String(marked.parse(md, { async: false, gfm: true }));
  /** what the painter does to the html of a text, as far as a test with no dom can say: the same thing */
  const shown = (md: string): string => cutHtml(html(md));

  test("a text with no run of 2,000 characters is returned as it is, with long words and urls in it", () => {
    const text = `a url https://example.com/${"a".repeat(1500)}/b?d=e and ${"m".repeat(RUN_MAX - 1)}\n\nand another`;
    expect(hasLongRun(text)).toBe(false);
    expect(cutRuns(text)).toBe(text);
    expect(cutHtml(html(text))).toBe(html(text));
  });
  test("a run is its head, then a marker that says how much is not shown, the way a command's long line is cut", () => {
    const out = cutRuns(`before ${blob} after`);
    expect(out).toBe(`before ${"A".repeat(RUN_HEAD)}… ${notShown(2500 - RUN_HEAD)} after`);
    expect(out.length).toBeLessThan(400);
  });
  test("a url elsewhere in the text keeps its words and its link", () => {
    const md = `see https://github.com/example-owner/example-repository/pull/12345 for the fix\n\n${blob}\n`;
    const out = shown(md);
    expect(out.startsWith(html(md.split("\n\n")[0] as string))).toBe(true);
    expect(out).toContain('href="https://github.com/example-owner/example-repository/pull/12345"');
    expect(out).toContain(notShown(2500 - RUN_HEAD));
    expect(out).not.toContain(blob);
  });
  test("a markdown link stays a link", () => {
    const out = shown(`[the pr](https://github.com/example-owner/example-repository/pull/12345)\n\n${blob}\n`);
    expect(out).toContain('<a href="https://github.com/example-owner/example-repository/pull/12345">the pr</a>');
  });
  test("a wide table stays a table", () => {
    const out = shown(`| name | value |\n|------------------------------|-------|\n| a | b |\n\n${blob}\n`);
    expect(out).toContain("<table>");
  });
  test("code in a fence, in a list, in a quote, indented or under a ~~~ is left as it is: the block is cut where it is dressed, from its own source", () => {
    const cases = [
      `1. run this:\n\n    \`\`\`bash\n    export TOKEN_FILE=/var/lib/service/credentials/production.json\n    \`\`\`\n\n${blob}\n`,
      `> \`\`\`json\n> {"path": "/var/lib/service/credentials/production.json"}\n> \`\`\`\n\n${blob}\n`,
      `text\n\n    const configurationLoaderInstance = createConfigurationLoader();\n\n${blob}\n`,
      `~~~\nconst configurationLoaderInstance = createConfigurationLoader();\n~~~\n\n${blob}\n`,
      `\`\`\`json\n{"key": "${blob}", "other": "short value here"}\n\`\`\`\n\n${blob}\n`,
    ];
    for (const md of cases) {
      const whole = html(md);
      const out = cutHtml(whole);
      const pres = (h: string) => [...h.matchAll(/<pre>[\s\S]*?<\/pre>/g)].map((m) => m[0]);
      expect(pres(out)).toEqual(pres(whole));
      expect(out).toContain(notShown(2500 - RUN_HEAD));
    }
  });
  test("a code block's own source is cut for display from the source, and the source is what is copied", () => {
    const source = `{"key": "${blob}", "other": "short value here"}`;
    const text = cutRuns(source);
    expect(text).toContain('"other": "short value here"');
    expect(text).toContain(notShown(2500 + 3 - RUN_HEAD));
    expect(text).not.toContain(blob);
    expect(source).toContain(blob);
  });
  test("a cut never lands inside an entity or between the halves of a pair", () => {
    const entity = `${"&amp;".repeat(60)}${"x".repeat(2500)}`;
    for (const out of [cutHtml(`<p>${entity}</p>`)]) expect(out).not.toMatch(/&[a-z]{0,3}…/);
    const emoji = "😀".repeat(1500);
    expect(cutRuns(emoji)).not.toMatch(/[\ud800-\udbff]…/);
  });
  test("a 6 MB single run is cut to a few hundred characters of a paragraph in bounded time", () => {
    const start = performance.now();
    const out = shown("x".repeat(6 * 1024 * 1024));
    expect(performance.now() - start).toBeLessThan(2000);
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain("characters not shown");
  });
  test("plain words are cut the same way, and the newest line of a thought too", () => {
    expect(boundedPlain("z".repeat(2_000_000)).shown.length).toBeLessThan(2000);
    expect(newestOf("z".repeat(2_000_000)).length).toBeLessThan(2000);
    expect(boundedPlain(`${"z".repeat(5000)} then some words`).shown).toContain("then some words");
  });
});
