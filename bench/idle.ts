/* the idle-cost run: what the app costs the device while a fleet streams and
   nobody touches it (docs/design.md, buttery as numbers; docs/verification.md,
   the budget run). the field number this answers to: the installed app at
   about 20% of a core with the display asleep, receiving ~21 KB/s.

     just build && bun bench/idle.ts [--minutes 3] [--warm 20] [--streams 10] [--done 100]
                                    [--only home,thread,hidden] [--keep-traces]

   it owns its world (bench/windows.ts: the pinned daemon, the bench model,
   the release binary, repos under /tmp), on the dev ports: the daemon on
   4840 and the model on 4841 (IDLE_DAEMON_PORT moves both within the port
   rule), boxbox on 3001 (IDLE_BOXBOX_PORT), and refuses to start if any of
   them answer. CMX2_REPO names the cmx2 checkout that holds cmx2.pin. the
   fleet: `--streams` sessions streaming for the whole run (five do a
   window's worth of tool work first), `--done` finished ones, and one
   thread kept quiet until the thread mode starts its long reply. a counting
   proxy in front of boxbox sees every byte the page and its sync worker
   receive.

   three modes, each in a freshly loaded page (the device cache warm from
   the run before), `--warm` seconds to settle, then `--minutes` measured:

     home     home visible at 1512 x 945 while the fleet streams
     thread   the quiet thread opened while its reply streams long text (one
              word every 40 ms for the whole window), the fleet streaming
     hidden   home, then the page told it is hidden (below), while the fleet
              streams

   per mode it prints the raw numbers and one json line, then a summary
   table, the build id, and each budget against its target (exit 1 when one
   is missed): main thread busy (union of top-level tasks) per minute and as
   a share of one core, split by self time into script, style, layout,
   paint and gc; long tasks over 50 ms; the sync worker's busy time and gc;
   the renderer process's cpu from SystemInfo.getProcessInfo (every thread of the page's process:
   main, worker, compositor, raster); the page's js heap from
   Performance.getMetrics every 5 s (start, peak, end); each thread's heap
   after its last gc and its allocation rate, from the gc events in the
   trace (the worker's heap is not readable any other way); bytes received;
   worker posts a minute and, per post, main thread ms, layouts and paints
   (frames and layouts follow the post rate, which shifts from run to run,
   so the per-post numbers are what compare builds on a busy machine);
   frames a second; dom writes a minute from a MutationObserver, and those
   that set the value already there; the load average at each window's
   start and end. the streams' prompts go out 20 ms apart from one start,
   so their words meet the server's 200 ms session ticks the same way each
   run.

   what this cannot answer, and why it is still the gate:
   - it is chromium (agent-browser's build, headless, through playwright-core
     over cdp), not the webkit people run. webkit has no trace a script can
     read and playwright's webkit is not installed here, so absolute numbers
     differ from an iphone's; the run is the same every time, so before and
     after on one machine is what it judges.
   - headless chromium never reports a page hidden (minimising or covering
     the window does not either, under automation), so `hidden` overrides
     document.visibilityState and document.hidden and fires visibilitychange:
     the app takes its hidden path, but the browser keeps producing frames.
     that is the worst case and, by the investigation, the likely field case:
     a mac with its display asleep may leave the page visible.
   - loopback, a fleet of ~110 sessions (the field holds up to 1000), minutes
     not hours. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const MINUTES = Number(flag("--minutes", "3"));
const WARM_S = Number(flag("--warm", "20"));
const STREAMS = Number(flag("--streams", "10"));
const DONE = Number(flag("--done", "100"));
const ONLY = flag("--only", "home,thread,hidden").split(",");
const KEEP_TRACES = args.includes("--keep-traces");
const MODES = (["home", "thread", "hidden"] as const).filter((m) => ONLY.includes(m));
type Mode = (typeof MODES)[number];
const EVERY_MS = 60;
const LONG_EVERY_MS = 40;
const SCRATCH = "/tmp/boxbox-idle";

// the world reads its ports and directory when it loads, so they are set before the import
process.env.WINDOWS_DAEMON_PORT ??= process.env.IDLE_DAEMON_PORT ?? "4840";
process.env.WINDOWS_BOXBOX_PORT ??= process.env.IDLE_BOXBOX_PORT ?? "3001";
process.env.WINDOWS_WORLD ??= join(SCRATCH, "world");
const { APP, log, until, World, WORLD } = await import("./windows");
type Thread = import("./windows").Thread;

/** agent-browser's chrome for testing, the build the other browser benches drive; CHROME names another */
function chromePath(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const dir = join(homedir(), ".agent-browser", "browsers");
  const builds = existsSync(dir) ? spawnSync("ls", [dir], { encoding: "utf8" }).stdout.split("\n").filter((d) => d.startsWith("chrome-")).sort() : [];
  const last = builds.at(-1);
  const path = last && join(dir, last, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  if (!path || !existsSync(path)) throw new Error("no chrome found: install agent-browser's (agent-browser install) or set CHROME");
  return path;
}

/* ---------- the fleet ---------- */
/** the streams' prompts go out this far apart, from one start, so where each stream's words fall against the server's
    200 ms session ticks is the same every run (the worker's post rate, and with it frames and layouts, follows them) */
const STAGGER_MS = 20;

function fleet(words: number): { streams: Thread[]; quiet: Thread[] } {
  const files = ["invoices.md", "greeting.md", "changelog.md", "pricing.md", "search.md"];
  const list: Thread[] = [];
  const quiet: Thread[] = [];
  for (let i = 0; i < STREAMS; i++) {
    const repo = i % 2 === 0 ? "ledger" : "site";
    const file = files[i];
    const prompt = file ? `[bench:work ${words} ${EVERY_MS} ${file}] stream ${i + 1}` : `[bench:words ${words} ${EVERY_MS}] stream ${i + 1}`;
    list.push({ repo, title: `stream ${i + 1}`, prompt });
  }
  for (let i = 0; i < DONE; i++) quiet.push({ repo: i % 2 === 0 ? "ledger" : "site", title: `done ${i + 1}`, prompt: "summarise the changelog in one line" });
  quiet.push({ repo: "ledger", title: "the long reply", prompt: "summarise the changelog in one line" });
  return { streams: list, quiet };
}

/** the streams: every session made first, then each prompt sent at its fixed offset from one start */
async function startStreams(world: InstanceType<typeof World>, streams: Thread[]): Promise<void> {
  const made: Array<{ id: string; thread: Thread }> = [];
  for (const thread of streams) {
    const created = await world.daemon("POST", "/session", { directory: join(WORLD, "repos", thread.repo), title: thread.title });
    if (!created.ok) throw new Error(`POST /session answered ${created.status}: ${await created.text()}`);
    const { id } = (await created.json()) as { id: string };
    made.push({ id, thread });
    world.sessions.push({ id, key: `bench:${id}`, thread });
  }
  const t0 = performance.now();
  for (const [i, { id, thread }] of made.entries()) {
    const wait = t0 + i * STAGGER_MS - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    // not awaited: the next prompt's offset must not wait on this one's answer
    void world.daemon("POST", `/session/${id}/prompt_async`, { text: thread.prompt, clientID: crypto.randomUUID() }).then((r) => {
      if (!r.ok) log(`${thread.title}: prompt answered ${r.status}`);
    });
  }
  log(`${made.length} streams prompted ${STAGGER_MS} ms apart in ${(performance.now() - t0).toFixed(0)} ms`);
}

/* ---------- the counting proxy: every byte the page and its sync worker receive ---------- */
let received = 0;
const upstream = new URL(APP);
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("host", upstream.host);
    if (headers.has("origin")) headers.set("origin", upstream.origin);
    let res: Response;
    try {
      res = await fetch(`${upstream.origin}${url.pathname}${url.search}`, { method: req.method, headers, body: req.body, redirect: "manual", decompress: false } as RequestInit);
    } catch (error) {
      return new Response(`the bench proxy could not reach ${upstream.origin}: ${String(error)}\n`, { status: 502 });
    }
    if (!res.body) return new Response(null, { status: res.status, headers: res.headers });
    const reader = res.body.getReader();
    // a hand-written pass-through, as bench/long.ts: bun crashed piping large bodies through a TransformStream
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else {
          received += value.byteLength;
          controller.enqueue(value);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(counted, { status: res.status, headers: res.headers });
  },
});
const ORIGIN = `http://127.0.0.1:${proxy.port}`;

