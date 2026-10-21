/* the wire between the server and the sync worker: `GET /api/stream`, the
   interest post and the thread reads (docs/protocol.md, protocol 3).

   every type is the server's utoipa document (`app/src/api/boxbox.d.ts`,
   generated), narrowed only where that document is looser than the wire:
   a tool call's `input` and `metadata` are any json, `upstream` and an
   interest's `thread` are always sent (possibly null), and a part the
   server could not make neutral crosses raw (`UnknownPart`). the contract 1
   names (`Ask`, `Control`, `JournalEntry`, `TailItem`, `SessionEntry`,
   `FleetSnapshot`, `Change`) are not imported here or anywhere in sync. */

import type { components as Boxbox } from "../api/boxbox";

type Schemas = Boxbox["schemas"];

/** the protocol the worker speaks; a hello with another one means the page must reload */
export const PROTOCOL = 3;

/** a tool call's state: `input` and `metadata` are the source's json as it sent it */
export type ToolState = Omit<Schemas["ToolState"], "input" | "metadata" | "attachments"> & {
  input: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  attachments?: Part[] | null;
};

type NarrowPart<P> = P extends { type: "tool" } ? Omit<P, "state"> & { state: ToolState } : P;

/** a part the server made neutral */
export type KnownPart = NarrowPart<Schemas["AgentPart"]>;

/** a part the server could not make neutral crosses as the source wrote it (server/src/wire/part.rs, `Unknown`): any
    fields, a type that may be one of the known ones without their fields. a part in a transcript always names itself
    and its message, which is how the server routed it */
export type UnknownPart = Record<string, unknown> & { type: string; id: string; messageID: string };

export type Part = KnownPart | UnknownPart;

export type MessageInfo = Schemas["AgentMessage"];

/** one message as the thread reads answer it: its info and its parts */
export type Message = { info: MessageInfo; parts: Part[] };

/** one display item of a thread's window tail */
export type TailItem = Schemas["ThreadTailItem"];

/** one thread in the fleet, identified by `<agent>:<thread>` */
export type Thread = Schemas["Thread"];

export type Agent = Schemas["Agent"];

/** a pending permission or question */
export type Ask = Schemas["AgentAsk"];

export type AskSettled = Schemas["AskSettled"];

/** the whole fleet, sent with a reset */
export type FleetSnapshot = Schemas["Fleet"];

/** what a stream gets transcript entries for: the open thread, the layers under it and the children held for them */
export type Interest = { thread: string | null; under: string[]; holds: string[] };

/** the body of `POST /api/stream/{stream}/interest` */
export type InterestPost = Interest & { ask: number; since?: Record<string, number> };

export type ThreadPatch = Schemas["ThreadPatch"];
export type TailPatch = Schemas["TailPatch"];
export type OrderOp = Schemas["OrderOp"];
export type TextOf = Schemas["TextOf"];
export type Reaction = Schemas["Reaction"];

type Control = Schemas["AgentControl"];

/** the first frame of every connection, with no id */
export type Hello = Omit<Extract<Control, { type: "hello" }>, "interest"> & { interest: Interest };

/** the cursor could not be caught up; the fleet replaces everything */
export type Reset = Extract<Control, { type: "reset" }>;

/** the end of a catch-up: the stream is live after it */
export type Caught = Extract<Control, { type: "caught" }>;

/** transcript entries applied by the transcript rules alone, never moving the cursor */
export type Catchup = Omit<Extract<Control, { type: "catchup" }>, "entries"> & { entries: Entry[] };

/** the confirm of an interest post */
export type InterestFrame = Omit<Extract<Control, { type: "interest" }>, "thread"> & { thread: string | null };

/** in a reconnect catch-up: a thread in interest whose missed transcript entries the ring no longer holds */
export type ThreadStale = Extract<Control, { type: "thread.stale" }>;

type Narrow<C> = C extends { type: "message" }
  ? Omit<C, "upstream"> & { upstream: number | null }
  : C extends { type: "part" }
    ? Omit<C, "part" | "upstream"> & { part: Part; upstream: number | null }
    : C extends { type: "message.removed" }
      ? Omit<C, "upstream"> & { upstream: number | null }
      : C;

/** one change, numbered by the journal: the server frames each change with its `seq` first */
export type Entry = Narrow<Schemas["AgentChange"]> & { seq: number };

export type EntryType = Entry["type"];

/** the entries that belong to one thread's transcript */
export type ThreadEntry = Extract<Entry, { type: "message" | "part" | "delta" | "message.removed" | "reactions" }>;
export type DeltaEntry = Extract<Entry, { type: "delta" }>;

/** what a data line decodes to */
export type Frame = Hello | Reset | Caught | Catchup | InterestFrame | ThreadStale | Entry;

/** what a window on the board's mac is sent beside the journal (docs/board.md, where the board is): id-less, with no seq,
    outside the journal. it never reaches the reducer, the cursor or the cache; the worker hands it to the ui as it is */
export type BoardFrame = Schemas["AppFrame"];

/** the repo colours: id-less, with no seq, outside the journal. `colours` is the whole map and replaces what the client
    holds (sent after `hello` on every connection); `colour` is one repo's change. they move no cursor and count as no entry */
export type ColourFrame = Schemas["ColourFrame"];

/** one repo's colour as the server sends it (named apart from window/repo.ts's `RepoColour`, which is the hue itself) */
export type RepoColourEntry = Schemas["RepoColour"];

