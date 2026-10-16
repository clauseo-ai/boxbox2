/* the sync worker (docs/architecture.md, the sync worker): the one owner
   of the stream, the cursor, the reducer's state and indexeddb. json
   parsing and storage never touch the ui thread; the ui gets patches,
   coalesced to one message a frame.

   boot reads the cache's meta, fleet and thread heads, and the pages of the
   one thread the url opens, and posts them before the stream opens, so a
   cold launch or a reload paints what it had on the first frame; then the
   stream resumes from the cached cursor and the server replays the gap.
   every other thread's pages are read when it is opened or held, before the
   wire is asked, and reach the ui as that thread's patch. */

import { Backoff } from "./backoff";
import { Cache, cleanDirty, type Dirty } from "./cache";
import type { Emit, FromWorker, StreamStatus, SyncCounters, ToWorker, UiSync } from "./messages";
import { inDaemonOrderAll } from "./order";
import { decodeFrame, formatCursor, type Message, parseCursor, PROTOCOL, splitKey } from "./protocol";
import {
  type Action,
  type Cold,
  coalesce,
  EMPTY_FLEET,
  type Effect,
  INITIAL_STATE,
  type Patch,
  reduce,
  type SyncState,
  type ThreadView,
  viewOf,
} from "./reducer";
import { readTranscript } from "./read";
import { type AskReply, keepReply, replyKey, restoreReplies } from "./replies";
import { Sender } from "./sender";
import { SseParser, type SseFrame } from "./sse";
import { Telemetry } from "./telemetry";

/** the worker's own global surface. this module only ever runs as the dedicated worker client.ts starts,
    but the app's dom lib types `self` as a window, so what the worker uses of its scope is named here */
type WorkerScope = {
  postMessage(message: FromWorker): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ToWorker>) => void): void;
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};
const scope = globalThis as unknown as WorkerScope;

/** a reader aborts after this long without a byte; the server writes a heartbeat every 15 s */
const STALL_MS = 45_000;
const SAVE_DEBOUNCE_MS = 200;
/** patches wait for the next animation frame, or this long where a worker has none or the tab is hidden */
const FRAME_FALLBACK_MS = 50;
/** a message asked for again within this long of its last ask is coming back stale, so it waits before it is fetched */
const REFETCH_STREAK_MS = 5_000;
const REFETCH_BACKOFF_MS = { floor: 250, cap: 8_000 };

function post(message: FromWorker) {
  scope.postMessage(message);
}

/** a wait the worker can cut short when it stops */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

class Sync {
  private state: SyncState = INITIAL_STATE;
  private cache: Cache | null = null;
  private readonly telemetry: Telemetry;
  /** aborted when the worker stops for good */
  private readonly life = new AbortController();
  /** the open connection, aborted to reconnect */
  private connection: AbortController | null = null;
  private reconnectNow = false;
  /** set while the page is away (`pause`): the socket is closed and the loop waits to dial again */
  private paused = false;
  private resumeWaiter: (() => void) | null = null;

  private stream: StreamStatus = { state: "connecting", since: Date.now(), lastEventAt: null };
  private downSince: number | null = null;
  private opened = false;
  private stats = { connects: 0, resumes: 0, replayed: 0, maxDownMs: 0 };
  /** the connection's replay, until the stream reaches the hello's head */
  private replay: { head: number; count: number; resumed: boolean; downMs: number | null } | null = null;

  private pending: Patch[] = [];
  private frameHandle: number | undefined;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;

  private dirty: Dirty = cleanDirty();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();

  /** hydrations and refetches in flight, so an effect repeated before its answer does not fetch twice */
  private readonly fetching = new Set<string>();
  /** cold threads whose pages are being read, so two asks for one thread read it once */
  private readonly restoring = new Map<string, Promise<void>>();
  private clock = 0;
  /** per message, when it was last asked for and the wait its repeats have grown to; an entry older than
      REFETCH_STREAK_MS is forgotten the next time any message is asked for */
  private readonly refetchStreaks = new Map<string, { at: number; backoff: Backoff }>();

  /** the composer's outbox and drafts */
  readonly sender: Sender;
  /** this device's replies to asks, by book key, oldest first: what the cache holds under `ask:` (replies.ts) */
  private replies: Record<string, AskReply> = {};

