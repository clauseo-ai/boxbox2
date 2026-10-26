/* one recording, two wires (docs/protocol.md, section 16). the recorded cmx2 tape went through main's server and main's app
   (contract 1) when fixtures/two-wire-main.json.gz was recorded; here the same tape, re-encoded as protocol 3 by the
   simulated encoder (server/goldens/protocol3/journal.sse.gz), goes through this build's reducer, and what each build's own
   code derives from its final state must be the same: the fleet (main's mapped through translate.rs's cmx2-to-neutral
   table when it was recorded; capabilities added to that table since are laid onto its agents, ADDED_SINCE_RECORDING),
   home's windows (which, in order, each window's view, its tail lines and its body), and for
   every thread with a transcript its turn models as live.ts builds them, the ruler's ticks and the turns panel's rows as
   stage.tsx derives them, and what the details panel reads (details-model.ts). on both sides every thread with transcript
   entries is opened (the first 40, the cap) or held (the rest) just before its first entry, its read answering nothing,
   so every entry applies; any later read or refetch is answered at once from what the tape has said so far. the threads
   need solid's browser build (live.ts's memos), so that part runs in the `bun test --conditions browser` pass and skips
   itself in the plain one. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createMemo, createRoot, createSignal } from "solid-js";
import type { Frame, Message, Part } from "./protocol";
import { parseCursor } from "./protocol";
import { parseTape } from "./fixtures/saves";
import { type Action, type Fleet, INITIAL_STATE, type Patch, reduce, type SyncState, THREAD_CAP, type ThreadView, viewOf } from "./reducer";
import { windowKeys } from "../ui/home/membership";
import { windowName, windowView } from "../ui/window/view";
import { tailLines } from "../ui/window/tail";
import { runOf } from "../ui/window/run";
import { extraOf } from "../ui/inbox/extra";
import type { Kin } from "../ui/thread/details-model";
import type { Turn } from "../ui/thread/model";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

/* the sync client hands the drive a handle on `window` when it loads, and bun has none: given one only in the browser pass, which
   is the only one that loads them */
if (reactive) (globalThis as { window?: unknown }).window ??= globalThis;
/* loaded by name, so the root typecheck (no dom) does not follow them into the sync client */
type Store = { applyPatches: (patches: readonly Patch[]) => void; state: { fleet: Fleet } };
type Data = {
  title: () => string; directory: () => string; repoRoot: () => string; count: () => number; working: () => boolean; held: () => boolean; hydrating: () => boolean;
  all: () => void; turns: () => Turn[]; children: () => ReadonlyMap<string, unknown>; kin: () => readonly Kin[];
};
type Live = { createThreadData: (key: () => string, thinking: () => "open" | "rows") => Data };
type Details = typeof import("../ui/thread/details-model");
const at = (path: string): string => path;
const { applyPatches, state: store } = reactive ? ((await import(at("../store"))) as Store) : ({} as Store);
const { createThreadData } = reactive ? ((await import(at("../ui/thread/live"))) as Live) : ({} as Live);
const details = reactive ? ((await import(at("../ui/thread/details-model"))) as Details) : ({} as Details);

type Json = Record<string, unknown>;
type Recorded = {
  recorded: { commit: string; entries: number; opened: string[]; now: number };
  /** main's final fleet, each agent, thread and ask made neutral by translate.rs, keyed as the reducer keys them */
  fleet: { agentNames: string[]; agents: Json[]; threads: Record<string, Json>; asks: Record<string, Json>; order: string[]; colours: Json };
  home: { keys: string[]; windows: Json };
  threads: Json;
};

const root = join(import.meta.dir, "../../..");
const MAIN = JSON.parse(gunzipSync(readFileSync(join(import.meta.dir, "fixtures/two-wire-main.json.gz"))).toString("utf8")) as Recorded;
/** capabilities translate::agent gained after the recording, with what it says for a cmx2 daemon now: main's fleet was made
    neutral by the table as it stood then, so these are laid onto its agents rather than editing the recording by hand */
