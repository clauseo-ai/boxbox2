/* a settled question's record (docs/thread.md, every state: asks), and the line a settled permission leaves on its tool's row, split from
   the card: it draws only in a settled ask's row, which is
   closed until someone opens it (or a pending card settles in place), so it is a chunk of its own (ui/later.ts, the surfaces), warmed
   with them once the launch has painted, and kept out of the first load's script budget (architecture.md). a pending ask's card,
   its question's words and its options are in the first load as before. */

import { For, Show, createSignal } from "solid-js";
import { deviceClass } from "../../push/device";
import type { AskBody } from "./card";
import type { AskReply } from "../../sync/replies";
import { YOU_ANSWERED, optionsControl, permitWords, questionLabel, recordFacts, recordShape, spokenRecord, typed, whoOf } from "./record";
import { QuestionWords } from "./question";
import { plainWords, shortWords } from "./words";

export /** a settled question as its row keeps it: every question's own words (its label, the markdown, its copy control), the answer given to
    it right under them, then where and when; an ask that was not answered says so once, under its questions. a tap opens the options
    as they were offered, each question's under its own answer, the chosen ones marked and typed words quoted, so no question's words
    are drawn twice. what came of it is the model's (the step's answers, its error, its end); who gave it is this device's record of
    its reply (sync/replies.ts), kept in the store and the cache, else the daemon's end time alone */
function AskRecord(props: { b: AskBody; questions: AskBody["questions"]; note: string | null }) {
  const [shown, setShown] = createSignal(false);
  const how = () => props.b.settled?.how ?? (props.b.dismissed ? "dismissed" : "answered");
  const facts = () => { const r = props.b.record; return recordFacts(r ? whoOf(r) : undefined, r ? r.at : props.b.settled?.at, deviceClass()); };
  const offered = () => props.questions.reduce((a, q) => a + q.options.length, 0);
  const shape = () => recordShape(how(), props.questions);
  const about = () => shortWords(plainWords(props.questions[0]?.question ?? ""), 40);
  return (
    <div class="ask-record" role="group" aria-label={spokenRecord(how(), props.questions, facts())}>
      <For each={props.questions}>{(q, i) => (
        <div class="ask-rec-q" role={props.questions.length > 1 ? "group" : undefined} aria-label={props.questions.length > 1 ? `${questionLabel(q)}: ${plainWords(q.question)}` : undefined}>
          <QuestionWords q={q} />
          <Show when={shape().blocks[i()]?.answer}>{(answer) => <p class="ask-rec-lead lit">{YOU_ANSWERED} <b>{answer()}</b></p>}</Show>
          <Show when={shown() && q.options.length + (q.answer ?? []).filter((a) => typed(a, q)).length > 0}>
            <ul class="ask-rec-opts" aria-label={`the options offered: ${shortWords(plainWords(q.question), 40)}`}>
              <For each={q.options}>{(o) => { const chosen = () => q.answer?.includes(o.label) === true; return <li classList={{ chosen: chosen() }}><i aria-hidden="true" />{o.label}<Show when={chosen()}><span class="ask-rec-sr">, chosen</span></Show></li>; }}</For>
              <For each={(q.answer ?? []).filter((a) => typed(a, q))}>{(words) => <li class="chosen typed"><i aria-hidden="true" />{`\u201c${words}\u201d`}<small>typed</small></li>}</For>
            </ul>
          </Show>
        </div>
      )}</For>
      <div class="ask-rec-foot">
        <Show when={shape().lead}>{(lead) => <p class="ask-rec-lead">{lead()}</p>}</Show>
        <Show when={props.note}>{(n) => <p class="ask-rec-facts">{n()}</p>}</Show>
        <Show when={!props.note && facts()}><p class="ask-rec-facts">{facts()}</p></Show>
        <Show when={offered() > 0}>
          <button class="ask-rec-more" aria-expanded={shown() ? "true" : "false"} aria-label={`${optionsControl(offered(), shown())}, ${about()}`} onClick={() => setShown(!shown())}>{optionsControl(offered(), shown())}</button>
        </Show>
      </div>
    </div>
  );
}

/** the line a settled permission leaves on its tool's row, when this device replied to it: what it replied, then where and when,
    above the tool's own body. a permission answered elsewhere, or before this device kept records, leaves nothing to say */
export function PermitRecord(props: { record: AskReply }) {
  const words = () => permitWords(props.record);
  const facts = () => recordFacts(whoOf(props.record), props.record.at, deviceClass());
  return (
    <div class="ask-permit" role="group" aria-label={[words(), facts()].filter(Boolean).join(", ")}>
      <p class="ask-rec-lead">{words()}</p>
      <Show when={facts()}><p class="ask-rec-facts">{facts()}</p></Show>
    </div>
  );
}
