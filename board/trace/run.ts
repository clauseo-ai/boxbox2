/* one traced run: a world staged, a board daemon started against it under
   the fake board, a scenario's steps played, every record kept against the
   step it happened in. record.ts writes the result as a trace; replay.ts
   runs it again and diffs.

   a step is over when the board and the world have both gone quiet: at
   least MIN_STEP_MS has passed, nothing that matters (a frame change, a
   board report, a keyed call, a process) has happened for QUIET_MS, no
   keyed call is still in flight, no agent is working (a turn a key set
   going, an allow or an answer, finishes inside the step that set it
   going), and any condition the step names holds. the clock-driven traffic
   (pings, the animated palette slots, the seat heartbeat, the twin mirror,
   telemetry batches, spend polls) does not count as activity; normalize.ts
   treats it the same way. */

import { join } from "node:path";
import { startDaemon } from "./daemon";
import type { Record } from "./preload";
import { keyEvents, type KeyEvent, type Scenario } from "./scenarios";
import type { World } from "./world";

const MIN_STEP_MS = 1000;
const QUIET_MS = 700;
const WORLD_POLL_MS = 200;
const STEP_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 20_000;

/** call paths that are clock-driven, not caused by a step */
const BACKGROUND = [/^\/api\/stream/, /^\/api\/telemetry/, /^\/api\/board\/seats/, /^\/api\/board\/frame/, /^\/api\/spend/];

export type TracedStep = {
  label: string;
  /** what drove the step: the daemon starting, a key gesture, an agent, or nothing */
  kind: "start" | "keys" | "world" | "idle";
  /** ms from the start of the run */
  startedAt: number;
  endedAt: number;
  /** the raw switch events fed to the board, ms from the step's start */
  keys: KeyEvent[];
  records: Record[];
};

export type Run = { steps: TracedStep[] };

export type RunOptions = {
  scenario: Scenario;
  world: World;
  daemonDir: string;
  runDir: string;
  /** replay feeds the recorded presses rather than re-deriving them */
  keysFor?: (index: number) => KeyEvent[] | undefined;
  log?: (line: string) => void;
};

const isFrame = (r: Record) => r.ch === "hid" && r.bytes[1] === 0x03;

function rebaseTelemetry(body: unknown, t0: number): unknown {
  if (typeof body !== "object" || body === null || !("events" in body) || !Array.isArray(body.events)) return body;
  return {
    ...body,
    events: body.events.map((event: unknown) =>
      typeof event === "object" && event !== null && "at" in event && typeof event.at === "number" ? { ...event, at: event.at - t0 } : event,
    ),
  };
}

