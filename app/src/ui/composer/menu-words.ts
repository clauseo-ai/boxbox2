/* what the composer's surfaces that load on demand say (ui/later.ts): the suggestions' slash rows, the new-thread sheet's
   refusal, the model menu's filter and its note. split from words.ts, which is in the first load, so these words load
   with the surfaces that say them (architecture.md, the script budget). pure, so every sentence is tested. */

import type { ListState } from "./words";

/** a slash row draws the context's fill (its ring and percent) only for compact, the one command the fill is about */
export const slashShowsFill = (choice: { name: string; local?: boolean | undefined }): boolean => choice.local === true && choice.name === "compact";

/** what the sheet says when a first message did not start: the host's own words when they already say so, else with that
    said first; always ending on what to do, once */
export function refusedStart(error: string | null, photosReturned = 0): string {
  const said = (error ?? "the machine refused it").trim().replace(/\.$/, "");
  const head = said.includes("did not start") ? said : `the thread did not start: ${said}`;
  // a message whose photos went back to the draft is not retried (it would start the thread with its words alone): its own words say what to do
  if (photosReturned) return `${head}.`;
  return head.includes("retry") ? `${head}.` : `${head}. retry sends it once, never twice.`;
}

/** the models a typed filter keeps: every word in the name, the provider or the id; the ones whose name starts with the
    first word lead, then the ones whose name holds every word, then the rest, each in the host's own order */
export function matchModels<M extends { id: string; name: string; provider: string }>(models: readonly M[], query: string): M[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...models];
  const scored: Array<[M, number, number]> = [];
  models.forEach((model, at) => {
    const name = model.name.toLowerCase();
    const all = `${name} ${model.provider.toLowerCase()} ${model.id.toLowerCase()}`;
    if (!words.every((word) => all.includes(word))) return;
    const rank = name.startsWith(words[0] ?? "") ? 0 : words.every((word) => name.includes(word)) ? 1 : 2;
    scored.push([model, rank, at]);
  });
  return scored.sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([model]) => model);
}

/** what the model menu says while the host's list is not here */
export function modelsNote(list: Exclude<ListState, "ready">): string {
  return list === "failed" ? "the models did not come." : "reading the models.";
}
