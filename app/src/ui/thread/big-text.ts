/* words too long to paint (docs/thread.md, code and copying: a long part). marked takes time that grows with the square of the text it is
   given (measured: 16 KB 30 ms, 64 KB 300 ms to 1.2 s, 256 KB 5 s, 1 MB over a minute), and a text of megabytes also makes millions of
   nodes. so what is painted is bounded two ways: a text is parsed in pieces of about 16 KB cut where a block ends (linear in its size, and
   a part of the 64 KB the longest real ones reach is shown whole), and a text past 80 KB shows its head and its tail with a line between
   that says how much is not shown, the way a long command's output does. what is not shown is still the store's, and every copy control
   copies the whole of it. pure; no dom. */

/** a text this long or shorter is shown whole */
export const HEAD = 64 * 1024;
export const TAIL = 16 * 1024;
/** the size a piece parsed at once aims at */
export const CHUNK = 16 * 1024;

const numbers = new Intl.NumberFormat("en-US");

/** the line the middle of a long text is replaced by */
export const notShown = (hidden: number): string => `${numbers.format(hidden)} characters not shown`;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** the fence open after a line, given the one open before it ("" for none): a fence is its marker, and closes only at a line of the same
    character, at least as long, with nothing after it. a line of the other kind inside one is its code */
export function fenceAfter(line: string, open: string): string {
  const m = FENCE.exec(line.replace(/\r?\n$/, ""));
  if (!m) return open;
  const marker = m[1] as string;
  const rest = m[2] as string;
  if (open === "") return marker[0] === "`" && rest.includes("`") ? "" : marker;
  return marker[0] === open[0] && marker.length >= open.length && rest.trim() === "" ? "" : open;
}

/** the fence open at `end` (its marker), reading the lines from `from`, where `open` is open already; "" when none is */
export function fenceAt(text: string, end: number, from = 0, open = ""): string {
  let pos = from;
  while (pos < end) {
    const lineEnd = text.indexOf("\n", pos);
    const stop = lineEnd < 0 || lineEnd > end ? end : lineEnd;
    open = fenceAfter(text.slice(pos, Math.min(stop, pos + 200)), open);
    if (lineEnd < 0) break;
    pos = lineEnd + 1;
  }
  return open;
}

/** the last place at or before `limit` a block ends (a blank line), else a line, else a word, but not before `floor`; `limit` itself when the text has none */
export function breakBefore(text: string, limit: number, floor: number): number {
  const blank = text.lastIndexOf("\n\n", limit);
  if (blank >= floor) return blank + 2;
  const line = text.lastIndexOf("\n", limit);
  if (line >= floor) return line + 1;
  const word = text.lastIndexOf(" ", limit);
  return word >= floor ? word + 1 : limit;
}

/** the first place at or after `from` a block ends, else a line, else a word, within `span` px of it; `from` itself when there is none */
function breakAfter(text: string, from: number, span: number): number {
  const blank = text.indexOf("\n\n", from);
  if (blank >= 0 && blank - from <= span) return blank + 2;
  const line = text.indexOf("\n", from);
  if (line >= 0 && line - from <= span) return line + 1;
  const word = text.indexOf(" ", from);
  return word >= 0 && word - from <= span ? word + 1 : from;
}

/** a text as it is painted: the whole of it when it is not long, else its head (to 64 KB, cut where a block ends) and its tail (the last
    16 KB, from where a block starts), with the number of characters between them said in a line of its own. a fenced block the cut falls in
    is closed at the end of the head, and opened again at the start of the tail, so the markdown stays what it was */
export function boundedText(text: string): { shown: string; hidden: number } {
  if (text.length <= HEAD + TAIL) return { shown: text, hidden: 0 };
  const headEnd = breakBefore(text, HEAD, HEAD / 2);
  const tailStart = breakAfter(text, text.length - TAIL, TAIL / 2);
  let head = text.slice(0, headEnd);
  let tail = text.slice(tailStart);
  const hidden = tailStart - headEnd;
  // a block open where the head ends is closed there, as it was opened; the tail starts inside one when one is open before it
  const headOpen = fenceAt(text, headEnd);
  if (headOpen) head = `${head.replace(/\n*$/, "")}\n${headOpen}\n`;
  const tailOpen = fenceAt(text, tailStart);
  if (tailOpen) tail = `${tailOpen}\n${tail}`;
  return { shown: `${head}\n\n*${notShown(hidden)}*\n\n${tail}`, hidden };
}