export async function traceRun(options: RunOptions): Promise<Run> {
  const log = options.log ?? ((line: string) => console.log(line));
  const t0 = Date.now();
  const steps: TracedStep[] = [];
  let current: TracedStep = { label: "the daemon starts, then the board is plugged in", kind: "start", startedAt: 0, endedAt: 0, keys: [], records: [] };
  let lastActivity = Date.now();
  let lastFrame = "";
  /** bumped on every frame that differs from the one before it */
  let frameChanges = 0;
  const inFlight = new Set<number>();
  const backgroundIds = new Set<number>();

  const onRecord = (raw: Record) => {
    const record = { ...raw, t: raw.t - t0 } as Record;
    /* telemetry events carry their own epoch stamps: rebase them onto the
       run's clock with everything else, so a trace holds one timeline */
    if (record.ch === "http" && record.path === "/api/telemetry") record.body = rebaseTelemetry(record.body, t0);
    current.records.push(record);
    if (record.ch === "hid") {
      if (isFrame(record)) {
        const frame = record.bytes.slice(2, 19).join(",");
        if (frame !== lastFrame) {
          lastFrame = frame;
          frameChanges += 1;
          lastActivity = Date.now();
        }
      }
      return;
    }
    if (record.ch === "http") {
      if (BACKGROUND.some((p) => p.test(record.path))) {
        backgroundIds.add(record.id);
        return;
      }
      inFlight.add(record.id);
    } else if (record.ch === "http-done") {
      if (backgroundIds.delete(record.id)) return;
      inFlight.delete(record.id);
    }
    lastActivity = Date.now();
  };

  const daemon = startDaemon({
    daemonDir: options.daemonDir,
    runDir: join(options.runDir, "daemon"),
    origin: options.world.origin,
    password: options.world.password,
    machineOrder: options.world.machineOrder,
    onRecord,
  });
  let crashed: number | null = null;
  void daemon.exited.then((code) => {
    crashed = code;
  });

  const settle = async (began: number, changesAtStart: number, needsChange: boolean, label: string) => {
    let worldQuiet = false;
    let worldCheckedAt = 0;
    for (;;) {
      if (crashed !== null) throw new Error(`the daemon exited with ${crashed} during "${label}"; see ${options.runDir}/daemon/daemon.log`);
      const now = Date.now();
      if (now - worldCheckedAt >= WORLD_POLL_MS) {
        worldCheckedAt = now;
        const wasQuiet: boolean = worldQuiet;
        worldQuiet = await options.world.quiet();
        /* an agent finishing is activity: the board's answer to it follows */
        if (wasQuiet !== worldQuiet) lastActivity = Date.now();
      }
      const quiet = now - lastActivity >= QUIET_MS && inFlight.size === 0 && worldQuiet;
      const changed = !needsChange || frameChanges > changesAtStart;
      if (now - began >= MIN_STEP_MS && quiet && changed) return;
      if (now - began > STEP_TIMEOUT_MS) throw new Error(`"${label}" never settled after ${STEP_TIMEOUT_MS}ms`);
      await Bun.sleep(20);
    }
  };

  try {
    /* the daemon logs in, opens the stream and reconciles with no board;
       once that has settled the board goes in, and the formation lap plays
       over a known state */
    const startBegan = Date.now();
    let streamOpen = false;
    while (!streamOpen) {
      if (Date.now() - startBegan > CONNECT_TIMEOUT_MS) throw new Error("the daemon never opened its stream");
      if (crashed !== null) throw new Error(`the daemon exited with ${crashed} before it opened its stream`);
      streamOpen = current.records.some((r) => r.ch === "http" && r.path === "/api/stream" && current.records.some((d) => d.ch === "http-done" && d.id === r.id && d.status === 200));
      await Bun.sleep(20);
    }
    await settle(startBegan, frameChanges, false, "the daemon starts");
    daemon.plug();
    const connectBegan = Date.now();
    while (lastFrame === "") {
      if (Date.now() - connectBegan > CONNECT_TIMEOUT_MS) throw new Error("the daemon never drew a frame on the fake board");
      if (crashed !== null) throw new Error(`the daemon exited with ${crashed} before it drew a frame`);
      await Bun.sleep(20);
    }
    await settle(connectBegan, frameChanges, false, current.label);

    for (const [index, step] of options.scenario.steps.entries()) {
      current.endedAt = Date.now() - t0;
      steps.push(current);
      const began = Date.now();
      const kind = "gesture" in step ? "keys" : "world" in step ? "world" : "idle";
      current = { label: step.label, kind, startedAt: began - t0, endedAt: 0, keys: [], records: [] };
      log(`  step ${index + 1}  ${step.label}`);
      const changesAtStart = frameChanges;
      if ("gesture" in step) {
        const events = options.keysFor?.(index + 1) ?? keyEvents(step.gesture);
        current.keys = events;
        for (const event of events) {
          const wait = began + event.at - Date.now();
          if (wait > 0) await Bun.sleep(wait);
          daemon.press(event.wire, event.down);
        }
        lastActivity = Date.now();
        await settle(began, changesAtStart, false, step.label);
      } else if ("world" in step) {
        await step.world(options.world);
        lastActivity = Date.now();
        await settle(began, changesAtStart, step.frameChange ?? false, step.label);
      } else {
        await Bun.sleep(step.idleMs);
      }
    }
    current.endedAt = Date.now() - t0;
    steps.push(current);
  } finally {
    /* shutdown traffic (the blanking frame, a last telemetry flush) races
       the process exit, so it is not part of the trace */
    current = { label: "shutdown", kind: "idle", startedAt: 0, endedAt: 0, keys: [], records: [] };
    await daemon.stop();
  }
  return { steps };
}