const ADDED_SINCE_RECORDING: Json = { fork: true, btw: true };
MAIN.fleet.agents = MAIN.fleet.agents.map((agent) => ({ ...agent, capabilities: { ...(agent["capabilities"] as Json), ...ADDED_SINCE_RECORDING } }));
/** threads main cut differently from this build since the recording (decision 92, 2026-10-22): main made a turn of every report,
    note and notice, and this build makes each one a row of the turn it came into, so a thread whose recording holds such a turn
    after its first has other turns (and the spend, the ruler and the panel that read them). those are held to main's turns from the
    person instead (the turns main started at a report or a notice gone), and every other thread to main's whole */
const recordedTurns = (key: string): Array<{ id: string; by: string }> => ((MAIN.threads as Record<string, { turns?: Array<{ id: string; by: string }> }>)[key]?.turns ?? []);
const RECUT_SINCE_RECORDING = new Set(Object.keys(MAIN.threads).filter((key) => recordedTurns(key).some((t, i) => i > 0 && (t.by === "mail" || t.by === "notice"))));
const EPOCH = "EPOCH";
const TRANSCRIPT = new Set(["message", "part", "delta", "message.removed"]);

/** a value as json says it: maps as their entries, sets as their members, undefined fields gone */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v)) ?? "null");