/* ---------- the trace ---------- */
type TraceEvent = { name: string; cat: string; ph: string; ts: number; dur?: number; tdur?: number; pid: number; tid: number; args?: Record<string, unknown> };
/* the disabled-by-default timeline categories triple the trace for nothing this run reads; even so a busy page traces
   at about 2 MB/s, so the window is traced in chunks (CHUNK_S), each read and dropped before the next */
const CATEGORIES = ["-*", "toplevel", "devtools.timeline", "v8.execute", "disabled-by-default-devtools.timeline.frame", ...(flag("--trace-extra", "") ? flag("--trace-extra", "").split(",") : [])];
/** the rendering steps counted one by one, so a dearer frame and more frames can be told apart */
const COUNTED = ["HandlePostMessage", "Layout", "UpdateLayoutTree", "Paint", "PrePaint"] as const;
const CHUNK_S = 30;
type Kind = "script" | "style" | "layout" | "paint" | "gc";
const KIND_OF: Record<string, Kind> = {
  FunctionCall: "script",
  EvaluateScript: "script",
  RunMicrotasks: "script",
  TimerFire: "script",
  FireAnimationFrame: "script",
  FireIdleCallback: "script",
  EventDispatch: "script",
  "v8.compile": "script",
  "v8.compileModule": "script",
  "V8.Execute": "script",
  "v8.run": "script",
  UpdateLayoutTree: "style",
  RecalculateStyles: "style",
  ParseAuthorStyleSheet: "style",
  Layout: "layout",
  Paint: "paint",
  PrePaint: "paint",
  PaintImage: "paint",
  Layerize: "paint",
  UpdateLayer: "paint",
  UpdateLayerTree: "paint",
  CompositeLayers: "paint",
  Commit: "paint",
  "Decode Image": "paint",
  MinorGC: "gc",
  MajorGC: "gc",
  "BlinkGC.AtomicPhase": "gc",
  "V8.GCScavenger": "gc",
  "V8.GCFinalizeMC": "gc",
  "V8.GCIncrementalMarking": "gc",
};

