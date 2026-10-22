/* a job per key that runs at most once per cooldown, alone in its module so its rules are tests: a call while the job is out
   or cooling down is not dropped and not repeated, it queues one trailing run at the end of the cooldown. the btws' reread
   after a hole uses it (worker.ts): a server that has lost a btw's length sends every 100 ms batch without an offset, and each
   would otherwise read the thread's btws whole, while a hole found as a read was answering must still be read. */

export type Timers = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };

type Slot = { out: boolean; again: boolean; timer: unknown };

export class Cooldown {
  /** a key is here while its job is out or cooling down, and leaves when a cooldown ends with nothing queued */
  private readonly slots = new Map<string, Slot>();

  constructor(
    private readonly ms: number,
    private readonly job: (key: string) => Promise<void>,
    private readonly timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  ) {}

  /** runs the job now, or once when the running one and its cooldown are over */
  ask(key: string): void {
    const slot = this.slots.get(key);
    if (slot) slot.again = true;
    else void this.start(key, { out: false, again: false, timer: undefined });
  }

  private async start(key: string, slot: Slot): Promise<void> {
    this.slots.set(key, slot);
    slot.out = true;
    slot.again = false;
    try {
      await this.job(key);
    } catch {
      /* a failed run is a run: the cooldown still holds, and a queued ask runs after it */
    } finally {
      slot.out = false;
      if (this.slots.get(key) === slot) {
        slot.timer = this.timers.set(() => {
          slot.timer = undefined;
          if (this.slots.get(key) !== slot) return;
          if (slot.again) void this.start(key, slot);
          else this.slots.delete(key);
        }, this.ms);
      }
    }
  }

  /** forgets every key and its timer (the worker stopped) */
  clear(): void {
    for (const slot of this.slots.values()) if (slot.timer !== undefined) this.timers.clear(slot.timer);
    this.slots.clear();
  }
}
