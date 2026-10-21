/* the daemon's order of a message's parts (docs/gotchas.md, "a message's
   parts keep the daemon's order").

   a part carries its place: `at {step, index}`, the step that wrote it and
   its index inside it (the server reads it from cmx2's id grammar,
   `prt_<session>_<seq>_<index>`, translate.rs). a part without `at` (one
   born from its first delta, or one that crossed raw) is placed by that
   grammar in its id, the same numbers. the daemon lists a message's parts in
   that order, but the stream does not deliver them in it: a text part is
   born by its first delta while a reasoning part of the same step lands
   whole when the step ends. a part the thread does not hold yet is therefore
   placed by its position, not by when it arrived.

   a part with no position (history imported from another runtime) keeps
   arrival order: it is appended, and it never moves a part that has one. the
   numbers are compared as numbers, because the seq is zero padded to a width
   the daemon may change. */

import type { Message, Part } from "./protocol";

type Position = { seq: number; index: number };

const POSITIONAL = /^prt_[^_]+_(\d+)_(\d+)$/;

/** where the daemon put a part with this id, or null for an id it did not mint in this shape */
export function positionOf(id: string): Position | null {
  const match = POSITIONAL.exec(id);
  if (!match) return null;
  const seq = Number(match[1]);
  const index = Number(match[2]);
  return Number.isSafeInteger(seq) && Number.isSafeInteger(index) ? { seq, index } : null;
}

/** a part's position: its `at` when it has one, else its id's */
export function placeOf(part: Pick<Part, "id"> & { at?: unknown }): Position | null {
  const at = part.at;
  if (typeof at === "object" && at !== null) {
    const { step, index } = at as Record<string, unknown>;
    if (typeof step === "number" && typeof index === "number") return { seq: step, index };
  }
  return positionOf(part.id);
}

const follows = (a: Position, b: Position) => a.seq > b.seq || (a.seq === b.seq && a.index > b.index);

/** the index a part goes to: before the first held part that follows it, else the end */
export function placeBefore(parts: readonly Part[], part: Pick<Part, "id"> & { at?: unknown }): number {
  const position = placeOf(part);
  if (!position) return parts.length;
  for (let i = 0; i < parts.length; i++) {
    const held = placeOf(parts[i] as Part); // i is inside the array
    if (held && follows(held, position)) return i;
  }
  return parts.length;
}

/** the parts in the daemon's order: the same array when they already are, so the common case allocates nothing */
export function inDaemonOrder(parts: Part[]): Part[] {
  let last: Position | null = null;
  let ordered = true;
  for (const part of parts) {
    const position = placeOf(part);
    if (!position) continue;
    if (last && follows(last, position)) {
      ordered = false;
      break;
    }
    last = position;
  }
  if (ordered) return parts;
  const placed: Part[] = [];
  for (const part of parts) placed.splice(placeBefore(placed, part), 0, part);
  return placed;
}

/** every message's parts in the daemon's order, and the index of the first message that had to change
    (null when none did), which is what a cache write has to start from */
export function inDaemonOrderAll(messages: Message[]): { messages: Message[]; from: number | null } {
  let from: number | null = null;
  const fixed = messages.map((message, i) => {
    const parts = inDaemonOrder(message.parts);
    if (parts === message.parts) return message;
    from ??= i;
    return { info: message.info, parts };
  });
  return from === null ? { messages, from } : { messages: fixed, from };
}
