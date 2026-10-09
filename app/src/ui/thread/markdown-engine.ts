/* marked and the sanitiser: the two libraries that turn the agent's markdown into html, about 70 KB of the app's script between them. they are
   a chunk of their own that markdown.ts fetches as the app starts (docs/thread.md, code and copying: the engine), so the first load, which has a
   budget (architecture.md), is not carrying them, and a thread painted before they arrive is painted as plain paragraphs and once more when
   they have. */

import DOMPurify from "dompurify";
import { marked } from "marked";
import { keepsClass } from "./languages";

/** the agent's markdown as html, sanitised: the answer, a report and what a row said are block markdown; a row's teaser and a thought's paragraphs use inlineNodes (thread.tsx), which builds nodes.
    links open in a new tab and carry no referrer; scripts, handlers and styles never survive; no button, form or input does, no data attribute, and no class (but marked's `language-ts` on a fence's code), so nothing the agent writes can look like our controls or be taken for the thread. */
export const sanitise = (md: string): string => {
  const raw = String(marked.parse(md, { async: false, gfm: true }));
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"], FORBID_ATTR: ["style"], ALLOW_DATA_ATTR: false });
};
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "class" && !keepsClass(node.tagName, data.attrValue)) data.keepAttr = false;
});
