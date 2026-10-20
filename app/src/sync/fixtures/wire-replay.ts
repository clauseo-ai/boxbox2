/* the wire between the worker and the ui, replayed: the recorded journal (ui/home/fixtures/journal.ndjson), then what it
   lacks (a key deleted and set again inside a session entry within one post, a session removed, a message removed, a
   host reset, a lost entry and the reconnect that replays it) and a long streamed answer, go through the real reducer the
   way the worker runs it (sync/worker.ts: patches pile up, are coalesced and posted once a frame, and copied on the way as
   postMessage does). the ui side takes them through the queue client.ts uses (queue.ts) and the store's own apply, at
   frames, or at once for each post while the page is hidden. reads are answered from a model of the daemon fed by the
   same frames, with content: a hydration leaves out the newest message half the time, as an in-flight read can, so
   entries for it refetch it and what waited is applied on the answer. after every apply the ui's store is compared with
   the worker state it mirrors. the batching is fixed by a seeded generator, so two builds see the same apply points and
   can be compared by a digest of what the ui held at each of them. */

import { unwrap } from "solid-js/store";
import { applyPatches, state as ui } from "../../store";
import type { Ask, Frame, Message, Part, SessionEntry } from "../protocol";
import { parseCursor } from "../protocol";
import { PatchQueue } from "../queue";
import { type Action, coalesce, INITIAL_STATE, reduce, type SyncState, viewOf } from "../reducer";

type Recorded = { id: string | null; frame: Frame };
/** one frame of the replay; `together` keeps the next one in the same post */
export type Step = Recorded & { together?: boolean };

export type Replay = {
  /** the ui's store matched the worker at every apply, or the first apply where it did not */
  mismatch: string | null;
  applies: number;
  /** posts from the worker and the patches and json characters they carried */
  posts: number;
  patches: number;
  bytes: number;
  /** time spent in the ui's apply, ms */
  applyMs: number;
  /** what the run went through, so a test can say it covered it */
  seen: { refetches: number; answered: number; gaps: number; hydrations: number; removed: number };
  /** a digest of the ui's fleet and threads at every apply, chained */
  uiDigest: string;
  /** a digest of the worker's final state, without what only a newer build keeps (`bookkeeping`) */
  workerDigest: string;
};

/** a chained digest, which the caller supplies (node's crypto in the tests): this file is built with the app */
export type Hasher = { update(text: string): void; digest(): string };

/** a small seeded generator, so batch sizes vary the same way on every run */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** the frames of `ui/home/fixtures/journal.ndjson`, read by the caller */
export function journal(text: string): Recorded[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Recorded);
}

const WORKING = "move invoices to the new ledger";
const WANTS = "set the greeting in the notes";
const PARKED = "rebuild the search index";

/** the journal, then the cases it lacks, then a long answer of `length` characters (deltas of 8 to 40 characters, a
    session tick every eight carrying the tail the server would: the last 280 characters), numbered as one journal */