/** floorsMb: the heap after each major gc, in order (after each minor one when no major ran): the floor under the
    sawtooth, whose first and last say whether the heap grows */
type ThreadCost = {
  busyMs: number;
  /** thread time (tdur) of the outermost tasks: wall busy less the time the thread waited for a core */
  cpuMs: number;
  self: Record<Kind, number>;
  longTasks: number[];
  heapAfterMb: number | null;
  allocMb: number;
  gcs: number;
  floorsMb: number[];
  /** per counted step (COUNTED): how many, and their inclusive wall ms */
  counts: Record<string, [number, number]>;
};

function union(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** a number the gc event carries, on itself or under data */
function heapArg(ev: TraceEvent, key: string): number | null {
  const direct = ev.args?.[key];
  if (typeof direct === "number") return direct;
  const data = ev.args?.data as Record<string, unknown> | undefined;
  const nested = data?.[key];
  return typeof nested === "number" ? nested : null;
}

function costOf(events: TraceEvent[]): ThreadCost {
  const complete = events.filter((e) => e.ph === "X" && typeof e.dur === "number");
  // busy: a top-level task, or classified work outside one (a worker's script does not always sit in a traced task)
  const top = union(complete.filter((e) => e.cat.split(",").includes("toplevel") || KIND_OF[e.name] !== undefined).map((e) => [e.ts, e.ts + (e.dur as number)]));
  const busyMs = top.reduce((sum, [s, e]) => sum + (e - s), 0) / 1000;
  // thread time of the outermost tasks: an event that starts at or after the end of the one before it opens a new task
  let cpuUs = 0;
  let reach = Number.NEGATIVE_INFINITY;
  const outer = complete.filter((e) => e.cat.split(",").includes("toplevel") || KIND_OF[e.name] !== undefined).sort((a, b) => a.ts - b.ts || (b.dur as number) - (a.dur as number));
  for (const e of outer) {
    if (e.ts >= reach) cpuUs += typeof e.tdur === "number" ? e.tdur : (e.dur as number);
    reach = Math.max(reach, e.ts + (e.dur as number));
  }
  const counts: Record<string, [number, number]> = {};
  for (const name of COUNTED) counts[name] = [0, 0];
  for (const e of complete) {
    const c = counts[e.name];
    if (c) {
      c[0]++;
      c[1] += (e.dur as number) / 1000;
    }
  }
  const longTasks = top.map(([s, e]) => (e - s) / 1000).filter((ms) => ms > 50);
  // self time: each classified event minus the classified events directly inside it
  const classified = complete.filter((e) => KIND_OF[e.name] !== undefined).sort((a, b) => a.ts - b.ts || (b.dur as number) - (a.dur as number));
  const self: Record<Kind, number> = { script: 0, style: 0, layout: 0, paint: 0, gc: 0 };
  const stack: Array<{ end: number; kind: Kind; self: number }> = [];
  const close = (until: number) => {
    while (stack.length > 0 && (stack.at(-1) as { end: number }).end <= until) {
      const done = stack.pop() as { kind: Kind; self: number }; // the loop checked the stack is not empty
      self[done.kind] += done.self;
    }
  };
  for (const e of classified) {
    close(e.ts);
    const parent = stack.at(-1);
    const dur = e.dur as number; // filtered to complete events with a duration
    if (parent) parent.self -= Math.min(dur, parent.end - e.ts);
    stack.push({ end: e.ts + dur, kind: KIND_OF[e.name] as Kind, self: dur });
  }
  close(Number.POSITIVE_INFINITY);
  for (const k of Object.keys(self) as Kind[]) self[k] /= 1000;
  // gc events: heap after the last one, and the allocation between them
  const gcs = events
    .filter((e) => (e.name === "MinorGC" || e.name === "MajorGC") && heapArg(e, "usedHeapSizeBefore") !== null && heapArg(e, "usedHeapSizeAfter") !== null)
    .sort((a, b) => a.ts - b.ts);
  let alloc = 0;
  for (let i = 1; i < gcs.length; i++) {
    const before = heapArg(gcs[i] as TraceEvent, "usedHeapSizeBefore") as number; // filtered above
    const after = heapArg(gcs[i - 1] as TraceEvent, "usedHeapSizeAfter") as number;
    alloc += Math.max(0, before - after);
  }
  const last = gcs.at(-1);
  const majors = gcs.filter((e) => e.name === "MajorGC");
  const floorsMb = (majors.length ? majors : gcs).map((e) => (heapArg(e, "usedHeapSizeAfter") as number) / 1048576); // filtered above
  return { busyMs, cpuMs: cpuUs / 1000, counts, self, longTasks, heapAfterMb: last ? (heapArg(last, "usedHeapSizeAfter") as number) / 1048576 : null, allocMb: alloc / 1048576, gcs: gcs.length, floorsMb };
}

function addCost(a: ThreadCost | null, b: ThreadCost | null): ThreadCost | null {
  if (!a || !b) return a ?? b;
  const self = { ...a.self };
  for (const k of Object.keys(self) as Kind[]) self[k] += b.self[k];
  const counts: Record<string, [number, number]> = {};
  for (const [name, [n, ms]] of Object.entries(a.counts)) counts[name] = [n + (b.counts[name]?.[0] ?? 0), ms + (b.counts[name]?.[1] ?? 0)];
  return { busyMs: a.busyMs + b.busyMs, cpuMs: a.cpuMs + b.cpuMs, counts, self, longTasks: [...a.longTasks, ...b.longTasks], heapAfterMb: b.heapAfterMb ?? a.heapAfterMb, allocMb: a.allocMb + b.allocMb, gcs: a.gcs + b.gcs, floorsMb: [...a.floorsMb, ...b.floorsMb] };
}

/** frames: DrawFrame events in the page's renderer (its compositor drew a frame) */
type TraceCost = { main: ThreadCost; worker: ThreadCost | null; rendererPid: number; frames: number };
function readTrace(buffer: Buffer): TraceCost {
  const parsed = JSON.parse(buffer.toString("utf8")) as { traceEvents: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const names = new Map<string, string>();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, String(e.args?.name ?? ""));
  const byThread = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (e.ph === "M") continue;
    const id = `${e.pid}:${e.tid}`;
    const list = byThread.get(id);
    if (list) list.push(e);
    else byThread.set(id, [e]);
  }
  // the page's main thread: the busiest renderer main (about:blank and spare renderers idle)
  let main: { id: string; cost: ThreadCost } | null = null;
  for (const [id, list] of byThread) {
    if (names.get(id) !== "CrRendererMain") continue;
    const cost = costOf(list);
    if (!main || cost.busyMs > main.cost.busyMs) main = { id, cost };
  }
  if (!main) throw new Error("the trace has no renderer main thread");
  const pid = Number(main.id.split(":")[0]);
  const workers = [...byThread.entries()].filter(([id]) => id.startsWith(`${pid}:`) && names.get(id) === "DedicatedWorker thread");
  const worker = workers.length ? costOf(workers.flatMap(([, list]) => list)) : null;
  const frames = events.filter((e) => e.pid === pid && e.name === "DrawFrame").length;
  return { main: main.cost, worker, rendererPid: pid, frames };
}

