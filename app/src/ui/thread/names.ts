/* the register of the page's row names (docs/thread.md, accessibility): which name each control takes so that no two share one.
   reactive, no dom. */

import { type Accessor, createComputed, createMemo, createSignal, type Signal } from "solid-js";
import { namesOf, tally } from "./ledger";

/** the page's register of row names (docs/thread.md, accessibility): each turn says the labels its controls carry, in
    order, and reads back how often the turns above it already carried each, so a row tells itself apart ("again",
    "third time") from every namesake higher on the page */
export type Names = {
  say(turn: string, labels: readonly Label[]): void;
  /** the names this turn's controls take, place for place, told apart from the turns above it */
  names(turn: string): readonly Label[];
  /** the turns on the page, top to bottom */
  order: Accessor<readonly string[]>;
};
/** a control's label, or undefined for a place that is not a control */
export type Label = string | undefined;

export const sameList = <T,>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
export const NONE: ReadonlyMap<string, number> = new Map();
const NO_LABELS: readonly Label[] = [];

/** the register for one page of turns. each turn says the labels its controls carry, and the register, which knows the turns
    in order, tells each back the names its controls take: a label told apart from the times the turns above already carried it.
    it is kept as a running count down the page, so a turn that arrives at the end or a label that changes in the last turn is
    counted from that turn alone, and a change higher up counts the page again once; a turn is told only when its own names
    changed. a turn that has said nothing (not painted yet) carries none, so what is not on the page is not counted */
export function createNames(turns: Accessor<readonly string[]>): Names {
  const order = createMemo(turns, [], { equals: sameList });
  const said = new Map<string, Signal<readonly Label[]>>();
  const told = new Map<string, Signal<readonly Label[]>>();
  const slot = (turn: string): Signal<readonly Label[]> => {
    let s = said.get(turn);
    if (!s) said.set(turn, (s = createSignal<readonly Label[]>([], { equals: sameList })));
    return s;
  };
  const toldTo = (turn: string): Signal<readonly Label[]> => {
    let s = told.get(turn);
    if (!s) told.set(turn, (s = createSignal<readonly Label[]>(NO_LABELS, { equals: sameList })));
    return s;
  };
  /* the page as last counted: the turns in order, what each said, the running count down to the end, and what was told */
  let ids: readonly string[] = [];
  let heard: Array<readonly Label[]> = [];
  let running = new Map<string, number>();
  createComputed(() => {
    const now = order();
    const labels = now.map((id) => slot(id)[0]());
    const sameOrder = now.length === ids.length && now.every((id, i) => id === ids[i]);
    const changed: number[] = [];
    if (sameOrder) labels.forEach((l, i) => { if (l !== heard[i]) changed.push(i); });
    const appended = !sameOrder && now.length === ids.length + 1 && ids.every((id, i) => id === now[i]) && labels.every((l, i) => i === ids.length || l === heard[i]);
    /* one turn changed and nothing below it has said anything (the newest turn, a turn arriving, a page painting its turns top
       to bottom): the count down to it is the running count less what it said before, so it is counted from there alone */
    const only = appended ? ids.length : changed.length === 1 && labels.slice((changed[0] as number) + 1).every((l) => l.length === 0) ? (changed[0] as number) : -1;
    if (only >= 0) {
      for (const l of appended ? NO_LABELS : (heard[only] ?? NO_LABELS)) if (l !== undefined) running.set(l, (running.get(l) ?? 0) - 1);
      toldTo(now[only] as string)[1](namesOf(labels[only] as readonly Label[], running));
      tally(labels[only] as readonly Label[], running);
    } else if (!sameOrder || changed.length) {
      running = new Map();
      for (let i = 0; i < now.length; i++) {
        toldTo(now[i] as string)[1](namesOf(labels[i] as readonly Label[], running));
        tally(labels[i] as readonly Label[], running);
      }
    }
    ids = now;
    heard = labels;
    const here = new Set(now);
    for (const id of said.keys()) if (!here.has(id)) { said.delete(id); told.delete(id); }
  });
  return {
    say: (turn, labels) => slot(turn)[1](labels),
    names: (turn) => toldTo(turn)[0](),
    order,
  };
}