export function scenario(recorded: readonly Recorded[], length: number): Step[] {
  const steps: Step[] = recorded.map((r) => ({ ...r }));
  const epoch = parseCursor(recorded[recorded.length - 1]?.id)?.epoch;
  if (!epoch) throw new Error("the journal ends without a cursor");
  let upstream = 0;
  const sessions = new Map<string, SessionEntry>();
  const asks = new Map<string, Ask>();
  let order: string[] = [];
  for (const { frame } of recorded) {
    if ("upstream" in frame && typeof frame.upstream === "number") upstream = Math.max(upstream, frame.upstream);
    if (frame.type === "session") sessions.set(frame.session.key, frame.session);
    if (frame.type === "ask") asks.set(`${frame.ask.host}:${frame.ask.id}`, frame.ask);
    if (frame.type === "ask.settled") asks.delete(`${frame.host}:${frame.id}`);
    if (frame.type === "order") order = frame.keys;
  }
  const titled = (title: string): SessionEntry => {
    const entry = [...sessions.values()].find((s) => s.info.title === title);
    if (!entry) throw new Error(`the journal holds no thread titled "${title}"`);
    return entry;
  };
  const push = (frame: Record<string, unknown>, together = false) => steps.push({ id: null, frame: frame as Frame, ...(together ? { together } : {}) });
  const tick = (entry: SessionEntry, together = false) => {
    sessions.set(entry.key, entry);
    push({ type: "session", session: entry }, together);
  };

  // a key deleted from a session's info and set again in the next tick goes to the end of the object; then back in place
  const working = titled(WORKING);
  const { title, ...untitled } = working.info;
  for (let round = 0; round < 3; round++) {
    tick({ ...working, info: untitled as SessionEntry["info"] }, true);
    tick({ ...working, info: { ...untitled, title } as SessionEntry["info"] });
    tick(working);
  }
  // a session removed, and the order without it
  const parked = titled(PARKED);
  sessions.delete(parked.key);
  push({ type: "session.removed", key: parked.key });
  order = order.filter((k) => k !== parked.key);
  push({ type: "order", keys: order });
  // a message removed from a held thread
  const wants = titled(WANTS);
  const first = recorded.find((r) => r.frame.type === "message" && r.frame.key === wants.key);
  if (first?.frame.type !== "message") throw new Error("the thread that wants has no message");
  push({ type: "message.removed", key: wants.key, messageID: first.frame.info.id, upstream: ++upstream });
  // the host's upstream stream reset: its sessions and asks again, a status changed, and every thread read again
  tick({ ...wants, status: null });
  push({ type: "host.reset", host: working.host, sessions: [...sessions.values()], asks: [...asks.values()] });

  // the long answer
  const id = working.id;
  const messageID = `msg_${id.slice(4)}_long`;
  const partID = `prt_${id.slice(4)}_long_0`;
  const created = working.info.time.updated + 1000;
  push({ type: "message", key: working.key, upstream: ++upstream, info: { id: messageID, sessionID: id, role: "assistant", time: { created } } });
  const random = seeded(7);
  const words = "the ledger keeps every invoice by its number and the migration moves them in order, checking each total twice ";
  let text = "";
  let deltas = 0;
  let updated = created;
  let tail = working.tail;
  while (text.length < length) {
    const size = 8 + Math.floor(random() * 33);
    const start = text.length % words.length;
    const piece = (words + words).slice(start, start + size);
    push({ type: "delta", key: working.key, messageID, partID, field: "text", delta: piece, offset: text.length });
    text += piece;
    if (++deltas % 8 === 0) {
      updated += 200;
      const item = { partID, messageID, kind: "text", role: "assistant", text: text.slice(-280) };
      tail = [...tail.filter((t) => t.partID !== partID), item].slice(-12) as SessionEntry["tail"];
      tick({ ...working, info: { ...working.info, time: { ...working.info.time, updated } }, tail });
    }
  }
  push({ type: "part", key: working.key, upstream: ++upstream, part: { id: partID, sessionID: id, messageID, type: "text", text, time: { start: created, end: updated } } });

  // one numbering for all of it, as the server's journal
  let seq = 0;
  for (const step of steps) {
    if (step.frame.type === "hello") continue;
    if (step.frame.type === "reset") {
      seq = step.frame.seq;
      continue;
    }
    seq++;
    step.frame = { ...step.frame, seq } as Frame;
    step.id = `${epoch}:${seq}`;
  }
  return steps;
}

/** the daemon's transcripts, as the frames tell them: what a read or a refetch would answer */
class Daemon {
  private threads = new Map<string, Map<string, { info: Message["info"]; parts: Map<string, Part> }>>();
  private upstream = new Map<string, number>();