/** cumulative cpu seconds of each of the browser's processes, by pid (SystemInfo.getProcessInfo: what the task manager reads) */
async function processCpu(browser: Browser): Promise<Map<number, number>> {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  return new Map(processInfo.map((p) => [p.id, p.cpuTime]));
}

/** the 1 minute load average, from uptime */
function loadAverage(): number {
  const out = spawnSync("uptime", { encoding: "utf8" }).stdout;
  return Number(/load averages?: ([\d.]+)/.exec(out)?.[1] ?? Number.NaN);
}

/* ---------- one mode ---------- */
type Result = {
  mode: Mode;
  seconds: number;
  /** seconds of the window inside a trace: the gaps between chunks are not, so trace numbers are rates over this */
  traced: number;
  /** Performance.getMetrics TaskDuration over the whole window: the page's main thread, a cross-check of the trace's busy */
  taskDurationMs: number;
  /** every dom write over the window (a MutationObserver from the init script), null when the page lost it */
  mutations: Mutations | null;
  /** DrawFrame events in the page's renderer over the traced seconds */
  frames: number;
  /** the machine's 1 minute load average at the start and end of the window (uptime): a loaded machine drops frames */
  load: [number, number];
  /** PerformanceObserver longtask entries over the whole window, ms */
  pageLongTasks: number[];
  main: ThreadCost;
  worker: ThreadCost | null;
  rendererCpuPct: number | null;
  /** every chrome process together (browser, gpu, renderers, utilities), % of one core */
  chromeCpuPct: number;
  heap: { startMb: number; peakMb: number; endMb: number; samplesMb: number[] };
  receivedBytes: number;
  visibility: string;
};

async function metric(cdp: CDPSession, name: string): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === name)?.value ?? Number.NaN;
}

