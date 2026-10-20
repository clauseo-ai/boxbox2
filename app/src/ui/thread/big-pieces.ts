/* a text cut into pieces of about 16 KB for marked (big-text.ts says why): only the engine's chunk paints whole texts and streaming
   replies (markdown-engine.ts, markdown-stream.ts), so this lives apart from the bounds the first load needs. pure; no dom. */

import { CHUNK, breakBefore, fenceAfter, fenceAt } from "./big-text";

/** a text in pieces of about `size`, each cut where a block ends outside a fenced block, so the pieces parse the way the whole would, and
    each in time that does not grow with the text: the text itself when it is hardly longer than a piece. a piece that cannot be cut at a
    block (one fence or one paragraph longer than twice the size) is cut at a line, or a word, and a fence the cut falls in is closed at its
    end and opened again at the start of the next */
export function chunksOf(text: string, size = CHUNK): string[] {
  const parts = piecesOf(text, size);
  if (parts.length < 2) return parts;
  /* a reference link names a definition that may be in another piece: the definitions of the whole text are given to each, which says nothing
     on its own page (marked draws none). what is given is bounded */
  const defs = definitionsOf(text);
  return defs ? parts.map((part) => `${part}\n\n${defs}\n`) : parts;
}

const DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*\S.*$/gm;
const DEFINITIONS_MAX = 8 * 1024;
function definitionsOf(text: string): string {
  const found: string[] = [];
  let bytes = 0;
  for (const m of text.matchAll(DEFINITION)) {
    bytes += m[0].length + 1;
    if (bytes > DEFINITIONS_MAX) break;
    found.push(m[0]);
  }
  return found.join("\n");
}

function piecesOf(text: string, size: number): string[] {
  if (text.length <= size * 1.5) return [text];
  const out: string[] = [];
  let from = 0;
  let reopen = "";
  while (text.length - from > size * 1.5) {
    let pos = from;
    let open = fenceOf(reopen);
    let fenceLine = reopen.replace(/\n$/, "");
    let cut = -1;
    let forced = -1;
    while (pos < text.length) {
      const lineEnd = text.indexOf("\n", pos);
      const next = lineEnd < 0 ? text.length : lineEnd + 1;
      const line = text.slice(pos, Math.min(next, pos + 200));
      const was = open;
      open = fenceAfter(line, open);
      if (open !== was) { if (open) fenceLine = line.replace(/\n$/, "").trimEnd(); }
      else if (!open && line.trim() === "") cut = next;
      if (cut > from && cut - from >= size) break;
      if (next - from >= size * 2) {
        // nothing ended a block in twice the size: cut at the line, or inside a line longer than that
        forced = next - pos > size * 2 ? breakBefore(text, pos + size, pos) : pos > from ? pos : next;
        break;
      }
      pos = next;
      if (lineEnd < 0) break;
    }
    if (forced > from && !(cut > from && cut - from >= size)) {
      const stillOpen = fenceAt(text, forced, from, fenceOf(reopen));
      out.push(`${reopen}${text.slice(from, forced)}${stillOpen ? `\n${stillOpen}\n` : ""}`);
      reopen = stillOpen ? `${fenceLine}\n` : "";
      from = forced;
    } else if (cut > from) {
      out.push(`${reopen}${text.slice(from, cut)}`);
      reopen = "";
      from = cut;
    } else break;
  }
  if (from < text.length) out.push(`${reopen}${text.slice(from)}`);
  return out;
}

/** the marker of the fence a line opens ("" when it is not a fence line) */
const fenceOf = (line: string): string => (line === "" ? "" : fenceAfter(line, ""));
