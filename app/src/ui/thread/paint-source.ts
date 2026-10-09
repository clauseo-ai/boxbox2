/* where a thread's first paint came from, for `perf.thread cached` (docs/thread.md, telemetry). the flag says whether the rows were
   painted from the client's own copy and not from the wire, and the budget it picks (300 ms or 1,500) follows it. the stage cannot see
   which, but it can see what an open from the wire looks like: the worker puts the thread in the store empty and still reading the moment
   it is asked for, and the rows arrive when the fetch lands. a thread whose rows came with no such empty thread before them was already in
   memory or was restored from the cache, as a first paint from the cache is. pure; no dom. */

export type PaintSource = {
  /** the thread as the store holds it now */
  see(thread: { held: boolean; hydrating: boolean; turns: number }): void;
  /** the first paint came from the client's copy */
  cached(): boolean;
};

export function paintSource(): PaintSource {
  let fromWire = false;
  return {
    see(thread) {
      if (thread.held && thread.hydrating && thread.turns === 0) fromWire = true;
    },
    cached: () => !fromWire,
  };
}
