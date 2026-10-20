/* a recorded stream played through the reducer the way the worker plays
   it, for the cache's tests: the home journal (ui/home/fixtures), with its
   two busiest threads opened and a third held from the start, each read
   from a recorded transcript (ui/thread/fixtures) so its pages are real
   pages, one of them carrying a photo. what the worker does with each
   result (mark it dirty, run its effects, save) is the caller's. */

import { parseJournal, type Recorded } from "../../ui/home/fixtures/replay";
import type { Message, SessionEntry } from "../protocol";
import { parseCursor } from "../protocol";
import { type Action, type Effect, INITIAL_STATE, type Patch, reduce, type SyncState } from "../reducer";

/** a photo a person sent: an image keeps its data url in the thread (reducer.ts, `slimPart`), so its bytes are in every page write */
function withPhoto(messages: Message[], at: number): Message[] {
  const target = messages[at];
  if (!target) return messages;
  const url = `data:image/png;base64,${"iVBORw0KGgo".repeat(20_000)}`;
  const photo = { id: `prt_photo_${at}`, sessionID: target.info.sessionID, messageID: target.info.id, type: "file", mime: "image/png", filename: "photo.png", url };
  const copy = [...messages];
  copy[at] = { info: target.info, parts: [...target.parts, photo as Message["parts"][number]] };
  return copy;
}

export const OPENED = ["bench:ses_426e19f7048b4b71becf", "bench:ses_0ec5613695a04a7aad16"] as const;
export const HELD = "bench:ses_97580bb036e44e02a938";

/** what the replay is made of, read by the caller: the journal's text, and the messages of two recorded transcripts
    (`{ messages }` of ui/thread/fixtures/cmx-deploy.json and notes-asks.json) */
export type Recording = { journal: string; deploy: Message[]; notes: Message[] };

/** the history each thread's read answers with */
function history(recording: Recording, key: string): Message[] {
  if (key === OPENED[0]) return withPhoto(recording.deploy, 120);
  if (key === OPENED[1]) return recording.notes;
  return [];
}

/** `pad` idle sessions join the reset's snapshot, each a copy of the recorded session with the longest tail, so the fleet has
    the size of a real one (docs/architecture.md: up to 300 windows, 1000 sessions) */
function padFleet(recorded: Recorded[], pad: number): void {
  let template: SessionEntry | null = null;
  for (const { frame } of recorded) {
    if (frame.type === "session" && (!template || frame.session.tail.length > template.tail.length)) template = frame.session;
  }
  const reset = recorded.find((r) => r.frame.type === "reset");
  if (!template || reset?.frame.type !== "reset") return;
  const padding = Array.from({ length: pad }, (_, i): SessionEntry => {
    const id = `ses_pad${String(i).padStart(4, "0")}`;
    return { ...structuredClone(template), key: `bench:${id}`, id, status: null };
  });
  reset.frame = { ...reset.frame, fleet: { ...reset.frame.fleet, sessions: [...reset.frame.fleet.sessions, ...padding] } };
}

export type Step = { action: Action; state: SyncState; patches: readonly Patch[]; effects: readonly Effect[]; index: number };

/** every action of the replay in order, with what the reducer made of it. a read the reducer asks for is answered at once,
    after the action that asked. without `histories` every read answers empty, so the threads hold only what streamed */
export function* recordedSteps(recording: Recording, { histories = true, pad = 0 }: { histories?: boolean; pad?: number } = {}): Generator<Step> {
  const recorded = parseJournal(recording.journal);
  if (pad > 0) padFleet(recorded, pad);
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
          queue.push({ type: "hydrated", key: effect.key, hydration: effect.hydration, upstreamEpoch: "u1", at: 0, messages, bytes: JSON.stringify(messages).length });
        }
      }
      yield { action: next, state, patches: result.patches, effects: result.effects, index: index++ };
    }
  };
  for (const { id, frame } of recorded) {
    const epoch = frame.type === "reset" ? frame.epoch : parseCursor(id)?.epoch;
    yield* play({ type: "frame", frame, epoch });
    if (frame.type === "reset") {
      for (const key of OPENED) yield* play({ type: "open", key, at: clock++ });
      yield* play({ type: "hold", key: HELD, at: clock++ });
    }
  }
}
