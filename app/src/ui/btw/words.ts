/* what a btw card says and offers in each state (docs/thread.md, btw: the card). pure, so every sentence and every
   accessible name is tested (words.test.ts); card.tsx draws it. the voice is design.md's: lowercase, plain verbs, an
   error says what happened and what to do. */

import type { Btw } from "./types";

/** the quiet caption on every card: what a btw is not */
export const BTW_CAPTION = "not in the agent's context · no tools";

/** what a running card says before its first word, in the meta line beside the label */
export const BTW_ANSWERING = "answering";

/** the card's label */
export const BTW_LABEL = "btw";

/** a control on the card: its word, its unique name, and what it does */
export type BtwVerb = { verb: "promote" | "added" | "dismiss" | "hide" | "retry"; word: string; name: string };

export type BtwView =
  /** nothing is drawn: a dismissed btw that never answered has nothing worth keeping */
  | { kind: "none" }
  /** dismissed: one line that expands on tap */
  | { kind: "chip"; word: string; name: string }
  | {
      kind: "card";
      state: Btw["status"];
      /** the region's name: a btw, and which */
      region: string;
      /** the answer is drawn (empty while the first words have not come: the caret alone stands for it) */
      answer: boolean;
      /** the line under the question that says what went wrong and what to do (error), or that the answer came back empty */
      note: string | null;
      verbs: BtwVerb[];
    };

/** what went wrong, said once, ending on what to do */
export function errorWords(error: string | null | undefined): string {
  const said = (error ?? "").trim().replace(/[.\s]+$/, "");
  return `${said ? `no answer: ${said}` : "no answer came"}. retry asks it again.`;
}

/** a card's words and verbs from its record, whether this device has it opened again after a dismiss (`expanded`, local),
    and `name`, the btw's bounded question told apart from its namesakes (place.ts, btwNames) */
export function btwView(btw: Btw, expanded: boolean, name: string): BtwView {
  const dismissed = btw.dismissed != null;
  if (dismissed && btw.status === "error") return { kind: "none" };
  const quoted = `"${name}"`;
  if (dismissed && !expanded) return { kind: "chip", word: `btw: ${firstLine(btw.question)}`, name: `btw ${quoted}, dismissed. show it` };
  const verbs: BtwVerb[] = [];
  if (btw.status === "error") verbs.push({ verb: "retry", word: "retry", name: `ask the btw ${quoted} again` });
  if (btw.status === "done") {
    verbs.push(
      btw.promotedMessageID != null
        ? { verb: "added", word: "added to thread", name: `added to thread: go to the message from the btw ${quoted}` }
        : { verb: "promote", word: "add to thread", name: `add the btw ${quoted} to the thread` },
    );
  }
  verbs.push(dismissed ? { verb: "hide", word: "hide", name: `hide the btw ${quoted}` } : { verb: "dismiss", word: "dismiss", name: `dismiss the btw ${quoted}` });
  const empty = btw.status === "done" && !/\S/.test(btw.answer);
  return {
    kind: "card",
    state: btw.status,
    region: `btw: ${name}`,
    answer: btw.status !== "error" || /\S/.test(btw.answer),
    note: btw.status === "error" ? errorWords(btw.error) : empty ? "the answer came back empty." : null,
    verbs,
  };
}

/** the question's first line, for the dismissed chip, which is one line and lets the page cut it with an ellipsis */
export function firstLine(question: string): string {
  return question.trim().split(/\n/)[0]?.trim() ?? "";
}

/** the marker on a promoted message: its words, and its name, which says where it goes */
export const FROM_BTW = "from a btw, with its answer";
export const fromBtwName = (name: string | undefined): string => (name ? `from a btw, with its answer: go to the btw "${name}"` : "from a btw, with its answer: go to the btw");

export { promotedParts, shownPrompt } from "./prompt";
