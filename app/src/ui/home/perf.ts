/* the budgets, measured where they are felt (docs/design.md, buttery, as
   numbers). each is a `perf.*` telemetry kind (telemetry/schema.ts):

   - perf.launch: navigation start to the first frame that showed windows.
   - perf.paint: an input to the frame that painted what it opened, per
     surface, in ms and frames.
   - perf.input: the browser's own event timing, for interactions it
     reports (over 16 ms).
   - perf.shift: cumulative layout shift over a visible stretch.
   - perf.longtask: any ui task over 50 ms, with what the ui was doing.
   - perf.frames: a transition's frames and the gaps in them.

   the ui thread measures, so it emits: a `Telemetry` of its own, batched
   the same way the worker's is and flushed when the page hides. the emitter
   is not in the first load (the script budget): the first sample loads it,
   a read from the worker's precache, and the samples taken meanwhile go to
   it in order with the time they were taken.
   `window.boxbox.perf()` hands the verification drive what was measured. */

import { deviceClassOf, type DeviceClass } from "../../../../telemetry/schema";
import { deviceId } from "../../push/device";
import type { Telemetry } from "../../sync/telemetry";

export type Surface = "home" | "thread";
export type Activity = "streaming" | "scrolling" | "transition" | "idle";

type Sample = { kind: string; ms: number; props: Record<string, string | number> };

let telemetry: Telemetry | null = null;
/** what this page measured, newest last, for the drive; capped like the telemetry queue */
const samples: Sample[] = [];
const SAMPLE_CAP = 500;
let activity: Activity = "idle";
let activityUntil = 0;
let launched = false;
/* a launch counts only if someone could see it: a page opened behind another, or hidden before it painted, runs
   no animation frames and would report the time it waited, not the time it took */
if (typeof document !== "undefined") {
  if (document.visibilityState !== "visible") launched = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") launched = true;
  });
}

let loading: Promise<Telemetry> | null = null;

function emitter(): Promise<Telemetry> {
  loading ??= import("../../sync/telemetry").then(({ Telemetry }) => {
    const deviceClass: DeviceClass = navigator.webdriver ? "automation" : deviceClassOf(navigator.userAgent, navigator.maxTouchPoints);
    const created = new Telemetry(deviceId(), deviceClass);
    telemetry = created;
    /* the queue lives as long as the page, so the page sends it as it hides, whatever is on screen then. it was sent
       only by home's observers, which stop when a screen replaces home: a tap's perf.paint and perf.frames, measured
       on home, then machines opened and the page reloaded inside the 10 s flush, never left (docs/gotchas.md) */
    const leaving = () => void created.flush(true);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") leaving();
    });
    window.addEventListener("pagehide", leaving);
    // a page that hid while the emitter loaded sends the samples it took meanwhile, once they are in its queue
    if (document.visibilityState === "hidden") setTimeout(leaving, 0);
    return created;
  });
  return loading;
}

function record<K extends "perf.launch" | "perf.paint" | "perf.input" | "perf.shift" | "perf.longtask" | "perf.frames">(
  kind: K,
  ms: number,
  props: Parameters<Telemetry["emit"]>[1] & Record<string, string | number>,
  surface: Surface,
): void {
  const rounded = Math.round(ms);
  samples.push({ kind, ms: rounded, props });
  if (samples.length > SAMPLE_CAP) samples.splice(0, samples.length - SAMPLE_CAP);
  if (telemetry) return telemetry.emit(kind, props as never, { surface, ms: rounded });
  const at = Date.now();
  void emitter().then((loaded) => loaded.emit(kind, props as never, { surface, ms: rounded, at }), () => undefined);
}

/** says what the ui is doing, so a long task is filed under it */
export function doing(what: Activity, forMs: number): void {
  activity = what;
  activityUntil = performance.now() + forMs;
}

function currentActivity(): Activity {
  return performance.now() < activityUntil ? activity : "idle";
}

/** the first frame that shows windows: once per page, and only for a page that was in front the whole time */
export function launchPainted(cached: boolean, windows: number): void {
  if (launched) return;
  launched = true;
  requestAnimationFrame(() => record("perf.launch", performance.now(), { cached: cached ? 1 : 0, windows }, "home"));
}

