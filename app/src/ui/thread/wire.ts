/* what the thread reads off the wire, and the readers that keep unknown
   fields honest. the server's protocol 3 document (`sync/protocol.ts`) names
   the neutral part union and the tool states; a part the server could not
   make neutral crosses raw, as its source wrote it (a type outside the union,
   or a known type with the source's fields). so the model narrows what the
   document names and reads the rest through these readers, which return
   `undefined` rather than guess. */

import type { KnownPart, MessageInfo, Part, ToolState } from "../../sync/protocol";

export type { MessageInfo, Part, ToolState };
export type ToolPart = Extract<KnownPart, { type: "tool" }>;
export type ToolStatus = ToolState["status"];

/** a part as the wire carries it: a neutral one, or one the server passed on raw */
export type WirePart = Part;
export type WireMessage = { info: MessageInfo; parts: readonly WirePart[] };

export const isToolPart = (p: WirePart): p is ToolPart => p.type === "tool" && typeof (p as ToolPart).tool === "string" && typeof (p as ToolPart).state === "object";

export const record = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
export const string = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const number = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const boolean = (v: unknown): boolean => v === true;
export const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
export const strings = (v: unknown): string[] => list(v).flatMap((x) => (typeof x === "string" ? [x] : []));

/** a `{start, end}` time on a part or a tool state, or nothing */
export function timeOf(v: unknown): { start?: number; end?: number } | undefined {
  const t = record(v);
  if (!t) return undefined;
  const start = number(t["start"]), end = number(t["end"]);
  return start === undefined && end === undefined ? undefined : { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) };
}
export const spanMs = (t: { start?: number; end?: number } | undefined): number => (t?.start !== undefined && t.end !== undefined ? Math.max(0, t.end - t.start) : 0);
