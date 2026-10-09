/* how full a thread's context is, as a ring: the share of the model's window in use, with a tick where the daemon compacts
   by itself. drawn only from the numbers the session reports (words.ts, contextFill); a thread that reports none has none. */

import { Show } from "solid-js";
import type { ContextFill } from "./words";

const SIZE = 18;
const R = 7;
const C = 2 * Math.PI * R;

export function ContextRing(props: { fill: ContextFill }) {
  const tick = () => {
    const mark = props.fill.mark;
    if (mark === null) return null;
    const angle = mark * 2 * Math.PI - Math.PI / 2;
    const at = (radius: number) => `${(SIZE / 2 + Math.cos(angle) * radius).toFixed(2)} ${(SIZE / 2 + Math.sin(angle) * radius).toFixed(2)}`;
    return `M${at(R - 3)}L${at(R + 2.2)}`;
  };
  return (
    <svg class="cz-ring" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" data-high={props.fill.percent >= 85 ? "" : undefined}>
      <circle class="cz-ring-track" cx={SIZE / 2} cy={SIZE / 2} r={R} />
      <circle class="cz-ring-fill" cx={SIZE / 2} cy={SIZE / 2} r={R} stroke-dasharray={`${(Math.min(100, props.fill.percent) / 100) * C} ${C}`} transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`} />
      <Show when={tick()}>{(d) => <path class="cz-ring-tick" d={d()} />}</Show>
    </svg>
  );
}
