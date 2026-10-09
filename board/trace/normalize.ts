/* a trace, reduced to what decision 1 holds identical: per step, the led
   frames the board was sent, the reports it sent back, the calls the daemon
   made (by meaning, not by path) and the radio's processes. two runs of the
   same scenario against the same behaviour normalize to the same lines;
   the diff is taken between those lines.

   what is kept byte for byte:
     - every FRAME (consecutive repeats collapse; the daemon already skips
       unchanged frames, so a repeat only follows a mode flip);
     - PALETTE writes to slots 0 to 13 (the reserved voices and liveries),
       GLOBAL, HELLO and MODE.

   what an agent's timing decides, and is reduced:
     - in steps an agent drives (world and idle steps), a frame the board
       held for less than BRIEF_FRAME_MS is the render loop catching up
       with a burst of events (a session marked busy one render before its
       first token lifts the key), and is dropped. every frame that holds
       is still compared byte for byte, and the shortest scene frame an
       agent can set off (the victory lap's 80ms) is longer. key steps and
       the start are compared frame for frame, with nothing dropped.

   what the daemon's seat memo decides, and is optional:
     - the controller re-derives its seat list at most every 250ms, but
       leaves the pit from fresh state, so after an answer the board can
       redraw the drive frame from before the pit for 0 to 250ms, or not
       at all, as the scheduler lands. a frame is optional when it has
       that shape: the picture from just before a frame that held at least
       RESHOW_AGE_MS, back for under SEAT_MEMO_MS, with no key down. an optional frame may be
       absent on one side; it can never differ. a pulse's beats return
       after 170 to 240ms and the meter never returns to the frame before
       its last, so neither is ever optional.

   what is clock-driven, and reduced:
     - PING is the keepalive; its cadence is checked (keepaliveGapMs), not
       diffed.
     - PALETTE writes to slots 14 and 15 are the two animated slots, streamed
       through sines; which keys breathe is already in the frame bytes.
     - the seat map rides change plus a 5s heartbeat: a post only counts
       when its map differs from the previous one.
     - the twin mirror is throttled to 5/s, so which intermediate frames it
       carries depends on timing: per step, only the last mirror counts.
     - spend is polled every 60s: a poll only counts when it is the first.
     - login happens once per call that finds no cookie, and the calls in
       flight at startup race for it: only the first login counts.
     - calls from different sources in one step (a keyed verb, the seat
       map, the stream's reconcile) interleave by timing: within a step,
       calls are grouped by verb, keeping each verb's own order.
     - telemetry is batched every 5s: each event is placed by its own
       timestamp, and its latency and id are dropped.

   calls are decoded into intents (decodeV1). a v2 decoder maps v2's wire
   onto the same intents; that is what "semantically identical" means. */

import type { Record } from "./preload";
import type { TracedStep } from "./run";

/** a call, by meaning. `host` and `session` carry aliases by the time a trace is written. */
export type Intent =
  | { verb: "login" }
  | { verb: "stream" }
  | { verb: "sessions"; host: string; directory: string | null }
  | { verb: "session"; host: string; session: string }
  | { verb: "spend" }
  | { verb: "replyPermission"; host: string; id: string; reply: string; directory: string | null }
  | { verb: "replyQuestion"; host: string; id: string; answers: unknown; directory: string | null }
  | { verb: "markRead"; session: string }
  | { verb: "focus"; session: string }
  | { verb: "compose"; machine: string }
  | { verb: "promptAsync"; host: string; session: string; text: unknown; directory: string | null }
  | { verb: "bind"; binds: unknown }
  | { verb: "mirror"; cells: unknown; palette: unknown }
  | { verb: "seats"; map: unknown }
  | { verb: "abort"; host: string; session: string; directory: string | null }
  | { verb: "loop"; host: string; session: string; directory: string | null }
  | { verb: "telemetry"; events: TelemetryEvent[] }
  | { verb: "unknown"; method: string; path: string; body: unknown };

