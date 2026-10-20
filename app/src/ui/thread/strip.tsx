/* the strip (docs/thread.md, the step group): a run's steps over time in one
   slim lane, read at a glance. thinking is a track of spans on top; tools are
   marks by kind in the bed under it: an edit a tall green tick, a long command
   a bar, an agent a full-height line, a question a square, the rest short
   ticks; a failure is red over any. live, the bed washes to a head at now and
   the running step grows to it. ordered (a home window, whose tail has no
   clock), the marks stand evenly apart and there is no head. one height
   everywhere it is drawn, so a group's row and a home window read the same.
   the geometry is groups.ts's; this only places it. a mark's modifiers carry
   the mk- prefix: a bare "bar" picked up home.css's `.home .bar` (the home
   bar: relative, padded, raised), and the running bar drew as a tall block
   over the rows on a desktop home.

   live, every second makes new shapes, so the lane's pieces are held by
   their place in the list (lane.ts), not by the shapes: a tick moves each
   mark, span and track in place and makes no element again. */

import { For, Show, createMemo } from "solid-js";
import { type Strip, stripShapes } from "./groups";
import { at, lane } from "./lane";
import "./thread.css";

/** the strip as a picture: no control of its own (a home window draws it inside its own button) */
export function StripLane(props: { strip: Strip; now?: number | undefined }) {
  const shapes = createMemo(() => stripShapes(props.strip, props.now));
  const pieces = lane(shapes);
  return (
    <div class="strip-lane" aria-hidden="true">
      <For each={pieces.tracks()}>{(t) => <><i class="strip-track" style={t.style()} /><i class="strip-bed" style={t.style()} /></>}</For>
      <Show when={shapes().wash}>{(w) => <i class="strip-wash" style={at(0, w())} />}</Show>
      <For each={pieces.thoughts()}>{(t) => <i class="strip-think" style={t.style()} />}</For>
      <For each={pieces.marks()}>{(m) => <i class={m.class()} style={m.style()} />}</For>
      <Show when={shapes().head !== undefined}><i class="strip-head" style={at(shapes().head ?? 0)} /></Show>
    </div>
  );
}
