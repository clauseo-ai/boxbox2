/* the composer's live line as inline markdown (docs/composer.md, the live line): the agent writes markdown, and its marks
   read as noise in one line of 13 px prose. strong is drawn strong, emphasis as emphasis, code in the mono face, a link
   as its words; no asterisk, underscore or backtick is shown. the line is a stream, so a mark that has opened and not yet
   closed is dropped, never drawn as a literal star that turns bold a moment later. block marks (a heading's hashes, a
   quote's bar, a list's bullet) go before the prose is cut to its last sentences. pure, so every case is tested. */

export type Run = { text: string; strong?: true; em?: true; code?: true };

/** a line's block marks gone: a heading's hashes, a quote's bar, a list's bullet or number, a fence */
export function withoutBlockMarks(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,3}[.)]\s+|```\S*\s*$)/, ""))
    .join("\n");
}

type Mark = "**" | "__" | "*" | "_" | "~~";
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** the runs of one line of prose: plain, strong, emphasised or code, the marks themselves gone */
export function inlineRuns(source: string): Run[] {
  // a link or an image reads as its words
  const text = source.replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s[^)]*)?\)/g, "$1");
  const runs: Run[] = [];
  const open = new Set<Mark>();
  let code = false;
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    const run: Run = { text: buffer };
    if (code) run.code = true;
    else {
      if (open.has("**") || open.has("__")) run.strong = true;
      if (open.has("*") || open.has("_")) run.em = true;
    }
    const last = runs.at(-1);
    if (last && last.strong === run.strong && last.em === run.em && last.code === run.code) last.text += run.text;
    else runs.push(run);
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "`") {
      // a code span opens only when it closes: the line is a stream, and a lone backtick is a mark still being written
      if (code || text.indexOf("`", i + 1) >= 0) {
        flush();
        code = !code;
      }
      i++;
      continue;
    }
    if (code) {
      buffer += ch;
      i++;
      continue;
    }
    const mark = (["**", "__", "~~", "*", "_"] as const).find((m) => text.startsWith(m, i));
    if (!mark) {
      buffer += ch;
      i++;
      continue;
    }
    const before = text[i - 1];
    const after = text[i + mark.length];
    // an underscore inside a word is the word's (snake_case), not a mark
    if (mark[0] === "_" && isWord(before) && isWord(after)) {
      buffer += mark;
      i += mark.length;
      continue;
    }
    if (open.has(mark)) {
      flush();
      open.delete(mark);
    } else if (after !== undefined && after !== " " && text.indexOf(mark, i + mark.length + 1) >= 0) {
      flush();
      open.add(mark);
    } else if (after === " " && (mark === "*" || mark === "_")) {
      // a star with a space after it is a star (2 * 3), not a mark
      buffer += mark;
    }
    // a mark with nothing to close it is a mark still being written: it is dropped
    i += mark.length;
  }
  flush();
  return runs;
}

/** the runs as plain words, for a screen reader and for comparing two lines */
export function plainOf(runs: readonly Run[]): string {
  return runs.map((r) => r.text).join("");
}