async function measure(browser: Browser, page: Page, mode: Mode): Promise<Result> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
  log(`${mode}: settling ${WARM_S} s`);
  await Bun.sleep(WARM_S * 1000);
  const visibility = await page.evaluate(() => document.visibilityState);
  const t0 = performance.now();
  const bytes0 = received;
  const task0 = await metric(cdp, "TaskDuration");
  await page.evaluate(() => {
    const watched = window as unknown as Watched;
    watched.idleLongTasks = [];
    watched.idleMutations = { childList: 0, characterData: 0, attributes: 0, sameCharacterData: 0, sameAttributes: 0, byClass: {} };
  });
  const heap: number[] = [(await metric(cdp, "JSHeapUsedSize")) / 1048576];
  const cpu0 = await processCpu(browser);
  const windowMs = MINUTES * 60_000;
  log(`${mode}: measuring ${MINUTES} min (page ${visibility})`);
  let main: ThreadCost | null = null;
  let worker: ThreadCost | null = null;
  let traced = 0;
  let pid = -1;
  let traceBytes = 0;
  let frames = 0;
  const load0 = loadAverage();
  while (performance.now() - t0 < windowMs - 1000) {
    const chunkMs = Math.min(CHUNK_S * 1000, windowMs - (performance.now() - t0));
    await browser.startTracing(page, { categories: CATEGORIES });
    const c0 = performance.now();
    while (performance.now() - c0 < chunkMs) {
      await Bun.sleep(Math.min(5000, chunkMs - (performance.now() - c0)));
      heap.push((await metric(cdp, "JSHeapUsedSize")) / 1048576);
    }
    const buffer = await browser.stopTracing();
    traced += (performance.now() - c0) / 1000;
    traceBytes += buffer.byteLength;
    if (KEEP_TRACES) writeFileSync(join(SCRATCH, `trace-${mode}-${Math.round(traced)}.json`), buffer);
    const trace = readTrace(buffer);
    if (pid >= 0 && trace.rendererPid !== pid) log(`${mode}: the page's renderer moved from ${pid} to ${trace.rendererPid}`);
    pid = trace.rendererPid;
    main = addCost(main, trace.main);
    worker = addCost(worker, trace.worker);
    frames += trace.frames;
  }
  const cpu1 = await processCpu(browser);
  const task1 = await metric(cdp, "TaskDuration");
  const seconds = (performance.now() - t0) / 1000;
  const receivedBytes = received - bytes0;
  const pageLongTasks = await page.evaluate(() => (window as unknown as Watched).idleLongTasks ?? []);
  const mutations = await page.evaluate(() => (window as unknown as Watched).idleMutations ?? null);
  await cdp.detach();
  if (!main) throw new Error(`${mode}: no trace was read`);
  log(`${mode}: traced ${traced.toFixed(0)} of ${seconds.toFixed(0)} s (${Math.round(traceBytes / 1048576)} MB of trace)`);
  const before = cpu0.get(pid);
  const after = cpu1.get(pid);
  const rendererCpuPct = before !== undefined && after !== undefined ? (100 * (after - before)) / seconds : null;
  // every chrome process: chromium writes indexeddb in the browser process and composites in the gpu one
  let all = 0;
  for (const [id, end] of cpu1) all += end - (cpu0.get(id) ?? 0);
  const chromeCpuPct = (100 * all) / seconds;
  return {
    mode,
    seconds,
    traced,
    frames,
    mutations,
    load: [load0, loadAverage()],
    main,
    worker,
    taskDurationMs: (task1 - task0) * 1000,
    pageLongTasks,
    rendererCpuPct,
    chromeCpuPct,
    heap: { startMb: heap[0] ?? Number.NaN, peakMb: Math.max(...heap), endMb: heap.at(-1) ?? Number.NaN, samplesMb: heap.map((h) => Math.round(h * 10) / 10) },
    receivedBytes,
    visibility,
  };
}

/* ---------- printing and budgets ---------- */
function perMinute(ms: number, seconds: number): number {
  return (ms * 60) / seconds;
}

function printResult(r: Result) {
  const m = r.main;
  const w = r.worker;
  const raw = {
    mode: r.mode,
    seconds: Math.round(r.seconds),
    tracedSeconds: Math.round(r.traced),
    load: r.load,
    frames: r.frames,
    mainCpuMs: Math.round(m.cpuMs),
    counts: Object.fromEntries(Object.entries(m.counts).map(([k, [n, ms]]) => [k, [n, Math.round(ms)]])),
    visibility: r.visibility,
    taskDurationMs: Math.round(r.taskDurationMs),
    pageLongTasksMs: r.pageLongTasks,
    mutations: r.mutations,
    mainBusyMs: Math.round(m.busyMs),
    mainSelfMs: Object.fromEntries(Object.entries(m.self).map(([k, v]) => [k, Math.round(v)])),
    longTasksMs: m.longTasks.map((t) => Math.round(t)),
    mainGcs: m.gcs,
    mainAllocMb: Math.round(m.allocMb),
    workerBusyMs: w ? Math.round(w.busyMs) : null,
    workerSelfMs: w ? Object.fromEntries(Object.entries(w.self).map(([k, v]) => [k, Math.round(v)])) : null,
    workerLongTasksMs: w ? w.longTasks.map((t) => Math.round(t)) : null,
    workerGcs: w?.gcs ?? null,
    workerAllocMb: w ? Math.round(w.allocMb) : null,
    workerHeapAfterMb: w?.heapAfterMb === null || w === null ? null : Math.round(w.heapAfterMb * 10) / 10,
    rendererCpuPct: r.rendererCpuPct === null ? null : Math.round(r.rendererCpuPct * 10) / 10,
    chromeCpuPct: Math.round(r.chromeCpuPct * 10) / 10,
    mainFloorsMb: m.floorsMb.map((h) => Math.round(h * 10) / 10),
    workerFloorsMb: w ? w.floorsMb.map((h) => Math.round(h * 10) / 10) : null,
    pageHeapMb: r.heap.samplesMb,
    receivedBytes: r.receivedBytes,
  };
  console.log(`IDLE_RAW ${JSON.stringify(raw)}`);
}

