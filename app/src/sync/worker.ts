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
import { Cache, type SaveStats, Saver, weight } from "./cache";
import { PageGate } from "./gate";
import type { Emit, FromWorker, StreamStatus, SyncCounters, ToWorker, UiSync } from "./messages";
import { inDaemonOrderAll } from "./order";
import { formatCursor, type Frame, type Message, parseCursor, PROTOCOL, routeFrame, splitKey } from "./protocol";
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
import { FRAME_CAP, SseOverflow, SseParser, type SseFrame } from "./sse";
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
/** the save's wait while a part streams (`Saver`): a second's words, ticks and cursor in one write instead of five */
const STREAMING_SAVE_MS = 1000;
/** how often the worker says what its connection cost it (`perf.sync`) */
const TALLY_MS = 60_000;
/** patches wait for the next animation frame, or this long where a worker has none or the tab is hidden */
const FRAME_FALLBACK_MS = 50;
/** a message asked for again within this long of its last ask is coming back stale, so it waits before it is fetched */
const REFETCH_STREAK_MS = 5_000;
const REFETCH_BACKOFF_MS = { floor: 250, cap: 8_000 };
/** a thread nobody shows is cooled (its messages leave memory, its pages stay in the cache) this long after it closed */
export const COOL_AFTER_MS = 5 * 60_000;
/** the threads closed last stay warm whatever their age, so going back to one of them reads nothing */
export const KEEP_WARM = 3;
/** while threads nobody shows are warm, they are looked at again at least this often (a session that stopped being busy) */
const COOL_SWEEP_MS = 30_000;

/** everything the worker says to the ui goes through it: held while the page is hidden (gate.ts) */
const gate = new PageGate((message) => scope.postMessage(message));

