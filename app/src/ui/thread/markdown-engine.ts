/* marked and the sanitiser: the two libraries that turn the agent's markdown into html, about 70 KB of the app's script between them. they are
   a chunk of their own that markdown.ts fetches as the app starts (docs/thread.md, code and copying: the engine), so the first load, which has a
   budget (architecture.md), is not carrying them, and a thread painted before they arrive is painted as plain paragraphs and once more when
   they have. */

import DOMPurify from "dompurify";
import { keepsClass } from "./languages";
import { ALLOWED_TAGS, ALLOWED_URI, reaches, toHtml } from "./markdown-gfm";
import { type Made, Stream, whole as wholeWith } from "./markdown-stream";

/** the agent's markdown as html, sanitised: the answer, a report and what a row said are block markdown; a row's teaser and a thought's paragraphs use inlineNodes (thread.tsx), which builds nodes.
    links open in a new tab and carry no referrer; scripts, handlers (every on* attribute) and styles never survive; no button, form or input does, no data attribute, and no class (but marked's `language-ts` on a fence's code), so nothing the agent writes can look like our controls or be taken for the thread. */
export const sanitise = (md: string): string =>
  DOMPurify.sanitize(toHtml(md), {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: ["href", "title", "class", "open", "colspan", "rowspan", "align", "start", "reversed", "datetime", "abbr"],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ADD_FORBID_CONTENTS: ["form", "object", "embed", "button", "select", "textarea", "input", "canvas"],
    ALLOW_DATA_ATTR: false,
  });
/** `sanitise`, and what in the markdown reaches past its block (a streaming reply's units, markdown-stream.ts) */
export const sanitiseUnit = (md: string): Made => { const html = sanitise(md); return { html, ...reaches() }; };
/* the painting of a whole text and of a streaming one live here, in the engine's chunk, so the first load does not carry them */
/** the html of a whole text as it is painted (markdown-stream.ts, `whole`) */
export const whole = (md: string): string => wholeWith(md, sanitise);
/** a streaming reply's units, for one surface */
export const stream = (): Stream => new Stream(sanitiseUnit);
/* an image is its words: its alt text where it was, never a request to wherever its src points */
DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName !== "img" || !(node instanceof Element)) return;
  const alt = node.getAttribute("alt")?.trim();
  // the words go in before it; the image itself is not on the list, so the sanitiser takes it out
  if (alt) node.parentNode?.insertBefore(node.ownerDocument.createTextNode(alt), node);
});
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "class" && !keepsClass(node.tagName, data.attrValue)) data.keepAttr = false;
});
