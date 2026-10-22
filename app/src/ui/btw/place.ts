/* where a thread's btws are drawn (docs/thread.md, btw: placement), and how their controls are told apart. pure, so
   the rule is tested (place.test.ts); live.ts reads it.

   a btw is drawn inside the turn that holds the message it was asked after (`afterMessageID`), after that turn's own
   content: a turn is a user message and the assistant messages that follow it, as turnsOf cuts them, so the id is
   looked up among both. a btw with no `afterMessageID`, or one naming a message the thread does not show (not read yet,
   or before the first prompt), goes in the last turn. within a turn the cards are in the order they were asked. */

import type { Btw } from "./types";

/** what placement reads of a message: its id and its role */
export type Placed = { id: string; role: string };

/** the btws by the id of the turn that shows them, each list in created order (the id breaks a tie). messages are the
    thread's shown ones (model.ts, shownMessages), oldest first */
export function placeBtws(messages: readonly Placed[], btws: readonly Btw[]): Map<string, Btw[]> {
  const out = new Map<string, Btw[]>();
  if (btws.length === 0) return out;
  const turnOf = new Map<string, string>();
  let turn: string | undefined;
  for (const m of messages) {
    if (m.role === "user") turn = m.id;
    if (turn !== undefined) turnOf.set(m.id, turn);
  }
  // the last turn: the last user message's id, which is the last value `turn` took
  const last = turn;
  if (last === undefined) return out;
  for (const b of btws) {
    const at = (b.afterMessageID != null ? turnOf.get(b.afterMessageID) : undefined) ?? last;
    const list = out.get(at);
    if (list) list.push(b);
    else out.set(at, [b]);
  }
  for (const list of out.values()) list.sort(byCreated);
  return out;
}

export const byCreated = (a: Btw, b: Btw): number => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** a question as a control names it: one line, at most this many characters */
export const NAME_CHARS = 60;

/** a question in one bounded line: white space collapsed, cut at a word near the bound with an ellipsis */
export function boundedQuestion(question: string, max = NAME_CHARS): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const REPEATS = ["", ", again", ", third time", ", fourth time", ", fifth time"];

/** each btw's name: its bounded question, and for a namesake asked later in the thread "again", then "third time" (as the
    ledger's rows are told apart, thread.md, names), so every control on the page has a name of its own */
export function btwNames(btws: readonly Btw[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const b of [...btws].sort(byCreated)) {
    const base = boundedQuestion(b.question) || "an empty question";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(b.id, `${base}${REPEATS[n] ?? `, time ${n + 1}`}`);
  }
  return out;
}
