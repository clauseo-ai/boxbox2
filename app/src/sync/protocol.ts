/* the wire between the server and the sync worker: `GET /api/stream` and
   the transcript hydration routes (docs/architecture.md, the sync model).

   the cmx2 shapes come from the vendored contract. boxbox's own shapes are
   written here by hand until the server's utoipa document carries them;
   each mirrors the utoipa schema of the same name, so moving to the
   generated type is one line per type:
   `export type X = components["schemas"]["X"]`. */

import type { components as Boxbox } from "../api/boxbox";
import type { components as Cmx2 } from "../api/cmx2";

export type SessionInfo = Cmx2["schemas"]["SessionInfo"];
export type SessionStatus = Cmx2["schemas"]["SessionStatus"];
export type MessageInfo = Cmx2["schemas"]["MessageInfo"];
export type Part = Cmx2["schemas"]["Part"];

/** one message as cmx2's `GET /session/:id/message` lists it */
export type Message = { info: MessageInfo; parts: Part[] };

/** the protocol the worker speaks; a hello with another one means the page must reload */
export const PROTOCOL = 1;

type Schemas = Boxbox["schemas"];

/* the generated types come from boxbox's utoipa document. the fields that
   carry daemon json byte for byte are declared there as plain objects, so
   each is narrowed here to the cmx2 type it holds, and `upstream`, which
   the server always writes (null when the daemon did not log the event),
   is required. */

/** a host's connection, health and the upstream cursor the server holds for it */
export type HostState = Schemas["HostStatus"];

/** one repo's colour as the server sends it (named apart from window/repo.ts's `RepoColour`, which is the hue itself) */
export type RepoColourEntry = Schemas["RepoColour"];

/** one display item of a session's window tail */
export type TailItem = Schemas["TailItem"];

/** one session in the fleet model, identified by `host:session` */
export type SessionEntry = Omit<Schemas["SessionEntry"], "info" | "status"> & { info: SessionInfo; status: SessionStatus | null };

/** a pending permission or question */
export type Ask = Omit<Schemas["Ask"], "request"> & { request: Record<string, unknown> };

/** the whole fleet model, sent with a reset */
export type FleetSnapshot = Omit<Schemas["FleetSnapshot"], "sessions" | "asks"> & { sessions: SessionEntry[]; asks: Ask[] };

/** the first frame of every connection, with no id */
export type Hello = Extract<Schemas["Control"], { type: "hello" }>;

/** the cursor could not be replayed; replace everything */
export type Reset = Omit<Extract<Schemas["Control"], { type: "reset" }>, "fleet"> & { fleet: FleetSnapshot };

type Narrow<C> = C extends { type: "message" }
  ? Omit<C, "info" | "upstream"> & { info: MessageInfo; upstream: number | null }
  : C extends { type: "part" }
    ? Omit<C, "part" | "upstream"> & { part: Part; upstream: number | null }
    : C extends { type: "message.removed" }
      ? Omit<C, "upstream"> & { upstream: number | null }
      : C extends { type: "host.reset" }
        ? Omit<C, "sessions" | "asks"> & { sessions: SessionEntry[]; asks: Ask[] }
        : C extends { type: "session" }
          ? Omit<C, "session"> & { session: SessionEntry }
          : C extends { type: "ask" }
            ? Omit<C, "ask"> & { ask: Ask }
            : C;

/** one change, numbered by the journal: the server frames each `Change` with its `seq` first */
export type Entry = Narrow<Schemas["Change"]> & { seq: number };

export type EntryType = Entry["type"];

/** the entries that belong to one session's transcript */
export type ThreadEntry = Extract<Entry, { type: "message" | "part" | "delta" | "message.removed" }>;
export type DeltaEntry = Extract<Entry, { type: "delta" }>;

/** what a data line decodes to */
export type Frame = Hello | Reset | Entry;

/** what a window on the board's mac is sent beside the journal (docs/board.md, where the board is): id-less, with no seq,
    outside the journal. it never reaches the reducer, the cursor or the cache; the worker hands it to the ui as it is */
export type BoardFrame = Schemas["AppFrame"];

/** the repo colours, on a stream that asked for them (`colours=1`): id-less, with no seq, outside the journal. `colours` is
    the whole map and replaces what the client holds (sent after `hello` on every connection, and again before a replay
    page when the map moved meanwhile); `colour` is one repo's change. they move no cursor and count as no entry */
export type ColourFrame = Schemas["ColourFrame"];

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

/** splits `host:session` at its first colon; host names never hold one */
export function splitKey(key: string): { host: string; session: string } | null {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) return null;
  return { host: key.slice(0, colon), session: key.slice(colon + 1) };
}

const FRAME_TYPES: ReadonlySet<string> = new Set<Frame["type"]>([
  "hello",
  "reset",
  "host",
  "host.removed",
  "host.reset",
  "session",
  "session.removed",
  "ask",
  "ask.settled",
  "order",
  "message",
  "part",
  "delta",
  "message.removed",
]);

const BOARD_TYPES: ReadonlySet<string> = new Set<BoardFrame["type"]>(["board.here", "board.gone", "board.focus", "board.compose"]);

const COLOUR_TYPES: ReadonlySet<string> = new Set<ColourFrame["type"]>(["colours", "colour"]);

/** a data line's json, when it names a frame type this protocol has. the fields are the server's to get right:
    its document is typed from the same rust structs, and the reducer is exhaustive over the union. a board frame is
    taken as it is, without a seq: it is never journalled (`isBoardFrame` tells the two apart). so is a colour frame, and
    one that carries a seq is no frame at all: the journal has no colour entry */
export function decodeFrame(data: string): Frame | BoardFrame | ColourFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || !("type" in value)) return null;
  const type = (value as { type: unknown }).type;
  if (typeof type !== "string") return null;
  if (BOARD_TYPES.has(type)) return value as BoardFrame;
  if (COLOUR_TYPES.has(type)) return "seq" in value ? null : (value as ColourFrame);
  if (!FRAME_TYPES.has(type)) return null;
  if (type !== "hello" && type !== "reset" && typeof (value as { seq?: unknown }).seq !== "number") return null;
  return value as Frame;
}

export function isBoardFrame(frame: Frame | BoardFrame | ColourFrame): frame is BoardFrame {
  return BOARD_TYPES.has(frame.type);
}

export function isColourFrame(frame: Frame | BoardFrame | ColourFrame): frame is ColourFrame {
  return COLOUR_TYPES.has(frame.type);
}

/** where a data line goes: the journal's frames to the reducer, which moves the cursor; a board frame to the ui as it is,
    and only on a stream that asked for board frames (`board`); a colour frame to the reducer outside the journal, and only
    on a stream that asked for colours (`colours`); anything else nowhere */
export type Routed = { to: "journal"; frame: Frame } | { to: "board"; frame: BoardFrame } | { to: "colours"; frame: ColourFrame };

export function routeFrame(data: string, board: boolean, colours: boolean): Routed | null {
  const frame = decodeFrame(data);
  if (!frame) return null;
  if (isBoardFrame(frame)) return board ? { to: "board", frame } : null;
  if (isColourFrame(frame)) return colours ? { to: "colours", frame } : null;
  return { to: "journal", frame };
}
