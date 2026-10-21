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

   calls are decoded into intents: decodeV1 reads v1's wire, decodeV2 the
   native daemon's acts on boxbox v2 (board/wire's Act), onto the same
   intents; that is what "semantically identical" means. a comparison
   across the two (the CROSS profiles) also folds what v1 said in a shape
   v2 does not have, and drops what v2 has no counterpart for on both
   sides (V1_ONLY): see crossVersion. */

import type { Record } from "./records";
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
  /** stop the running turn and run the queue now: v2's one act for v1's abort then loop */
  | { verb: "flush"; session: string }
  | { verb: "unbind"; wire: number }
  /** the board was unplugged */
  | { verb: "gone" }
  | { verb: "telemetry"; events: TelemetryEvent[] }
  | { verb: "unknown"; method: string; path: string; body: unknown };

export type TelemetryEvent = {
  at: number;
  kind: string;
  props: unknown;
  session?: string;
  ok?: number;
};

/** what a decoder may know beyond the call: the open asks' option labels from the views the daemon had
    received by then, since v2 names a question's answer by its index and v1 by its label */
export type DecodeContext = { askOptions: ReadonlyMap<string, readonly string[]> };

export type Decoder = (method: string, path: string, directory: string | null, body: unknown, context?: DecodeContext) => Intent;

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
  if (method === "POST" && bare === "/api/telemetry") return telemetryIntent(body);
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

