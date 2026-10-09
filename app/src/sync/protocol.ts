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

/** a data line's json, when it names a frame type this protocol has. the fields are the server's to get right:
    its document is typed from the same rust structs, and the reducer is exhaustive over the union */
export function decodeFrame(data: string): Frame | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || !("type" in value)) return null;
  const type = (value as { type: unknown }).type;
  if (typeof type !== "string" || !FRAME_TYPES.has(type)) return null;
  if (type !== "hello" && type !== "reset" && typeof (value as { seq?: unknown }).seq !== "number") return null;
  return value as Frame;
}
