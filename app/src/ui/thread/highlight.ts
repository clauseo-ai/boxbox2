/* syntax highlighting for fenced code in the agent's markdown (docs/thread.md, code blocks). the grammars are highlight.js's, in a chunk of their
   own (highlight-engine.ts) that is fetched when a thread first shows a fence, and when the app is idle, so the first-load script stays inside its
   script budget. until it has arrived a fence is plain, and the surfaces paint again the moment it does. an unlabelled or unknown fence is plain
   always. the colours are not here: hljs writes classes, and thread.css maps each to a token that reads the appearance (one place, no theme css
   from the package). no dom. */

export { type Language, infoWord, languageOf } from "./languages";

type Engine = typeof import("./highlight-engine");

let engine: Engine | undefined;
let loading: Promise<void> | undefined;

/** fetches the highlighter once, and resolves when it has landed or failed (a surface that wanted it asks `highlighterReady`). a fetch that fails (offline, a chunk the update replaced) is not tried again: the browser keeps a failed module as failed until the page is loaded again, so a second try would only fail the same way; fences stay plain until then */
export function loadHighlighter(): Promise<void> {
  loading ??= import("./highlight-engine").then(
    (m) => { engine = m; },
    () => undefined,
  );
  return loading;
}

export const highlighterReady = (): boolean => engine !== undefined;

/** `code` painted as html for the grammar, or undefined when it is to be shown plain (no grammar, too long, or the highlighter not here yet, which is asked for). `open` is the block a reply is still writing, which is held to a smaller size. the cache and the caps are the highlighter's own (highlight-engine.ts), so they are not in the first load either */
export function highlight(grammar: string | undefined, code: string, open = false): string | undefined {
  if (!grammar) return undefined;
  if (!engine) { void loadHighlighter(); return undefined; }
  return engine.highlight(grammar, code, open);
}
