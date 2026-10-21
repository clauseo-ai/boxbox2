/* how the ui lands what the worker posts in its store (client.ts): patches wait for the ui's own frame and land in one
   store pass, so two posts paint once; a hidden page runs no frames, so what reaches it lands at once. the stream's status
   lands after every patch posted before it, never ahead of them, and what the worker held while the page was hidden
   lands in one go, in order (gate.ts): the store is never behind the stream when the caught-up second (ui/caught-up.ts)
   is up. apart from the dom, so the wire replay drives the same code (fixtures/wire-replay.ts). */

import type { Landed, StreamStatus } from "./messages";
import { PatchQueue } from "./queue";
import type { Patch } from "./reducer";

export type LandingHooks = {
  hidden(): boolean;
  frame(run: () => void): number;
  cancel(handle: number): void;
  apply(patches: Patch[]): void;
  stream(stream: StreamStatus): void;
};

export class Landing {
  private readonly queue = new PatchQueue();
  private handle: number | undefined;

  constructor(private readonly ui: LandingHooks, private readonly landed: () => void = () => {}) {}

  /** a frame is asked for and what waits lands in it */
  get waiting(): boolean {
    return this.handle !== undefined;
  }

  take(message: Landed | { type: "held"; messages: Landed[] }): void {
    switch (message.type) {
      case "patches":
        this.queue.push(message.patches);
        // the queue is coalesced as it grows, bounded by the paths it touches, not by the time away
        if (this.ui.hidden()) return this.now();
        this.handle ??= this.ui.frame(() => {
          this.handle = undefined;
          this.ui.apply(this.queue.take());
          this.landed();
        });
        return;
      case "stream":
        this.now();
        this.ui.stream(message.stream);
        return;
      case "held":
        this.now();
        for (const one of message.messages) {
          if (one.type === "patches") this.ui.apply(one.patches);
          else this.ui.stream(one.stream);
        }
        return;
      default:
        message satisfies never;
    }
  }

  /** what waits for the frame lands now */
  now(): void {
    if (this.handle !== undefined) this.ui.cancel(this.handle);
    this.handle = undefined;
    const patches = this.queue.take();
    if (patches.length > 0) this.ui.apply(patches);
  }

  clear(): void {
    if (this.handle !== undefined) this.ui.cancel(this.handle);
    this.handle = undefined;
    this.queue.clear();
  }
}
