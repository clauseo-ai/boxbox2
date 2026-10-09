/* the settings controls, in the design law's materials: a track pressed
   into the ground with the chosen option sitting on it in the light tone
   (an ask's options, design.md: depth), and a switch whose knob moves on
   the snap spring by transform alone. both are real form semantics
   (radiogroup, switch) with names agent-browser can reach. */

import { For, type JSX } from "solid-js";

export type Choice<T extends string> = { value: T; label: string };

export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}): JSX.Element {
  let group: HTMLDivElement | undefined;
  // arrow keys move the choice, as a native radio group does
  const onKey = (event: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const at = props.choices.findIndex((c) => c.value === props.value);
    const next = props.choices[(at + step + props.choices.length) % props.choices.length];
    if (!next) return;
    props.onChange(next.value);
    group?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label} ref={group} onKeyDown={onKey}>
      <For each={props.choices}>
        {(choice) => (
          <button
            type="button"
            role="radio"
            data-value={choice.value}
            aria-checked={choice.value === props.value}
            tabindex={choice.value === props.value ? 0 : -1}
            disabled={props.disabled}
            onClick={() => choice.value !== props.value && props.onChange(choice.value)}
          >
            {choice.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function Toggle(props: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      class="toggle"
      aria-label={props.label}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="toggle-knob" aria-hidden="true" />
    </button>
  );
}
