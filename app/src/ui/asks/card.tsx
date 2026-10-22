/* an ask's card (docs/thread.md, every state: asks): a question's options,
   its typed answer, pick any, several questions answered together, dismiss;
   a permission's allow once, always allow, deny and deny and say why; and,
   once a question is settled, its record (what was answered, where and when,
   the options as offered on a tap). the thread draws it in the ask's row, and
   home's answer sheet draws the same card for every pending ask of a thread.
   it answers through the AskContext its host provides; with none (a story),
   it only looks the part. */

import { For, Show, createContext, createMemo, createSignal, useContext } from "solid-js";
import { deviceClass } from "../../push/device";
import { blockForKey } from "../thread/ask-landing";
import { DiffView } from "../thread/diff";
import type { AskOutcome } from "../thread/outcome";
import type { Body } from "../thread/rows";
import type { AskReply } from "../../sync/replies";
import { YOU_ANSWERED, optionsControl, permitWords, questionLabel, recordFacts, recordShape, spokenRecord, typed, whoOf } from "./record";
import { QuestionWords } from "./question";
import { plainWords, shortWords } from "./words";
import "./card.css";

/** what a host does when an ask is answered; the stories provide none, so their cards only look the part */
export type AskActions = {
  answer(askID: string, answers: string[][]): Promise<AskOutcome>;
  reject(askID: string): Promise<AskOutcome>;
  permit(askID: string, reply: "once" | "always" | "reject", message?: string): Promise<AskOutcome>;
};
export const AskContext = createContext<AskActions>();

export type AskBody = Extract<Body, { k: "ask" }>;
export type PermissionBody = Extract<Body, { k: "permission" }>;

/** the honest state of a reply: nothing sent, sending, sent (until the ask settles on the stream), a note (it lost the race, or the
    ask is gone: said in the law's words, with nothing to retry), or a problem to tap. who settled it is not the card's to hold:
    the actions keep this device's record in the store (sync/replies.ts), and the settled row reads it from there */
export function useReply() {
  const [busy, setBusy] = createSignal(false);
  const [sent, setSent] = createSignal<string | null>(null);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  let last: (() => Promise<AskOutcome>) | null = null;
  const run = async (label: string, send: () => Promise<AskOutcome>) => {
    if (busy() || sent() !== null || note() !== null) return;
    last = send;
    setBusy(true);
    setProblem(null);
    const out = await send();
    setBusy(false);
    if (out.ok) setSent(label);
    else if (out.settled || out.gone) setNote(out.problem);
    else setProblem(out.problem);
  };
  const retry = () => { if (last) void run(sent() ?? "", last); };
  return { busy, sent, problem, note, run, retry };
}

/** keys 1 to 9 press the options of one question while focus is on the card or inside it, never in a field: the window used to
    answer them, and the card a push or a window's pill sends you to takes focus, so a keyboard answers it from there. an ask of
    several questions counts within the question focus is in, else the first with no answer yet (ask-landing.ts) */
function pressOption(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return;
  /* a link in the question's words, or its copy control, keeps its keys: a digit there is not an answer */
  if (event.target instanceof Element && event.target.closest(".ask-said a, .copy-btn")) return;
  const digit = Number(event.key);
  if (!Number.isInteger(digit) || digit < 1 || !(event.currentTarget instanceof HTMLElement)) return;
  const card = event.currentTarget;
  const blocks = [...card.querySelectorAll<HTMLElement>(".ask-q")];
  const scope = blocks[blockForKey(blocks.map((b) => ({ focused: b.contains(document.activeElement), answered: b.querySelector('[aria-pressed="true"]') !== null || (b.querySelector<HTMLInputElement>("input")?.value.trim() ?? "") !== "" })))] ?? card;
  const option = scope.querySelectorAll<HTMLButtonElement>("button.ask-opt")[digit - 1];
  if (!option || option.disabled) return;
  event.preventDefault();
  option.click();
}

