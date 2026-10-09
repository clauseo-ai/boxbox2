/* jittered exponential backoff, the same rule as the server's upstream
   watcher (server/src/upstream/backoff.rs): the ceiling doubles from the
   floor to the cap, and each wait is between half the ceiling and all of
   it, so a fleet of devices never redials in lockstep. */

export class Backoff {
  private ceiling: number;

  constructor(
    private readonly floorMs: number,
    private readonly capMs: number,
    private readonly random: () => number = Math.random,
  ) {
    this.ceiling = floorMs;
  }

  nextDelay(): number {
    const delay = this.ceiling / 2 + (this.random() * this.ceiling) / 2;
    this.ceiling = Math.min(this.ceiling * 2, this.capMs);
    return Math.round(delay);
  }

  reset(): void {
    this.ceiling = this.floorMs;
  }
}