const f1 = (n: number | null | undefined, width = 7) => (n === null || n === undefined || !Number.isFinite(n) ? "-" : n.toFixed(1)).padStart(width);

/** how far the heap floor rose over the window: the mean of the last three floors less the mean of the first three */
function growth(floors: number[]): number | null {
  if (floors.length < 2) return null;
  const n = Math.min(3, Math.floor(floors.length / 2));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return mean(floors.slice(-n)) - mean(floors.slice(0, n));
}

/** the numbers each budget and the summary read, as rates: trace numbers per traced minute, the rest per window minute */
function rates(r: Result) {
  const tm = (ms: number) => perMinute(ms, r.traced);
  const m = r.main;
  const w = r.worker;
  const long = [...r.pageLongTasks, ...m.longTasks];
  return {
    busy: tm(m.busyMs),
    core: (100 * m.busyMs) / 1000 / r.traced,
    cpuCore: (100 * m.cpuMs) / 1000 / r.traced,
    fps: r.frames / r.traced,
    posts: ((m.counts.HandlePostMessage?.[0] ?? 0) * 60) / r.traced,
    msPerPost: m.counts.HandlePostMessage?.[0] ? m.busyMs / m.counts.HandlePostMessage[0] : null,
    layoutsPerPost: m.counts.HandlePostMessage?.[0] ? (m.counts.Layout?.[0] ?? 0) / m.counts.HandlePostMessage[0] : null,
    paintsPerPost: m.counts.HandlePostMessage?.[0] ? (m.counts.Paint?.[0] ?? 0) / m.counts.HandlePostMessage[0] : null,
    sameAttributes: r.mutations ? (r.mutations.sameAttributes * 60) / r.seconds : null,
    sameText: r.mutations ? (r.mutations.sameCharacterData * 60) / r.seconds : null,
    load0: r.load[0],
    load1: r.load[1],
    task: perMinute(r.taskDurationMs, r.seconds),
    script: tm(m.self.script),
    style: tm(m.self.style),
    layout: tm(m.self.layout),
    paint: tm(m.self.paint),
    gc: tm(m.self.gc),
    longCount: Math.max(r.pageLongTasks.length, m.longTasks.length),
    longMax: long.length ? Math.max(...long) : 0,
    worker: w ? tm(w.busyMs) : null,
    workerGc: w ? tm(w.self.gc) : null,
    workerCore: w ? (100 * w.busyMs) / 1000 / r.traced : null,
    renderer: r.rendererCpuPct,
    chrome: r.chromeCpuPct,
    floorGrowth: growth(m.floorsMb),
    workerFloorGrowth: w ? growth(w.floorsMb) : null,
    heapStart: r.heap.startMb,
    heapPeak: r.heap.peakMb,
    heapEnd: r.heap.endMb,
    alloc: m.allocMb / r.traced,
    workerHeap: w?.heapAfterMb ?? null,
    workerAlloc: w ? w.allocMb / r.traced : null,
    kbps: r.receivedBytes / 1024 / r.seconds,
  };
}

function printSummary(list: Result[]) {
  console.log("\nms per minute of one thread unless marked; % of one core; heap in MB; chromium headless");
  const cols: Array<[string, keyof ReturnType<typeof rates>]> = [
    ["main busy", "busy"],
    ["% core", "core"],
    ["cpu %", "cpuCore"],
    ["frames/s", "fps"],
    ["posts/min", "posts"],
    ["ms/post", "msPerPost"],
    ["lay/post", "layoutsPerPost"],
    ["pnt/post", "paintsPerPost"],
    ["same@/min", "sameAttributes"],
    ["load", "load0"],
    ["load end", "load1"],
    ["task(cdp)", "task"],
    ["script", "script"],
    ["style", "style"],
    ["layout", "layout"],
    ["paint", "paint"],
    ["gc", "gc"],
    ["long>50", "longCount"],
    ["max long", "longMax"],
    ["wkr busy", "worker"],
    ["wkr gc", "workerGc"],
    ["wkr %", "workerCore"],
    ["rndr %", "renderer"],
    ["chrome %", "chrome"],
    ["heap 0", "heapStart"],
    ["peak", "heapPeak"],
    ["end", "heapEnd"],
    ["floor +MB", "floorGrowth"],
    ["MB/s", "alloc"],
    ["wkr heap", "workerHeap"],
    ["wkr +MB", "workerFloorGrowth"],
    ["wkr MB/s", "workerAlloc"],
    ["KB/s in", "kbps"],
  ];
  console.log(["mode".padEnd(7), ...cols.map(([h]) => h.padStart(9))].join(" "));
  for (const r of list) {
    const v = rates(r);
    console.log([r.mode.padEnd(7), ...cols.map(([, k]) => f1(v[k], 9))].join(" "));
  }
  console.log("\ndom writes per minute (MutationObserver): kind, and how many set the value already there");
  for (const r of list) {
    const m = r.mutations;
    if (!m) continue;
    const pm = (n: number) => ((n * 60) / r.seconds).toFixed(0);
    console.log(`${r.mode.padEnd(7)} child ${pm(m.childList)}, text ${pm(m.characterData)} (same ${pm(m.sameCharacterData)}), attributes ${pm(m.attributes)} (same ${pm(m.sameAttributes)})`);
    const top = Object.entries(m.byClass).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [name, n] of top) console.log(`          ${pm(n).padStart(7)}/min  ${name}`);
  }
  console.log("\nmain thread rendering steps: count per minute, mean ms (inclusive)");
  console.log(["mode".padEnd(7), ...COUNTED.map((c) => `${c} /min`.padStart(22) + "mean".padStart(7))].join(" "));
  for (const r of list) {
    const cells = COUNTED.map((c) => {
      const [n, ms] = r.main.counts[c] ?? [0, 0];
      return f1((n * 60) / r.traced, 22) + f1(n ? ms / n : 0, 7);
    });
    console.log([r.mode.padEnd(7), ...cells].join(" "));
  }
}