function post(message: FromWorker) {
  gate.send(message);
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

/** exported for its tests; the worker runs the one the `start` message makes */
export class Sync {
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
  /** the threads the ui shows (the stage, the layers under it, the children it holds): the only ones its store holds, so the
      only ones whose patches go to it (`show`, `hide`) */
  private readonly shown = new Set<string>();
  /** when each thread the ui let go of was closed, for the sweep that cools it (`sweep`) */
  private readonly closedAt = new Map<string, number>();
  /** when each thread a press shows had closed (0 for one that was cold), for the hide that follows when no open did */
  private readonly pressedFrom = new Map<string, number>();
  private coolTimer: ReturnType<typeof setTimeout> | undefined;
  private sweeping = false;
  /** a sweep was asked for while one waited on its save: it runs again when that one ends */
  private sweepAgain = false;
  private frameHandle: number | undefined;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly saver = new Saver(
    () => this.cache,
    () => this.state,
    SAVE_DEBOUNCE_MS,
    (stats) => this.tallySave(stats),
    STREAMING_SAVE_MS,
  );
  /** what the connection cost since `since`, told once a minute while it is up (`perf.sync`): counts and sizes, no content */
  private tally = { since: 0, frames: 0, received: 0, posts: 0, patches: 0, posted: 0, saves: 0, puts: 0, stored: 0 };

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

  /** the connection carried a board frame: when it ends, the ui is told the board went with it */
  private boardSeen = false;

  /** `board`: this device may sit beside a board, so its stream asks for board frames (docs/board.md) */
  /** `frameCap`: the most text one sse frame may hold (sse.ts), smaller only in tests */
  /** `now`: the clock threads are cooled by */
  constructor(
    device: string,
    deviceClass: ConstructorParameters<typeof Telemetry>[1],
    private readonly board = false,
    private readonly frameCap = FRAME_CAP,
    /** the clock the sweep reads, a test's own in tests */
    private readonly now: () => number = Date.now,
  ) {
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
    // the thread the url opens paints on the first frame, so its pages are read now; no other thread's are. the ui shows it
    // (its open, sent next, says so too)
    if (open) this.shown.add(open);
    if (open) await this.restore(open, true);
    const ms = Math.round(performance.now() - started);
    const composer = (await this.cache?.loadComposer(open).catch(() => null)) ?? { drafts: {}, outbox: [], rows: [], replies: [] };
    this.sender.restore(composer.outbox, composer.drafts);
    this.telemetry.restore(composer.rows);
    const replies = restoreReplies(composer.replies);
    this.replies = replies.book;
    if (replies.dropped.length) void this.cache?.putReply(null, null, replies.dropped).catch(() => undefined);
    const views: Record<string, ThreadView> = {};
    for (const [key, thread] of Object.entries(this.state.threads)) if (this.shown.has(key)) views[key] = viewOf(thread);
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

  /** the ui shows a thread (on stage, a layer under it, a child it holds): it gets the thread as the worker holds it now, and
      every patch to it from here. one that is cold comes back from the cache first */
  show(key: string, press = false): void {
    if (this.shown.has(key)) return;
    this.shown.add(key);
    if (press) this.pressedFrom.set(key, this.closedAt.get(key) ?? 0);
    else this.pressedFrom.delete(key);
    this.closedAt.delete(key);
    const thread = this.state.threads[key];
    if (thread) {
      this.pending.push({ path: ["threads", key], value: viewOf(thread) });
      this.scheduleFrame();
    } else void this.restore(key, false);
  }

  /** the ui no longer shows a thread: its store lets go of it, and the worker cools it in time (`sweep`). a press that no
      open followed (`press`) puts it back where it was among the closed: the person never saw it, so it must not push a
      thread they did see out of the KEEP_WARM */
  hide(key: string, press = false): void {
    if (!this.shown.delete(key)) return;
    const before = this.pressedFrom.get(key);
    this.pressedFrom.delete(key);
    this.closedAt.set(key, press && before !== undefined ? before : this.now());
    this.pending.push({ path: ["threads", key], value: undefined, closed: true });
    this.scheduleFrame();
    void this.sweep();
  }

  /** cools the threads nobody shows, keeping warm the ones a session is busy in, the ones held for another, and the
      KEEP_WARM the person closed last; the rest go COOL_AFTER_MS after they closed (a lane's child is shown, and so warm,
      for as long as its parent is drawn, released or not). a
      thread goes only once the cache holds its pages exactly as memory does: everything marked is saved first, and one
      that changed meanwhile waits for the next sweep. without a cache nothing is cooled (its pages would be lost) */
  async sweep(): Promise<void> {
    clearTimeout(this.coolTimer);
    this.coolTimer = undefined;
    if (!this.cache || this.life.signal.aborted) return;
    if (this.sweeping) {
      this.sweepAgain = true;
      return;
    }
    const now = this.now();
    const busy = (key: string) => {
      const status = this.state.fleet.sessions[key]?.status?.type;
      return status === "busy" || status === "retry";
    };
    const warm = Object.values(this.state.threads).filter((t) => !this.shown.has(t.key));
    for (const t of warm) if (!this.closedAt.has(t.key)) this.closedAt.set(t.key, now);
    const closed = (key: string) => this.closedAt.get(key) ?? now;
    const due: string[] = [];
    let next = Number.POSITIVE_INFINITY;
    let kept = 0;
    for (const t of [...warm].sort((a, b) => closed(b.key) - closed(a.key))) {
      if (t.leased || busy(t.key)) {
        next = Math.min(next, now + COOL_SWEEP_MS);
        continue;
      }
      // the person's own threads closed last stay; a child held for a lane goes in time like the rest
      if (t.openedAt > 0 && kept < KEEP_WARM) {
        kept++;
        continue;
      }
      const at = closed(t.key) + COOL_AFTER_MS;
      if (at <= now) due.push(t.key);
      else next = Math.min(next, at);
    }
    if (due.length > 0) {
      this.sweeping = true;
      try {
        await this.saver.save();
        await this.saver.idle();
      } finally {
        this.sweeping = false;
      }
      // a worker that stopped meanwhile (a sign-out) changes nothing more
      if (this.life.signal.aborted) return;
      if (this.sweepAgain) {
        this.sweepAgain = false;
        return this.sweep();
      }
      const threads: Record<string, number> = {};
      for (const key of due) {
        const pages = this.coolable(key);
        if (pages === null) next = Math.min(next, this.now() + COOL_SWEEP_MS);
        else threads[key] = pages;
      }
      if (Object.keys(threads).length > 0) this.dispatch({ type: "cool", threads });
      for (const key of Object.keys(threads)) if (!this.state.threads[key]) this.closedAt.delete(key);
      // one the reducer kept (a read or a refetch began) is looked at again
      if (Object.keys(threads).some((key) => this.state.threads[key])) next = Math.min(next, this.now() + COOL_SWEEP_MS);
    }
    for (const key of this.closedAt.keys()) if (!this.state.threads[key]) this.closedAt.delete(key);
    if (Number.isFinite(next) && !this.life.signal.aborted) this.coolTimer = setTimeout(() => void this.sweep(), Math.max(0, next - this.now()));
  }

  /** the pages a thread nobody shows has in the cache, when the cache holds it exactly as memory does now (nothing of it is
      marked or being written, its pages are this cache's own, and it is not being read again); null when it does not */
  private coolable(key: string): number | null {
    const thread = this.state.threads[key];
    if (!this.cache || !thread || this.shown.has(key) || thread.status !== "live" || !this.saver.clean(key)) return null;
    const pages = this.cache.pagesOf(key);
    // the pages on disk are the ones this cache wrote for these messages, in the layout it knows they lie in
    return pages !== null && pages.count === thread.messages.length ? pages.pages : null;
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
        this.saver.markThread(head.key, ordered.from);
        this.saver.schedule();
      }
    }
    // a head written before heads carried a size is measured now, once, from what was read; the thread is saved with it
    const bytes = messages && !head.sized ? JSON.stringify(messages).length : head.bytes;
    // and its head is written with it, so the next restore finds a size and measures nothing
    if (messages && !head.sized) this.saver.markThread(head.key, Number.POSITIVE_INFINITY);
    this.dispatch({ type: "restored", key: head.key, messages, ...(messages && !head.sized ? { bytes } : {}) }, quiet);
    // a thread back in memory that nobody shows is cooled in time like any (its open may have come and gone meanwhile)
    if (!this.shown.has(head.key)) void this.sweep();
    this.telemetry.emit("perf.cache", { what: "restore", threads: 1, messages: messages?.length ?? 0, bytes }, { ms: Math.round(performance.now() - started), ok: messages !== null });
  }

  /** `quiet`: the ui is about to be told the whole state (boot), so the patches are not sent as well */
  dispatch(action: Action, quiet = false): void {
    const result = reduce(this.state, action);
    this.state = result.state;
    if (action.type === "restored" || action.type === "cool") {
      // what came back from the cache, or went to it, is what the cache holds: only a thread that starts over is written, and
      // its head alone changes otherwise (a read that begins again)
      if (action.type === "restored") {
        if (action.messages === null) this.saver.markThread(action.key, 0);
        else if (result.effects.length > 0) this.saver.markThread(action.key, Number.POSITIVE_INFINITY);
      }
      if (!quiet) this.toUi(result.patches);
    } else if (result.patches.length > 0) {
      if (!quiet) this.toUi(result.patches);
      this.saver.mark(result.patches);
    }
    for (const effect of result.effects) this.run(effect);
    this.saver.schedule();
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
      let overflowed = false;
      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (this.state.cursor) headers["last-event-id"] = formatCursor(this.state.cursor);
        // the app always asks for the repo colours, which travel beside the journal (protocol.ts, `ColourFrame`)
        const res = await fetch(this.board ? "/api/stream?colours=1&board=1" : "/api/stream?colours=1", { headers, signal: connection.signal, credentials: "same-origin", cache: "no-store" });
        if (res.status === 401) signedOut = true;
        else if (res.ok && res.body) overflowed = (await this.read(res.body, connection)) === "overflow";
      } catch {
        /* aborted, refused or dropped: the connection is over either way */
      } finally {
        this.life.signal.removeEventListener("abort", stop);
        this.boardLost();
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
      // reach the hello back off (design.md: no "offline" for a resume under 5 s). a frame past the parser's cap is not the
      // network: the server sends it again on the next dial, so that dial backs off like one that never went live
      if (this.stats.connects > connectsBefore && !overflowed) backoff.reset();
      const delay = this.reconnectNow ? 0 : backoff.nextDelay();
      this.reconnectNow = false;
      await sleep(delay, this.life.signal);
    }
  }

  /** reads one connection's frames until it ends; "overflow" when it was dropped for a frame past the cap */
  private async read(body: ReadableStream<Uint8Array>, connection: AbortController): Promise<"overflow" | undefined> {
    const parser = new SseParser(this.frameCap);
    const reader = body.getReader();
    // one timer watches the time of the last byte, and is armed again only when it fires: a chunk costs a clock read, not
    // a timer cleared and a timer set, and the stream still drops STALL_MS after its last byte
    let lastByte = performance.now();
    let stall: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      const quiet = performance.now() - lastByte;
      if (quiet >= STALL_MS) connection.abort();
      else stall = setTimeout(watch, STALL_MS - quiet);
    };
    stall = setTimeout(watch, STALL_MS);
    this.tallyStart();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return undefined;
        lastByte = performance.now();
        this.tally.received += value.byteLength;
        if (lastByte - this.tally.since >= TALLY_MS) this.tallyEmit(lastByte);
        for (const frame of parser.push(value)) {
          this.onFrame(frame);
          if (connection.signal.aborted) return undefined;
        }
      }
    } catch (error) {
      // a frame past the parser's cap: no well-formed stream sends one, so the connection is dropped, said once, and resumed
      // from the cursor like any drop
      if (!(error instanceof SseOverflow)) throw error;
      this.telemetry.emit("perf.sync", { what: "overflow", received: error.held });
      connection.abort();
      return "overflow";
    } finally {
      clearTimeout(stall);
      this.tallyEmit(performance.now());
      reader.cancel().catch(() => undefined);
    }
  }

  /* —— what the connection costs (`perf.sync`) —— */

  private tallyStart(): void {
    this.tally = { since: performance.now(), frames: 0, received: 0, posts: 0, patches: 0, posted: 0, saves: 0, puts: 0, stored: 0 };
  }

  /** the window so far, when anything came in it, and a new window from `now` */
  private tallyEmit(now: number): void {
    const { since, ...counts } = this.tally;
    // a worker that stopped (a sign-out) writes no more rows
    if (counts.received > 0 && !this.life.signal.aborted) this.telemetry.emit("perf.sync", { what: "minute", ...counts }, { ms: Math.round(now - since) });
    this.tallyStart();
  }

  private tallySave(stats: SaveStats): void {
    this.tally.saves++;
    this.tally.puts += stats.puts;
    this.tally.stored += stats.bytes;
  }

  private onFrame(sse: SseFrame): void {
    this.tally.frames++;
    const routed = routeFrame(sse.data, this.board, true);
    if (!routed) return;
    // so is a colour frame: the reducer takes it as an action of its own, never as an entry
    if (routed.to === "colours") {
      this.dispatch(routed.frame);
      return;
    }
    // a board frame is outside the journal: it moves no cursor, no seq and no replay count
    if (routed.to === "board") {
      this.boardSeen = routed.frame.type !== "board.gone";
      post({ type: "board", frame: routed.frame });
      return;
    }
    const frame = routed.frame;
    if (frame.type === "hello") {
      if (frame.protocol !== PROTOCOL) {
        post({ type: "reload" });
        this.stop();
        return;
      }
      this.wentLive(frame.head);
    }
    const epoch = parseCursor(sse.id)?.epoch;
    if (frame.type === "reset") return this.reset(frame, epoch);
    this.dispatch({ type: "frame", frame, epoch });
    this.sender.frame(frame);
    if (frame.type !== "hello") {
      // the status the ui holds is a copy (`setStream` posts it), so the worker's own is changed in place, not made anew per frame
      this.stream.lastEventAt = Date.now();
      if (this.replay) {
        this.replay.count++;
        if (frame.seq >= this.replay.head) this.replayDone(true);
      }
    }
  }

  /** the server could not replay from the cursor: the threads on screen are read again, and every other thread whose pages the
      cache holds as memory does goes cold and stale (read again when it is wanted), so a reset costs what is on screen. one
      with changes not yet on disk is read again, as every thread was before. the reset lands at once, never after a save:
      the stream said live at the hello, and its caught-up second (ui/caught-up.ts) must find the snapshot's fleet in the
      store */
  private reset(frame: Extract<Frame, { type: "reset" }>, epoch: string | undefined): void {
    const cool: Record<string, number> = {};
    for (const key of Object.keys(this.state.threads)) {
      const pages = this.coolable(key);
      if (pages !== null) cool[key] = pages;
    }
    this.dispatch({ type: "frame", frame, epoch, cool });
    this.sender.frame(frame);
    this.replayDone(false);
    for (const key of Object.keys(cool)) this.closedAt.delete(key);
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

  /** a connection that carried a board ended (a drop, a pause, a stop): the next one may come from a mac the board has
      left, and one that never comes must not leave digits standing, so the ui drops them now. the server sends
      `board.here` again on a stream that opens while the board is here */
  private boardLost(): void {
    if (!this.boardSeen) return;
    this.boardSeen = false;
    post({ type: "board", frame: { type: "board.gone" } });
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
        this.saver.markThread(effect.key, 0);
        this.telemetry.emit("perf.cache", { what: "evict", threads: 1, bytes: effect.bytes, opened: effect.opened ? 1 : 0, cap: effect.cap });
        return;
      case "head":
        this.saver.markThread(effect.key, Number.POSITIVE_INFINITY);
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

  /** the patches the ui's store takes: a thread's only while it shows it, so the store holds what is on screen and no more */
  private toUi(patches: readonly Patch[]): void {
    let any = false;
    for (const patch of patches) {
      const [top, key] = patch.path;
      if (top === "threads" && typeof key === "string" && !this.shown.has(key)) continue;
      this.pending.push(patch);
      any = true;
    }
    if (any) this.scheduleFrame();
  }

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
    this.tally.posts++;
    this.tally.patches += patches.length;
    this.tally.posted += weight(patches);
    post({ type: "patches", patches });
  }

  /* —— the cache —— */

  /** writes the cursor and what changed, from the state as it is when the write starts (`Saver`) */
  save(): Promise<void> {
    return this.saver.save();
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
    clearTimeout(this.coolTimer);
    this.saver.stop();
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
    await this.saver.idle();
    await this.cache?.clear().catch(() => undefined);
    this.cache?.close();
    this.cache = null;
  }
}

let sync: Sync | null = null;
let ready: Promise<void> = Promise.resolve();

scope.addEventListener("message", (event) => {
  const message = event.data;
  // the page's visibility is the gate's, whatever the worker is doing: it takes effect at once, boot or not
  if (message.type === "visibility") return gate.setHidden(message.hidden);
  if (message.type === "start") {
    gate.setHidden(message.hidden);
    if (sync) return;
    const started = new Sync(message.device, message.deviceClass, message.board);
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
      case "show":
        current.show(message.key, message.press === true);
        return;
      case "hide":
        current.hide(message.key, message.press === true);
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
      case "photos":
        post({ type: "photos", key: message.key, photos: await current.sender.photos(message.key) });
        return;
      default:
        message satisfies never;
    }
  });
});
