/* a size-capped least-recently-used map: the oldest entries leave when the bytes held pass the cap (every map has an eviction rule,
   AGENTS.md rule 7). the highlighter's cache of painted code and the thread's caches (memo-cache.ts) are this one class. no dom. */

export class Lru<V = string> {
  private readonly held = new Map<string, { value: V; bytes: number }>();
  private total = 0;
  /** how often a read found, missed, and how many entries the cap pushed out: what the cache reports as telemetry (`perf.memo`) */
  hits = 0;
  misses = 0;
  evicted = 0;

  /** `weigh` is what one entry costs, in bytes; for strings, two a character, the key counting too (a js string is up to two a character) */
  constructor(private readonly cap: number, private readonly weigh: (key: string, value: V) => number = (key, value) => 2 * (key.length + String(value).length)) {}

  get(key: string): V | undefined {
    const was = this.held.get(key);
    if (was === undefined) { this.misses++; return undefined; }
    this.hits++;
    // a map iterates in insertion order, so re-inserting makes this the newest
    this.held.delete(key);
    this.held.set(key, was);
    return was.value;
  }

  /** an entry bigger than the whole cap is not kept (and pushes nothing out). `bytes` is what the caller says it costs, else `weigh` */
  set(key: string, value: V, bytes: number = this.weigh(key, value)): void {
    this.delete(key);
    if (bytes > this.cap) return;
    this.held.set(key, { value, bytes });
    this.total += bytes;
    for (const [k, e] of this.held) {
      if (this.total <= this.cap) break;
      this.held.delete(k);
      this.total -= e.bytes;
      this.evicted++;
    }
  }

  delete(key: string): void {
    const was = this.held.get(key);
    if (!was) return;
    this.total -= was.bytes;
    this.held.delete(key);
  }

  /** every entry whose key `match` says belongs to what is leaving (a thread the worker let go) */
  dropWhere(match: (key: string) => boolean): void {
    for (const key of [...this.held.keys()]) if (match(key)) this.delete(key);
  }

  clear(): void {
    this.held.clear();
    this.total = 0;
  }

  get size(): number { return this.held.size; }
  get weight(): number { return this.total; }
}