  take(frame: Frame): void {
    if (frame.type !== "message" && frame.type !== "part" && frame.type !== "delta" && frame.type !== "message.removed") return;
    const thread = this.threads.get(frame.key) ?? new Map();
    this.threads.set(frame.key, thread);
    if ("upstream" in frame && typeof frame.upstream === "number") this.upstream.set(frame.key, Math.max(frame.upstream, this.upstream.get(frame.key) ?? 0));
    if (frame.type === "message") {
      const held = thread.get(frame.info.id);
      thread.set(frame.info.id, { info: frame.info, parts: held?.parts ?? new Map() });
    } else if (frame.type === "part") {
      thread.get(frame.part.messageID)?.parts.set(frame.part.id, frame.part);
    } else if (frame.type === "delta") {
      const message = thread.get(frame.messageID);
      if (!message) return;
      const part = message.parts.get(frame.partID) ?? ({ id: frame.partID, sessionID: message.info.sessionID, messageID: frame.messageID, type: "text", text: "" } as Part);
      const had = typeof part[frame.field] === "string" ? (part[frame.field] as string) : "";
      message.parts.set(frame.partID, { ...part, [frame.field]: had.slice(0, frame.offset) + frame.delta } as Part);
    } else {
      thread.delete(frame.messageID);
    }
  }

  message(key: string, id: string): Message | null {
    const held = this.threads.get(key)?.get(id);
    return held ? { info: held.info, parts: [...held.parts.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) } : null;
  }

  read(key: string, inFlight: boolean): { at: number; messages: Message[] } {
    const ids = [...(this.threads.get(key)?.keys() ?? [])];
    const messages = ids.map((id) => this.message(key, id)).filter((m): m is Message => m !== null);
    // an in-flight read can miss the newest message; its frames are inside the read's seq, so only a refetch brings it
    if (inFlight && messages.at(-1)?.info.role === "assistant") messages.pop();
    return { at: this.upstream.get(key) ?? 0, messages };
  }
}

const keysOf = (steps: readonly Step[]): string[] => {
  const keys = new Set<string>();
  for (const { frame } of steps) if (frame.type === "message" || frame.type === "part" || frame.type === "delta") keys.add(frame.key);
  return [...keys];
};

/** fields of a newer build's thread that are bookkeeping for caps, not state the ui or the cache sees */
const bookkeeping = new Set<string>(["bufferBytes", "heldBytes"]);
const workerJson = (state: SyncState): string => JSON.stringify(state, (name, value: unknown) => (bookkeeping.has(name) ? undefined : value));

/** the ui's copy of what the worker holds: the fleet, and the view of every thread */
const uiJson = (): string => JSON.stringify({ fleet: unwrap(ui.fleet), threads: unwrap(ui.threads) });
const mirrorJson = (state: SyncState): string => {
  const threads: Record<string, unknown> = {};
  for (const [key, thread] of Object.entries(state.threads)) threads[key] = viewOf(thread);
  return JSON.stringify({ fleet: state.fleet, threads });
};

/** `hidden`: the steps, by index, during which the page is hidden and every post lands at once; `gap`: the step whose
    frame is lost the first time, so the next one is a gap and the worker reconnects from its cursor */
