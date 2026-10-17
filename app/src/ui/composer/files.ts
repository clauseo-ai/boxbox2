/* files that are not photos (docs/composer.md, attachments: any file): which ones the composer takes and as what kind, how
   large each may be, how a tile names one, and the words for one it does not take. cmx2 reads a pdf (whole, for a model
   that reads documents, and as its text for the rest), and puts any text or json file into the message whole; the server
   holds each to the same numbers (server/src/http/compose.rs, `document`). pure: the reading is `read-file.ts`, a chunk of
   its own loaded at the first file. */

export { isPhotoKind } from "../../sync/outbox";

/** one pdf, at most, as the person sees it in their files (MAX_PDF_FILE): under the 20 mb cmx2 hands a model whole */
export const MAX_PDF_FILE = 9 * 1024 * 1024;
/** one text or json file, at most (MAX_TEXT_FILE): cmx2 puts all of it in the message, so this keeps one file from filling
    the model's context (about 130,000 tokens) */
export const MAX_TEXT_FILE = 512 * 1024;

/** kinds by extension, which win over the browser's: a mac names a markdown file `text/markdown` and another system names it
    nothing, and a browser calls a `.ts` file `video/mp2t`. code and config read as plain text */
const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  xml: "text/xml",
  css: "text/css",
};
const PLAIN = [
  "txt", "text", "log", "yaml", "yml", "toml", "ini", "conf", "cfg", "sql", "graphql", "diff", "patch", "rst", "tex",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp",
  "hpp", "cs", "php", "lua", "sh", "bash", "zsh", "fish", "vue", "svelte", "scss", "less", "zig", "ex", "exs", "erl", "hs",
  "ml", "scala", "dart", "r", "pl", "proto", "dockerfile", "makefile", "gitignore", "editorconfig",
];
for (const ext of PLAIN) BY_EXTENSION[ext] = "text/plain";

/** a kind the server takes as a file: a pdf, json, or `text/` with a plain subtype (no parameters) */
const TAKEN = /^(application\/pdf|application\/json|text\/[a-z0-9.+-]+)$/;

/** what the plus menu's file picker offers */
export const FILE_ACCEPT = ["application/pdf", "application/json", "text/*", ...Object.keys(BY_EXTENSION).map((ext) => `.${ext}`)].join(",");

/** a file's extension, lowercased, without its dot; a name with none (`Makefile`) is its own */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(dot + 1) : dot === 0 ? name.slice(1) : name).toLowerCase();
}

/** a `.env` or `.env.local` holds secrets: it is never sent by a stray drop, whatever kind the browser gives it */
const SECRETS = /^\.env(\..*)?$/i;

/** the kind a file goes as, or null when it is not one the agent takes as a file (an image is a photo, not a file) */
export function fileKind(file: { type: string; name: string }): string | null {
  if (SECRETS.test(baseName(file.name))) return null;
  const known = BY_EXTENSION[extensionOf(file.name)];
  if (known) return known;
  const type = file.type.toLowerCase();
  return TAKEN.test(type) ? type : null;
}

/** a file's name after its last slash or backslash, which is all of it a browser gives and all of it the server keeps */
export const baseName = (name: string): string => name.split(/[/\\]/).pop()?.trim() ?? "";

/** a file's name, at most, in characters (server/src/http/compose.rs, MAX_FILENAME) */
export const MAX_FILENAME = 255;

/** the characters a file's name cannot hold, as the server refuses them: a quote and angle brackets would break the label cmx2
    gives the file (`<file path="...">`), and a control or format character (a bidi override, a zero-width space) would hide
    what it says */
const UNSAFE_IN_NAME = /["<>\p{Cc}\p{Cf}]/u;

/** the name a file goes by, or why it cannot go by it: words for the person, before a byte is read */
export function fileName(name: string): { ok: true; name: string } | { ok: false; reason: string } {
  const base = baseName(name);
  const length = [...base].length;
  if (length === 0 || base === "." || base === "..") return { ok: false, reason: "a file with no name cannot go. rename it and add it again." };
  if (length > MAX_FILENAME) return { ok: false, reason: `${cutMiddle(base)} has a name of ${length} characters. rename it to ${MAX_FILENAME} or fewer and add it again.` };
  const bad = UNSAFE_IN_NAME.exec(base)?.[0];
  if (bad) return { ok: false, reason: `${cutMiddle(base.replace(/[\p{Cc}\p{Cf}]/gu, ""))} has ${bad === '"' ? "a quote" : bad === "<" || bad === ">" ? "an angle bracket" : "a hidden direction or control mark"} in its name. rename it and add it again.` };
  return { ok: true, name: base };
}

/** a size as the person reads it: kb under a megabyte, else mb with a decimal when it is not whole, rounded up so a refusal
    never says a size that fits */
export function sizeOf(bytes: number): string {
  const MIB = 1024 * 1024;
  if (bytes < MIB) return `${Math.max(1, Math.ceil(bytes / 1024))} kb`;
  const tenths = Math.ceil((bytes * 10) / MIB);
  return `${tenths % 10 === 0 ? tenths / 10 : `${Math.floor(tenths / 10)}.${tenths % 10}`} mb`;
}

/** why a file of this kind and size cannot go, in the agent's own numbers; null when it can */
export function tooLarge(agent: string, name: string, mime: string, bytes: number): string | null {
  const pdf = mime === "application/pdf";
  const most = pdf ? MAX_PDF_FILE : MAX_TEXT_FILE;
  if (bytes <= most) return null;
  return `${name} is ${sizeOf(bytes)}. ${agent} takes ${pdf ? "pdfs" : "text files"} up to ${sizeOf(most)}.`;
}

/** what is said of a dropped or pasted file the agent does not take: it is mentioned by its name instead (the host's file
    list finds it when it is in the repo), and the words say so */
export function notTaken(agent: string, name: string): string {
  const ext = name.includes(".") ? extensionOf(name) : "";
  return ext ? `${agent} does not take .${ext} files, so ${name} is mentioned by its name instead.` : `${agent} does not take ${name}, so it is mentioned by its name instead.`;
}

/** what is said of the first photo or file past the count one message carries */
export function noRoomLeft(agent: string, most: number, name: string): string {
  return `${agent} takes ${most} photos and files on a message. ${name} did not fit.`;
}

/** a name cut in its middle so its start and its extension both show: "bookin…al.pdf". 13 is what fits a tile when two share
    a phone's row */
export function cutMiddle(name: string, most = 13): string {
  const chars = [...name];
  if (chars.length <= most) return name;
  // the end keeps the whole extension and a little before it, so "final.pdf" reads as "al.pdf" and not as "l.pdf"
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? [...name.slice(dot)].length : 0;
  const tail = Math.min(most - 3, Math.max(Math.ceil((most - 1) * 0.4), ext + 2));
  // a cut that lands after a space keeps no space before the mark
  return `${chars.slice(0, most - 1 - tail).join("").trimEnd()}…${chars.slice(-tail).join("")}`;
}

/** the word on a file's type tile: its extension when that is short, else what its kind is */
export function typeWord(name: string, mime: string): string {
  const ext = name.includes(".") ? extensionOf(name) : "";
  if (ext && ext.length <= 4) return ext;
  return mime === "application/pdf" ? "pdf" : mime === "application/json" ? "json" : "text";
}
