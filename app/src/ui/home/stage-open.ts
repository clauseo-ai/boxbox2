/* what home does with a thread the store says is open (a url's `?thread=`, a push tap, a relaunch). a thread
   opens only when it has an entry to draw: `open()` set without a layer that renders leaves `.wins` and home's
   field inert on the deck and every tap dead, so the decision is pure and tested. */

/** open it, wait for the fleet to bring it, or let it go (the url named a thread that is not anywhere) */
export type OpenVerdict = "open" | "wait" | "drop";

/** `caughtUp`: the stream is live and its replay has landed, so a session the fleet does not hold now is not coming */
export function openVerdict(hasEntry: boolean, caughtUp: boolean): OpenVerdict {
  if (hasEntry) return "open";
  return caughtUp ? "drop" : "wait";
}
