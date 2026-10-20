/* a streaming reply painted in units (markdown-stream.ts) is the reply painted whole: every document is streamed in seeded random
   chunks, and after every chunk the units, joined, must be the html of the whole text so far. here the sanitiser is marked alone (the
   real one needs a dom; the said-streaming-equivalence story holds the painter to the same in the browser, sanitiser and all), so this
   proves where the cuts fall, how raw html and definitions keep a piece whole, and that what is made again is only what changed. */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { reaches, toHtml } from "./markdown-gfm";
import { type Made, Stream, cutsOf, whole } from "./markdown-stream";
import { EDGES, SAMPLES, chunkEnds, long, seeded, textsOf } from "./stories/stream-docs";

const fixtures = join(import.meta.dir, "fixtures");
const recorded = readdirSync(fixtures).filter((f) => f.endsWith(".json")).flatMap((f) => textsOf(JSON.parse(readFileSync(join(fixtures, f), "utf8"))));

let parsed = 0;
const sanitise = (md: string): Made => { parsed += md.length; return { html: toHtml(md), ...reaches() }; };

/** streams `doc` in chunks and returns the first prefix whose units are not the whole, or undefined */
function mismatch(doc: string, seed: number, most: number): { at: number; units: string; whole: string } | undefined {
  const stream = new Stream(sanitise);
  for (const at of chunkEnds(doc, seeded(seed), most)) {
    const md = doc.slice(0, at);
    const units = stream.units(md).join("");
    const want = whole(md, toHtml);
    if (units !== want) return { at, units, whole: want };
  }
  return undefined;
}

describe("the units of every prefix are the whole", () => {
  test("the edge cases, at many chunkings", () => {
    /* the one document of thousands of characters (the long run) streams in larger chunks: in chunks of a few characters it alone took seconds */
    for (const [i, doc] of EDGES.entries()) for (let seed = 1; seed <= 12; seed++) expect({ doc: i, seed, found: mismatch(doc, seed, doc.length > 2000 ? 120 + seed * 20 : 1 + (seed % 6)) }).toEqual({ doc: i, seed, found: undefined });
  });
  test("the code stories' answers", () => {
    for (const [i, doc] of SAMPLES.entries()) for (let seed = 1; seed <= 4; seed++) expect({ doc: i, seed, found: mismatch(doc, seed, 12) }).toEqual({ doc: i, seed, found: undefined });
  });
  test("every reply in the fixtures", () => {
    expect(recorded.length).toBeGreaterThan(100);
    for (const [i, doc] of recorded.entries()) expect({ doc: i, found: mismatch(doc, 7 + i, 40) }).toEqual({ doc: i, found: undefined });
  });
  test("texts long enough to be cut into pieces, and to show only their head and tail", () => {
    for (const bytes of [30 * 1024, 100 * 1024]) expect(mismatch(long(bytes), bytes, 1500)).toBeUndefined();
  });
});

describe("where a text is cut", () => {
  test("at a block after a blank line, never in a fence, a list or a quote", () => {
    const doc = "one.\n\n## two\n\n```\na\n\nb\n```\n\n- x\n\n- y\n\n> q\n\nthree.";
    expect(cutsOf(doc).map((at) => doc.slice(at, at + 5))).toEqual(["## tw", "```\na", "three"]);
  });
  test("nowhere in a piece with a footnote or a carriage return, and nowhere after a fence in a list", () => {
    expect(cutsOf("a[^1].\n\nb.\n\n[^1]: n")).toEqual([]);
    expect(cutsOf("a.\r\n\r\nb.")).toEqual([]);
    expect(cutsOf("a.\n\nb.\n\n- ```\n  x\n  ```\n\nc.\n\nd.").length).toBe(1);
  });
  test("raw html keeps the rest of the piece one unit, and a definition all of it", () => {
    const stream = new Stream(sanitise);
    expect(stream.units("a.\n\nb.\n\nc.")).toHaveLength(3);
    expect(stream.units("a.\n\nb <b>open\n\nc.\n\nd.")).toHaveLength(2);
    expect(stream.units("a [r].\n\nb.\n\n[r]: https://example.com")).toHaveLength(1);
  });
});

describe("a frame makes only what changed", () => {
  test("streaming a long reply word by word parses a small share of what painting it whole does", () => {
    const doc = recorded.reduce((a, b) => (b.length > a.length ? b : a));
    const stream = new Stream(sanitise);
    let wholeChars = 0;
    parsed = 0;
    for (let i = doc.indexOf(" ", 1); i > 0; i = doc.indexOf(" ", i + 1)) { stream.units(doc.slice(0, i)); wholeChars += i; }
    expect(parsed / wholeChars).toBeLessThan(0.3);
  });
  test("what it keeps is the last text's units, nothing older", () => {
    const stream = new Stream(sanitise);
    stream.units("a.\n\nb.\n\nc.");
    parsed = 0;
    stream.units("a.\n\nb.\n\nc. more");
    expect(parsed).toBe("c. more".length);
    stream.units("x.\n\ny.");
    parsed = 0;
    stream.units("a.\n\nb.\n\nc. more");
    expect(parsed).toBe("a.\n\nb.\n\nc. more".length);
  });
});
