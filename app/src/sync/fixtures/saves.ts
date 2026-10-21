/* a recorded stream played through the reducer the way the worker plays
   it, for the cache's tests: the protocol 3 journal tape
   (server/goldens/protocol3/journal.sse.gz, the recorded cmx2 tape the
   simulated encoder re-encoded), behind a hello and a reset as a fresh
   connect gets them, with its two busiest threads opened and a third held
   from the start, each read from a recorded transcript
   (ui/thread/fixtures, made neutral by neutral.ts) so its pages are real
   pages, one of them carrying a photo. what the worker does with each
   result (mark it dirty, run its effects, save) is the caller's. */

import type { Frame, Message, Thread } from "../protocol";
import { parseCursor } from "../protocol";
import { type Action, type Effect, INITIAL_STATE, type Patch, reduce, type SyncState } from "../reducer";
import { neutralMessage } from "./neutral";

/** one frame of the tape: its sse id (null when it had none) and its data */
export type Recorded = { id: string | null; frame: Frame };

/** the frames of an sse text: an optional `id:` line and `data:` lines, then a blank line */
export function parseTape(text: string): Recorded[] {
  const out: Recorded[] = [];
  for (const block of text.split("\n\n")) {
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length > 0) out.push({ id, frame: JSON.parse(data.join("\n")) as Frame });
  }
  return out;
}

/** the tape's epoch: its ids are `EPOCH:<seq>` */
const EPOCH = "EPOCH";

/** a photo a person sent: an image keeps its data url in the thread (reducer.ts, `slimPart`), so its bytes are in every page write */
function withPhoto(messages: Message[], at: number): Message[] {
  const target = messages[at];
  if (!target) return messages;
  const url = `data:image/png;base64,${"iVBORw0KGgo".repeat(20_000)}`;
  const photo = { id: `prt_photo_${at}`, messageID: target.info.id, type: "image", mime: "image/png", filename: "photo.png", url, flavour: "attached" };
  const copy = [...messages];
  copy[at] = { info: target.info, parts: [...target.parts, photo as Message["parts"][number]] };
  return copy;
}

/** the tape's two threads with the most transcript entries, and the third, held */
export const OPENED = ["bench:ses_f1db24a935fc4e40a63c", "bench:ses_e4f85b4aa9b04a7aa433"] as const;
export const HELD = "bench:ses_2f14db9d662b46868ec3";

/** what the replay is made of, read by the caller: the tape's text, and the cmx2 messages of two recorded transcripts
    (`{ messages }` of ui/thread/fixtures/cmx-deploy.json and notes-asks.json), made neutral here */
export type Recording = { tape: string; deploy: unknown[]; notes: unknown[] };

const neutral = (raw: unknown[]): Message[] => raw.map((m) => neutralMessage(m as Parameters<typeof neutralMessage>[0]));

/** the history each thread's read answers with */
function history(recording: Recording, key: string): Message[] {
  if (key === OPENED[0]) return withPhoto(neutral(recording.deploy), 120);
  if (key === OPENED[1]) return neutral(recording.notes);
  return [];
}

/** `pad` idle threads join the reset's snapshot, each a copy of the recorded thread with the longest tail, so the fleet has
    the size of a real one (docs/architecture.md: up to 300 windows, 1000 threads) */
function padFleet(recorded: Recorded[], pad: number): void {
  let template: Thread | null = null;
  for (const { frame } of recorded) {
    if (frame.type === "thread" && (!template || frame.thread.tail.length > template.tail.length)) template = frame.thread;
  }
  const reset = recorded.find((r) => r.frame.type === "reset");
  if (!template || reset?.frame.type !== "reset") return;
  const padding = Array.from({ length: pad }, (_, i): Thread => {
    const id = `ses_pad${String(i).padStart(4, "0")}`;
    return { ...structuredClone(template), key: `bench:${id}`, id, activity: { state: "idle" } };
  });
  reset.frame = { ...reset.frame, fleet: { ...reset.frame.fleet, threads: [...reset.frame.fleet.threads, ...padding] } };
}

/** a deterministic generator, so every build streams the same deltas */
function seeded(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1_103_515_245 + 12_345) % 2_147_483_648;
    return value / 2_147_483_648;
  };
}

/** `count` long answers of `length` characters each, streamed after the tape into the first opened thread as the server
    streams one (deltas of 8 to 40 characters), each settled by its whole part, the last left streaming when `settle` is
    false; numbered on from the tape's last entry */