/** a telemetry batch, the same shape on v1 and v2 (server/src/http/telemetry.rs): each event's latency and id dropped */
function telemetryIntent(body: unknown): Intent {
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

const hostOf = (key: string) => key.split(":")[0] ?? key;

/** a seat map as both versions can say it: the seats on the keys now, by digit. v1 posted every seat with
    `visible` and its page; v2 posts the visible ones (board/wire's Seat), `bound` only when a binding holds the
    digit */
export function seatList(map: unknown): { seats: unknown[] } {
  const seats = field(map, "seats");
  const list = (Array.isArray(seats) ? seats : [])
    .filter((s: unknown) => field(s, "visible") !== false)
    .map((s: unknown) => ({ digit: Number(field(s, "digit")), key: String(field(s, "key")), ...(field(s, "bound") === true ? { bound: true } : {}) }))
    .sort((a, b) => a.digit - b.digit);
  return { seats: list };
}

/** the native daemon on boxbox v2: login, the board stream, telemetry, and every act (board/wire's Act) */
export const decodeV2: Decoder = (method, path, _directory, body, context) => {
  const bare = path.split("?")[0] ?? path;
  if (method === "POST" && bare === "/api/login") return { verb: "login" };
  if (method === "GET" && (bare === "/api/stream" || bare === "/api/board/stream")) return { verb: "stream" };
  if (method === "POST" && bare === "/api/telemetry") return telemetryIntent(body);
  if (method === "POST" && bare === "/api/board/act") {
    const verb = field(body, "verb");
    const key = String(field(body, "key"));
    switch (verb) {
      case "focus":
        return { verb: "focus", session: key };
      case "compose":
        return { verb: "compose", machine: String(field(body, "machine")) };
      case "read":
        return { verb: "markRead", session: key };
      case "reply": {
        const ask = String(field(body, "ask"));
        const answer = field(body, "answer");
        const kind = field(answer, "kind");
        if (kind === "option") {
          const index = Number(field(answer, "index"));
          /* an index the views never offered stays visible as one, so it cannot pass as a label */
          const label = context?.askOptions.get(ask)?.[index] ?? `<option ${index} of an ask no view offered>`;
          return { verb: "replyQuestion", host: hostOf(key), id: ask, answers: [[label]], directory: null };
        }
        return { verb: "replyPermission", host: hostOf(key), id: ask, reply: String(kind), directory: null };
      }
      case "flush":
        return { verb: "flush", session: key };
      case "seats":
        return { verb: "seats", map: seatList(body) };
      case "bind":
        return { verb: "bind", binds: [{ wire: field(body, "wire"), key, color: field(body, "color") }] };
      case "unbind":
        return { verb: "unbind", wire: Number(field(body, "wire")) };
      case "gone":
        return { verb: "gone" };
      default:
        break;
    }
  }
  return { verb: "unknown", method, path, body };
};

/** v1 intents with no v2 counterpart, dropped from a comparison across versions on both sides, with why */
export const V1_ONLY: { verb: Intent["verb"]; why: string }[] = [
  { verb: "mirror", why: "the on-screen twin (POST /api/board/frame) is gone; v2's app has none (docs/board.md)" },
  { verb: "spend", why: "the spend poll is gone with the odometer (decision 79)" },
  { verb: "sessions", why: "refreshSessions: v1 listed each host's sessions to derive the board itself; v2's server sends the view (decision 80)" },
  { verb: "session", why: "fetchSession: as refreshSessions, one session at a time" },
];

/** a v1 or v2 intent as a comparison across versions reads it, or null when it is not compared. v1's flush was
    abort then loop on the same session: the abort is the flush, the loop its second half. v2 never sends the
    directory a v1 reply rode on (the server knows where the session lives), so neither side keeps it. */
export function crossVersion(intent: Intent): Intent | null {
  if (V1_ONLY.some((d) => d.verb === intent.verb)) return null;
  switch (intent.verb) {
    case "abort":
      return { verb: "flush", session: intent.session };
    case "loop":
      return null;
    case "replyPermission":
    case "replyQuestion":
      return { ...intent, directory: null };
    case "seats":
      return { verb: "seats", map: seatList(intent.map) };
    default:
      return intent;
  }
}

/** how one side of a diff is read: its decoder, and whether it meets the other version */
export type Profile = { decode: Decoder; cross: boolean };
export const V1: Profile = { decode: decodeV1, cross: false };
/** a v1 trace, read to meet a v2 replay */
export const V1_CROSS: Profile = { decode: decodeV1, cross: true };
export const V2_CROSS: Profile = { decode: decodeV2, cross: true };

/** who sits on the nine digit keys, by digit (index 0 is digit 1): a thread key, or null for an empty digit */
export type Seats = readonly (string | null)[];

export type StepView = {
  label: string;
  leds: string[];
  /** per leds line: may be absent on the other side (a seat memo re-show) */
  ledsOptional: boolean[];
  /** across versions, per leds line: the seat map the frame was drawn under (null for a line that is not a frame,
      or a run with no seat map yet), so a frame compares by thread (decision 80) */
  ledsSeats?: (Seats | null)[];
  /** across versions, per leds line: drawn before the first view reached the daemon (decision 81) */
  ledsBeforeView?: boolean[];
  /** across versions, per leds line: how long the frame held, in ms */
  ledsHold?: number[];
  /** across versions, per leds line: a seat-memo redraw after an answer, the picture from just before the pit was
      entered, back for under SEAT_MEMO_MS (v1's memo; see memoAfterAnswer) */
  ledsMemo?: boolean[];
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

/** frames that are the seat memo redrawing the picture from before the pit after an answer: in a step whose keys
    answered an ask, a frame held under SEAT_MEMO_MS that shows the picture the board wore when the press that entered
    the pit went down. the pit's entry is read from the daemon's own board.key event (target pit) */
function memoAfterAnswer(steps: TracedStep[], holds: Map<Record, number>): Set<Record> {
  const out = new Set<Record>();
  const all = steps.flatMap((s) => s.records);
  const frames = all.filter((r): r is Extract<Record, { ch: "hid" }> => r.ch === "hid" && r.bytes[1] === 0x03);
  const pictureAt = (t: number) => frames.filter((f) => f.t <= t).at(-1)?.bytes.slice(2, 19).join(",");
  const downs = all.filter((r) => r.ch === "board" && r.bytes[0] === 0x82 && r.bytes[2] === 0).map((r) => r.t);
  const entries: number[] = [];
  for (const r of all) {
    if (r.ch !== "http" || !Array.isArray(field(r.body, "events"))) continue;
    for (const e of field(r.body, "events") as unknown[]) {
      if (field(e, "kind") === "board.key" && field(field(e, "props"), "target") === "pit") entries.push(Number(field(e, "at")));
    }
  }
  const answered = (step: TracedStep) =>
    step.records.some((r) => r.ch === "http" && (/\/(permission|question)\/[^/]+\/reply/.test(r.path) || (r.path === "/api/board/act" && field(r.body, "verb") === "reply")));
  for (const step of steps) {
    if (step.kind !== "keys" || !answered(step)) continue;
    for (const f of step.records) {
      if (f.ch !== "hid" || f.bytes[1] !== 0x03 || (holds.get(f) ?? 0) >= SEAT_MEMO_MS) continue;
      const entry = entries.filter((t) => t <= f.t).at(-1);
      const press = entry === undefined ? undefined : downs.filter((t) => t <= entry).at(-1);
      if (press !== undefined && pictureAt(press - 1) === f.bytes.slice(2, 19).join(",")) out.add(f);
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

/** the asks a board stream frame offers: a view's threads, each with its open ask's option labels */
function asksOf(data: unknown): [string, readonly string[]][] {
  if (field(data, "type") !== "view") return [];
  const threads = field(data, "threads");
  return (Array.isArray(threads) ? threads : []).flatMap((t: unknown) => {
    const ask = field(t, "ask");
    const options = field(ask, "options");
    return ask === undefined ? [] : [[String(field(ask, "id")), Array.isArray(options) ? options.map(String) : []] as [string, string[]]];
  });
}

/** a call that names a thread, named by the digit it sits on (decision 80): a tap on k1 focuses digit 1's thread on
    each side, and "the top call" is digit 1's */
function onSeats(intent: Intent, seats: Seats | null): Intent {
  switch (intent.verb) {
    case "focus":
    case "markRead":
    case "flush":
      return { ...intent, session: byDigit(intent.session, seats) };
    default:
      return intent;
  }
}

/** where an instant falls: the last step that had begun by then */
function stepAt(steps: TracedStep[], t: number): number {
  let index = 0;
  for (const [i, step] of steps.entries()) if (step.startedAt <= t) index = i;
  return index;
}

/** the nine digit keys' wire indices, digit 1 first (k1 k2 k3 k4 k5 k6 k7 k8 k9) */
export const DIGIT_WIRES = [11, 12, 13, 8, 9, 10, 4, 5, 6] as const;

type SeatPost = { t: number; seats: Seats };

/** every seat map a run posted, in time order, as the cross-version profile reads it (v1's postSeats, v2's
    Act::Seats): what sits on each digit from that moment */
function seatTimeline(steps: TracedStep[], profile: Profile): SeatPost[] {
  const out: SeatPost[] = [];
  for (const step of steps) {
    for (const r of step.records) {
      if (r.ch !== "http") continue;
      const decoded = profile.decode(r.method, r.path, r.directory, r.body);
      if (decoded.verb !== "seats") continue;
      const seats = Array<string | null>(9).fill(null);
      for (const s of seatList(decoded.map).seats) {
        const digit = Number(field(s, "digit"));
        if (digit >= 1 && digit <= 9) seats[digit - 1] = String(field(s, "key"));
      }
      out.push({ t: r.t, seats });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** the seat map in effect at `t`, or null before the first post */
function seatsAt(timeline: SeatPost[], t: number): Seats | null {
  let found: Seats | null = null;
  for (const post of timeline) {
    if (post.t > t) break;
    found = post.seats;
  }
  return found;
}

/** a thread key as the digit it sits on at `t`, or the key when it sits on none */
function byDigit(key: string, seats: Seats | null): string {
  const at = seats?.indexOf(key) ?? -1;
  return at >= 0 ? `digit ${at + 1}` : key;
}

/** readback names a thread by its title, which in a trace is its alias: `h1:<alpha>` is read as "alpha" */
function readbackByDigit(words: string, seats: Seats | null): string {
  let out = words;
  for (const [i, key] of (seats ?? []).entries()) {
    const alias = key === null ? undefined : /<([^>]+)>/.exec(key)?.[1];
    if (alias) out = out.replace(new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), `digit ${i + 1}`);
  }
  return out;
}

export function normalize(steps: TracedStep[], profile: Profile = V1): View {
  const views: StepView[] = steps.map((s) => ({
    label: s.label,
    leds: [],
    ledsOptional: [],
    ...(profile.cross ? { ledsSeats: [], ledsBeforeView: [], ledsHold: [], ledsMemo: [] } : {}),
    board: [],
    calls: [],
    radio: [],
  }));
  /* across versions, a seat is the comparison's unit (decision 80): digit n is window n on each side */
  const timeline = profile.cross ? seatTimeline(steps, profile) : [];
  const frames = steps.flatMap((s) => s.records.filter((r) => r.ch === "hid" && r.bytes[1] === 0x03));
  const nextFrameAt = new Map(frames.map((f, i) => [f, frames[i + 1]?.t ?? Number.POSITIVE_INFINITY]));
  /* "at that moment" is the press: a verb's call and its telemetry name the thread the finger chose, even when its
     answer reorders the seats before the call returns */
  const presses = steps.flatMap((s) => s.records).filter((r) => r.ch === "board" && r.bytes[0] === 0x82 && r.bytes[2] === 0).map((r) => r.t);
  const seatsOfPress = (t: number) => {
    const press = presses.filter((at) => at <= t).at(-1);
    return seatsAt(timeline, press ?? t);
  };
  const firstView = steps.flatMap((s) => s.records).find((r) => r.ch === "sse" && field(r.data, "type") === "view")?.t ?? Number.POSITIVE_INFINITY;
  const statuses = new Map<number, number | null>();
  for (const step of steps) for (const r of step.records) if (r.ch === "http-done") statuses.set(r.id, r.status);

  let lastLed = "";
  let lastSeats = "";
  let spendSeen = false;
  let loginSeen = false;
  let keepaliveGapMs = 0;
  let lastWriteAt: number | null = null;
  const askOptions = new Map<string, readonly string[]>();
  const holds = frameHolds(steps);
  const optional = memoReshows(steps, holds);
  const memo = profile.cross ? memoAfterAnswer(steps, holds) : new Set<Record>();

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
            /* a seat post follows the render it belongs to: the map a frame wears is the last one posted before
               the next frame replaced it */
            const isFrame = r.bytes[1] === 0x03;
            view.ledsSeats?.push(isFrame ? seatsAt(timeline, (nextFrameAt.get(r) ?? r.t) - 1) : null);
            view.ledsBeforeView?.push(isFrame && r.t < firstView);
            view.ledsHold?.push(isFrame ? (holds.get(r) ?? 0) : 0);
            view.ledsMemo?.push(isFrame && memo.has(r));
          }
          if (line !== null) lastLed = line;
          break;
        }
        case "board":
          view.board.push(boardLine(r.bytes));
          break;
        case "exec":
          if (r.cmd === "say") {
            const words = r.args.at(-1) ?? "";
            view.radio.push(`say ${JSON.stringify(profile.cross ? readbackByDigit(words, seatsOfPress(r.t)) : words)}`);
          } else view.radio.push(`${r.cmd} start`);
          break;
        case "exec-end":
          if (r.cmd !== "say") view.radio.push(`${r.cmd} stop`);
          break;
        case "sse":
          for (const [id, options] of asksOf(r.data)) askOptions.set(id, options);
          break;
        case "http": {
          const decoded = profile.decode(r.method, r.path, r.directory, r.body, { askOptions });
          const crossed = profile.cross ? crossVersion(decoded) : decoded;
          if (crossed === null) break;
          const intent = profile.cross ? onSeats(crossed, seatsOfPress(r.t)) : crossed;
          if (intent.verb === "telemetry") {
            for (const event of intent.events) {
              const placed = profile.cross && event.session !== undefined ? { ...event, session: byDigit(event.session, seatsOfPress(event.at)) } : event;
              (views[stepAt(steps, event.at)] as StepView).calls.push(telemetryLine(placed));
            }
          } else if (intent.verb === "mirror") {
            mirror = `mirror (last of step) ${stable({ cells: intent.cells, palette: intent.palette })}`;
          } else if (intent.verb === "seats") {
            const map = stable(intent.map);
            /* across versions each side's map is its own (decision 80), and the comparison reads every other line
               through it, so the map is not itself a line: it changes whenever the app's order does, which v1's
               triage did at other moments */
            if (map !== lastSeats && !profile.cross) view.calls.push(`seats ${map}`);
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