  constructor(device: string, deviceClass: ConstructorParameters<typeof Telemetry>[1]) {
    this.telemetry = new Telemetry(
      device,
      deviceClass,
      (ids) => post({ type: "flushed", ids }),
      () => {
        const cache = this.cache;
        return cache ? { put: (rows) => cache.putRows(rows), forget: (ids) => cache.forgetRows(ids) } : null;
      },
    );
    this.sender = new Sender(() => this.cache, { device, deviceClass }, this.telemetry, post, this.life.signal);
  }

  async boot(open: string | null): Promise<void> {
    const started = performance.now();
    this.cache = await Cache.open({
      // an upgrade waits for a tab on an older build to let go: the page says so rather than waiting in silence
      blocked: () => post({ type: "cache", blocked: true }),
      unblocked: () => post({ type: "cache", blocked: false }),
      // a newer build upgraded the database under this page: it lets go, and what it holds in memory is its last word
      superseded: () => {
        this.cache = null;
        post({ type: "reload" });
      },
    });
    const loaded = await this.cache?.loadBoot().catch(() => null);
    if (loaded) {
      const cold: Record<string, Cold> = {};
      for (const head of loaded.heads) cold[head.key] = head;
      this.state = {
        ...INITIAL_STATE,
        cursor: loaded.cursor,
        fleet: loaded.fleet ?? EMPTY_FLEET,
        cold,
        counters: loaded.counters ?? INITIAL_STATE.counters,
      };
    }
    // the thread the url opens paints on the first frame, so its pages are read now; no other thread's are
    if (open) await this.restore(open, true);
    const ms = Math.round(performance.now() - started);
    const composer = (await this.cache?.loadComposer().catch(() => null)) ?? { drafts: {}, outbox: [], rows: [], replies: [] };
    this.sender.restore(composer.outbox, composer.drafts);
    this.telemetry.restore(composer.rows);
    const replies = restoreReplies(composer.replies);
    this.replies = replies.book;
    if (replies.dropped.length) void this.cache?.putReply(null, null, replies.dropped).catch(() => undefined);
    const views: Record<string, ThreadView> = {};
    for (const [key, thread] of Object.entries(this.state.threads)) views[key] = viewOf(thread);
    const sync: UiSync = { fleet: this.state.fleet, threads: views, stream: this.stream, drafts: composer.drafts, outbox: this.sender.views(), replies: Object.values(this.replies) };
    post({ type: "boot", sync });
    this.telemetry.emit("perf.cache", { what: "boot", threads: Object.keys(this.state.cold).length + Object.keys(this.state.threads).length, messages: Object.values(this.state.threads).reduce((n, t) => n + t.messages.length, 0) }, { ms, ok: true });
    void this.streamLoop();
  }

  /** a monotonic clock for recency: threads opened or held in one millisecond keep the order they were asked in */
  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  /** the person opens a thread. the reducer takes it first (a cold thread is promoted where it is, so the read of its pages
      cannot race an eviction of it), then a cold one comes back from the cache, so the wire is asked only for what the
      cache lacks */
  async open(key: string): Promise<void> {
    this.dispatch({ type: "open", key, at: this.tick() });
    await this.restore(key, false);
  }

  /** a thread held for another (a child's lane): taken and restored like an open, and counted apart from the person's own */
  async hold(key: string): Promise<void> {
    this.dispatch({ type: "hold", key, at: this.tick() });
    await this.restore(key, false);
  }

  release(key: string): void {
    this.dispatch({ type: "release", key });
  }

  /** a stage's retry: a thread waiting on its read reads again now; one the worker does not hold in memory (evicted, or never
      taken) is opened again, which restores or reads it */
  async reread(key: string): Promise<void> {
    if (this.state.threads[key]) this.dispatch({ type: "reread", key });
    else await this.open(key);
  }

  /** reads a cold thread's pages and puts it back in memory. reads of one thread are shared; an entry that passes the
      thread meanwhile is already marked in its head, which is what the restore reads when it lands */
  private restore(key: string, quiet: boolean): Promise<void> {
    const head = this.state.cold[key];
    if (!head) return Promise.resolve();
    const reading = this.restoring.get(key) ?? this.readPages(head, quiet).finally(() => this.restoring.delete(key));
    this.restoring.set(key, reading);
    return reading;
  }

