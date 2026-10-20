/* the strip's pieces (strip.tsx), held by their place in each list of the
   shapes rather than by the shapes: live, every second makes new shapes,
   and a list keyed by them made every mark's element again each second. a
   piece is made when its list grows to it; a tick changes only what its
   class and style read, so its element stays and moves in place. */

import { type Accessor, createMemo, indexArray } from "solid-js";
import type { MarkShape, StripShapes } from "./groups";

export type Style = Record<string, string>;
export const at = (left: number, width?: number): Style => ({ left: `${left}%`, ...(width !== undefined ? { width: `${width}%` } : {}) });
/* a stretch after a folded quiet one starts 3 px on, so the tracks break there */
const track = (left: number, width: number): Style => (left > 0 ? { left: `calc(${left}% + 3px)`, width: `calc(${width}% - 3px)` } : at(left, width));
const markClass = (m: MarkShape): string => `strip-mk mk-${m.kind}${m.bar ? " mk-bar" : ""}${m.running ? " mk-running" : ""}${m.bad ? " mk-bad" : ""}`;

/** one piece of the lane, as its element reads it */
export type Piece = { class: Accessor<string>; style: Accessor<Style> };
export type Lane = { tracks: Accessor<Piece[]>; thoughts: Accessor<Piece[]>; marks: Accessor<Piece[]> };

/** the lane's pieces, one per place in each list: a piece is made when its list grows to it, and a new tick only changes what
    its class and style read */
export function lane(shapes: Accessor<StripShapes>): Lane {
  const pieces = <T,>(list: () => readonly T[], cls: (t: T) => string, style: (t: T) => Style): Accessor<Piece[]> =>
    createMemo(indexArray(list, (t) => ({ class: () => cls(t()), style: () => style(t()) })));
  return {
    tracks: pieces(() => shapes().tracks, () => "strip-track", (t) => track(t.left, t.width)),
    thoughts: pieces(() => shapes().thoughts, () => "strip-think", (t) => at(t.left, t.width)),
    marks: pieces(() => shapes().marks, markClass, (m) => at(m.left, m.width)),
  };
}