export type TelemetryEvent = {
  at: number;
  kind: string;
  props: unknown;
  session?: string;
  ok?: number;
};

export type Decoder = (method: string, path: string, directory: string | null, body: unknown) => Intent;

const PROXY = /^\/api\/hosts\/([^/]+)\/proxy\/(.*)$/;

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record_<unknown>)[key] : undefined;
}
type Record_<T> = { [key: string]: T };

/** boxbox v1's wire (board/src/client.ts at the frozen commit) */
export const decodeV1: Decoder = (method, path, directory, body) => {
  const bare = path.split("?")[0] ?? path;
  if (method === "POST" && bare === "/api/login") return { verb: "login" };
  if (method === "GET" && bare === "/api/stream") return { verb: "stream" };
  if (method === "GET" && bare === "/api/spend") return { verb: "spend" };
  if (method === "POST" && bare === "/api/read") {
    const marks = field(body, "marks");
    const first = Array.isArray(marks) ? (marks[0] as unknown) : undefined;
    return { verb: "markRead", session: String(field(first, "session")) };
  }
  if (method === "POST" && bare === "/api/board/focus") return { verb: "focus", session: String(field(body, "session")) };
  if (method === "POST" && bare === "/api/board/compose") return { verb: "compose", machine: String(field(body, "machine")) };
  if (method === "POST" && bare === "/api/board/bindings") return { verb: "bind", binds: field(body, "binds") };
  if (method === "POST" && bare === "/api/board/frame") return { verb: "mirror", cells: field(body, "cells"), palette: field(body, "palette") };
  if (method === "POST" && bare === "/api/board/seats") return { verb: "seats", map: body };
  if (method === "POST" && bare === "/api/telemetry") {
    const events = field(body, "events");
    return {
      verb: "telemetry",
      events: (Array.isArray(events) ? events : []).map((e: unknown) => ({
        at: Number(field(e, "at")),
        kind: String(field(e, "kind")),
        props: field(e, "props") ?? {},
        ...(field(e, "session") !== undefined ? { session: String(field(e, "session")) } : {}),
        ...(field(e, "ok") !== undefined ? { ok: Number(field(e, "ok")) } : {}),
      })),
    };
  }
  const proxied = PROXY.exec(path);
  if (proxied) {
    const host = proxied[1] ?? "";
    const rest = proxied[2] ?? "";
    const restBare = rest.split("?")[0] ?? rest;
    if (method === "GET" && restBare === "session") return { verb: "sessions", host, directory };
    let m = /^session\/([^/]+)$/.exec(restBare);
    if (method === "GET" && m) return { verb: "session", host, session: `${host}:${m[1]}` };
    m = /^permission\/([^/]+)\/reply$/.exec(restBare);
    if (method === "POST" && m) return { verb: "replyPermission", host, id: m[1] ?? "", reply: String(field(body, "reply")), directory };
    m = /^question\/([^/]+)\/reply$/.exec(restBare);
    if (method === "POST" && m) return { verb: "replyQuestion", host, id: m[1] ?? "", answers: field(body, "answers"), directory };
    m = /^session\/([^/]+)\/(prompt_async|abort|loop)$/.exec(restBare);
    if (method === "POST" && m) {
      const session = `${host}:${m[1]}`;
      if (m[2] === "prompt_async") return { verb: "promptAsync", host, session, text: field(body, "parts"), directory };
      return { verb: m[2] === "abort" ? "abort" : "loop", host, session, directory };
    }
  }
  return { verb: "unknown", method, path, body };
};

export type StepView = {
  label: string;
  leds: string[];
  /** per leds line: may be absent on the other side (a seat memo re-show) */
  ledsOptional: boolean[];
  board: string[];
  calls: string[];
  radio: string[];
};

export type View = { steps: StepView[]; keepaliveGapMs: number };

export const CHANNELS = ["leds", "board", "calls", "radio"] as const;

const hex = (n: number) => n.toString(16).padStart(2, "0");

export const BRIEF_FRAME_MS = 60;
export const SEAT_MEMO_MS = 250;
export const RESHOW_AGE_MS = 1000;