  private async readPages(head: Cold, quiet: boolean): Promise<void> {
    const started = performance.now();
    let messages = (await this.cache?.loadPages(head).catch(() => null)) ?? null;
    if (!this.state.cold[head.key]) return; // evicted, or restored by another read, while the pages were coming
    if (messages) {
      // a cache written before parts were held in the daemon's order: shown right now, and written right
      const ordered = inDaemonOrderAll(messages);
      if (ordered.from !== null) {
        messages = ordered.messages;
        this.dirty.threads.set(head.key, Math.min(ordered.from, this.dirty.threads.get(head.key) ?? ordered.from));
        this.scheduleSave();
      }
    }
    // a head written before heads carried a size is measured now, once, from what was read; the thread is saved with it
    const bytes = messages && !head.sized ? JSON.stringify(messages).length : head.bytes;
    // and its head is written with it, so the next restore finds a size and measures nothing
    if (messages && !head.sized) this.dirty.threads.set(head.key, this.dirty.threads.get(head.key) ?? Number.POSITIVE_INFINITY);
    this.dispatch({ type: "restored", key: head.key, messages, ...(messages && !head.sized ? { bytes } : {}) }, quiet);
    this.telemetry.emit("perf.cache", { what: "restore", threads: 1, messages: messages?.length ?? 0, bytes }, { ms: Math.round(performance.now() - started), ok: messages !== null });
  }

  /** `quiet`: the ui is about to be told the whole state (boot), so the patches are not sent as well */
  dispatch(action: Action, quiet = false): void {
    const result = reduce(this.state, action);
    this.state = result.state;
    if (action.type === "restored") {
      // what came back from the cache is what the cache holds: only a thread that starts over is written, and its head alone
      // changes otherwise (a read that begins again)
      if (action.messages === null) this.dirty.threads.set(action.key, 0);
      else if (result.effects.length > 0) this.dirty.threads.set(action.key, this.dirty.threads.get(action.key) ?? Number.POSITIVE_INFINITY);
      if (!quiet && result.patches.length > 0) {
        this.pending.push(...result.patches);
        this.scheduleFrame();
      }
    } else if (result.patches.length > 0) {
      if (!quiet) this.pending.push(...result.patches);
      this.markDirty(result.patches);
      if (!quiet) this.scheduleFrame();
    }
    for (const effect of result.effects) this.run(effect);
    this.scheduleSave();
  }

  /* —— the stream —— */