/** plain words as they are painted when they are long (a prompt, a thought, the end of a thought still being written): the head and the
    tail, each cut at a line or a word, with the number of characters between them said on a line of its own. nothing is read as markdown, so
    the line is plain words too */
export const PLAIN_HEAD = 32 * 1024;
export const PLAIN_TAIL = 8 * 1024;
export function boundedPlain(text: string): { shown: string; hidden: number } {
  if (text.length <= PLAIN_HEAD + PLAIN_TAIL) return { shown: cutRuns(text), hidden: 0 };
  const headEnd = breakBefore(text, PLAIN_HEAD, PLAIN_HEAD / 2);
  const tailStart = breakAfter(text, text.length - PLAIN_TAIL, PLAIN_TAIL / 2);
  const hidden = tailStart - headEnd;
  return { shown: cutRuns(`${text.slice(0, headEnd)}\n\n${notShown(hidden)}\n\n${text.slice(tailStart)}`), hidden };
}

/** what the control that opens a long prompt says: it promises all of it only when all of it is what opens (past this, what opens is
    `boundedPlain`, its start and its end) */
export const openLabel = (length: number): string => (length <= PLAIN_HEAD + PLAIN_TAIL ? `show all ${numbers.format(length)} characters` : `show the start and the end of ${numbers.format(length)} characters`);

/** the last `PLAIN_TAIL` characters of a text that is long, from a word: a box that follows the newest line of what is being written
    shows nothing else */
export function newestOf(text: string): string {
  if (text.length <= PLAIN_TAIL * 2) return cutRuns(text);
  const start = text.length - PLAIN_TAIL;
  const word = text.indexOf(" ", start);
  return cutRuns(text.slice(word >= 0 && word - start < 200 ? word + 1 : start));
}

/** a run of characters with no whitespace this long (a minified file, a base64 blob) cannot be laid out: the browser has nowhere to break it
    but between characters and shapes it a character at a time, over five seconds for 70 KB in the app's own font (a space every 24
    characters is two milliseconds; a zero-width space, 3.6 s). so what is painted of one is its head and a marker that says how much is
    not shown, as a command's long line is cut (evidence.ts). nothing is put into the text: it is cut for display only, and every copy
    control copies the source (markdown.ts, a code block's own; the store's text for the rest) */
export const RUN_MAX = 2000;
export const RUN_HEAD = 200;

const isSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff;

/** whether a text holds a run that long. by a count of characters, not a pattern: `\S{2000}` tries every start of a text of runs of 1,999 */
export function hasLongRun(text: string): boolean {
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (isSpace(text.charCodeAt(i))) run = 0;
    else if (++run >= RUN_MAX) return true;
  }
  return false;
}

/** the head of a run, ended where it does not split a pair of a character or an entity of html */
function headOf(run: string, html: boolean): string {
  let end = RUN_HEAD;
  const last = run.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  if (html) {
    const amp = run.lastIndexOf("&", end - 1);
    if (amp >= end - 10 && amp >= 0 && run.indexOf(";", amp) >= end) end = amp;
  }
  return run.slice(0, end);
}

function cut(text: string, html: boolean): string {
  let out = "";
  let from = 0;
  let run = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !isSpace(text.charCodeAt(i))) { run++; continue; }
    if (run >= RUN_MAX) {
      const start = i - run;
      out += `${text.slice(from, start)}${headOf(text.slice(start, start + RUN_HEAD + 8), html)}… ${notShown(run - RUN_HEAD)}`;
      from = i;
    }
    run = 0;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** a text with every run that long cut (see RUN_MAX); a text with none is returned as it is */
export const cutRuns = (text: string): string => (hasLongRun(text) ? cut(text, false) : text);

/** the html of a text, with the runs in its words cut. its tags are not read as words, and neither is what a `pre` holds: a code block is cut
    where it is dressed, from its own source, which is what its control copies (markdown.ts) */
export function cutHtml(html: string): string {
  if (!hasLongRun(html)) return html;
  let out = "";
  let pre = 0;
  for (const piece of html.split(/(<[^>]*>)/)) {
    if (piece.startsWith("<")) {
      if (/^<pre[\s>]/i.test(piece)) pre++;
      else if (/^<\/pre>/i.test(piece)) pre = Math.max(0, pre - 1);
      out += piece;
    } else out += pre === 0 && hasLongRun(piece) ? cut(piece, true) : piece;
  }
  return out;
}