function streamAnswers(recorded: Recorded[], length: number, count: number, settle: boolean): void {
  let seq = 0;
  let upstream = 0;
  for (const { frame } of recorded) {
    if ("seq" in frame && typeof frame.seq === "number") seq = Math.max(seq, frame.seq);
    if ("upstream" in frame && typeof frame.upstream === "number") upstream = Math.max(upstream, frame.upstream);
  }
  const key = OPENED[0];
  const thread = key.slice("bench:".length);
  const push = (frame: Record<string, unknown>) => {
    seq++;
    recorded.push({ id: `${EPOCH}:${seq}`, frame: { seq, ...frame } as Frame });
  };
  const random = seeded(7);
  const words = "the ledger keeps every invoice by its number and the migration moves them in order, checking each total twice ";
  for (let answer = 0; answer < count; answer++) {
    const messageID = `msg_${thread.slice(4)}_long${answer}`;
    const partID = `prt_${thread.slice(4)}_long${answer}_0`;
    const created = 1_792_053_400_000 + answer * 100_000;
    push({ type: "message", key, upstream: ++upstream, message: { id: messageID, role: "assistant", created } });
    let text = "";
    while (text.length < length) {
      const size = 8 + Math.floor(random() * 33);
      const start = text.length % words.length;
      const piece = (words + words).slice(start, start + size);
      push({ type: "delta", key, messageID, partID, field: "text", delta: piece, offset: text.length });
      text += piece;
    }
    if (settle || answer < count - 1) {
      push({ type: "part", key, upstream: ++upstream, part: { type: "text", id: partID, messageID, text, time: { start: created, end: created + 60_000 } } });
    }
  }
}

export type Step = { action: Action; state: SyncState; patches: readonly Patch[]; effects: readonly Effect[]; index: number };

/** what the replay holds besides the tape: `pad` idle threads in the fleet; `answers` long answers of `answer` characters
    streamed after it, the last left unsettled when `settle` is false; `frames`, only the tape's first frames */
export type ReplayOptions = { histories?: boolean; pad?: number; answer?: number; answers?: number; settle?: boolean; frames?: number };

/** every action of the replay in order, with what the reducer made of it. a read the reducer asks for is answered at once,
    after the action that asked, stamped with the journal head as the server would. without `histories` every read answers
    empty, so the threads hold only what streamed */
export function* recordedSteps(recording: Recording, { histories = true, pad = 0, answer = 0, answers = 1, settle = true, frames }: ReplayOptions = {}): Generator<Step> {
  const recorded: Recorded[] = [
    { id: null, frame: { type: "hello", protocol: 3, epoch: EPOCH, head: 0, build: "BUILD", stream: "0".repeat(32), interest: { thread: null, under: [], holds: [] } } as Frame },
    { id: `${EPOCH}:0`, frame: { type: "reset", seq: 0, epoch: EPOCH, reason: "none", fleet: { agents: [], threads: [], asks: [], order: [] } } as Frame },
    ...parseTape(recording.tape).slice(0, frames),
  ];
  if (pad > 0) padFleet(recorded, pad);
  if (answer > 0) streamAnswers(recorded, answer, answers, settle);
  let state = INITIAL_STATE;
  let index = 0;
  let clock = 1_000;
  const queue: Action[] = [];
  const play = function* (action: Action): Generator<Step> {
    queue.push(action);
    while (queue.length > 0) {
      const next = queue.shift() as Action; // the loop runs while the queue has one
      const result = reduce(state, next);
      state = result.state;
      for (const effect of result.effects) {
        if (effect.type === "hydrate") {
          const messages = histories ? history(recording, effect.key) : [];
          queue.push({ type: "hydrated", key: effect.key, hydration: effect.hydration, upstreamEpoch: "u1", at: 0, seq: state.cursor?.seq ?? 0, messages, bytes: JSON.stringify(messages).length });
        }
      }
      yield { action: next, state, patches: result.patches, effects: result.effects, index: index++ };
    }
  };
  for (const { id, frame } of recorded) {
    yield* play({ type: "frame", frame, id: parseCursor(id) });
    if (frame.type === "reset") {
      for (const key of OPENED) yield* play({ type: "open", key, at: clock++ });
      yield* play({ type: "hold", key: HELD, at: clock++ });
    }
  }
}