type Budget = { what: string; mode: Mode; target: string; value: (r: Result) => number | null; ok: (v: number) => boolean; unit: string };
/* docs/design.md, buttery as numbers (idle cost), each with its gate here and its perf row there. judged on this run's
   chromium with the defaults (10 streaming, 100 done, 3 minutes a mode), as before and after on one machine. the
   baseline on 2026-10-20 (main f8f04d1, two runs): home 4.7 and 4.8% of a core with 12.8 and 15.2 MB/s allocated,
   thread 13.0 and 12.6%, hidden 4.6 and 3.9%, the worker under 1%, no long tasks, no floor growth, page peak 42 MB */
const BUDGETS: Budget[] = [
  { what: "home visible: main thread busy", mode: "home", target: "<= 3% of a core", unit: "%", value: (r) => rates(r).core, ok: (v) => v <= 3 },
  { what: "home visible: main thread allocation", mode: "home", target: "<= 6 MB/s", unit: "MB/s", value: (r) => rates(r).alloc, ok: (v) => v <= 6 },
  { what: "thread streaming: long tasks over 50 ms", mode: "thread", target: "none", unit: "", value: (r) => rates(r).longCount, ok: (v) => v === 0 },
  { what: "thread streaming: main thread busy", mode: "thread", target: "<= 8% of a core", unit: "%", value: (r) => rates(r).core, ok: (v) => v <= 8 },
  { what: "hidden: main thread busy", mode: "hidden", target: "<= 2% of a core", unit: "%", value: (r) => rates(r).core, ok: (v) => v <= 2 },
  // per worker post: what the run's post rate does not move (verification.md, reading the rendering numbers)
  { what: "home visible: main thread per worker post", mode: "home", target: "<= 2.5 ms", unit: "ms", value: (r) => rates(r).msPerPost, ok: (v) => v <= 2.5 },
  { what: "home visible: layouts per worker post", mode: "home", target: "<= 1.1", unit: "", value: (r) => rates(r).layoutsPerPost, ok: (v) => v <= 1.1 },
  { what: "thread streaming: main thread per worker post", mode: "thread", target: "<= 3 ms", unit: "ms", value: (r) => rates(r).msPerPost, ok: (v) => v <= 3 },
  ...MODES.flatMap((mode): Budget[] => [
    { what: `${mode}: dom writes that change nothing`, mode, target: "0 a minute", unit: "/min", value: (r) => (r.mutations ? (rates(r).sameAttributes ?? 0) + (rates(r).sameText ?? 0) : null), ok: (v) => v === 0 },
    { what: `${mode}: sync worker busy`, mode, target: "<= 2% of a core", unit: "%", value: (r) => rates(r).workerCore, ok: (v) => v <= 2 },
    { what: `${mode}: page heap floor growth`, mode, target: "<= 5 MB over the window", unit: "MB", value: (r) => rates(r).floorGrowth, ok: (v) => v <= 5 },
    { what: `${mode}: worker heap floor growth`, mode, target: "<= 5 MB over the window", unit: "MB", value: (r) => rates(r).workerFloorGrowth, ok: (v) => v <= 5 },
    { what: `${mode}: page heap peak`, mode, target: "<= 64 MB", unit: "MB", value: (r) => r.heap.peakMb, ok: (v) => v <= 64 },
  ]),
];

function checkBudgets(list: Result[]): number {
  if (BUDGETS.length === 0) return 0;
  console.log("\nbudget                                         mode      value     target                     result");
  let missed = 0;
  for (const b of BUDGETS) {
    const r = list.find((x) => x.mode === b.mode);
    if (!r) continue;
    const v = b.value(r);
    // a number the run could not take (fewer than two gcs in the window) is n/a, said, not a miss
    const ok = v === null || b.ok(v);
    if (!ok) missed++;
    console.log(`${b.what.padEnd(46)} ${b.mode.padEnd(7)} ${f1(v, 9)} ${b.unit.padEnd(4)} ${b.target.padEnd(26)} ${v === null ? "n/a" : ok ? "met" : "MISSED"}`);
  }
  return missed;
}