/** frames that are the seat memo showing a stale picture. the shape is
    A, then B for at least RESHOW_AGE_MS, then A again for under
    SEAT_MEMO_MS: the board returning for a moment to the picture it showed
    just before, with no finger on a key. a frame drawn while a key is down
    is the key's own answer (the meter opens on the press), never lag. */
function memoReshows(steps: TracedStep[], holds: Map<Record, number>): Set<Record> {
  const out = new Set<Record>();
  let before = null as string | null;
  let previous = null as { key: string; hold: number } | null;
  const down = new Set<number>();
  for (const step of steps) {
    for (const r of step.records) {
      if (r.ch === "board" && r.bytes[0] === 0x82) {
        if (r.bytes[2] === 0) down.add(r.bytes[1] ?? -1);
        else down.delete(r.bytes[1] ?? -1);
        continue;
      }
      if (r.ch !== "hid" || r.bytes[1] !== 0x03) continue;
      const key = r.bytes.slice(2, 19).join(",");
      if (key === previous?.key) continue;
      const hold = holds.get(r) ?? 0;
      const stale = previous !== null && key === before && previous.hold >= RESHOW_AGE_MS && hold < SEAT_MEMO_MS;
      if (step.kind !== "start" && down.size === 0 && stale) out.add(r);
      before = previous?.key ?? null;
      previous = { key, hold };
    }
  }
  return out;
}

/** how long each FRAME write held before the next one replaced it */
function frameHolds(steps: TracedStep[]): Map<Record, number> {
  const frames = steps.flatMap((s) => s.records.filter((r) => r.ch === "hid" && r.bytes[1] === 0x03));
  const end = steps.at(-1)?.endedAt ?? 0;
  return new Map(frames.map((f, i) => [f, (frames[i + 1]?.t ?? Math.max(end, f.t)) - f.t]));
}

function ledLine(bytes: number[]): string | null {
  const op = bytes[1];
  const body = bytes.slice(2);
  switch (op) {
    case 0x01:
      return `hello proto ${body[0]}`;
    case 0x02: {
      const slot = body[0] ?? 0;
      if (slot >= 14) return null;
      return `palette ${slot} ${body.slice(1, 4).join(",")}`;
    }
    case 0x03:
      return `frame ${body.slice(0, 17).map(hex).join(" ")}`;
    case 0x04:
      return `global ${body[0]}`;
    case 0x05:
      return null;
    case 0x06:
      return `mode ${body[0] === 1 ? "calc" : "drive"}`;
    default:
      return `unknown op ${op}`;
  }
}

function boardLine(bytes: number[]): string {
  switch (bytes[0]) {
    case 0x81:
      return `hello-ack fw ${bytes[1]} proto ${bytes[2]} mode ${bytes[3]}`;
    case 0x82:
      return `key ${bytes[1]} ${bytes[2] === 0 ? "down" : "up"}`;
    case 0x83:
      return `mode ${bytes[1] === 1 ? "calc" : "drive"} (${["host", "local", "watchdog"][bytes[2] ?? 0] ?? bytes[2]})`;
    default:
      return `unknown op ${bytes[0]}`;
  }
}

/** json with sorted keys, so two equal intents print the same */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record_<unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function outcome(status: number | null | undefined): string {
  if (status === undefined) return "pending";
  if (status === null) return "unreachable";
  return status >= 200 && status < 300 ? "ok" : `failed ${status}`;
}

function callLine(intent: Exclude<Intent, { verb: "telemetry" | "mirror" | "seats" }>, status: number | null | undefined): string {
  const { verb, ...args } = intent;
  const rest = Object.keys(args).length > 0 ? ` ${stable(args)}` : "";
  return `${verb}${rest} -> ${outcome(status)}`;
}

function telemetryLine(event: TelemetryEvent): string {
  const tail = [
    event.session !== undefined ? `session ${event.session}` : null,
    event.ok !== undefined ? `ok ${event.ok}` : null,
  ].filter((part) => part !== null);
  return `telemetry ${event.kind} ${stable(event.props)}${tail.length > 0 ? ` ${tail.join(" ")}` : ""}`;
}

