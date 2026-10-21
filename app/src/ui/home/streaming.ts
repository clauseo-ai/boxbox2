/* home's streaming label (perf.ts, doing): long tasks are filed as
   streaming for 2 s after any write to the threads while one of them
   works. it was an effect over every thread in the fleet, which read
   every thread to be woken by each; now the store beats once per batch
   that wrote a thread (store.ts, `sessionsBeat`) and whether one works
   (busy; a retry or a parked thread does not, as before) is a memo per
   thread, so a frame costs one read of each. it wakes on every write as
   before, whether the worker sent whole threads or changed fields: a
   tail item, the activity of a thread at rest, a thread coming or going. */

import { type Accessor, createEffect, createMemo } from "solid-js";
import type { Fleet } from "../../sync/reducer";
import { keyed } from "../fleet-index";

export function watchStreaming(fleet: () => Fleet, beat: Accessor<number>, keys: Accessor<readonly string[]>, mark: () => void): void {
  const working = keyed(keys, (key) => fleet().threads[key]?.activity.state === "busy");
  const any = createMemo(() => working().includes(true));
  createEffect(() => {
    beat();
    // the fleet set whole (the worker's boot, signing out) is a write to the threads too
    void fleet().threads;
    if (any()) mark();
  });
}
