/* the conversation's rows (docs/thread.md, an assistant's thread): your message with its origin line, its quote block and
   its reactions; the agent's words with the quote line above them; the hover reply and react controls; the reaction bar;
   the reply strip above the composer; a send that is not confirmed; a part this build does not know; a scheduled run's
   mark line; and the live edge's "thinking". every control is named by the law's table (design.md, accessible names)
   and gated by the caller on the agent's capabilities by name (`quotes`, `reactions`, `origins`), never on its runtime. */

import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { light } from "../../thread/thread";
import { againName, pillName, pillsOf, quoteLine, quoteName, REACTIONS, reactName, reactWith, replyName, scheduledLine, stripLine, stripName, timeLine, type ReplyTarget, type Unconfirmed, unconfirmedWords, unknownWords, unresolvedQuote } from "../words";
import type { Origin, Quote, Reaction } from "../wire";
import "./conversation.css";

/* —— jumping to what a quote quotes —— */

/** scrolls the stage's own scroller to a message by its id and rings it in the accent for 1.6 s, as a landing from the tape
    does (thread.tsx, light). answers false when the thread no longer holds it (the quote is then not a button at all) */
export function jumpTo(message: string, root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLElement>(`[data-message="${CSS.escape(message)}"]`);
  if (!el) return false;
  light(el, el.closest<HTMLElement>("[data-scroller]") ?? undefined);
  return true;
}

/* —— the quote block in your bubble, and the quote line above the agent's words —— */

export type QuoteProps = {
  quote: Quote;
  /** the agent's name: the quoted sender when it is "agent"'s own words */
  agent: string;
  /** a quote of a file names it in its line */
  file?: string;
  /** a picture quote carries a 32 px thumbnail at the block's right */
  thumb?: string;
  /** the channel the thread lives on, for a quote whose original the source could not resolve */
  channel?: string | null;
  /** the thread holds the original: the block is a button that goes to it */
  canJump: boolean;
  onJump?: (message: string) => void;
};

const senderOf = (q: Quote, agent: string) => (q.sender === "agent" ? agent : q.sender);
const lineOf = (p: QuoteProps) => (p.quote.message === null && p.quote.preview === null ? unresolvedQuote(p.channel ?? null) : quoteLine(p.quote, p.file));

export function QuoteBlock(props: QuoteProps) {
  const who = () => senderOf(props.quote, props.agent);
  const jumpable = () => props.canJump && props.quote.message !== null;
  const inner = () => (
    <>
      <span class="qb-text-col">
        <b class="qb-who">{who()}</b>
        <span class="qb-text">{lineOf(props)}</span>
      </span>
      <Show when={props.thumb && props.quote.glyph === "image"}>
        <img class="qb-thumb" src={props.thumb} alt="" width={32} height={32} />
      </Show>
    </>
  );
  return (
    <Show when={jumpable()} fallback={<span class="qb" data-you={who() === "you" ? "" : undefined}>{inner()}</span>}>
      <button type="button" class="qb" data-you={who() === "you" ? "" : undefined} aria-label={quoteName(who(), lineOf(props))} onClick={() => props.quote.message && props.onJump?.(props.quote.message)}>
        {inner()}
      </button>
    </Show>
  );
}

export function QuoteLine(props: QuoteProps) {
  const who = () => senderOf(props.quote, props.agent);
  const jumpable = () => props.canJump && props.quote.message !== null;
  const inner = () => (
    <>
      <span class="qline-rule" aria-hidden="true" />
      <b>{who()}</b>
      <span class="qline-text">{` · ${lineOf(props)}`}</span>
    </>
  );
  return (
    <Show when={jumpable()} fallback={<p class="qline">{inner()}</p>}>
      <button type="button" class="qline" aria-label={quoteName(who(), lineOf(props))} onClick={() => props.quote.message && props.onJump?.(props.quote.message)}>
        {inner()}
      </button>
    </Show>
  );
}

/* —— reactions —— */

export type ReactionsProps = {
  reactions: readonly Reaction[];
  agent: string;
  /** your reaction is drawn faded until its echo */
  pending?: string | null;
  /** the row came in on a channel and the mirror there failed */
  mirrorFailed?: string | null;
  onRemove?: (emoji: string) => void;
};

