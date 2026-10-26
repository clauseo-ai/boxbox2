/* the undo toast's time, as the toast mounts it (toast.tsx): the 6 s (`Lifetime`), its holds, and the offer's expiry in the
   store, with no dom so toast.reactive.test.ts mounts it as home does. home hands it the offer as a value (a keyed <Show>):
   the store object stays readable after the store lets go of it, so nothing here reads a stale accessor when an undo or
   the time ends the toast. the serial its callbacks name is a copy, taken each time the offer changes. */

import { createEffect, on, onCleanup, untrack } from "solid-js";
import { dropUndo, type Undo, undoUntil } from "../../store";
import { type Clock, Lifetime, TOAST_MS } from "./undo";

/** what the toast's ring does as the time holds, runs and starts over */
export type Ring = { restart: (left: number, held: boolean) => void; pause: () => void; play: () => void; stop: () => void };

export type Hold = "pointer" | "focus" | "busy";

export function toastLife(undo: Undo, ring: Ring, clock: Clock): { set: (source: Hold, on: boolean) => void; focused: () => boolean } {
  let serial = untrack(() => undo.serial);
  // the offer carries when it runs out, so home coming back after it shows nothing (store.ts, `liveUndo`)
  const time = new Lifetime(TOAST_MS, () => dropUndo(serial), clock, (at) => undoUntil(serial, at));
  /* each source of a hold is held once: a pointer over the toast, focus in it, its undo out */
  const held = { pointer: false, focus: false, busy: false };
  const any = () => held.pointer || held.focus || held.busy;
  const set = (source: Hold, on: boolean) => {
    if (held[source] === on) return;
    held[source] = on;
    if (on) {
      time.hold();
      ring.pause();
    } else {
      time.release();
      if (!any()) ring.play();
    }
  };
  /* each clear (a new serial) and each failed undo starts the time the store gives it (the full time for a new one; what is
     left of it when home comes back while it still runs), and the ring from the same point */
  createEffect(
    on(
      () => [undo.serial, undo.error] as const,
      ([next]) => {
        serial = next;
        const until = untrack(() => undo.until);
        const left = Number.isFinite(until) ? Math.min(TOAST_MS, Math.max(0, until - clock.now())) : TOAST_MS;
        ring.restart(left, any());
        time.restart(left);
      },
    ),
  );
  createEffect(() => set("busy", undo.busy));
  onCleanup(() => {
    time.stop();
    ring.stop();
  });
  return { set, focused: () => held.focus };
}