/** what the init script keeps on the page: every long task's duration, for the whole window */
type Mutations = { childList: number; characterData: number; attributes: number; sameCharacterData: number; sameAttributes: number; byClass: Record<string, number> };
type Watched = { idleLongTasks?: number[]; idleMutations?: Mutations };

/** the part of the app's verification handle (app/src/sync/client.ts, window.boxbox) this run drives */
type Driven = { boxbox?: { stream(): { state: string }; open(key: string): void; painted(): number } };

/* ---------- the run ---------- */
const world = new World();
let code = 0;
let browser: Browser | null = null;
// ctrl-c or a kill still stops the daemon, the model, boxbox and chrome: they run in process groups of their own
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await browser?.close().catch(() => undefined);
      proxy.stop(true);
      await world.stop();
      process.exit(130);
    })();
  });
}
const results: Result[] = [];
try {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  await world.start();
  // every stream outlives the run: setup, then each mode's settle and window, plus a margin
  const seconds = 120 + MODES.length * (WARM_S + MINUTES * 60 + 20);
  const words = Math.ceil((seconds * 1000) / EVERY_MS);
  const { streams, quiet } = fleet(words);
  await world.run(quiet);
  await startStreams(world, streams);
  log(`fleet: ${STREAMS} streaming (${words} words each, one every ${EVERY_MS} ms), ${DONE} done, one quiet`);
  const longOne = world.sessions.find((s) => s.thread.title === "the long reply");
  if (!longOne) throw new Error("the long reply's session was not made");

  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 945 } });
  await context.addInitScript(() => {
    const watched = window as unknown as Watched;
    watched.idleLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) watched.idleLongTasks?.push(Math.round(entry.duration));
    }).observe({ type: "longtask", buffered: true });
    // every dom write, by kind and by the nearest class, and whether it set what was already there
    watched.idleMutations = { childList: 0, characterData: 0, attributes: 0, sameCharacterData: 0, sameAttributes: 0, byClass: {} };
    const start = () => {
      new MutationObserver((records) => {
        const tally = watched.idleMutations;
        if (!tally) return;
        for (const r of records) {
          tally[r.type]++;
          if (r.type === "characterData" && r.oldValue === r.target.textContent) tally.sameCharacterData++;
          if (r.type === "attributes" && r.attributeName && r.target instanceof Element && r.oldValue === r.target.getAttribute(r.attributeName)) tally.sameAttributes++;
          let node: Node | null = r.target;
          while (node && !(node instanceof Element && node.classList.length > 0)) node = node.parentNode;
          const name = `${r.type === "attributes" ? `@${r.attributeName ?? ""} ` : r.type === "characterData" ? "text " : "child "}.${node instanceof Element ? (node.classList[0] ?? "") : "(none)"}`;
          tally.byClass[name] = (tally.byClass[name] ?? 0) + 1;
        }
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, characterDataOldValue: true });
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  const status = await page.evaluate(
    async (password) => (await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) })).status,
    world.gate,
  );
  log(`signed in through the proxy: ${status}`);
  const load = async (url: string) => {
    await page.goto(url);
    await until("the stream to be live", async () => (await page.evaluate(() => (window as unknown as Driven).boxbox?.stream().state ?? "none")) === "live", 30_000);
  };
  await load(`${ORIGIN}/`);
  const build = await page.evaluate(() => document.querySelector("script[type=module][src]")?.getAttribute("src") ?? "unknown");
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() ? " (uncommitted changes)" : "";
  log(`build ${build}, commit ${commit}${dirty}, chrome ${browser?.version() ?? "?"}`);

  for (const mode of MODES) {
    await load(`${ORIGIN}/`);
    if (mode === "thread") {
      const sent = await world.daemon("POST", `/session/${longOne.id}/prompt_async`, {
        text: `[bench:words ${Math.ceil(((WARM_S + MINUTES * 60 + 30) * 1000) / LONG_EVERY_MS)} ${LONG_EVERY_MS}] the long reply`,
        clientID: crypto.randomUUID(),
      });
      log(`thread: the long reply asked -> ${sent.status}`);
      await page.evaluate((key) => (window as unknown as Driven).boxbox?.open(key), longOne.key);
      await until("the long reply painting", async () => (await page.evaluate(() => (window as unknown as Driven).boxbox?.painted() ?? 0)) > 200, 30_000);
    }
    if (mode === "hidden") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
    const result = await measure(browser, page, mode);
    results.push(result);
    printResult(result);
  }
  await browser.close();
  browser = null;

  printSummary(results);
  console.log(`\nbuild ${build}, commit ${commit}${dirty}; chromium headless over cdp: relative before and after on this machine, not webkit's absolute cost`);
  const missed = checkBudgets(results);
  if (missed > 0) code = 1;
} catch (error) {
  console.error(`idle: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  proxy.stop(true);
  await world.stop();
  if (!KEEP_TRACES) rmSync(SCRATCH, { recursive: true, force: true });
}
process.exit(code);

