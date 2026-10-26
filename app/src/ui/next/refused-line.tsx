/* a refused first message, said where the person is (docs/composer.md, a first message that did not start is not lost):
   home's field says a refusal under itself, but while a thread is on the stage the field is under it, hidden and inert, so
   home draws this line over the thread instead, where the undo toast sits. it never moves the person home by itself:
   retry sends the same message again (one send, the same client id), and edit goes home to the field with the words put
   back, both the person's choice. it goes when the send is retried, edited, or the person goes home, where the field
   says it. a chunk of its own (ui/later.ts); its look is at the end of next.css, in the first load with home. */

import { onCleanup, Show } from "solid-js";
import { play } from "../../motion/animate";
import { SNAP } from "../../motion/springs";
import { state } from "../../store";
import type { OutboxView } from "../../sync/outbox";
import { refusedStart } from "../composer/menu-words";
import { barControl, focusBack } from "../home/focus-back";
import { repoName } from "../window/repo";
import type { NextApi } from "./next-up";

/** the field's send, refused (store.ts, `newThread`; its rules are composer/new-thread.ts) */
function refusedSend(): OutboxView | undefined {
  const sent = state.newThread.sent;
  const entry = sent ? state.composer.outbox.find((e) => e.clientID === sent.clientID) : undefined;
  return entry?.state === "failed" ? entry : undefined;
}

/** mounted by home while a thread covers the field; it draws only while the field's send is refused */
export function RefusedLine(props: {
  arrangement: "deck" | "strip" | "rail";
  /** home's way to the field's verbs (`withNext`): retry and edit are the field's own, so its rules hold */
  field: (run: (api: NextApi) => void) => void;
  /** home's way to the field: the thread steps back (or shrinks on the deck) and the caret goes in the words */
  home: () => void;
}) {
  return (
    <Show when={refusedSend()} keyed>
      {(refused) => (
        <Line
          refused={refused}
          arrangement={props.arrangement}
          onRetry={() => props.field((api) => api.retry())}
          onEdit={() => {
            props.field((api) => api.edit());
            props.home();
          }}
        />
      )}
    </Show>
  );
}

function Line(props: {
  /** the refused send's outbox entry, as a value (the keyed <Show>) */
  refused: OutboxView;
  arrangement: "deck" | "strip" | "rail";
  onRetry: () => void;
  onEdit: () => void;
}) {  const repo = () => (props.refused.target.kind === "new" ? repoName(props.refused.target.directory) : "");
  let focused = false;
  onCleanup(() => {
    // focus was on retry or edit: it goes to the bar's first control, not the body, as the line leaves
    if (focused) queueMicrotask(() => (document.activeElement === null || document.activeElement === document.body || !document.activeElement.isConnected ? focusBack(null, barControl) : undefined));
  });
  return (
    <div
      class="nx-refused-line"
      role="alert"
      data-arrangement={props.arrangement}
      ref={(el) => play(el, [{ opacity: 0, transform: "translateY(12px) scale(.98)" }, { opacity: 1, transform: "none" }], SNAP)}
      onFocusIn={() => (focused = true)}
      onFocusOut={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) focused = false;
      }}
    >
      <p>{refusedStart(props.refused.error, props.refused.photosReturned ?? 0)}</p>
      <div class="nx-refused-acts">
        {/* a message whose photos went back to the draft is not retried: its own words say what to do */}
        <Show when={!props.refused.photosReturned}>
          <button type="button" class="nx-pill on" aria-label={`retry starting the thread in ${repo()}`} onClick={() => props.onRetry()}>
            retry
          </button>
        </Show>
        <button type="button" class="nx-pill" aria-label={`edit the message for ${repo()} in home's field`} onClick={() => props.onEdit()}>
          edit
        </button>
      </div>
    </div>
  );
}
