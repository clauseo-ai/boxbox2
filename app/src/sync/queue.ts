/* the ui thread's queue of the worker's patches (client.ts): what arrives between two frames waits here and lands in one
   store pass. it is coalesced as it grows, once it has doubled since the last time, so it stays bounded by the paths it
   touches however many posts come before it lands, and each post costs what it carries, not what is already waiting */

import { coalesce, type Patch } from "./reducer";

/** under this many patches the queue is not coalesced until it lands */
const COALESCE_FROM = 256;

export class PatchQueue {
  private queued: Patch[] = [];
  /** how long the queue was when it was last coalesced */
  private coalescedAt = 0;

  push(patches: readonly Patch[]): void {
    for (const patch of patches) this.queued.push(patch);
    if (this.queued.length <= Math.max(COALESCE_FROM, 2 * this.coalescedAt)) return;
    this.queued = coalesce(this.queued);
    this.coalescedAt = this.queued.length;
  }

  /** everything waiting, coalesced, and the queue empty */
  take(): Patch[] {
    const patches = coalesce(this.queued);
    this.clear();
    return patches;
  }

  clear(): void {
    this.queued = [];
    this.coalescedAt = 0;
  }
}
