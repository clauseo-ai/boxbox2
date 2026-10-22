/* a thread's btws as the reducer keeps them (docs/protocol.md, btw): each
   record merged by one monotonic rule, whoever sent it (the stream, the
   thread read, the reread after a gap, a verb's own answer), so the order
   they arrive in never takes a card backwards, and the map capped. */

import type { Btw } from "./protocol";

/** the most btws one thread keeps; past it the oldest settled one goes first, then the oldest still running */
export const BTW_CAP = 64;

export const settled = (btw: Btw): boolean => btw.status !== "running";

/** the record a held btw and a sent one make. running moves to done or error and never back: a running record that comes
    after a settled one (an older snapshot, a stream echo behind a reread) changes nothing but what sticks. while both run, the
    longer answer stands, since each is a prefix of the same words and the shorter is the older. a dismissal and a promotion
    stick once any record carried them */
export function mergeBtw(held: Btw | undefined, sent: Btw): Btw {
  if (!held) return sent;
  let base: Btw;
  if (settled(held) && !settled(sent)) base = held;
  else if (!settled(held) && !settled(sent) && held.answer.length > sent.answer.length) base = { ...sent, answer: held.answer };
  else base = sent;
  const dismissed = sent.dismissed ?? held.dismissed;
  const promotedMessageID = sent.promotedMessageID ?? held.promotedMessageID;
  return {
    ...base,
    ...(dismissed === undefined ? {} : { dismissed }),
    ...(promotedMessageID === undefined ? {} : { promotedMessageID }),
  };
}

/** the ids that go when `btws` holds more than BTW_CAP: settled before running, the oldest created first among each */
export function overCap(btws: Readonly<Record<string, Btw>>): string[] {
  const all = Object.values(btws);
  if (all.length <= BTW_CAP) return [];
  const order = [...all].sort((a, b) => Number(settled(b)) - Number(settled(a)) || a.created - b.created);
  return order.slice(0, all.length - BTW_CAP).map((btw) => btw.id);
}

/** the thread's btws with `sent` merged in and the cap applied; `held` itself when nothing changed, so a repeat costs no
    patch. `same` decides whether a merged record is the one held */
export function foldBtws(held: Readonly<Record<string, Btw>> | undefined, sent: readonly Btw[], same: (a: Btw, b: Btw) => boolean): Readonly<Record<string, Btw>> | undefined {
  let next: Record<string, Btw> | null = null;
  for (const one of sent) {
    const before = (next ?? held)?.[one.id];
    const after = mergeBtw(before, one);
    if (before && same(before, after)) continue;
    next ??= { ...held };
    next[one.id] = after;
  }
  if (next === null) return held;
  for (const id of overCap(next)) delete next[id];
  return next;
}
