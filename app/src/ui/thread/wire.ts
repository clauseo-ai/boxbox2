/* what the thread reads off the wire, and the readers that keep unknown
   fields honest. the contract (`api/cmx2.d.ts`, generated from the vendored
   openapi document) names the part union and the tool states; both leave
   room for more fields (`additionalProperties: true`), and imported history
   carries parts the union does not name (ask a15). so the model takes the
   wire shape as recorded, narrows what the contract names, and reads the
   rest through these readers, which return `undefined` rather than guess. */

import type { components } from "../../api/cmx2";

export type MessageInfo = components["schemas"]["MessageInfo"];
export type Part = components["schemas"]["Part"];
export type ToolPart = components["schemas"]["ToolPart"];
export type ToolState = components["schemas"]["ToolState"];
export type ToolStatus = ToolState["status"];
export type PermissionRequest = components["schemas"]["PermissionRequest"];
export type QuestionRequest = components["schemas"]["QuestionRequest"];
export type QuestionInfo = components["schemas"]["QuestionInfo"];

/** a part as the wire carries it: the contract's shape, or one the contract does not name yet */
export type WirePart = Part | (Record<string, unknown> & { type: string });
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
