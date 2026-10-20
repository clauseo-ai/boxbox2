/* a reply's markdown painted while it streams (docs/thread.md, code and copying: a streaming reply), in time that follows what changed,
   not what was written. painting the whole text on every frame costs marked, the sanitiser and a parse of the html for every character
   so far, so a long reply cost the square of its length. here the text is cut into units at the starts of blocks that nothing written
   after them can change, each unit is parsed and sanitised alone, and a unit already made is not made again: a frame parses only the
   unit being written. the html of the units, joined, is the html of the whole (`whole`), which the equivalence test holds for every
   prefix of every test document (markdown-stream.test.ts, and the painter's own in the browser, the said-streaming-equivalence story).

   where a cut is safe: at the start of a line after a blank line, outside a fence, that starts a block nothing before it can absorb or
   change. the cuts are refused for a whole piece that holds a footnote (`[^`, numbered across the text) or a carriage return, and from
   the first fence that is not at the start of a line (one in a list or a quote, whose end only marked knows). what marked itself reads
   says the rest (markdown-gfm.ts, `reaches`): a link definition is read by references anywhere in the piece, so a piece that holds one
   is one unit; raw html could leave a tag open that the units after it would sit in, so from a unit that holds any the piece is one
   unit. pure; no dom. */

import { chunksOf } from "./big-pieces";
import { CHUNK, boundedText, cutHtml } from "./big-text";

/** a unit's sanitised html, and whether its markdown held raw html or a link definition */
export type Made = { html: string; raw: boolean; defs: boolean };
export type Sanitiser = (md: string) => Made;

/** the html of a whole text as it is painted: its head and tail when it is huge, in pieces (big-text.ts), each sanitised */
export const whole = (md: string, sanitise: (md: string) => string): string => cutHtml(chunksOf(boundedText(md).shown, CHUNK).map(sanitise).join(""));

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
/** a fence marker anywhere but the start of a line: in a list item, a quote, or indented */
const FENCE_ELSEWHERE = /^[ \t>*+\-\d.)]+(?:`{3}|~{3})/;
const BLANK = /^[ \t]*$/;

/** whether a line closes a fence opened with `marker`, as marked reads it: up to three spaces, the marker, more of either fence character, spaces */
function closes(line: string, marker: string): boolean {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  if (!line.startsWith(marker, i)) return false;
  return /^[~`]* *$/.test(line.slice(i + marker.length));
}

/** a line may start a unit when it cannot continue what came before it: not indented (indented code, a list item's lines), not a list
    item (a list carries on, and turns loose, across a blank line), not a quote, a table's pipe or a tag */
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const startsUnit = (line: string): boolean => {
  const c = line.charCodeAt(0);
  return !(c === 32 || c === 9 || c === 62 || c === 124 || c === 60 || LIST_ITEM.test(line));
};

/** where a piece may be cut into units: the offsets of the lines that start one, in order, none at 0 */
export function cutsOf(piece: string): number[] {
  if (piece.includes("[^") || piece.includes("\r")) return [];
  const cuts: number[] = [];
  let fence = "";
  let blank = false;
  let pos = 0;
  while (pos < piece.length) {
    const end = piece.indexOf("\n", pos);
    const stop = end < 0 ? piece.length : end;
    const line = piece.slice(pos, stop);
    if (fence) {
      if (closes(line, fence)) fence = "";
    } else if (BLANK.test(line)) {
      blank = true;
    } else {
      if (blank && pos > 0 && startsUnit(line)) cuts.push(pos);
      blank = false;
      const open = FENCE_OPEN.exec(line);
      if (open) {
        const marker = open[1] as string;
        // a run of backticks with a backtick after it is code in a line, not a fence
        if (!(marker[0] === "`" && (open[2] as string).includes("`"))) fence = marker;
      } else if (FENCE_ELSEWHERE.test(line)) return cuts;
    }
    if (end < 0) break;
    pos = end + 1;
  }
  return cuts;
}

/** one surface's streaming text: its units as html. what it keeps is the units of the last text it was given, keyed by their markdown,
    so it holds about one copy of that text's html and lets the rest go on each call */
export class Stream {
  private made = new Map<string, Made>();
  constructor(private readonly sanitise: Sanitiser) {}

  /** the html of `md` in units: joined, it is `whole(md)` */
  units(md: string): string[] {
    const made = new Map<string, Made>();
    const make = (text: string): Made => {
      let unit = made.get(text) ?? this.made.get(text);
      if (unit === undefined) {
        const out = this.sanitise(text);
        unit = { ...out, html: cutHtml(out.html) };
      }
      made.set(text, unit);
      return unit;
    };
    const out: string[] = [];
    for (const piece of chunksOf(boundedText(md).shown, CHUNK)) {
      const cuts = cutsOf(piece);
      const units: Made[] = [];
      let from = 0;
      for (const cut of cuts) {
        const unit = make(piece.slice(from, cut));
        if (unit.raw || unit.defs) break;
        units.push(unit);
        from = cut;
      }
      const rest = make(from === 0 ? piece : piece.slice(from));
      // a definition in the last unit is read by references in the ones before it
      if (rest.defs && from > 0) out.push(make(piece).html);
      else out.push(...units.map((u) => u.html), rest.html);
    }
    this.made = made;
    return out;
  }
}
