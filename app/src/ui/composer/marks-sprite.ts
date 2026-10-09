/* the provider marks as one inline svg in index.html (marks-data.ts says why): a vite plugin, for the app's build and dev server and for the
   stories' (ladle) alike. the symbols are in the document when it is parsed, so a `<use href="#cz-mark-openai">` draws in the first
   frame, which a fetched sprite or a lazy chunk could not promise. the svg is out of the way and out of the accessibility tree. */

import type { Plugin } from "vite";
import { markSprite } from "./marks-data";

export function marksInHtml(): Plugin {
  return {
    name: "boxbox-marks-sprite",
    transformIndexHtml: () => [
      { tag: "svg", attrs: { id: "cz-marks", "aria-hidden": "true", width: "0", height: "0", style: "position:absolute;overflow:hidden" }, children: markSprite(), injectTo: "body-prepend" },
    ],
  };
}