/** every path where two json values differ, up to `limit` */
function differences(a: unknown, b: unknown, path = "", out: string[] = [], limit = 20): string[] {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path || "."}: ${JSON.stringify(a)?.slice(0, 160)} != ${JSON.stringify(b)?.slice(0, 160)}`);
    return out;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  for (const k of new Set([...ka, ...kb])) differences((a as Json)[k], (b as Json)[k], `${path}/${k}`, out, limit);
  return out;
}

/** the transcripts the server holds, as the tape tells them: what a read or a refetch answers. a settled text part sent with its
    `textOf` in place of its text (docs/protocol.md, section 8) keeps the text it streamed, as the server's store does */
class Transcripts {
  private threads = new Map<string, Map<string, { info: Message["info"]; parts: Map<string, Part> }>>();
  private upstream = new Map<string, number>();

  take(frame: Frame): void {
    if (frame.type !== "message" && frame.type !== "part" && frame.type !== "delta" && frame.type !== "message.removed") return;
    const thread = this.threads.get(frame.key) ?? new Map<string, { info: Message["info"]; parts: Map<string, Part> }>();
    this.threads.set(frame.key, thread);
    if ("upstream" in frame && typeof frame.upstream === "number") this.upstream.set(frame.key, Math.max(frame.upstream, this.upstream.get(frame.key) ?? 0));
    if (frame.type === "message") {
      thread.set(frame.message.id, { info: frame.message, parts: thread.get(frame.message.id)?.parts ?? new Map() });
    } else if (frame.type === "part") {
      const parts = thread.get(frame.part.messageID)?.parts;
      if (!parts) return;
      const { textOf, ...rest } = frame.part as Json;
      const held = parts.get(frame.part.id) as Json | undefined;
      parts.set(frame.part.id, (textOf !== undefined && rest["text"] === undefined ? { ...rest, text: held?.["text"] ?? "" } : rest) as Part);
    } else if (frame.type === "delta") {
      const message = thread.get(frame.messageID);
      if (!message) return;
      const part = (message.parts.get(frame.partID) ?? { type: "text", id: frame.partID, messageID: frame.messageID, text: "" }) as Json;
      const had = typeof part[frame.field] === "string" ? (part[frame.field] as string) : "";
      message.parts.set(frame.partID, { ...part, [frame.field]: had.slice(0, frame.offset) + frame.delta } as Part);
    } else thread.delete(frame.messageID);
  }

  message(key: string, id: string): Message | null {
    const held = this.threads.get(key)?.get(id);
    return held ? { info: held.info, parts: [...held.parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) } : null;
  }

  read(key: string): { at: number; messages: Message[] } {
    const ids = [...(this.threads.get(key)?.keys() ?? [])];
    return { at: this.upstream.get(key) ?? 0, messages: ids.map((id) => this.message(key, id)).filter((m): m is Message => m !== null) };
  }
}

/** the tape behind a hello and a reset, as a fresh connect gets it, through the reducer; every thread with transcript entries
    opened (held past the cap) just before its first one */
function replay(): { state: SyncState; entries: number; opened: string[]; effects: Record<string, number> } {
  const tape = parseTape(gunzipSync(readFileSync(join(root, "server/goldens/protocol3/journal.sse.gz"))).toString("utf8"));
  const transcripts = new Transcripts();
  const effects: Record<string, number> = {};
  let state = INITIAL_STATE;
  const queue: Action[] = [];
  const play = (action: Action) => {
    queue.push(action);
    while (queue.length > 0) {
      const next = queue.shift() as Action; // the loop runs while the queue has one
      const result = reduce(state, next);
      state = result.state;
      for (const effect of result.effects) {
        effects[effect.type] = (effects[effect.type] ?? 0) + 1;
        if (effect.type === "hydrate") {
          const read = transcripts.read(effect.key);
          queue.push({ type: "hydrated", key: effect.key, hydration: effect.hydration, upstreamEpoch: "upstream", at: read.at, seq: state.cursor?.seq ?? 0, messages: structuredClone(read.messages) });
        } else if (effect.type === "refetch") {
          queue.push({ type: "refetched", key: effect.key, hydration: effect.hydration, messageID: effect.messageID, message: structuredClone(transcripts.message(effect.key, effect.messageID)) });
        }
      }
    }
  };
  play({ type: "frame", frame: { type: "hello", protocol: 3, epoch: EPOCH, head: 0, build: "BUILD", stream: "0".repeat(32), interest: { thread: null, under: [], holds: [] } } as Frame, id: null });
  play({ type: "frame", frame: { type: "reset", seq: 0, epoch: EPOCH, reason: "none", fleet: { agents: [], threads: [], asks: [], order: [] } } as Frame, id: parseCursor(`${EPOCH}:0`) });
  const opened: string[] = [];
  let clock = 1;
  for (const { id, frame } of tape) {
    if (TRANSCRIPT.has(frame.type) && "key" in frame && typeof frame.key === "string" && !opened.includes(frame.key)) {
      opened.push(frame.key);
      play(opened.length <= THREAD_CAP ? { type: "open", key: frame.key, at: clock++ } : { type: "hold", key: frame.key, at: clock++ });
    }
    transcripts.take(frame);
    play({ type: "frame", frame, id: parseCursor(id) });
  }
  return { state, entries: tape.length, opened, effects };
}

const run = replay();
const fleet = run.state.fleet;

test("the tape's every entry applies, and every thread with a transcript is held at the end, as on main", () => {
  expect(run.entries).toBe(2933);
  expect(run.state.cursor?.seq).toBe(2933);
  expect(run.opened).toEqual(MAIN.recorded.opened);
  expect(run.effects["reconnect"]).toBeUndefined();
  for (const key of run.opened) expect(run.state.threads[key]?.status).toBe("live");
});

test("the final fleet equals main's, mapped through the cmx2-to-neutral table", () => {
  const ours = json({
    agentNames: fleet.agentNames,
    agents: [...fleet.agentNames].map((name) => fleet.agents[name]),
    threads: fleet.threads,
    asks: fleet.asks,
    order: fleet.order,
    colours: fleet.colours,
  });
  expect(Object.keys(fleet.threads).length).toBe(Object.keys(MAIN.fleet.threads).length);
  expect(differences(ours, MAIN.fleet)).toEqual([]);
});

test("home's windows, their views, tail lines and bodies equal main's", () => {
  const keys = windowKeys(fleet, MAIN.recorded.now);
  const windows: Json = {};
  for (const key of keys) {
    const thread = fleet.threads[key];
    if (!thread) continue;
    const asks = Object.values(fleet.asks).filter((a) => a.key === key);
    const view = windowView(thread, asks, fleet.colours, extraOf(thread, true));
    windows[key] = json({ view, name: windowName(view), tail: tailLines(thread.tail), run: runOf(thread.tail, view.state) });
  }
  expect(keys).toEqual(MAIN.home.keys);
  expect(keys.length).toBeGreaterThan(0);
  expect(differences(windows, MAIN.home.windows)).toEqual([]);
});

test.skipIf(!reactive)("every thread's turns, ruler, turns panel and details equal main's", () => {
  const views: Record<string, ThreadView> = {};
  for (const [key, thread] of Object.entries(run.state.threads)) views[key] = viewOf(thread);
  applyPatches([{ path: ["fleet"], value: structuredClone(fleet) }, { path: ["threads"], value: structuredClone(views) }]);
  const firstLineOf = (text: string): string => { for (const line of text.slice(0, 20_000).split("\n")) if (line.trim()) return line.slice(0, 300); return ""; };
  const turnLabel = (t: Turn) => (t.by === "compaction" ? "compacted" : t.by === "mail" ? `${t.from ?? "an agent"} ${t.note ? "wrote" : "reported"}` : firstLineOf(t.prompt) || "(an image)");
  const stepsOf = (t: Turn): number => t.items.filter((i) => i.k === "step").length;
  const threads: Json = {};
  let turnCount = 0;
  for (const [key, thread] of Object.entries(run.state.threads)) {
    if (thread.messages.length === 0) continue;
    createRoot((dispose) => {
      const data = createThreadData(() => key, () => "rows");
      data.all();
      const turns = data.turns();
      turnCount += turns.length;
      const children = data.children() as Parameters<Details["rosterOf"]>[1];
      const kin = data.kin();
      const info = store.fleet.threads[key];
      const prompts = turns.filter((t) => t.by === "you" || t.by === "queued" || t.by === "steer" || t.by === "brief");
      const ruler = prompts.map((t) => ({ ask: t.items.some((i) => i.k === "step" && i.family === "ask"), label: turnLabel(t), steps: stepsOf(t), answered: Boolean(t.answer), at: t.at, ms: t.end - t.at }));
      const listed = turns.filter((t) => t.by !== "notice");
      const switched = details.switches(listed);
      const panel = listed.map((t) => ({ id: t.id, by: t.by, label: turnLabel(t), at: t.at, ms: t.end - t.at, steps: stepsOf(t), model: switched.get(t.id) ?? null }));
      const agents = details.rosterOf(turns, children);
      const files = details.filesChanged(turns);
      const spend = details.spendOf(turns, info, kin, agents);
      const ran = details.ranOf(turns);
      const tokens = info?.tokens;
      threads[key] = json({
        title: data.title(), directory: data.directory(), repoRoot: data.repoRoot(), count: data.count(), working: data.working(), held: data.held(), hydrating: data.hydrating(),
        turns, children, kin, ruler, panel,
        details: {
          agents, agentStates: agents.map((a) => details.agentState(a)), files, spend, ran: ran.map((t) => t.id),
          steps: ran.reduce((n, t) => n + stepsOf(t), 0),
          facts: details.factsOf(turns, info, spend.agents), summary: details.summaryOf(agents.length, files.files.length),
          context: details.contextOf(info) ?? null, models: details.modelsOf(turns),
          cached: tokens && details.cachedShare(tokens) !== null ? details.percentWords(tokens.cacheRead, tokens.input + tokens.cacheRead) : null,
          tokens: tokens ? details.tokensIn(tokens) : null,
        },
      });
      dispose();
    });
  }
  expect(Object.keys(threads).sort()).toEqual(Object.keys(MAIN.threads).sort());
  expect(turnCount).toBeGreaterThan(Object.keys(threads).length);
  const untouched = (all: Json): Json => Object.fromEntries(Object.entries(all).filter(([key]) => !RECUT_SINCE_RECORDING.has(key)));
  expect(differences(untouched(threads), untouched(MAIN.threads as Json))).toEqual([]);
  for (const key of RECUT_SINCE_RECORDING) {
    const ours = ((threads[key] as { turns: Array<{ id: string }> }).turns).map((t) => t.id);
    expect(ours).toEqual(recordedTurns(key).filter((t, i) => i === 0 || (t.by !== "mail" && t.by !== "notice")).map((t) => t.id));
  }
});
