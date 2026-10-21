/* every verb of the message leading the queue, in a menu over the strip (docs/composer.md, sending): what a long press
   or a right click on the strip opens. only a press opens it, so it is a chunk of its own (ui/later.ts), warmed with the
   other surfaces; the strip owns its opening, its focus and its closing. its look is composer.css. */

import { For, Show } from "solid-js";
import { type QueueItem, type QueueVerb, verbName } from "./queue";
import type { CardVerbs } from "./words";

const verbsWords: Array<[keyof Omit<CardVerbs, "apart">, string]> = [
  ["retry", "retry"],
  ["edit", "edit"],
  ["steerNow", "steer now"],
  ["runNow", "run now"],
  ["editWaiting", "edit"],
  ["unsend", "unsend"],
];

export function QueueVerbs(props: { item: QueueItem; verbs: CardVerbs; why: string; onVerb: (verb: QueueVerb, id: string) => void; onKeyDown: (event: KeyboardEvent) => void; ref: (el: HTMLDivElement) => void }) {
  return (
    <div class="cz-menu cz-verbs" ref={props.ref} role="menu" aria-label={`what to do with: ${props.item.text}`} onKeyDown={(e) => props.onKeyDown(e)}>
      <For each={verbsWords.filter(([verb]) => props.verbs[verb])}>
        {([verb, word]) => (
          <button type="button" class="cz-option cz-verb" role="menuitem" data-danger={verb === "unsend" ? "" : undefined} aria-label={verbName(verb, props.item)} onClick={() => props.onVerb(verb, props.item.id)}>
            <b>{word}</b>
          </button>
        )}
      </For>
      <Show when={verbsWords.every(([verb]) => !props.verbs[verb])}>
        <p class="cz-note">{props.why}</p>
      </Show>
    </div>
  );
}
