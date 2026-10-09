/* the effort meter and its dial (docs/composer.md, the effort meter). the meter is the signal-strength glyph: one bar per level
   of the model's ladder, rising, the bars up to the chosen level lit. it is the chip's face in both mounts. the dial is the
   top row turned into a segmented control over the levels with a thumb that slides between them (thumbed.tsx), each segment
   its own bar glyph and name; a profile's named variants sit after the levels as plain pills. arrows move, return picks,
   escape closes (the composer's top row hears it). */

import { createMemo, For, Show } from "solid-js";
import { Icon } from "./icons";
import { meterOf, type Scale } from "./effort";
import { Thumbed } from "./thumbed";

const BAR_W = 3;
const BAR_GAP = 2;
const TALL = 14;
const SHORT = 5;

/** the glyph: `levels` is the model's ladder, `effort` the rung lit. a named variant is no rung, so it wears the tune mark */
export function EffortMeter(props: { levels: readonly string[]; effort: string | null; class?: string }) {
  const meter = createMemo(() => meterOf(props.levels, props.effort));
  const width = () => meter().bars * BAR_W + (meter().bars - 1) * BAR_GAP;
  const heightOf = (i: number) => (meter().bars === 1 ? 10 : SHORT + ((TALL - SHORT) * i) / (meter().bars - 1));
  const slots = createMemo(() => Array.from({ length: meter().bars }, (_, i) => i));
  return (
    <Show when={!meter().variant} fallback={<Icon name="tune" class={props.class ? `cz-meter-variant ${props.class}` : "cz-meter-variant"} />}>
      <svg class={props.class ? `cz-meter ${props.class}` : "cz-meter"} width={width()} height={TALL} viewBox={`0 0 ${width()} ${TALL}`} aria-hidden="true">
        <For each={slots()}>
          {(i) => <rect x={i * (BAR_W + BAR_GAP)} y={TALL - heightOf(i)} width={BAR_W} height={heightOf(i)} rx={BAR_W / 2} data-on={i < meter().filled ? "" : undefined} style={{ "--i": i }} />}
        </For>
      </svg>
    </Show>
  );
}

type DialProps = {
  scale: Scale;
  /** the ladder the segments' glyphs are drawn on: the model's own levels, or with the list not here (a lone known effort) the standard five */
  ladder?: readonly string[];
  /** the effort in force: the draft's pick, or the thread's */
  current: string | null;
  /** the radiogroup's accessible name */
  name: string;
  /** opened from a keyboard: focus lands on the pick, so arrows work at once. a finger leaves focus where it was */
  keyboard: boolean;
  /** the pick, made at once */
  onPick: (effort: string) => void;
  /** the dial folds back into its chip, after the thumb has landed */
  onClose: () => void;
};

export function EffortDial(props: DialProps) {
  const segments = createMemo(() =>
    props.scale.levels.map((effort) => ({
      value: effort,
      face: () => (
        <>
          <EffortMeter levels={props.ladder ?? props.scale.levels} effort={effort} />
          <span class="cz-seg-name">{effort}</span>
        </>
      ),
    })),
  );
  const pills = createMemo(() => props.scale.named.map((effort) => ({ value: effort, label: effort })));
  return <Thumbed class="cz-dial" name={props.name} segments={segments()} pills={pills()} current={props.current} keyboard={props.keyboard} onPick={props.onPick} onClose={props.onClose} />;
}
