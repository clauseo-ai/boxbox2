/* a btw in the thread (docs/thread.md, btw): the card, the one line a dismissed one folds to, and the marker on a message
   that was added to the thread from one. what each says is words.ts's; where each goes is place.ts's, read through
   BtwContext, which the stage fills (a story fills it with fakes). the verbs go through the context's actions, which
   the worker carries out: the ui never fetches. */

import { createMemo, createSignal, For, Show, useContext } from "solid-js";
import { FollowContext, LandingContext, light, Markdown, WindowContext } from "../thread/thread";
import { BtwContext, type Btw, type BtwDone } from "./types";
import { BTW_ANSWERING, BTW_CAPTION, BTW_LABEL, type BtwVerb, btwView, FROM_BTW, fromBtwName } from "./words";
import { markerTarget, parentMarkerName } from "./marker";
import "./card.css";

/** the scroller a light moves: the stage's, when the card is on one */
const scrollerOf = (el: Element): HTMLElement | undefined => el.closest<HTMLElement>(".stage-scroll") ?? undefined;

/** the btws a turn holds, after its content: nothing at all when it holds none (a turn with no btw is unchanged) */
export function BtwCards(props: { turnID: string }) {
  const thread = useContext(BtwContext);
  const list = () => thread?.of(props.turnID) ?? [];
  return (
    <Show when={thread && list().length > 0}>
      <For each={list()}>{(b) => <BtwCard btw={b} />}</For>
    </Show>
  );
}