/** where an instant falls: the last step that had begun by then */
function stepAt(steps: TracedStep[], t: number): number {
  let index = 0;
  for (const [i, step] of steps.entries()) if (step.startedAt <= t) index = i;
  return index;
}

export function normalize(steps: TracedStep[], decode: Decoder = decodeV1): View {
  const views: StepView[] = steps.map((s) => ({ label: s.label, leds: [], ledsOptional: [], board: [], calls: [], radio: [] }));
  const statuses = new Map<number, number | null>();
  for (const step of steps) for (const r of step.records) if (r.ch === "http-done") statuses.set(r.id, r.status);

  let lastLed = "";
  let lastSeats = "";
  let spendSeen = false;
  let loginSeen = false;
  let keepaliveGapMs = 0;
  let lastWriteAt: number | null = null;
  const holds = frameHolds(steps);
  const optional = memoReshows(steps, holds);

  for (const [index, step] of steps.entries()) {
    const view = views[index] as StepView;
    let mirror: string | null = null;
    for (const r of step.records) {
      switch (r.ch) {
        case "hid": {
          if (lastWriteAt !== null) keepaliveGapMs = Math.max(keepaliveGapMs, r.t - lastWriteAt);
          lastWriteAt = r.t;
          const agentDriven = step.kind === "world" || step.kind === "idle";
          if (agentDriven && r.bytes[1] === 0x03 && (holds.get(r) ?? 0) < BRIEF_FRAME_MS) break;
          const line = ledLine(r.bytes);
          if (line !== null && line !== lastLed) {
            view.leds.push(line);
            view.ledsOptional.push(optional.has(r));
          }
          if (line !== null) lastLed = line;
          break;
        }
        case "board":
          view.board.push(boardLine(r.bytes));
          break;
        case "exec":
          view.radio.push(r.cmd === "say" ? `say ${JSON.stringify(r.args.at(-1) ?? "")}` : `${r.cmd} start`);
          break;
        case "exec-end":
          if (r.cmd !== "say") view.radio.push(`${r.cmd} stop`);
          break;
        case "http": {
          const intent = decode(r.method, r.path, r.directory, r.body);
          if (intent.verb === "telemetry") {
            for (const event of intent.events) (views[stepAt(steps, event.at)] as StepView).calls.push(telemetryLine(event));
          } else if (intent.verb === "mirror") {
            mirror = `mirror (last of step) ${stable({ cells: intent.cells, palette: intent.palette })}`;
          } else if (intent.verb === "seats") {
            const map = stable(intent.map);
            if (map !== lastSeats) view.calls.push(`seats ${map}`);
            lastSeats = map;
          } else if (intent.verb === "spend") {
            if (!spendSeen) view.calls.push(callLine(intent, statuses.get(r.id)));
            spendSeen = true;
          } else if (intent.verb === "login") {
            if (!loginSeen) view.calls.push(callLine(intent, statuses.get(r.id)));
            loginSeen = true;
          } else {
            view.calls.push(callLine(intent, statuses.get(r.id)));
          }
          break;
        }
        default:
          break;
      }
    }
    if (mirror !== null) view.calls.push(mirror);
  }
  /* group each step's calls by verb, verbs in name order so arrival timing cannot reorder them, each verb's
     own order kept; telemetry, placed by timestamp, goes last */
  for (const view of views) {
    const verbOf = (line: string) => (line.startsWith("telemetry ") ? "~telemetry" : (line.split(" ")[0] ?? ""));
    const order = [...new Set(view.calls.map(verbOf))].sort((a, b) => (a === "~telemetry" ? 1 : b === "~telemetry" ? -1 : a < b ? -1 : a > b ? 1 : 0));
    view.calls = order.flatMap((verb) => view.calls.filter((line) => verbOf(line) === verb));
  }
  return { steps: views, keepaliveGapMs };
}
