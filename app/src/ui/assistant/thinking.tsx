/* the thinking chip (docs/composer.md, the chips): the chip beside the model is the agent's `reasoning`. its word is the
   agent's (`word`: "thinking" for an assistant, "effort" for cmx), its meter one bar per level above "off", and a press
   opens today's dial over the agent's own levels, named by the agent. the chip shows the thread's own level; a pick is the
   thread's from the next message on. an agent without `reasoning` has no chip (the caller does not draw one). */

import { createMemo, For, Show } from "solid-js";
import { Thumbed } from "../composer/thumbed";
import type { Reasoning } from "./wire";

const BAR_W = 3;
const BAR_GAP = 2;
const TALL = 14;
const SHORT = 5;

/** the meter: one bar per level above "off", lit up to the level in force; "off" lights none */
export function ReasoningMeter(props: { levels: readonly string[]; level: string | null }) {
  const ladder = createMemo(() => props.levels.filter((l) => l !== "off" && l !== "none"));
  const lit = createMemo(() => (props.level ? ladder().indexOf(props.level) + 1 : 0));
  const n = () => Math.max(1, ladder().length);
  const width = () => n() * BAR_W + (n() - 1) * BAR_GAP;
  const heightOf = (i: number) => (n() === 1 ? 10 : SHORT + ((TALL - SHORT) * i) / (n() - 1));
  return (
    <svg class="cz-meter" width={width()} height={TALL} viewBox={`0 0 ${width()} ${TALL}`} aria-hidden="true">
      <For each={Array.from({ length: n() }, (_, i) => i)}>
        {(i) => <rect x={i * (BAR_W + BAR_GAP)} y={TALL - heightOf(i)} width={BAR_W} height={heightOf(i)} rx={BAR_W / 2} data-on={i < lit() ? "" : undefined} style={{ "--i": i }} />}
      </For>
    </svg>
  );
}

/** a level as the dial names it to a screen reader: "off", "low thinking" */
export const levelName = (word: string, level: string): string => (level === "off" ? "off" : `${level} ${word}`);

/** the chip: "thinking for this message, low" (design.md, accessible names); open, aria-expanded */
export function ReasoningChip(props: { reasoning: Reasoning; level: string | null; open: boolean; onToggle: () => void }) {
  return (
    <button
      class="cz-key me cz-chip"
      type="button"
      aria-label={`${props.reasoning.word} for this message, ${props.level ?? "the agent's own"}`}
      aria-expanded={props.open ? "true" : "false"}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => props.onToggle()}
    >
      <ReasoningMeter levels={props.reasoning.levels} level={props.level} />
      <em class="cz-chip-label">{props.level ?? props.reasoning.word}</em>
    </button>
  );
}

/** the dial over the agent's levels: the top row turned into the segmented control (thumbed.tsx), each segment its meter
    and its name, arrows to move, return to pick, escape to close (the top row hears it) */
export function ReasoningDial(props: { reasoning: Reasoning; level: string | null; keyboard: boolean; onPick: (level: string) => void; onClose: () => void }) {
  const segments = createMemo(() =>
    props.reasoning.levels.map((level) => ({
      value: level,
      face: () => (
        <>
          <ReasoningMeter levels={props.reasoning.levels} level={level} />
          <span class="cz-seg-name">{level}</span>
        </>
      ),
    })),
  );
  return (
    <Show when={segments().length > 0}>
      <Thumbed
        class="cz-dial"
        name={`${props.reasoning.word} for this message`}
        segments={segments()}
        current={props.level}
        keyboard={props.keyboard}
        labelOf={(v) => levelName(props.reasoning.word, v)}
        onPick={props.onPick}
        onClose={props.onClose}
      />
    </Show>
  );
}
