/* an agent's report or note as its chip and its sheet say it (docs/thread.md,
   what started the turn): the outcome read from the report's first word, the
   first line as its gist without an outcome word that only labels it, and the
   agent's letter for a report whose first word says no outcome. read from the
   words the agent wrote, never computed state. pure; no dom. */

import { clock } from "./rows";

export type Outcome = "ready" | "blocked" | "failed" | "none";

const WORDS: Record<Exclude<Outcome, "none">, readonly string[]> = {
  ready: ["ready", "done", "merged", "landed", "shipped", "fixed", "complete", "completed", "finished", "passed", "green"],
  blocked: ["blocked", "waiting", "stuck", "paused", "needs", "question"],
  failed: ["failed", "failing", "broken", "error", "crashed", "aborted", "red"],
};

/** how a report went, from its first word: the agents' reports open with it by convention ("ready to merge", "blocked:", "failed:") */
export function outcomeOf(line: string): Outcome {
  const word = (/^\p{L}*/u.exec(line)?.[0] ?? "").toLowerCase();
  for (const [outcome, words] of Object.entries(WORDS) as Array<[Exclude<Outcome, "none">, readonly string[]]>) if (words.includes(word)) return outcome;
  return "none";
}

/** the report's first line with words in it, without its markdown marks (a heading's hashes, a bullet, a quote's bar, a list's number,
    emphasis and code ticks). reads its first lines only, never the whole report */
export function firstLine(text: string): string {
  let seen = 0;
  for (const raw of text.split("\n", 40)) {
    if (!raw.trim()) continue;
    if (++seen > 12) break;
    let line = raw.slice(0, 240).trimStart();
    if (line.startsWith("```") || /^[-*_=|: ]+$/.test(line)) continue;
    line = line.replace(/^[#>\-*+ ]+/, "").replace(/^\d+\.\s*/, "");
    const plain = line.replace(/[*`]/g, "").trim();
    if (plain) return plain;
  }
  return "";
}

/** the line without a leading outcome word that only labels it ("blocked: the zoom shots wait" reads "the zoom shots wait"); "ready
    to merge cd16978" stays whole */
export function unlabelled(line: string): string {
  const word = /^\p{L}*/u.exec(line)?.[0] ?? "";
  if (!word || outcomeOf(word) === "none") return line;
  const rest = line.slice(word.length).trimStart();
  if (!rest || !":-.,".includes(rest[0] as string)) return line;
  const after = rest.slice(1).replace(/^[\s-]+/, "");
  return after || line;
}

/** one report as its chip and its sheet show it */
export type Report = { name: string; text: string; at: number; note: boolean; outcome: Outcome; gist: string; verb: "reported" | "wrote"; initial: string; spoken: string };

export function reportOf(t: { from?: string | undefined; prompt: string; at: number; note?: boolean | undefined }): Report {
  const name = t.from || "an agent";
  const note = t.note === true;
  const first = firstLine(t.prompt);
  const outcome = outcomeOf(first);
  const gist = unlabelled(first);
  const last = name.split("/").filter(Boolean).at(-1) ?? name;
  const spoken = [`${note ? "note" : "report"} from ${name}`, ...(outcome !== "none" ? [outcome] : []), clock(t.at), ...(gist ? [gist] : [])].join(", ");
  return { name, text: t.prompt, at: t.at, note, outcome, gist, verb: note ? "wrote" : "reported", initial: (last[0] ?? "?").toUpperCase(), spoken };
}
