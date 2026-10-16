/* the effort dial (docs/composer.md, the effort meter): the composer's top row turned into a segmented control over the
   model's levels, each segment the meter's glyph (dial.tsx) and its name, a profile's named variants after them as plain
   pills. it opens at a press on the effort chip, so it is a chunk of its own (ui/later.ts). */

import { createMemo } from "solid-js";
import { EffortMeter } from "./dial";
import type { Scale } from "./effort";
import { Thumbed } from "./thumbed";

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
