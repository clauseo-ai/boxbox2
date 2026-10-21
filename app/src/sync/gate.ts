/* what the worker posts to the ui, held while the page is hidden (docs/architecture.md, the sync worker). a hidden page
   paints nothing, so the patches it would apply are work for nobody: the worker keeps them instead, coalesced as they come
   (queue.ts), so they are bounded by the paths they touch and not by the time away, and posts them when the page is
   visible again, in one message, which the ui lands in one go (landing.ts).

   the stream's status is held with them, the last one only, and lands after them: the ui decides the stream has caught up
   a second after it went live (ui/caught-up.ts), so a status that reached the store ahead of the patches would let that
   second pass with the store behind the replay, and an ask or a thread the fleet has not been told of yet would be taken
   for gone (docs/gotchas.md, the hidden queue that raced the caught-up second). nothing paints and no timer runs while the
   one message lands, so the statuses between, and where they stood among the patches, are seen by nobody. any other
   message that touches the store (the outbox, a born thread, photos handed back, a board frame) first lets out everything
   held, so it lands after what came before it, as it always did. the answers to the ui's own questions and the telemetry
   acknowledgements touch nothing the patches do and pass at once. */

import type { FromWorker, Landed, StreamStatus } from "./messages";
import { PatchQueue } from "./queue";

export class PageGate {
  private hidden = false;
  private readonly patches = new PatchQueue();
  private holding = false;
  private stream: StreamStatus | null = null;

  constructor(private readonly post: (message: FromWorker) => void) {}

  /** the page was hidden or shown: shown, everything held goes now */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (!hidden) this.release();
  }

  send(message: FromWorker): void {
    if (!this.hidden) return this.post(message);
    switch (message.type) {
      case "patches":
        this.patches.push(message.patches);
        this.holding = true;
        return;
      case "stream":
        // a copy: the worker changes its own status in place as frames come
        this.stream = { ...message.stream };
        this.holding = true;
        return;
      case "reply":
      case "flushed":
      case "dropped":
        return this.post(message);
      default:
        this.release();
        this.post(message);
    }
  }

  /** something is held, for the tests */
  get waiting(): boolean {
    return this.holding;
  }

  /** everything held, as one message: the patches, then the stream's last status */
  private release(): void {
    if (!this.holding) return;
    const messages: Landed[] = [];
    const patches = this.patches.take();
    if (patches.length > 0) messages.push({ type: "patches", patches });
    if (this.stream) messages.push({ type: "stream", stream: this.stream });
    this.stream = null;
    this.holding = false;
    if (messages.length > 0) this.post({ type: "held", messages });
  }
}
