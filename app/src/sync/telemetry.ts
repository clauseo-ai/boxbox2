/* the worker's telemetry emitter: events typed by the dictionary
   (telemetry/schema.ts), batched to `POST /api/telemetry`. device and
   device class ride on the batch; the server stamps nothing it was not
   told (server/src/http/telemetry.rs). labels never carry user content.

   a row is kept in the composer's outbox in indexeddb from the moment it
   is written until the server takes the batch that carries it, and the
   next start sends what a closed page left there, so a row written is a
   row delivered. a row can then arrive twice; the server drops a repeat
   of an id it wrote recently. */

import type { DeviceClass, EventEnvelope, EventKind, PropsOf } from "../../../telemetry/schema";
import { mintId } from "./mint-id";

/** the server takes at most 500 per batch; a queue past this drops its oldest */
const QUEUE_CAP = 500;
const FLUSH_MS = 10_000;
const FLUSH_AT = 50;

export type RawEvent = { kind: EventKind; id: string; at: number; props: Record<string, string | number> } & EventEnvelope;

/** where rows wait for the server (cache.ts, the outbox store). writes are best effort: a device that cannot keep
    them still sends them from memory, as before */
export type RowStore = {
  put(rows: readonly RawEvent[]): Promise<void>;
  forget(ids: readonly string[]): Promise<void>;
};


export class Telemetry {
  private queue: RawEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** batches on their way: one, or more while a leaving page sent beside one */
  private inFlight = 0;

  constructor(
    private readonly device: string,
    private readonly deviceClass: DeviceClass,
    /** called with the ids of a batch the server took */
    private readonly onFlushed: (ids: string[]) => void = () => {},
    /** the outbox, once the cache is open; null keeps rows in memory only */
    private readonly store: () => RowStore | null = () => null,
    private readonly endpoint = "/api/telemetry",
  ) {}

  /** rows a closed page left in the outbox go out first, in the order they were written; rows written before the
      outbox opened are kept in it from now on */
  restore(rows: readonly RawEvent[]): void {
    const early = [...this.queue];
    if (early.length > 0) this.keep(() => this.store()?.put(early));
    if (rows.length === 0) return;
    const known = new Set(this.queue.map((e) => e.id));
    const left = [...rows].filter((e) => !known.has(e.id)).sort((a, b) => a.at - b.at);
    this.queue = [...left, ...this.queue];
    this.cap();
    void this.flush();
  }

  emit<K extends EventKind>(kind: K, props: PropsOf<K>, envelope: EventEnvelope = {}): void {
    this.emitAny(kind, props as Record<string, unknown>, envelope);
  }

  /** the same, for an event that crossed the worker boundary already typed as a pair (messages.ts, `Emit`) */
  emitAny(kind: EventKind, props: Record<string, unknown>, envelope: EventEnvelope = {}): void {
    const at = envelope.at ?? Date.now();
    const clean: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(props)) {
      if (typeof value === "string" || typeof value === "number") clean[name] = value;
    }
    const row: RawEvent = { ...envelope, kind, id: envelope.id ?? mintId(at), at, props: clean };
    this.queue.push(row);
    this.keep(() => this.store()?.put([row]));
    this.cap();
    if (this.queue.length >= FLUSH_AT) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  /** sends what is queued; a failed batch goes back to the front of the queue. batches go one at a time, except
      when the page is `leaving`: a batch still in flight then is keepalive and outlives the page, but a row written
      since it left (the hide's own perf.shift) would wait for it and die with the page, so it goes now beside it */
  async flush(leaving = false): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if ((this.inFlight > 0 && !leaving) || this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.inFlight++;
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device: this.device, deviceClass: this.deviceClass, events: batch }),
      });
      // 4xx will not get better by sending again; anything else is kept for the next flush
      if (!res.ok && res.status >= 500) this.requeue(batch);
      else {
        const ids = batch.map((e) => e.id);
        this.keep(() => this.store()?.forget(ids));
        this.onFlushed(ids);
      }
    } catch {
      this.requeue(batch);
    } finally {
      this.inFlight--;
    }
  }

  /** past the cap the oldest rows are dropped, from the outbox too, so it never holds more than the queue does */
  private cap() {
    if (this.queue.length <= QUEUE_CAP) return;
    const dropped = this.queue.splice(0, this.queue.length - QUEUE_CAP).map((e) => e.id);
    this.keep(() => this.store()?.forget(dropped));
  }

  /** an outbox write that fails leaves the row in memory, where it was going to be sent from anyway */
  private keep(write: () => Promise<void> | undefined) {
    write()?.catch(() => undefined);
  }

  private requeue(batch: RawEvent[]) {
    this.queue = [...batch, ...this.queue];
    this.cap();
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