/** a pill per emoji hanging under the message's corner, the count when more than one chose it, a ring of the accent on yours */
export function Reactions(props: ReactionsProps) {
  const pills = () => pillsOf(props.reactions);
  return (
    <Show when={pills().length > 0}>
      <span class="rx-row">
        <For each={pills()}>
          {(pill) => (
            <Show
              when={pill.mine}
              fallback={
                <span class="rx" role="img" aria-label={pillName(pill, props.agent)}>
                  <span aria-hidden="true">{pill.emoji}</span>
                  <Show when={pill.count > 1}><i aria-hidden="true">{pill.count}</i></Show>
                </span>
              }
            >
              <button type="button" class="rx on" data-state={props.pending === pill.emoji ? "sending" : undefined} aria-label={pillName(pill, props.agent)} onClick={() => props.onRemove?.(pill.emoji)}>
                <span aria-hidden="true">{pill.emoji}</span>
                <Show when={pill.count > 1}><i aria-hidden="true">{pill.count}</i></Show>
              </button>
            </Show>
          )}
        </For>
        <Show when={props.mirrorFailed}>{(ch) => <span class="rx-status" role="status">reacted here. {ch()} did not take it.</span>}</Show>
      </span>
    </Show>
  );
}

/** the reaction bar: boxbox's six in their order, one press sends and closes. on a row that came in on a channel (a
    direct conversation only) it says the reaction is mirrored there. arrows walk it, escape closes it */
export function ReactionBar(props: { channel?: string | null; onPick: (emoji: string) => void; onClose: () => void }) {
  let bar!: HTMLDivElement;
  const buttons = () => [...bar.querySelectorAll<HTMLButtonElement>("button")];
  const onKey = (e: KeyboardEvent) => {
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), props.onClose();
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      all[(at + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]?.focus();
    }
  };
  const outside = (e: PointerEvent) => {
    if (!bar.contains(e.target as Node)) props.onClose();
  };
  onMount(() => {
    buttons()[0]?.focus({ preventScroll: true });
    setTimeout(() => document.addEventListener("pointerdown", outside), 0);
  });
  onCleanup(() => document.removeEventListener("pointerdown", outside));
  return (
    <div class="rx-bar" ref={bar} role="group" aria-label="reactions" onKeyDown={onKey}>
      <span class="rx-bar-six">
        <For each={REACTIONS}>
          {(r) => (
            <button type="button" aria-label={reactWith(r.name)} onClick={() => (props.onPick(r.emoji), props.onClose())}>
              <span aria-hidden="true">{r.emoji}</span>
            </button>
          )}
        </For>
      </span>
      <Show when={props.channel}>{(ch) => <span class="rx-bar-note">also reacts on {ch()}</span>}</Show>
    </div>
  );
}

/* —— the row's hover controls: reply (the web's idiom for the swipe) and react —— */

export type RowActionsProps = {
  mine: boolean;
  agent: string;
  at: number;
  words: string;
  quotes: boolean;
  reactions: boolean;
  onReply?: () => void;
  onReact?: () => void;
};