/** `<epoch>:<seq>`, the journal's cursor and the sse id */
export type Cursor = { epoch: string; seq: number };

export function parseCursor(text: string | undefined | null): Cursor | null {
  if (!text) return null;
  const colon = text.lastIndexOf(":");
  if (colon <= 0) return null;
  const seq = Number(text.slice(colon + 1));
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return { epoch: text.slice(0, colon), seq };
}

export function formatCursor(cursor: Cursor): string {
  return `${cursor.epoch}:${cursor.seq}`;
}

/** splits `<agent>:<thread>` at its first colon; agent keys never hold one */
export function splitKey(key: string): { agent: string; thread: string } | null {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return null;
  return { agent: key.slice(0, colon), thread: key.slice(colon + 1) };
}

/** a text's utf-16 length and fnv-1a 32 hash over its utf-16 code units, as 8 lowercase hex (docs/protocol.md, section 8):
    what a settled part's `textOf` names */
export function textOf(text: string): TextOf {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return { length: text.length, hash: hash.toString(16).padStart(8, "0") };
}

const CONTROL_TYPES: ReadonlySet<string> = new Set<Frame["type"]>(["hello", "reset", "caught", "catchup", "interest", "thread.stale"]);

const TRANSCRIPT_TYPES: ReadonlySet<string> = new Set<ThreadEntry["type"]>(["message", "part", "delta", "message.removed", "reactions"]);

const ENTRY_TYPES: ReadonlySet<string> = new Set<EntryType>([
  "agent",
  "agent.removed",
  "thread",
  "thread.patch",
  "thread.removed",
  "thread.reset",
  "ask",
  "ask.settled",
  "order",
  "order.patch",
  "message",
  "part",
  "delta",
  "message.removed",
  "reactions",
]);

const BOARD_TYPES: ReadonlySet<string> = new Set<BoardFrame["type"]>(["board.here", "board.gone", "board.focus", "board.compose"]);

const COLOUR_TYPES: ReadonlySet<string> = new Set<ColourFrame["type"]>(["colours", "colour"]);

/** why a frame cannot apply (docs/protocol.md, section 3): a patch whose base the client does not hold or that does not fit
    it, or a catch-up or confirm that does not parse */
export type Fault = "patch-error" | "read-late" | "hash-miss" | "catchup-error";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** a transcript entry as a catch-up carries it: its type, its seq, and the thread it is for */
const isTranscriptEntry = (value: unknown): boolean =>
  isObject(value) && typeof value["type"] === "string" && TRANSCRIPT_TYPES.has(value["type"]) && typeof value["seq"] === "number" && typeof value["key"] === "string";

/** where a data line goes:
    - `journal`: a frame of the protocol, to the reducer, with the sse id the worker parsed;
    - `skip`: a type this client does not know. it is ignored, and the worker still moves the cursor past its id (the
      reducer's `skipped` action), which keeps a home device's cursor near the head;
    - `broken`: a `catchup` or `interest` frame that does not parse, a protocol error: the reducer's `broken` action drops
      the cursor and reconnects;
    - `board`: a board frame, to the ui as it is, and only on a stream that asked for board frames;
    - `colours`: a colour frame, to the reducer outside the journal.
    null is a line that is no frame at all (not json, no type, an entry without its seq, a colour frame with one) */
export type Routed =
  | { to: "journal"; frame: Frame }
  | { to: "skip"; type: string }
  | { to: "broken"; what: Fault }
  | { to: "board"; frame: BoardFrame }
  | { to: "colours"; frame: ColourFrame };

/** a data line's json, routed. the fields are the server's to get right: its document is typed from the same rust
    structs, and the reducer is exhaustive over the union. the two frames whose parse is a protocol error (a catch-up and
    a confirm) are checked whole here */
export function routeFrame(data: string, board: boolean): Routed | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const type = value["type"];
  if (typeof type !== "string") return null;
  if (BOARD_TYPES.has(type)) return board ? { to: "board", frame: value as BoardFrame } : null;
  if (COLOUR_TYPES.has(type)) return "seq" in value ? null : { to: "colours", frame: value as ColourFrame };
  if (type === "catchup") {
    const entries = value["entries"];
    return Array.isArray(entries) && entries.every(isTranscriptEntry) ? { to: "journal", frame: value as Catchup } : { to: "broken", what: "catchup-error" };
  }
  if (type === "interest") {
    const ok =
      typeof value["ask"] === "number" &&
      typeof value["seq"] === "number" &&
      (value["thread"] === null || value["thread"] === undefined || typeof value["thread"] === "string") &&
      isStrings(value["under"]) &&
      isStrings(value["holds"]) &&
      (value["stale"] === undefined || isStrings(value["stale"])) &&
      (value["reset"] === undefined || isStrings(value["reset"]));
    return ok ? { to: "journal", frame: { ...value, thread: value["thread"] ?? null } as InterestFrame } : { to: "broken", what: "catchup-error" };
  }
  if (CONTROL_TYPES.has(type)) return { to: "journal", frame: value as Frame };
  if (!ENTRY_TYPES.has(type)) return { to: "skip", type };
  if (typeof value["seq"] !== "number") return null;
  return { to: "journal", frame: value as Entry };
}

export const isTranscript = (entry: Entry): entry is ThreadEntry => TRANSCRIPT_TYPES.has(entry.type);