/** an input opened something: measures from the input to the end of the first frame that rendered the response.
    the response is rendered synchronously in the handler, so the next frame paints it; a message posted from that
    frame's animation callback runs once its style, layout and paint are done, which is where the clock stops */
export function tapped(event: Event, control: "window" | "capsule" | "back" | "answer" | "fold", arrangement: "deck" | "strip" | "rail", surface: Surface): void {
  const start = event.timeStamp;
  let frames = 0;
  requestAnimationFrame(() => {
    frames++;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      record("perf.paint", performance.now() - start, { control, arrangement, frames }, surface);
    };
    channel.port2.postMessage(null);
  });
}

/** counts a transition's frames and the gaps over 1.5 frame times */
export function watchTransition(transition: "grow" | "shrink" | "pour" | "reorder" | "capsule" | "back" | "agent" | "agent-back", durationMs: number, surface: Surface): void {
  doing("transition", durationMs + 100);
  const begin = performance.now();
  let last = begin;
  let frames = 0;
  let dropped = 0;
  const frameMs = 1000 / 60;
  const step = (now: number) => {
    frames++;
    if (now - last > frameMs * 1.5) dropped += Math.round((now - last) / frameMs) - 1;
    last = now;
    if (now - begin < durationMs) requestAnimationFrame(step);
    else record("perf.frames", now - begin, { transition, frames, dropped }, surface);
  };
  requestAnimationFrame(step);
}

/** starts the observers once: long tasks, layout shift, event timing */
export function startPerf(surface: () => Surface): () => void {
  const observers: PerformanceObserver[] = [];
  let shift = 0;
  let shifts = 0;
  const observe = (type: string, onEntries: (entries: PerformanceEntryList) => void, extra: Record<string, unknown> = {}) => {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    const observer = new PerformanceObserver((list) => onEntries(list.getEntries()));
    observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    observers.push(observer);
  };
  observe("longtask", (entries) => {
    for (const entry of entries) record("perf.longtask", entry.duration, { during: currentActivity() }, surface());
  });
  observe("layout-shift", (entries) => {
    for (const entry of entries as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
      if (entry.hadRecentInput) continue;
      shift += entry.value;
      shifts++;
    }
  });
  // the first input of a page is always reported, whatever its duration: input delay plus the time to the next paint
  observe("first-input", (entries) => {
    for (const entry of entries as Array<PerformanceEventTiming>) record("perf.input", entry.duration, { type: entry.name }, surface());
  });
  observe(
    "event",
    (entries) => {
      for (const entry of entries as Array<PerformanceEntry & { interactionId?: number }>) {
        if (!entry.interactionId) continue;
        record("perf.input", entry.duration, { type: entry.name }, surface());
      }
    },
    { durationThreshold: 16 },
  );
  const onHide = () => {
    if (document.visibilityState !== "hidden") return;
    record("perf.shift", 0, { score: Math.round(shift * 1000), shifts }, surface());
    shift = 0;
    shifts = 0;
    void telemetry?.flush(true);
  };
  document.addEventListener("visibilitychange", onHide);
  return () => {
    for (const observer of observers) observer.disconnect();
    document.removeEventListener("visibilitychange", onHide);
  };
}

/** what was measured on this page, for the verification drive */
export function measured(): { samples: Sample[]; shift: number } {
  const shiftNow = performance.getEntriesByType("layout-shift") as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>;
  return { samples: [...samples], shift: shiftNow.filter((e) => !e.hadRecentInput).reduce((sum, e) => sum + e.value, 0) };
}

/** sends what is queued now (the drive reads the rows back from the server) */
export async function flushPerf(): Promise<void> {
  await (loading ?? Promise.resolve(telemetry)).then((loaded) => loaded?.flush(), () => undefined);
}

export type PerfHandle = { perf: typeof measured; flush: typeof flushPerf };

declare global {
  interface Window {
    /** the budget run's handle (bench/home.ts): what this page measured, and a way to send it now */
    boxboxPerf: PerfHandle;
  }
}

window.boxboxPerf = { perf: measured, flush: flushPerf };