export function AskCard(props: { b: AskBody }) {
  const actions = useContext(AskContext);
  const reply = useReply();
  /* the questions as words: a new body with the same words is the same questions, so the blocks and their fields are kept */
  const questions = createMemo(() => props.b.questions, props.b.questions, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const several = () => questions().length > 1;
  /* what is chosen and what is typed, a list of each per question: a typed answer is the one the daemon takes in place of
     the options, so it wins when there are words in it */
  const [picked, setPicked] = createSignal<string[][]>([]);
  const [typed, setTyped] = createSignal<string[]>([]);
  const answerOf = (i: number): string[] => { const words = typed()[i]?.trim(); return words ? [words] : (picked()[i] ?? []); };
  const complete = () => questions().length > 0 && questions().every((_, i) => answerOf(i).length > 0);
  const id = () => props.b.askID;
  const send = (answers: string[][]) => { const askID = id(); if (!askID || !actions) return; void reply.run(answers.map((a) => a.join(", ")).join("; "), () => actions.answer(askID, answers)); };
  const sendAll = () => send(questions().map((_, i) => answerOf(i)));
  const dismiss = () => { const askID = id(); if (!askID || !actions) return; void reply.run("dismissed", () => actions.reject(askID)); };
  const locked = () => reply.busy() || reply.sent() !== null || reply.note() !== null;
  const choose = (question: number, label: string, multiple: boolean) => setPicked((all) => {
    const next = questions().map((_, i) => [...(all[i] ?? [])]);
    const held = next[question] ?? [];
    next[question] = multiple ? (held.includes(label) ? held.filter((x) => x !== label) : [...held, label]) : [label];
    return next;
  });
  const type = (question: number, words: string) => setTyped((all) => questions().map((_, i) => (i === question ? words : (all[i] ?? ""))));
  const first = () => questions()[0];
  /* one tap answers a lone question with one choice; anything more is chosen, then sent */
  const oneTap = () => !several() && first()?.multiple !== true;
  const sentLabel = () => reply.sent();
  /* names quote the question as words, never its markdown marks */
  const spoken = (q: { question: string } | undefined, limit: number) => shortWords(plainWords(q?.question ?? ""), limit);
  return (
    <div class="ask-card" data-ask={id()} tabIndex={-1} role="group" aria-label={several() ? `${questions().length} questions` : `question: ${spoken(first(), 60)}`} data-one={several() ? undefined : ""} onKeyDown={pressOption}>
      <Show when={props.b.pending && !id()}>
        <For each={questions()}>{(q) => <div class="ask-q"><QuestionWords q={q} /></div>}</For>
        <div class="ask-ans">waiting its turn: not asked yet</div>
      </Show>
      <Show when={props.b.pending && id()} fallback={<Show when={!props.b.pending}><AskRecord b={props.b} questions={questions()} note={props.b.record ? null : reply.note()} /></Show>}>
        <For each={questions()}>{(q, qi) => (
          <div class="ask-q" role={several() || q.multiple ? "group" : undefined} aria-label={several() ? plainWords(q.question) : q.multiple ? "pick any" : undefined}>
            <QuestionWords q={q} />
            <div class="ask-opts">
              <For each={q.options}>{(o, i) => (
                <button
                  class={`ask-opt ${i() === 0 && oneTap() ? "first" : ""}`}
                  aria-label={several() ? `answer ${o.label}, ${spoken(q, 60)}` : `answer ${o.label}`}
                  aria-pressed={oneTap() ? (sentLabel() === o.label ? "true" : "false") : (picked()[qi()]?.includes(o.label) ?? false)}
                  disabled={locked()}
                  onClick={() => (oneTap() ? send([[o.label]]) : choose(qi(), o.label, q.multiple))}
                >
                  {o.label}
                  {/* a description is the agent's words too, but an option is a button and holds no link: its markdown is said as plain words */}
                  <Show when={o.description && o.description !== `answer ${o.label}`}><small>{plainWords(o.description)}</small></Show>
                </button>
              )}</For>
            </div>
            <Show when={q.custom}>
              <form class="ask-line" onSubmit={(e) => { e.preventDefault(); const words = typed()[qi()]?.trim(); if (several()) { if (complete()) sendAll(); } else if (words) send([[words]]); }}>
                <input class="ask-input" type="text" placeholder="or type an answer" aria-label={several() ? `type an answer to ${spoken(q, 60)}` : "type an answer"} value={typed()[qi()] ?? ""} onInput={(e) => type(qi(), e.currentTarget.value)} disabled={locked()} autocomplete="off" />
                <Show when={!several()}><button class="ask-go" type="submit" aria-label="answer with what you typed" disabled={locked() || !typed()[qi()]?.trim()}>answer</button></Show>
              </form>
            </Show>
          </div>
        )}</For>
        <Show when={several()}>
          <button class="ask-go ask-send" aria-label={`answer all ${questions().length} questions: ${spoken(first(), 40)}`} disabled={locked() || !complete()} onClick={sendAll}>answer</button>
        </Show>
        <Show when={!several() && !oneTap()}>
          <button class="ask-go ask-send" disabled={locked() || (picked()[0]?.length ?? 0) === 0} onClick={() => send([picked()[0] ?? []])}>answer with {picked()[0]?.length ?? 0} picked</button>
        </Show>
        <div class="ask-foot">
          <Show when={reply.busy()}><span class="ask-sent">sending</span></Show>
          <Show when={reply.sent()}>{(s) => <span class="ask-sent">sent: {s()}</span>}</Show>
          <Show when={reply.note()}>{(n) => <span class="ask-note">{n()}</span>}</Show>
          <Show when={reply.problem()}>{(p) => <button class="ask-problem" onClick={reply.retry}>{p()}</button>}</Show>
          <Show when={!locked()}><button class="ask-quiet" onClick={dismiss}>dismiss</button></Show>
        </div>
      </Show>
    </div>
  );
}

export function PermissionCard(props: { b: PermissionBody }) {
  const actions = useContext(AskContext);
  const reply = useReply();
  const [why, setWhy] = createSignal<string | null>(null);
  const id = () => props.b.askID;
  const locked = () => reply.busy() || reply.sent() !== null || reply.note() !== null;
  const permit = (r: "once" | "always" | "reject", label: string, message?: string) => { const askID = id(); if (!askID || !actions) return; void reply.run(label, () => actions.permit(askID, r, message)); };
  return (
    <div class="ask-card" data-ask={id()} tabIndex={-1} role="group" aria-label={`permission: ${shortWords(props.b.what, 60)}`} onKeyDown={pressOption}>
      <div class="ask-what">wants your permission to <b>{props.b.what}</b></div>
      <Show when={props.b.diff}>{(d) => <DiffView lines={d()} />}</Show>
      <div class="ask-opts">
        <button class="ask-opt first" aria-label="allow once" aria-pressed={reply.sent() === "allowed once" ? "true" : "false"} disabled={locked()} onClick={() => permit("once", "allowed once")}>allow once</button>
        <button class="ask-opt" aria-label="always allow" aria-pressed={reply.sent() === "always allowed" ? "true" : "false"} disabled={locked()} onClick={() => permit("always", "always allowed")}>always allow<small>every {props.b.permission} in this project</small></button>
        <button class="ask-opt" aria-label="deny" aria-pressed={reply.sent() === "denied" ? "true" : "false"} disabled={locked()} onClick={() => permit("reject", "denied")}>deny</button>
      </div>
      <Show when={why() === null} fallback={
        <form class="ask-line" onSubmit={(e) => { e.preventDefault(); permit("reject", "denied", why()?.trim() || undefined); }}>
          <input class="ask-input" type="text" placeholder="say why, and the agent reads it" aria-label="why not" value={why() ?? ""} onInput={(e) => setWhy(e.currentTarget.value)} disabled={locked()} autocomplete="off" />
          <button class="ask-go" type="submit" disabled={locked()}>deny</button>
        </form>
      }>
        <Show when={!locked()}><button class="ask-quiet" onClick={() => setWhy("")}>or deny and say why</button></Show>
      </Show>
      <div class="ask-foot">
        <Show when={reply.busy()}><span class="ask-sent">sending</span></Show>
        <Show when={reply.sent()}>{(s) => <span class="ask-sent">sent: {s()}</span>}</Show>
        <Show when={reply.note()}>{(n) => <span class="ask-note">{n()}</span>}</Show>
        <Show when={reply.problem()}>{(p) => <button class="ask-problem" onClick={reply.retry}>{p()}</button>}</Show>
      </div>
    </div>
  );
}

/** a settled question as its row keeps it: every question's own words (its label, the markdown, its copy control), the answer given to
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
