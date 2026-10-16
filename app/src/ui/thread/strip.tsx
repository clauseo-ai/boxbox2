/* the strip (docs/thread.md, the step group): a run's steps over time in one
   slim lane, read at a glance. thinking is a track of spans on top; tools are
   marks by kind in the bed under it: an edit a tall green tick, a long command
   a bar, an agent a full-height line, a question a square, the rest short
   ticks; a failure is red over any. live, the bed washes to a head at now and
   the running step grows to it. ordered (a home window, whose tail has no
   clock), the marks stand evenly apart and there is no head. one height
   everywhere it is drawn, so a group's row and a home window read the same.
   the geometry is groups.ts's; this only places it. */

import { For, Show, createMemo } from "solid-js";
import { type Strip, stripShapes } from "./groups";
import "./thread.css";

/** the strip as a picture: no control of its own (a home window draws it inside its own button) */
export function StripLane(props: { strip: Strip; now?: number | undefined }) {
  const shapes = createMemo(() => stripShapes(props.strip, props.now));
  const at = (left: number, width?: number) => ({ left: `${left}%`, ...(width !== undefined ? { width: `${width}%` } : {}) });
  /* a stretch after a folded quiet one starts 3 px on, so the tracks break there */
  const track = (left: number, width: number) => (left > 0 ? { left: `calc(${left}% + 3px)`, width: `calc(${width}% - 3px)` } : at(left, width));
  return (
    <div class="strip-lane" aria-hidden="true">
      <For each={shapes().tracks}>{(t) => <><i class="strip-track" style={track(t.left, t.width)} /><i class="strip-bed" style={track(t.left, t.width)} /></>}</For>
      <Show when={shapes().wash}>{(w) => <i class="strip-wash" style={at(0, w())} />}</Show>
      <For each={shapes().thoughts}>{(t) => <i class="strip-think" style={at(t.left, t.width)} />}</For>
      <For each={shapes().marks}>{(m) => <i class={`strip-mk ${m.kind}${m.bar ? " bar" : ""}${m.running ? " running" : ""}${m.bad ? " bad" : ""}`} style={at(m.left, m.width)} />}</For>
      <Show when={shapes().head !== undefined}><i class="strip-head" style={at(shapes().head ?? 0)} /></Show>
    </div>
  );
}