/** one btw: the card, or its one line once dismissed */
export function BtwCard(props: { btw: Btw }) {
  const thread = useContext(BtwContext);
  const win = useContext(WindowContext);
  const follow = useContext(FollowContext);
  const landing = useContext(LandingContext);
  // opened again after a dismiss: this device's alone (the dismiss is synced, the look back is not)
  const [expanded, setExpanded] = createSignal(false);
  const [busy, setBusy] = createSignal<BtwVerb["verb"] | null>(null);
  const [problem, setProblem] = createSignal<string | null>(null);
  // the message a promote answered with, until the record says so itself (the stream's echo)
  const [added, setAdded] = createSignal<string | undefined>(undefined);
  const record = (): Btw => {
    const id = added();
    return id !== undefined && props.btw.promotedMessageID == null ? { ...props.btw, promotedMessageID: id } : props.btw;
  };
  const name = () => thread?.nameOf(props.btw.id) || props.btw.question;
  const view = createMemo(() => btwView(record(), expanded(), name()));
  // a card asked while the reader watches fades up; one painted as a thread lands just shows (the motion law)
  const enter = props.btw.status === "running" && !landing?.();
  let el: HTMLElement | undefined;

  const run = async (verb: BtwVerb["verb"], go: () => Promise<BtwDone>, then?: (done: Extract<BtwDone, { ok: true }>) => void) => {
    if (busy()) return;
    setBusy(verb);
    setProblem(null);
    try {
      const done = await go();
      if (!done.ok) setProblem(done.message);
      else then?.(done);
    } finally {
      setBusy(null);
    }
  };
  const key = () => thread?.key() ?? "";
  /* focus stays with the btw when the card folds to its line or opens from it: a keyboard is not dropped to the page */
  const keepFocus = () => queueMicrotask(() => {
    const now = el?.isConnected ? el : document.querySelector<HTMLElement>(`[data-btw="${CSS.escape(props.btw.id)}"]`);
    (now?.matches("button") ? now : now?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
  });
  const onVerb = (v: BtwVerb) => {
    if (!thread) return;
    const had = el?.contains(document.activeElement) ?? false;
    switch (v.verb) {
      case "promote":
        return void run("promote", () => thread.actions.promote(key(), props.btw.id), (done) => { if (done.messageID) setAdded(done.messageID); });
      case "added":
        return toMessage(record().promotedMessageID);
      case "dismiss":
        follow?.hold();
        return void run("dismiss", () => thread.actions.dismiss(key(), props.btw.id), () => { setExpanded(false); if (had) keepFocus(); });
      case "hide":
        follow?.hold();
        setExpanded(false);
        if (had) keepFocus();
        return;
      case "retry":
        // the same question asked again; the failed one goes once the new one is asked, so the thread does not keep both
        return void run("retry", () => thread.actions.ask(key(), props.btw.question), () => void thread.actions.dismiss(key(), props.btw.id));
      default:
        return v.verb satisfies never;
    }
  };
  /* the message the btw was added as: its turn is filled first, so its bubble is there to land on */
  const toMessage = (messageID: string | null | undefined) => {
    if (!messageID || !el) return;
    win?.reveal(messageID);
    const root = el.closest("[data-flip-root]") ?? document;
    const bubble = root.querySelector<HTMLElement>(`[data-turn="${CSS.escape(messageID)}"] .you`);
    if (bubble) light(bubble, scrollerOf(bubble));
  };

  return (
    <Show when={view().kind !== "none"}>
      <Show
        when={view().kind === "card" ? view() : undefined}
        fallback={
          <Show when={view().kind === "chip" ? view() : undefined}>
            {(chip) => {
              const c = chip() as Extract<ReturnType<typeof btwView>, { kind: "chip" }>;
              return (
                <button ref={(b) => { el = b; }} type="button" class="btw-chip" data-btw={props.btw.id} aria-expanded="false" aria-label={c.name} onClick={() => { follow?.hold(); setExpanded(true); keepFocus(); }}>
                  <b>btw:</b> {c.word.slice(5)}
                </button>
              );
            }}
          </Show>
        }
      >
        {(shown) => {
          const v = () => shown() as Extract<ReturnType<typeof btwView>, { kind: "card" }>;
          return (
            <section ref={(s) => { el = s; }} class="btw" role="region" aria-label={v().region} data-btw={props.btw.id} data-state={v().state} data-enter={enter ? "" : undefined} aria-busy={props.btw.status === "running" ? "true" : undefined}>
              <div class="btw-head">
                <b class="btw-label">{BTW_LABEL}</b>
                <span class="btw-caption">{BTW_CAPTION}</span>
              </div>
              <p class="btw-q">{props.btw.question}</p>
              <Show when={v().answer}>
                <Show when={props.btw.answer !== "" || props.btw.status !== "running"} fallback={<p class="btw-wait caret">{BTW_ANSWERING}</p>}>
                  <Markdown class="btw-a say-md" text={props.btw.answer} caret={props.btw.status === "running"} />
                </Show>
              </Show>
              <Show when={v().note}>{(note) => <p class="btw-note" role={v().state === "error" ? "alert" : undefined}>{note()}</p>}</Show>
              <Show when={problem()}>{(p) => <p class="btw-problem" role="alert">{p()}</p>}</Show>
              <div class="btw-acts">
                <For each={v().verbs}>
                  {(verb) => (
                    <button type="button" data-verb={verb.verb} aria-label={verb.name} aria-busy={busy() === verb.verb ? "true" : undefined} aria-expanded={verb.verb === "hide" ? "true" : undefined} onClick={() => onVerb(verb)}>
                      {verb.word}
                    </button>
                  )}
                </For>
              </div>
            </section>
          );
        }}
      </Show>
    </Show>
  );
}

/** the marker under a message added to the thread from a btw: it goes to the card and lights it */
export function BtwMarker(props: { btwID: string }) {
  const thread = useContext(BtwContext);
  const win = useContext(WindowContext);
  const follow = useContext(FollowContext);
  let el!: HTMLButtonElement;
  /* the card is this thread's, or, in a fork, the parent's: the fork copied the message and never the btw (marker.ts) */
  const target = () => markerTarget(props.btwID, (id) => thread?.turnOf(id), thread?.lineage?.() ?? null);
  const go = () => {
    const to = target();
    if (to.kind === "parent") {
      if (thread?.parentOpening?.()) return;
      thread?.openInParent?.(props.btwID);
      return;
    }
    if (to.kind !== "here") return;
    follow?.hold();
    win?.reveal(to.turn);
    const root = el.closest("[data-flip-root]") ?? document;
    const card = root.querySelector<HTMLElement>(`[data-btw="${CSS.escape(props.btwID)}"]`);
    if (card) light(card, scrollerOf(card));
  };
  const words = () => <>{FROM_BTW.slice(0, 7)}<b>btw</b>{FROM_BTW.slice(10)}</>;
  const name = () => { const to = target(); return to.kind === "parent" ? parentMarkerName(to.title) : fromBtwName(thread?.nameOf(props.btwID) || undefined); };
  return (
    <>
      {/* a btw no thread here can show (let go, in a thread that is not a fork) leaves the words with nothing to go to */}
      <Show when={target().kind !== "none"} fallback={<span class="btw-from" data-from-btw={props.btwID}>{words()}</span>}>
        <button ref={el} type="button" class="btw-from" data-from-btw={props.btwID} aria-label={name()} aria-disabled={target().kind === "parent" && thread?.parentOpening?.() ? "true" : undefined} onClick={go}>
          {words()}
        </button>
      </Show>
      <Show when={thread?.parentNote?.(props.btwID)}>{(why) => <p class="btw-from-note" role="alert">{why()}</p>}</Show>
    </>
  );
}
