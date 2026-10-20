/* home's streaming label (perf.ts, doing): long tasks are filed as
   streaming for 2 s after any write to the sessions while one of them
   works. it was an effect over `Object.values(state.fleet.sessions)`,
   which read every session to be woken by each; now the store beats once
   per batch that wrote a session (store.ts, `sessionsBeat`) and whether
   one works is a memo per session, so a frame costs one read of each. it
   wakes on every write as before, whether the worker sent whole entries
   or changed fields: a tail item, a status of a thread at rest, a session
   coming or going. */

import { type Accessor, createEffect, createMemo } from "solid-js";
import type { Fleet } from "../../sync/reducer";
import { keyed } from "../fleet-index";

export function watchStreaming(fleet: () => Fleet, beat: Accessor<number>, keys: Accessor<readonly string[]>, mark: () => void): void {
  const working = keyed(keys, (key) => fleet().sessions[key]?.status?.type === "busy");
  const any = createMemo(() => working().includes(true));
  createEffect(() => {
    beat();
    // the fleet set whole (the worker's boot, signing out) is a write to the sessions too
    void fleet().sessions;
    if (any()) mark();
  });
}
