/* whether the stream has caught up (docs/design.md, motion is honest). a connect replays what was missed: the stream is "live" at
   the hello, before the frames that bring the fleet and its asks, so what the fleet does not hold is not known to be gone, and
   what arrives is not news, until the replay has landed. the second after the stream went live is what that takes. home
   spends motion on it, and the stage lets go of an ask it was sent to only after it. */

import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { state } from "../store";

/** after a (re)connect the server replays what was missed; this long after the stream went live it has landed */
export const CATCH_UP_MS = 1000;

/** how long until the replay a connect brings has landed: 0 once it has, null while the stream is not live at all */
export function catchUpIn(stream: { state: string; since: number }, now: number): number | null {
  return stream.state === "live" ? Math.max(0, stream.since + CATCH_UP_MS - now) : null;
}

/** true once the stream has been live for CATCH_UP_MS, false again whenever it changes (a reconnect starts the second over). called
    in a component, which owns its timer */
export function createCaughtUp(): Accessor<boolean> {
  const [caughtUp, setCaughtUp] = createSignal(false);
  createEffect(() => {
    const wait = catchUpIn(state.stream, Date.now());
    setCaughtUp(false);
    if (wait === null) return;
    const timer = setTimeout(() => setCaughtUp(true), wait);
    onCleanup(() => clearTimeout(timer));
  });
  return caughtUp;
}
