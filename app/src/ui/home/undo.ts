/* the undo toast's parts with no dom (toast.tsx draws it): its words, the ring's sweep and its time. pure or driven by an
   injected clock, so undo.test.ts pins them. */

import type { Undo } from "../../store";

export { TOAST_MS, toastWords } from "./offers";

/** the square's edge from twelve clockwise, as fractions of the way round: where the sweep turns a corner */
const CORNERS: readonly [number, string][] = [
  [1 / 8, "100% 0%"],
  [3 / 8, "100% 100%"],
  [5 / 8, "0% 100%"],
  [7 / 8, "0% 0%"],
];

const pct = (n: number): string => `${Math.round(n * 1000) / 1000}%`;

/** the point on the square's edge a fraction `t` of the way round from twelve */
function edgeAt(t: number): string {
  const along = (from: [number, number], to: [number, number], f: number) => `${pct(from[0] + (to[0] - from[0]) * f)} ${pct(from[1] + (to[1] - from[1]) * f)}`;
  if (t <= 1 / 8) return along([50, 0], [100, 0], t * 8);
  if (t <= 3 / 8) return along([100, 0], [100, 100], (t - 1 / 8) * 4);
  if (t <= 5 / 8) return along([100, 100], [0, 100], (t - 3 / 8) * 4);
  if (t <= 7 / 8) return along([0, 100], [0, 0], (t - 5 / 8) * 4);
  return along([0, 0], [50, 0], (t - 7 / 8) * 8);
}

/** what is left of the ring at `t` drained: the wedge from the moving edge clockwise back to twelve. the polygon always has
    seven points (the centre, the edge, four corners, twelve), a passed corner sitting on the edge, so every frame
    interpolates point by point */
export function wedge(t: number): string {
  const at = edgeAt(t);
  const corners = CORNERS.map(([where, point]) => (where <= t ? at : point));
  return `polygon(50% 50%, ${at}, ${corners.join(", ")}, 50% 0%)`;
}

/** the sweep's frames: one at each corner, so a straight stretch of edge is a straight interpolation */
export const DRAIN_FRAMES = [0, 1 / 8, 3 / 8, 5 / 8, 7 / 8, 1].map((t) => ({ clipPath: wedge(t), offset: t }));


/** the undo button's name: what it brings back, so it is never one of two "undo"s */
export function undoName(undo: Pick<Undo, "keys" | "title">): string {
  return undo.keys.length === 1 && undo.title !== null ? `undo clearing ${undo.title}` : `undo clearing ${undo.keys.length} threads`;
}

/** the undo button while its undo is out: aria-disabled, never disabled. a browser drops focus from a disabled button, so
    the toast would not know focus was in it when it closes, and focus would fall to the body (toast.tsx); the press is
    ignored while out (settle-api.ts, `undoLast`) */
export function undoOut(undo: Pick<Undo, "busy">): "true" | undefined {
  return undo.busy ? "true" : undefined;
}

export type Clock = {
  now: () => number;
  after: (ms: number, run: () => void) => unknown;
  cancel: (handle: unknown) => void;
};

/** the toast's time: it runs out after `ms` unless held (a pointer over the toast, focus in it, an undo out), and a hold
    keeps what was left. `restart` gives the full time again (a newer clear, an undo that failed), or what is left of an
    offer's time when the toast mounts again. `deadline` hears when it will run out (Infinity while held), so the store's
    offer carries its expiry while home is away and the toast with it. the owner stops it */
export class Lifetime {
  private left: number;
  private started = 0;
  private handle: unknown = undefined;
  private holds = 0;
  constructor(
    private readonly ms: number,
    private readonly expire: () => void,
    private readonly clock: Clock,
    private readonly deadline: (at: number) => void = () => {},
  ) {
    this.left = ms;
  }
  /** the time starts over from the full length (or `left` of it), unless a hold is on */
  restart(left = this.ms): void {
    this.cancel();
    this.left = Math.min(this.ms, Math.max(0, left));
    this.run();
  }
  hold(): void {
    if (this.holds++ > 0) return;
    if (this.handle !== undefined) this.left = Math.max(0, this.left - (this.clock.now() - this.started));
    this.cancel();
    this.deadline(Infinity);
  }
  release(): void {
    if (this.holds === 0 || --this.holds > 0) return;
    this.run();
  }
  /** the owner is done with it; a hold still on hands back the time it kept, so the offer runs out that much later */
  stop(): void {
    this.cancel();
    if (this.holds > 0) this.deadline(this.clock.now() + this.left);
  }
  private run(): void {
    if (this.holds > 0) return;
    this.started = this.clock.now();
    this.deadline(this.started + this.left);
    this.handle = this.clock.after(this.left, () => {
      this.handle = undefined;
      this.expire();
    });
  }
  private cancel(): void {
    if (this.handle !== undefined) this.clock.cancel(this.handle);
    this.handle = undefined;
  }
}