  private async streamLoop(): Promise<void> {
    const backoff = new Backoff(500, 30_000);
    while (!this.life.signal.aborted) {
      if (this.paused) {
        await this.whilePaused();
        continue;
      }
      const connection = new AbortController();
      this.connection = connection;
      const stop = () => connection.abort();
      this.life.signal.addEventListener("abort", stop, { once: true });
      const connectsBefore = this.stats.connects;
      let signedOut = false;
      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (this.state.cursor) headers["last-event-id"] = formatCursor(this.state.cursor);
        const res = await fetch("/api/stream", { headers, signal: connection.signal, credentials: "same-origin", cache: "no-store" });
        if (res.status === 401) signedOut = true;
        else if (res.ok && res.body) await this.read(res.body, connection);
      } catch {
        /* aborted, refused or dropped: the connection is over either way */
      } finally {
        this.life.signal.removeEventListener("abort", stop);
      }
      if (this.life.signal.aborted) break;
      if (signedOut) {
        post({ type: "signed-out" });
        this.stop();
        break;
      }
      // a pause closed the socket on purpose: not a drop, nothing backs off
      if (this.paused) continue;
      this.wentDown();
      // a stream that went live and then dropped is the network, not a failing server: the next dial
      // starts from the floor, so a flaky link resumes in under a second; only dials that never
      // reach the hello back off (design.md: no "offline" for a resume under 5 s)
      if (this.stats.connects > connectsBefore) backoff.reset();
      const delay = this.reconnectNow ? 0 : backoff.nextDelay();
      this.reconnectNow = false;
      await sleep(delay, this.life.signal);
    }
  }

  private async read(body: ReadableStream<Uint8Array>, connection: AbortController): Promise<void> {
    const parser = new SseParser();
    const reader = body.getReader();
    let stall = setTimeout(() => connection.abort(), STALL_MS);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        clearTimeout(stall);
        stall = setTimeout(() => connection.abort(), STALL_MS);
        for (const frame of parser.push(value)) {
          this.onFrame(frame);
          if (connection.signal.aborted) return;
        }
      }
    } finally {
      clearTimeout(stall);
      reader.cancel().catch(() => undefined);
    }
  }

  private onFrame(sse: SseFrame): void {
    const frame = decodeFrame(sse.data);
    if (!frame) return;
    if (frame.type === "hello") {
      if (frame.protocol !== PROTOCOL) {
        post({ type: "reload" });
        this.stop();
        return;
      }
      this.wentLive(frame.head);
    }
    const epoch = parseCursor(sse.id)?.epoch;
    const resetting = frame.type === "reset";
    this.dispatch({ type: "frame", frame, epoch });
    this.sender.frame(frame);
    if (resetting) this.replayDone(false);
    else if (frame.type !== "hello") {
      this.stream = { ...this.stream, lastEventAt: Date.now() };
      if (this.replay) {
        this.replay.count++;
        if (frame.seq >= this.replay.head) this.replayDone(true);
      }
    }
  }

  private wentLive(head: number): void {
    const now = Date.now();
    const downMs = this.downSince === null ? null : now - this.downSince;
    if (downMs !== null) this.stats.maxDownMs = Math.max(this.stats.maxDownMs, downMs);
    this.downSince = null;
    this.stats.connects++;
    this.replay = { head, count: 0, resumed: this.state.cursor !== null, downMs };
    this.setStream({ state: "live", since: now, lastEventAt: this.stream.lastEventAt });
    const cursor = this.state.cursor;
    if (cursor && cursor.seq >= head) this.replayDone(true);
  }

  /** the connection caught up (or reset): the stream is live, and telemetry says how it got there */
  private replayDone(resumed: boolean): void {
    const replay = this.replay;
    if (!replay) return;
    this.replay = null;
    const didResume = resumed && replay.resumed;
    if (didResume) this.stats.resumes++;
    this.stats.replayed += replay.count;
    const props = { resumed: didResume ? 1 : 0, replayed: replay.count };
    if (!this.opened) this.telemetry.emit("app.stream", { state: "open", ...props });
    else this.telemetry.emit("app.stream", { state: "reopen", ...props, ...(replay.downMs === null ? {} : { downMs: replay.downMs }) });
    this.opened = true;
  }

  /** closes the stream's socket now, writes everything, and waits to dial again. a page on its way out would
      otherwise hold its connection for a minute after it is gone, and the browser allows six per host: the next
      page's hydration queued behind them (docs/gotchas.md, the sync worker) */
  async pause(): Promise<void> {
    this.paused = true;
    this.connection?.abort();
    await this.flush();
  }

  /** the page is back (restored from the back/forward cache): the loop dials at once */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.reconnectNow = true;
    this.resumeWaiter?.();
  }

  private whilePaused(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.resumeWaiter = null;
        this.life.signal.removeEventListener("abort", done);
        resolve();
      };
      this.resumeWaiter = done;
      this.life.signal.addEventListener("abort", done, { once: true });
    });
  }

  private wentDown(): void {
    if (this.downSince !== null) return;
    this.downSince = Date.now();
    this.replay = null;
    if (this.opened) this.telemetry.emit("app.stream", { state: "error" });
    this.setStream({ state: "down", since: this.downSince, lastEventAt: this.stream.lastEventAt });
  }

  private setStream(stream: StreamStatus): void {
    this.stream = stream;
    post({ type: "stream", stream });
    this.sender.stream(stream.state);
  }

  /* —— effects —— */

  private run(effect: Effect): void {
    switch (effect.type) {
      case "reconnect":
        this.reconnectNow = true;
        this.connection?.abort();
        return;
      case "hydrate":
        void this.hydrate(effect.key, effect.hydration);
        return;
      case "refetch":
        void this.refetch(effect.key, effect.messageID, effect.hydration);
        return;
      case "evicted":
        this.dirty.threads.set(effect.key, 0);
        this.telemetry.emit("perf.cache", { what: "evict", threads: 1, bytes: effect.bytes, opened: effect.opened ? 1 : 0, cap: effect.cap });
        return;
      case "head":
        this.dirty.threads.set(effect.key, this.dirty.threads.get(effect.key) ?? Number.POSITIVE_INFINITY);
        return;
      default:
        effect satisfies never;
    }
  }

  private async hydrate(key: string, hydration: number): Promise<void> {
    const job = `hydrate ${key} ${hydration}`;
    const place = splitKey(key);
    if (!place || this.fetching.has(job)) return;
    this.fetching.add(job);
    const backoff = new Backoff(1000, 30_000);
    try {
      const read = await readTranscript({
        path: `/api/hosts/${encodeURIComponent(place.host)}/sessions/${encodeURIComponent(place.session)}/messages`,
        get: (path) => this.get(path),
        // the thread must still be the one this read was made for: one evicted and held again has another number
        wanted: () => !this.life.signal.aborted && this.state.threads[key]?.hydration === hydration,
        wait: (ms) => sleep(ms, this.life.signal),
        nextDelay: () => backoff.nextDelay(),
        failed: (trouble) => this.dispatch({ type: "read-failed", key, hydration, trouble }),
      });
      if (read === null || read === "signed-out") return;
      this.dispatch({ type: "hydrated", key, hydration, upstreamEpoch: read.at.epoch, at: read.at.seq, messages: read.messages, bytes: read.bytes });
      this.sender.read(key, read.messages);
    } finally {
      this.fetching.delete(job);
    }
  }

  /** how long a refetch of this message waits before it goes out: none the first time, then longer for each
      ask that follows closely, so a message the daemon keeps answering short of what is needed is not hammered */
  private refetchDelay(job: string): number {
    const now = Date.now();
    for (const [name, streak] of this.refetchStreaks) if (now - streak.at >= REFETCH_STREAK_MS) this.refetchStreaks.delete(name);
    const last = this.refetchStreaks.get(job);
    const backoff = last?.backoff ?? new Backoff(REFETCH_BACKOFF_MS.floor, REFETCH_BACKOFF_MS.cap);
    this.refetchStreaks.set(job, { at: now, backoff });
    return last ? backoff.nextDelay() : 0;
  }

  /** `hydration` is the number of the thread's read when it asked: the job is that incarnation's, and its answer goes to no
      other (a thread evicted and held again has another number, and may be waiting on the same message) */
  private async refetch(key: string, messageID: string, hydration: number): Promise<void> {
    const job = `refetch ${key} ${hydration} ${messageID}`;
    const place = splitKey(key);
    if (!place || this.fetching.has(job)) return;
    this.fetching.add(job);
    // the job ends before its answer is dispatched: the answer can ask for the same message again (a hole the
    // snapshot did not close), and that ask has to find the job gone
    let released = false;
    const release = () => {
      if (released) return; // a job the answer started under the same name is not this one's to end
      released = true;
      this.fetching.delete(job);
    };
    const backoff = new Backoff(1000, 30_000);
    const path = `/api/hosts/${encodeURIComponent(place.host)}/sessions/${encodeURIComponent(place.session)}/messages/${encodeURIComponent(messageID)}`;
    const wanted = () => !this.life.signal.aborted && this.state.threads[key]?.hydration === hydration && this.state.threads[key]?.refetching[messageID] !== undefined;
    try {
      // the streak is the message's, across incarnations of the thread: asking again soon is the daemon answering short
      await sleep(this.refetchDelay(`refetch ${key} ${messageID}`), this.life.signal);
      while (wanted()) {
        const res = await this.get(path);
        if (!wanted()) {
          void res?.body?.cancel().catch(() => undefined);
          return;
        }
        if (res?.status === 404) {
          void res.body?.cancel().catch(() => undefined);
          release();
          this.dispatch({ type: "refetched", key, hydration, messageID, message: null });
          return;
        }
        if (res?.ok) {
          const message = (await res.json().catch(() => null)) as Message | null;
          if (!wanted()) return;
          if (message?.info) {
            release();
            this.dispatch({ type: "refetched", key, hydration, messageID, message });
            this.sender.read(key, [message]);
            return;
          }
        }
        void res?.body?.cancel().catch(() => undefined);
        if (res?.status === 401) return;
        await sleep(backoff.nextDelay(), this.life.signal);
      }
    } finally {
      release();
    }
  }

  private async get(path: string): Promise<Response | null> {
    try {
      return await fetch(path, { credentials: "same-origin", cache: "no-store", signal: this.life.signal });
    } catch {
      return null;
    }
  }

  /* —— patches, once a frame —— */

  private scheduleFrame(): void {
    if (this.frameTimer !== undefined) return;
    this.frameTimer = setTimeout(() => this.flushPatches(), FRAME_FALLBACK_MS);
    if (scope.requestAnimationFrame) this.frameHandle = scope.requestAnimationFrame(() => this.flushPatches());
  }

  private flushPatches(): void {
    clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
    if (this.frameHandle !== undefined) scope.cancelAnimationFrame?.(this.frameHandle);
    this.frameHandle = undefined;
    if (this.pending.length === 0) return;
    const patches = coalesce(this.pending);
    this.pending = [];
    post({ type: "patches", patches });
  }

  /* —— the cache —— */

  private markDirty(patches: readonly Patch[]): void {
    for (const { path } of patches) {
      if (path[0] === "fleet") {
        this.dirty.fleet = true;
      } else if (path[0] === "threads" && typeof path[1] === "string") {
        const index = path[2] === "messages" && typeof path[3] === "number" ? path[3] : path[2] === "status" ? Number.POSITIVE_INFINITY : 0;
        this.dirty.threads.set(path[1], Math.min(index, this.dirty.threads.get(path[1]) ?? Number.POSITIVE_INFINITY));
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer === undefined && this.cache) this.saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  /** writes the cursor and what changed, from the state as it is now; saves run one after another */
  save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const cache = this.cache;
    if (!cache) return Promise.resolve();
    const state = this.state;
    const dirty = this.dirty;
    this.dirty = cleanDirty();
    this.saving = this.saving.then(() =>
      cache.save(state, dirty).catch(() => {
        // the write failed whole, so everything it held is still to write
        this.dirty.fleet ||= dirty.fleet;
        for (const [key, from] of dirty.threads) this.dirty.threads.set(key, Math.min(from, this.dirty.threads.get(key) ?? from));
        this.scheduleSave();
      }),
    );
    return this.saving;
  }

  /** the page is hidden or leaving: everything goes out now */
  async flush(): Promise<void> {
    this.flushPatches();
    await Promise.all([this.save(), this.telemetry.flush(true), this.sender.flush()]);
  }

  /* —— the ui's questions —— */

  counters(): SyncCounters {
    const cursor = this.state.cursor;
    return {
      ...this.state.counters,
      cursor: cursor ? formatCursor(cursor) : null,
      epoch: cursor?.epoch ?? null,
      ...this.stats,
    };
  }

  transcript(key: string): string {
    return JSON.stringify(this.state.threads[key]?.messages ?? null);
  }

  /** a telemetry event the ui measured (a paint, a send's echo): the worker owns the queue */
  emit(event: Emit): void {
    this.telemetry.emitAny(event.kind, event.props as Record<string, unknown>, event.envelope);
  }

  stop(): void {
    this.life.abort();
    this.connection?.abort();
    clearTimeout(this.frameTimer);
    clearTimeout(this.saveTimer);
    if (this.frameHandle !== undefined) scope.cancelAnimationFrame?.(this.frameHandle);
    this.telemetry.stop();
  }

  /** keeps a reply's record, in memory and in the cache, and lets go of what fell past the cap. a write that fails costs the record
      after a reload, nothing more: the row says the time alone then, as it would for another device's answer */
  replied(record: AskReply): void {
    const kept = keepReply(this.replies, record);
    this.replies = kept.book;
    void this.cache?.putReply(replyKey(record.thread, record.callID), record, kept.dropped).catch(() => undefined);
  }

  async forget(): Promise<void> {
    this.replies = {};
    this.stop();
    await this.telemetry.flush();
    await this.saving;
    await this.cache?.clear().catch(() => undefined);
    this.cache?.close();
    this.cache = null;
  }
}

