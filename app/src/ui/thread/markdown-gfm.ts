/* the markdown the agent writes, read as github reads it (docs/thread.md, code and copying: the engine) where marked does not: a single
   tilde is a tilde (`~/.agents/x` stays as written; `~~struck~~` strikes), and footnotes (`[^1]` and its `[^1]: words`) are numbered
   superscripts with the notes in a block at the end. pure: marked and strings, no dom, so it is tested without a browser; the
   sanitiser runs over what this makes (markdown-engine.ts). */

import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";

/* ---------- the html an agent may write ---------- */

/** the html an agent may write and see painted (decision 17, widened 2026-10-16 to what the native client paints and more that is safe):
    text structure, emphasis, code, lists, tables, quotes, details, links. any other tag is dropped and its words kept; the ones that run
    or embed something, or take input, are dropped with what they hold. an image is never loaded: it is shown as its words (its alt) */
export const ALLOWED_TAGS: readonly string[] = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "kbd", "samp", "var",
  "b", "strong", "i", "em", "u", "ins", "s", "del", "strike", "mark", "small", "sub", "sup", "abbr", "cite", "q", "dfn", "time",
  "ul", "ol", "li", "dl", "dt", "dd", "details", "summary", "a", "span", "div", "footer",
  "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col",
];
/** links go to the web or to mail, nowhere else (no javascript:, no data:, no relative path the app would read as its own) */
export const ALLOWED_URI = /^(?:https?:|mailto:)/i;

/* ---------- footnotes ---------- */

export type Footnotes = { /** the text with its definitions taken out */ body: string; /** each referenced note in the order its first reference comes, numbered from 1 */ notes: Array<{ label: string; text: string }>; number: ReadonlyMap<string, number> };

const DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** a text's footnotes: definitions (outside fences, with their indented lines after them) taken out, and numbered by where they are
    first referenced. a definition nothing refers to is dropped, as github drops it; a reference with no definition stays as written */
export function footnotes(md: string): Footnotes {
  if (!md.includes("[^")) return { body: md, notes: [], number: new Map() };
  const lines = md.split("\n");
  const kept: string[] = [];
  const defs = new Map<string, string>();
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const f = FENCE.exec(line);
    if (f) { const mark = (f[1] as string)[0] as string; if (fence === null) fence = mark; else if (fence === mark) fence = null; }
    const d = fence === null ? DEF.exec(line) : null;
    if (!d) { kept.push(line); continue; }
    const label = (d[1] as string).toLowerCase();
    const text = [d[2] as string];
    while (i + 1 < lines.length && /^( {4}|\t)\S/.test(lines[i + 1] as string)) text.push((lines[++i] as string).trim());
    if (!defs.has(label)) defs.set(label, text.join(" ").trim());
  }
  const body = kept.join("\n");
  const number = new Map<string, number>();
  const notes: Footnotes["notes"] = [];
  for (const m of body.matchAll(/\[\^([^\]\s]+)\]/g)) {
    const label = (m[1] as string).toLowerCase();
    const text = defs.get(label);
    if (text === undefined || number.has(label)) continue;
    number.set(label, notes.length + 1);
    notes.push({ label, text });
  }
  return { body, notes, number };
}

/* ---------- marked, read as github ---------- */

/** the footnotes of the text being read: set for one synchronous parse and cleared after it */
let reading: ReadonlyMap<string, number> = new Map();

const footnoteRef: TokenizerAndRendererExtension = {
  name: "footnoteRef",
  level: "inline",
  start: (src) => { const at = src.indexOf("[^"); return at < 0 ? undefined : at; },
  tokenizer(src) {
    const m = /^\[\^([^\]\s]+)\]/.exec(src);
    const n = m ? reading.get((m[1] as string).toLowerCase()) : undefined;
    return m && n !== undefined ? { type: "footnoteRef", raw: m[0], n } : undefined;
  },
  renderer: (token) => `<sup>${String((token as Tokens.Generic)["n"])}</sup>`,
};

/** one marked of our own: gfm, a strikethrough only between two tildes each side, and footnote references */
export const gfm = new Marked({ gfm: true, async: false });
gfm.use({
  extensions: [footnoteRef],
  tokenizer: {
    del(src) {
      const m = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?!~)/.exec(src);
      if (!m) return undefined;
      return { type: "del", raw: m[0], text: m[1] as string, tokens: this.lexer.inlineTokens(m[1] as string) };
    },
  },
});

/** the agent's markdown as html, before the sanitiser: github's reading, its footnotes in a block at the end (a footer, which nothing
    else in a reply is drawn as, so the stylesheet can tell it) */
export function toHtml(md: string): string {
  const notes = footnotes(md);
  reading = notes.number;
  try {
    const html = String(gfm.parse(notes.body));
    if (!notes.notes.length) return html;
    return `${html}<footer><ol>${notes.notes.map((note) => `<li>${String(gfm.parseInline(note.text))}</li>`).join("")}</ol></footer>`;
  } finally {
    reading = new Map();
  }
}