/** shown on hover and on focus within the row, under (hover: hover); the row's long-press menu carries them on touch */
export function RowActions(props: RowActionsProps) {
  return (
    <span class="row-acts">
      <Show when={props.reactions}>
        <button type="button" class="row-act" aria-label={reactName(props.mine, props.agent, props.at, props.words)} onClick={() => props.onReact?.()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM8.5 14c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2M9 9.5v.5M15 9.5v.5" /></svg>
        </button>
      </Show>
      <Show when={props.quotes}>
        <button type="button" class="row-act" aria-label={replyName(props.mine, props.agent, props.at, props.words)} onClick={() => props.onReply?.()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7 5 12l5 5M5.5 12H14a5 5 0 0 1 5 5v1" /></svg>
        </button>
      </Show>
    </span>
  );
}

/* —— your message —— */

export type YourMessageProps = {
  id: string;
  text: string;
  at: number;
  origin?: Origin;
  quote?: QuoteProps;
  reactions?: ReactionsProps;
  /** the row's controls, when the agent takes quotes or reactions */
  actions?: Omit<RowActionsProps, "mine" | "at" | "words">;
  /** the reaction bar is open over this row */
  barOpen?: boolean;
  barChannel?: string | null;
  onPickReaction?: (emoji: string) => void;
  onCloseBar?: () => void;
  /** a send boxbox could not confirm: faded, the words under it, and the one control */
  unconfirmed?: { state: Unconfirmed; agent: string; machine: string; onAgain?: () => void };
  /** the sender in a group conversation, when it is not you: a quiet well on the left with their name over it */
  sender?: string;
  children?: JSX.Element;
};

export function YourMessage(props: YourMessageProps) {
  const checking = () => props.unconfirmed?.state === "checking";
  const slot = () => (checking() && props.unconfirmed ? unconfirmedWords("checking", props.unconfirmed.agent, props.unconfirmed.machine) : timeLine(props.at, props.origin));
  const other = () => props.sender !== undefined && props.sender !== "you";
  const onKey = (e: KeyboardEvent) => {
    // `r` on a focused row replies to it (composer.md, web and native)
    if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey && props.actions?.quotes && e.target === e.currentTarget) {
      e.preventDefault();
      props.actions.onReply?.();
    }
  };
  return (
    <div class="as-msg" data-message={props.id} data-mine={other() ? undefined : ""} tabIndex={props.actions ? 0 : undefined} onKeyDown={onKey}>
      <Show when={other()}>
        <span class="as-sender">{props.sender}</span>
      </Show>
      <div class="as-bubble-line">
        <Show when={props.actions}>{(a) => <RowActions mine={!other()} at={props.at} words={props.text} {...a()} />}</Show>
        <div class="as-bubble-col">
          <div class={other() ? "as-their" : "you as-you"} data-state={props.unconfirmed ? "sending" : undefined}>
            <Show when={props.quote}>{(q) => <QuoteBlock {...q()} />}</Show>
            {props.children}
            <Show when={props.text}>
              <span class="as-words">{props.text}</span>
            </Show>
            <time class="origin">{slot()}</time>
          </div>
          <Show when={props.reactions}>{(r) => <Reactions {...r()} />}</Show>
        </div>
      </div>
      <Show when={props.barOpen}>
        <ReactionBar channel={props.barChannel ?? null} onPick={(e) => props.onPickReaction?.(e)} onClose={() => props.onCloseBar?.()} />
      </Show>
      <Show when={props.unconfirmed && !checking() ? props.unconfirmed : null}>
        {(u) => (
          <p class="as-unconfirmed">
            <span>{unconfirmedWords(u().state, u().agent, u().machine)}</span>
            <button type="button" aria-label={againName(props.text)} onClick={() => u().onAgain?.()}>
              send it again
            </button>
          </p>
        )}
      </Show>
    </div>
  );
}

/* —— the agent's words —— */

export type AgentWordsProps = {
  id: string;
  /** what it said, already drawn (the said row's markdown); plain words are fine for a story */
  children: JSX.Element;
  /** its words as text, for the controls' names */
  text: string;
  at: number;
  quote?: QuoteProps;
  reactions?: ReactionsProps;
  actions?: Omit<RowActionsProps, "mine" | "at" | "words">;
  barOpen?: boolean;
  barChannel?: string | null;
  onPickReaction?: (emoji: string) => void;
  onCloseBar?: () => void;
};

export function AgentWords(props: AgentWordsProps) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey && props.actions?.quotes && e.target === e.currentTarget) {
      e.preventDefault();
      props.actions.onReply?.();
    }
  };
  return (
    <div class="as-msg as-said" data-message={props.id} tabIndex={props.actions ? 0 : undefined} onKeyDown={onKey}>
      <Show when={props.quote}>{(q) => <QuoteLine {...q()} />}</Show>
      <div class="as-said-line">
        <div class="as-said-words">{props.children}</div>
        <Show when={props.actions}>{(a) => <RowActions mine={false} at={props.at} words={props.text} {...a()} />}</Show>
      </div>
      <Show when={props.reactions}>{(r) => <Reactions {...r()} />}</Show>
      <Show when={props.barOpen}>
        <ReactionBar channel={props.barChannel ?? null} onPick={(e) => props.onPickReaction?.(e)} onClose={() => props.onCloseBar?.()} />
      </Show>
    </div>
  );
}

/* —— the reply strip above the composer —— */

/** a glass tab the composer's width less 8 px a side, 52 px tall, joined to the composer: the reply glyph, a rule in the
    accent, the author over one line of what it replies to, and a round close. escape takes it away too */
export function ReplyStrip(props: { target: ReplyTarget; onClose: () => void }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));
  return (
    <div class="reply-strip" role="group" aria-label={stripName(props.target)}>
      <svg class="reply-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7 5 12l5 5M5.5 12H14a5 5 0 0 1 5 5v1" /></svg>
      <span class="reply-rule" aria-hidden="true" />
      <span class="reply-text">
        <b>{props.target.who}</b>
        <span>{stripLine(props.target)}</span>
      </span>
      <button type="button" class="reply-close" aria-label="stop replying" onClick={() => props.onClose()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
      </button>
    </div>
  );
}

/* —— small rows —— */

/** a part this build does not know: one muted line naming its kind and saying to update, with its text when it has one */
export function UnknownPartRow(props: { kind: string; text?: string }) {
  return (
    <div class="as-unknown">
      <p>{unknownWords(props.kind)}</p>
      <Show when={props.text}>{(t) => <p class="as-unknown-text">{t()}</p>}</Show>
    </div>
  );
}

/** a turn the assistant started on a schedule: a mark line where your bubble would be */
export function ScheduledLine(props: { at: number; name?: string }) {
  const words = () => scheduledLine(props.at, props.name);
  const kind = () => (props.name === "heartbeat" ? "heartbeat" : "scheduled");
  return (
    <p class="sched">
      <b>{kind()}</b>
      {words().slice(kind().length)}
    </p>
  );
}

/** the live edge while the agent thinks and shows no reasoning: a still dot and "thinking" in the accent; nothing pulses */
export function ThinkingLine() {
  return (
    <p class="as-thinking" role="status">
      <span aria-hidden="true" />
      thinking
    </p>
  );
}