export function replayWire(steps: readonly Step[], hasher: () => Hasher, seed = 1, options: { hidden?: [number, number]; gap?: number } = {}): Replay {
  applyPatches([{ path: ["fleet"], value: structuredClone(INITIAL_STATE.fleet) }, { path: ["threads"], value: {} }]);
  const random = seeded(seed);
  const daemon = new Daemon();
  const queue = new PatchQueue();
  let worker: SyncState = INITIAL_STATE;
  let pending: Parameters<typeof coalesce>[0][number][] = [];
  // a read or a refetch answers some frames after it was asked, so entries buffer and wait meanwhile
  const later: Array<{ due: number; answer: () => Action }> = [];
  let tick = 0;
  let reads = 0;
  let reconnect = false;
  const result: Replay = { mismatch: null, applies: 0, posts: 0, patches: 0, bytes: 0, applyMs: 0, seen: { refetches: 0, answered: 0, gaps: 0, hydrations: 0, removed: 0 }, uiDigest: "", workerDigest: "" };
  const chain = hasher();

  const dispatch = (action: Action) => {
    const reduced = reduce(worker, action);
    worker = reduced.state;
    pending.push(...reduced.patches);
    for (const effect of reduced.effects) {
      if (effect.type === "hydrate") {
        const wait = effect.key.endsWith("becf") && tick < 400 ? 400 - tick : 5 + Math.floor(random() * 40);
        const inFlight = reads++ % 2 === 0;
        later.push({
          due: tick + wait,
          answer: () => {
            result.seen.hydrations++;
            const read = daemon.read(effect.key, inFlight);
            return { type: "hydrated", key: effect.key, hydration: effect.hydration, upstreamEpoch: "upstream", at: read.at, messages: structuredClone(read.messages) };
          },
        });
      } else if (effect.type === "refetch") {
        result.seen.refetches++;
        later.push({
          due: tick + 3,
          answer: () => {
            const message = daemon.message(effect.key, effect.messageID);
            if (message) result.seen.answered++;
            return { type: "refetched", key: effect.key, hydration: effect.hydration, messageID: effect.messageID, message: structuredClone(message) };
          },
        });
      } else if (effect.type === "reconnect") {
        reconnect = true;
      }
    }
  };
  const apply = () => {
    const patches = queue.take();
    if (patches.length === 0) return;
    const started = performance.now();
    applyPatches(patches);
    result.applyMs += performance.now() - started;
    result.applies++;
    const seen = uiJson();
    chain.update(seen);
    if (result.mismatch === null && pending.length === 0 && seen !== mirrorJson(worker)) result.mismatch = `apply ${result.applies}, frame ${tick}`;
  };
  const post = (hidden: boolean) => {
    if (pending.length === 0) return;
    const patches = coalesce(pending);
    pending = [];
    result.posts++;
    result.patches += patches.length;
    result.bytes += JSON.stringify(patches).length;
    // postMessage hands the ui a copy: the store mutates what it is given in place, never the worker's state
    queue.push(structuredClone(patches));
    if (hidden) apply();
  };

  const keys = keysOf(steps);
  keys.forEach((key, i) => dispatch(i === keys.length - 1 ? { type: "hold", key, at: i + 1 } : { type: "open", key, at: i + 1 }));
  let untilPost = 1;
  let untilApply = 1;
  let fed = -1;
  let lost = false;
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at] as Step; // at is inside the steps
    const { id, frame } = step;
    // the daemon wrote every frame, whether or not this client got it
    if (at > fed) {
      fed = at;
      daemon.take(frame);
    }
    if (at === options.gap && !lost) {
      lost = true;
      continue;
    }
    tick++;
    const epoch = frame.type === "reset" ? frame.epoch : parseCursor(id)?.epoch;
    dispatch({ type: "frame", frame, epoch });
    if (frame.type === "session.removed" || frame.type === "message.removed") result.seen.removed++;
    for (let i = later.length - 1; i >= 0; i--) {
      const one = later[i];
      if (one && one.due <= tick) {
        later.splice(i, 1);
        dispatch(one.answer());
      }
    }
    if (reconnect) {
      // the stream is dialled again from the cursor and the server replays what followed it
      reconnect = false;
      result.seen.gaps++;
      const from = worker.cursor?.seq ?? 0;
      const resume = steps.findIndex((s) => s.frame.type !== "hello" && s.frame.type !== "reset" && "seq" in s.frame && s.frame.seq === from + 1);
      if (resume >= 0) at = resume - 1;
    }
    if (step.together) continue;
    const hidden = options.hidden !== undefined && at >= options.hidden[0] && at < options.hidden[1];
    if (--untilPost > 0) continue;
    untilPost = 1 + Math.floor(random() * 6);
    post(hidden);
    if (hidden || --untilApply > 0) continue;
    untilApply = 1 + Math.floor(random() * 3);
    apply();
  }
  for (let rounds = 0; later.length > 0 && rounds < 100; rounds++) for (const one of later.splice(0)) dispatch(one.answer());
  post(false);
  apply();
  result.uiDigest = chain.digest();
  const final = hasher();
  final.update(workerJson(worker));
  result.workerDigest = final.digest();
  return result;
}