let sync: Sync | null = null;
let ready: Promise<void> = Promise.resolve();

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "start") {
    if (sync) return;
    const started = new Sync(message.device, message.deviceClass);
    sync = started;
    ready = started.boot(message.open);
    return;
  }
  // everything else waits for boot, so an open sent at launch lands on the cached state
  void ready.then(async () => {
    const current = sync;
    if (!current) return;
    switch (message.type) {
      case "open":
        await current.open(message.key);
        return;
      case "hold":
        await current.hold(message.key);
        return;
      case "release":
        current.release(message.key);
        return;
      case "reread":
        await current.reread(message.key);
        return;
      case "flush":
        await current.flush();
        return;
      case "pause":
        await current.pause();
        return;
      case "resume":
        current.resume();
        return;
      case "sign-out":
        await current.forget();
        post({ type: "reply", id: message.id, value: true });
        return;
      case "ask":
        post({ type: "reply", id: message.id, value: message.query === "counters" ? current.counters() : current.transcript(message.key) });
        return;
      case "telemetry":
        current.emit(message);
        return;
      case "draft":
        current.sender.draft(message.key, message.draft, message.abandoned);
        return;
      case "send":
        current.sender.send(message.outgoing);
        return;
      case "retry":
        current.sender.retry(message.clientID);
        return;
      case "discard":
        current.sender.discard(message.clientID, message.photosToDraft);
        return;
      case "unsend":
        await current.sender.unsend(message.key, message.messageID, message.clientID, message.toDraft);
        return;
      case "replied":
        current.replied(message.record);
        return;
      default:
        message satisfies never;
    }
  });
});
