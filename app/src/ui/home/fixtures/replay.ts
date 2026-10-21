/* the recorded journal, replayed through the real reducer (sync/reducer.ts) exactly as the worker applies it: every frame of
   `journal-p3.ndjson` is a data line boxbox's `GET /api/stream` sent while five threads ran across two repos on a real cmx2
   daemon (bench/windows.ts capture). the file is `journal.ndjson` (the contract 1 capture) turned into the protocol 3 frames
   the server sends for the same changes (to-protocol3.ts). the stories paint from it and the tests check the window states
   against it, so home is built from what the daemon actually says. */

import type { Frame, Thread } from "../../../sync/protocol";
import { parseCursor } from "../../../sync/protocol";
import { INITIAL_STATE, type Patch, reduce, type SyncState } from "../../../sync/reducer";

export type Recorded = { id: string | null; frame: Frame };

export function parseJournal(text: string): Recorded[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Recorded);
}

/** the sync state after the first `count` frames (all of them by default), with each frame's patches */
export function replay(recorded: readonly Recorded[], count = recorded.length): { state: SyncState; patches: Patch[][] } {
  let state = INITIAL_STATE;
  const patches: Patch[][] = [];
  for (const { id, frame } of recorded.slice(0, count)) {
    const result = reduce(state, { type: "frame", frame, id: parseCursor(id) });
    state = result.state;
    patches.push(result.patches);
  }
  return { state, patches };
}

/** the moment the journal ends: what the stories use as "now", so clocks and the 12 hour rule hold still */
export function endOf(recorded: readonly Recorded[]): number {
  let last = 0;
  for (const { frame } of recorded) {
    if (frame.type === "thread") last = Math.max(last, frame.thread.updated);
    else if (frame.type === "thread.patch" && typeof frame.set?.updated === "number") last = Math.max(last, frame.set.updated);
  }
  return last;
}

/** a thread's key by its title */
export function keyOf(state: SyncState, title: string): string {
  const thread = Object.values(state.fleet.threads).find((t: Thread) => t.title === title);
  if (!thread) throw new Error(`the journal holds no thread titled "${title}"`);
  return thread.key;
}

/** the recorded threads, by the state each ended in */
export const TITLES = {
  working: "move invoices to the new ledger",
  wants: "set the greeting in the notes",
  done: "summarise the changelog",
  queued: "pricing table on mobile",
  parked: "rebuild the search index",
} as const;
