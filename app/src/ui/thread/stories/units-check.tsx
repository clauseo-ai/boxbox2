/* the painter's units held to the whole in the browser, with the real sanitiser and the real dom (markdown.ts, markdown-stream.ts): every
   document (stream-docs.ts, and every reply in the fixtures) is streamed into one painter in small seeded chunks, and after every chunk its
   surface must be, html for html, what a painter that paints every text whole makes of the same text from nothing. once a document has
   streamed it settles, and must again be what the whole painter makes of it. the story writes on its sample how many frames it compared
   (`data-frames`), how many differed (`data-mismatches`, which must be 0) and the first that did; `data-check` says when it is done */

import { onMount } from "solid-js";
import { loadHighlighter } from "../highlight";
import { loadMarkdown, painter } from "../markdown";
import cmxUrl from "../fixtures/cmx-deploy.json?url";
import notesUrl from "../fixtures/notes-asks.json?url";
import northstarUrl from "../fixtures/northstar-heavy.json?url";
import { EDGES, SAMPLES, chunkEnds, long, seeded, textsOf } from "./stream-docs";

/** the documents and the most characters a chunk of each may carry: the small ones in tiny chunks, the long ones in larger, so the whole
    painter (which costs the square of a text) keeps the check to seconds */
async function documents(): Promise<Array<{ text: string; most: number }>> {
  const recorded: string[] = [];
  for (const url of [cmxUrl, notesUrl, northstarUrl]) recorded.push(...textsOf(await (await fetch(url)).json()));
  return [
    ...EDGES.map((text) => ({ text, most: 5 })),
    ...SAMPLES.map((text) => ({ text, most: 9 })),
    ...recorded.map((text) => ({ text, most: Math.max(12, Math.round(text.length / 60)) })),
    { text: long(30 * 1024), most: 1200 },
  ];
}

export function UnitsCheck() {
  let host!: HTMLDivElement;
  onMount(() => {
    const sample = host.closest<HTMLElement>(".stage-sample") ?? host;
    void (async () => {
      await Promise.all([loadMarkdown(), loadHighlighter()]);
      const streamed = document.createElement("div");
      const reference = document.createElement("div");
      host.append(streamed, reference);
      let frames = 0, mismatches = 0;
      const compare = (md: string, caret: boolean, where: string) => {
        const fresh = painter(reference, undefined, true);
        fresh.paint(md, caret);
        frames++;
        if (streamed.innerHTML !== reference.innerHTML) {
          mismatches++;
          sample.dataset["first"] ??= where;
        }
        fresh.dispose();
        reference.replaceChildren();
      };
      for (const [d, doc] of (await documents()).entries()) {
        /* one document's stream is compared in one task: the copy controls are renamed in a later frame (copy.ts), which the fresh one would not be yet */
        const surface = painter(streamed);
        for (const at of chunkEnds(doc.text, seeded(d + 1), doc.most)) {
          const md = doc.text.slice(0, at);
          surface.paint(md, true);
          compare(md, true, `document ${d} at ${at}`);
        }
        surface.paint(doc.text, false);
        compare(doc.text, false, `document ${d} settled`);
        surface.dispose();
        streamed.replaceChildren();
        await new Promise((r) => setTimeout(r, 0));
      }
      sample.dataset["frames"] = String(frames);
      sample.dataset["mismatches"] = String(mismatches);
      /* with ?measure in the address, the longest reply is also streamed word by word into a painter of each kind, timed (the cost the units take away) */
      if (location.search.includes("measure")) {
        const longest = (await documents()).reduce((a, b) => (b.text.length > a.text.length ? b : a)).text;
        for (const kind of ["whole", "units"] as const) {
          const surface = painter(streamed, undefined, kind === "whole");
          const start = performance.now();
          for (let i = longest.indexOf(" ", 1); i > 0; i = longest.indexOf(" ", i + 1)) surface.paint(longest.slice(0, i), true);
          surface.paint(longest, false);
          sample.dataset[kind] = `${Math.round(performance.now() - start)}`;
          surface.dispose();
          streamed.replaceChildren();
        }
      }
      sample.dataset["check"] = "done";
      host.textContent = `${frames} frames compared, ${mismatches} differed${mismatches ? ` (first: ${sample.dataset["first"] ?? ""})` : ""}`;
    })();
  });
  /* the surfaces are compared, not shown: hidden, no code block is measured, so neither painter marks one as overflowing */
  return <div ref={host} class="units-check" style={{ "font-size": "13px" }}><style>{".units-check > div { display: none; }"}</style></div>;
}
