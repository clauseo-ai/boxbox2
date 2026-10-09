/* highlight.js's core and the grammars boxbox registers (languages.ts is their table): a chunk of its own, about 30 kb compressed, that the
   first-load script does not carry (the script budget is 120 kb and the app was 118). highlight.ts loads it when a thread first shows a fence, and
   when the app is idle, so it has usually arrived by then. no auto-detection: a wrong guess is worse than plain text, and a guess costs a
   pass over every grammar. */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { GrammarKey } from "./languages";
import { Lru } from "./lru";

export { Lru };

/* jsx and tsx ride the javascript and typescript grammars (hljs lists them as aliases); html rides xml's. the keys are the table's, so a grammar added here without a row there does not compile */
const REGISTERED: Record<GrammarKey, Parameters<typeof hljs.registerLanguage>[1]> = { bash, c, cpp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, plaintext, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(REGISTERED)) hljs.registerLanguage(name, grammar);

/** code over this many characters is shown plain: a pass over a long paste holds the frame (about 20 ms for 10,000 characters of typescript in bun, more on the ipad, the budget's slowest device) */
export const HIGHLIGHT_MAX_CODE = 12_000;
/** the block a reply is still writing is painted again on every frame, so it is held to a fifth of that: past it the block is plain until the reply settles */
export const HIGHLIGHT_STREAM_MAX = 2_500;
/** what the cache may hold, in bytes (a js string is up to two a character, the key counts too). a thread's worth of code blocks is well under this, and it is a small share of the 150 mb heap budget (design.md, buttery) */
export const HIGHLIGHT_CACHE_BYTES = 2 * 1024 * 1024;

const painted = new Lru(HIGHLIGHT_CACHE_BYTES);

/** `code` as html for the grammar, or undefined when it is to be shown plain (too long, or the grammar failed on it). hljs escapes the code, so the html is safe to set; it is cached by grammar and code, unless `open`: the block a reply is still writing */
export function highlight(grammar: string, code: string, open: boolean, cache: Lru = painted): string | undefined {
  if (code.length > (open ? HIGHLIGHT_STREAM_MAX : HIGHLIGHT_MAX_CODE)) return undefined;
  const key = `${grammar}\u0000${code}`;
  const held = cache.get(key);
  if (held !== undefined) return held;
  try {
    const out = hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value;
    /* a block still being written is a different text on every frame: kept, its partials would push the settled blocks' entries out */
    if (!open) cache.set(key, out);
    return out;
  } catch {
    return undefined;
  }
}

/** the registry as hljs holds it, for the test that holds languages.ts to it */
export function registry(): Array<{ key: string; name: string; aliases: readonly string[] }> {
  return hljs.listLanguages().map((key) => ({ key, name: hljs.getLanguage(key)?.name ?? "", aliases: hljs.getLanguage(key)?.aliases ?? [] }));
}
