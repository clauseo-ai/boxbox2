/* the undo toast's offers, in the store (store.ts) and so in the first load: which clear the toast shows, which wait for it,
   and when each runs out. pure over the time, so undo.test.ts pins every rule; undo.ts (a later chunk) has the rest. */

import type { Undo } from "../../store";

/** how long the toast offers the clear back */
export const TOAST_MS = 6000;

/** what the toast says: "cleared 3", "cleared 1" */
export function toastWords(count: number): string {
  return `cleared ${count}`;
}

/** what home's live region says while the toast shows (the toast's line, the one thread's title, or why the undo failed),
    empty while none does: the region is there before the toast, so the words are announced as they arrive */
export function toastAnnouncement(undo: Pick<Undo, "keys" | "title" | "error"> | null): string {
  if (!undo) return "";
  if (undo.error) return undo.error;
  return undo.keys.length === 1 && undo.title !== null ? `${toastWords(1)}, ${undo.title}` : toastWords(undo.keys.length);
}

/** the toast's offers: the one on screen and the ones waiting for it to end, oldest first. pure over the time (`now`, in
    performance.now ms, the clock the toast's `Lifetime` runs on), so undo.test.ts pins every rule; the store holds them */
export type Offers = { now: Undo | null; next: Undo[] };

/** at most this many offers wait: an auto-clear joins one already waiting, so only a failed undo adds another */
export const WAITING_MAX = 4;

/** the offers as they stand at `now`: an offer whose time ran out (on screen or not: home may have been away) is gone, and
    the next one waiting shows for its own full time from the moment the one before it ended */
export function settled(offers: Offers, now: number): Offers {
  let { now: shown, next } = offers;
  while (shown && shown.until <= now) {
    const ended = shown.until;
    const [first, ...rest] = next;
    shown = first ? { ...first, until: ended + TOAST_MS } : null;
    next = rest;
  }
  return shown === offers.now && next === offers.next ? offers : { now: shown, next };
}

/** a new clear offered back. a hand clear's toast is never replaced by an auto-clear: the auto-clear waits (joining one
    already waiting) and shows when the hand toast ends. anything else replaces what is on screen, so ⌘z and the button
    always undo the clear the toast shows */
export function offered(offers: Offers, offer: Undo, now: number): Offers {
  const at = settled(offers, now);
  if (offer.cause === "auto" && at.now?.cause === "hand") {
    const last = at.next.at(-1);
    if (last?.cause === "auto" && !last.error) {
      const keys = [...new Set([...last.keys, ...offer.keys])];
      return { now: at.now, next: [...at.next.slice(0, -1), { ...last, keys, title: keys.length === 1 ? last.title : null }] };
    }
    return { now: at.now, next: [...at.next, offer].slice(-WAITING_MAX) };
  }
  return { now: { ...offer, until: now + TOAST_MS }, next: at.next };
}

/** the toast is done with this offer (undone, timed out, dismissed): the next one waiting shows for its full time */
export function dropped(offers: Offers, serial: number, now: number): Offers {
  if (offers.now?.serial === serial) {
    const [first, ...rest] = offers.next;
    return { now: first ? { ...first, until: now + TOAST_MS } : null, next: rest };
  }
  const next = offers.next.filter((o) => o.serial !== serial);
  return next.length === offers.next.length ? offers : { now: offers.now, next };
}

/** an undo came back refused or failed: its line always shows. on screen still, it says why there; when a newer toast took
    over meanwhile, the failed one comes back on screen with its line and the newer one waits for it, first in line */
export function failed(offers: Offers, offer: Undo, error: string, now: number): Offers {
  const back: Undo = { ...offer, busy: false, error, until: now + TOAST_MS };
  if (offers.now?.serial === offer.serial) return { now: back, next: offers.next };
  const next = offers.next.filter((o) => o.serial !== offer.serial);
  return { now: back, next: (offers.now ? [{ ...offers.now, busy: false }, ...next] : next).slice(0, WAITING_MAX) };
}

