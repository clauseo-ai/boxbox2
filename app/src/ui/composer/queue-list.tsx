/* the queue's list (docs/composer.md, sending): a tap on the strip (queue.tsx) opens every message on its way with its verbs,
   floating over the thread as the plus menu does. it opens at a press, so it is a chunk of its own (ui/later.ts). */

import { Index, Show } from "solid-js";
import { Icon } from "./icons";
import { type QueueItem, type QueueVerb, verbName, withPhotos } from "./queue";
import { type Agent, cardVerbs, cardWords } from "./words";

export type QueueListProps = {
  items: readonly QueueItem[];
  agent: Agent;
  draftEmpty: boolean;
  unsending: ReadonlySet<string>;
  onVerb: (verb: QueueVerb, id: string) => void;
  onClose: () => void;
  /** the list's element: it takes focus as it opens */
  ref: (el: HTMLDivElement) => void;
};

/** every message on its way, by place, each with its verbs */
export function QueueList(props: QueueListProps) {
  return (
    <div class="cz-menu cz-queue-list" ref={props.ref} role="dialog" aria-label="messages on their way" tabIndex={-1}>
      <div class="cz-queue-head">
        <b>messages on their way</b>
        <span>{props.items.length}</span>
        <button class="cz-key close" type="button" aria-label="close the messages on their way" onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </div>
      <div class="cz-queue" role="list">
        {/* by place, not by object: the list is built again at every step of a working turn, and a card made again would drop the
            focus a keyboard had in it */}
        <Index each={props.items}>{(each) => <QueueCard item={each()} agent={props.agent} draftEmpty={props.draftEmpty} unsending={props.unsending.has(each().id)} onVerb={props.onVerb} />}</Index>
      </div>
    </div>
  );
}

/** one message in the list: what it is, why it waits and what sends it, and every verb it has */
function QueueCard(props: { item: QueueItem; agent: Agent; draftEmpty: boolean; unsending: boolean; onVerb: (verb: QueueVerb, id: string) => void }) {
  const words = () => cardWords(props.item.card, props.agent);
  const verbs = () => cardVerbs(props.item.card, props.agent, props.draftEmpty);
  const go = (verb: QueueVerb) => () => props.onVerb(verb, props.item.id);
  return (
    <div class="cz-card" role="listitem" data-state={props.item.card.state} data-unsending={props.unsending ? "" : undefined} data-verbs={verbs().apart ? "" : undefined}>
      <div class="cz-card-text">
        <small>{words().label}</small>
        <p>{withPhotos(props.item)}</p>
        <span class="cz-why">{words().why}</span>
      </div>
      <div class="cz-card-acts">
        <Show when={verbs().retry}>
          <button class="cz-pill on" type="button" aria-label={verbName("retry", props.item)} onClick={go("retry")}>retry</button>
        </Show>
        <Show when={verbs().edit}>
          <button class="cz-pill" type="button" aria-label={verbName("edit", props.item)} onClick={go("edit")}>edit</button>
        </Show>
        <Show when={verbs().steerNow}>
          <button class="cz-pill" type="button" aria-label={verbName("steerNow", props.item)} onClick={go("steerNow")}>steer now</button>
        </Show>
        <Show when={verbs().runNow}>
          {/* the first waiting message runs the queue; a steer runs itself: it is the one that can sit for good behind a long command */}
          <button class="cz-pill" type="button" aria-label={verbName("runNow", props.item)} onClick={go("runNow")}>run now</button>
        </Show>
        <Show when={verbs().editWaiting}>
          <button class="cz-pill" type="button" aria-label={verbName("editWaiting", props.item)} onClick={go("editWaiting")}>edit</button>
        </Show>
        <Show when={verbs().unsend}>
          <button class="cz-pill x" type="button" aria-label={verbName("unsend", props.item)} disabled={props.unsending} onClick={go("unsend")}>
            <Icon name="close" />
          </button>
        </Show>
      </div>
    </div>
  );
}
