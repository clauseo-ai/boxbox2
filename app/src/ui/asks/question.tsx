/* a question's own words in its card (docs/thread.md, every state: asks): its short label above them in the light tone, the words as
   the agent wrote them, painted as the thread paints its markdown (markdown.ts: the same parse and the same sanitiser, so a link
   goes only to the web or to mail and opens in a tab of its own), and a copy control that copies the markdown as written. the words
   are text to select: they are not in the row's head (a button) and nothing on them toggles the row or presses an option. the
   card draws this while it asks and once it is settled, in the thread and on home's answer sheet alike. */

import { Show, createEffect, on, onCleanup } from "solid-js";
import { CopyButton } from "../thread/copy-button";
import { questionCopyLabel } from "../thread/copy-names";
import { painter } from "../thread/markdown";
import { copyOfQuestion, plainWords } from "./words";


/** the markdown, painted once and again when it changes; a question settles before it is drawn, so it never streams */
function Words(props: { md: string }) {
  const el = <div class="ask-t ask-md" /> as HTMLDivElement;
  const surface = painter(el);
  surface.paint(props.md, false);
  createEffect(on(() => props.md, (md) => surface.paint(md, false), { defer: true }));
  onCleanup(() => surface.dispose());
  return el;
}

export function QuestionWords(props: { q: { header: string; question: string } }) {
  const header = () => props.q.header.trim();
  return (
    <div class="ask-said">
      <Show when={header()}><p class="ask-h">{header()}</p></Show>
      <Words md={props.q.question} />
      <Show when={props.q.question.trim()}>
        <CopyButton kind="question" class="ask-copy" name={questionCopyLabel(plainWords(props.q.question))} text={() => copyOfQuestion(props.q)} />
      </Show>
    </div>
  );
}
