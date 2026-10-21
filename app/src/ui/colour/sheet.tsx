/* a repo's colour sheet (docs/design.md, the colour sheet): which of the ten a repo wears on every device, or automatic,
   the one boxbox gave it. the repo is a host and its root, so the sheet names the machine.

   trying a colour repaints the repo everywhere at once (the store's preview: the stage behind the sheet, home's windows,
   the marks), and nothing is sent until "use". "keep" and every way of closing put the repo back as it was. a refusal
   keeps the sheet open with the server's words. after "use" the preview stays until the stream's `colour` frame holds the
   choice, or a short wait passes, so the stage never flashes back to the old colour between the answer and the frame.

   a modal dialog in the top layer, as the report sheet is, so the stage's masked scroller does not turn its glass off and
   the page under it is inert: from the screen's foot on a phone, a card at the foot of the screen elsewhere. escape, the
   close, "keep" and a press outside it close it; the opener puts the keyboard back where it was. */

import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack } from "solid-js";
import { chooseColour } from "../../api/client";
import { play } from "../../motion/animate";
import { FADE, SHEET } from "../../motion/springs";
import { setColourPreview, state } from "../../store";
import type { Thread } from "../../sync/protocol";
import { Close } from "../close";
import { RepoMark } from "../repo-mark/repo-mark";
import { reducedMotion } from "../thread/motion";
import { colourMap } from "../window/colours";
import { colourAssignment, colourStyle, type RepoColour, repoKey } from "../window/repo";
import { windowView } from "../window/view";
import {
  autoLine,
  buttonsOf,
  currentPick,
  heardBeforeRefused,
  type HeldPick,
  holds,
  neighboursOf,
  noteOf,
  type Pick,
  pickFor,
  previewFor,
  refusedLine,
  samePick,
  sentFor,
  shownBy,
  stepPick,
  swatchesOf,
} from "./picker-model";
import "./colour.css";

/** how long the preview may wait for the stream to carry a choice the server took, before the sheet lets go anyway */
const SETTLE_MS = 3000;
/** the other repos drawn as small windows; the note names the rest */
const NEIGHBOUR_WINDOWS = 3;

export type ColourSheetProps = {
  host: string;
  /** the repo's project root, never a worktree's directory */
  root: string;
  /** the repo's name as the surface says it */
  name: string;
  /** the thread the sheet was opened from, whose window it shows; the repo's newest thread otherwise */
  thread?: string | undefined;
  /** the surface the sheet belongs to (the stage): beside other columns, the card stands at its foot rather than the
      screen's. measured once, as it opens */
  within?: HTMLElement | undefined;
  /** the sheet is gone (and the preview with it, or held by a choice the stream has not carried yet) */
  onClose: () => void;
};

/** what a small window shows: the newest thread's title, its chip, and an open ask's question */
type Mini = { title: string | null; chip: string | null; ask: string | null };

const miniOf = (entry: Thread | undefined): Mini => {
  if (!entry) return { title: null, chip: null, ask: null };
  const view = windowView(entry, Object.values(state.fleet.asks).filter((a) => a.key === entry.key), colourMap());
  return { title: view.title, chip: view.chip?.text ?? null, ask: view.ask?.text ?? null };
};

export function ColourSheet(props: ColourSheetProps) {
  let dialog!: HTMLDialogElement;
  let group!: HTMLDivElement;
  const repo = () => ({ host: props.host, root: props.root });
  const key = createMemo(() => repoKey(repo()));
  const assignment = createMemo(() => colourAssignment(repo(), state.fleet.colours));
  const assigned = () => state.fleet.colours[key()] !== undefined;
  const current = createMemo(() => currentPick(repo(), state.fleet.colours), undefined, { equals: samePick });
  /* what the person is trying: the sheet's own state, not a copy of the store's, which holds only what the server took. it
     is held with the repo it was made for: should the props name another repo while the sheet is open, the pick is that
     repo's current one, so one repo's pick is never previewed for or sent to another (the openers also remount the sheet
     on a new repo) */
  const [held, setHeld] = createSignal<HeldPick>(untrack(() => ({ key: key(), pick: current() })));
  const pick = createMemo(() => pickFor(held(), key(), current()), undefined, { equals: samePick });
  const setPick = (next: Pick) => setHeld({ key: key(), pick: next });
  const shown = (): RepoColour => shownBy(pick(), assignment().auto);

  /* the sessions on this machine, newest first: the roots of the repos beside this one, and each repo's newest thread */
  const sessions = createMemo(() => Object.values(state.fleet.threads).filter((s) => s.agent === props.host).sort((a, b) => b.updated - a.updated));
  const neighbours = createMemo(() => neighboursOf(repo(), state.fleet.colours, sessions().map((s) => s.place?.root ?? "")));
  const newestIn = (root: string) => sessions().find((s) => (s.place?.root ?? "") === root);
  const own = createMemo(() => miniOf((props.thread ? state.fleet.threads[props.thread] : undefined) ?? newestIn(props.root)));
  const swatches = createMemo(() => swatchesOf(pick(), assignment().auto, neighbours()));
  const note = createMemo(() => noteOf(props.host, shown(), neighbours()));
  const noteBadge = () => swatches().find((s) => s.shown)?.badge ?? null;

  /* sending: "use" holds the buttons until the server answers; a refusal is said, and the sheet stays */
  const [sending, setSending] = createSignal(false);
  const [refused, setRefused] = createSignal<string | null>(null);
  /* the buttons say what was tried while it is sent: the stream's frame can land before the answer and make the pick the
     server's, which would take "use" away under the finger */
  const [sentPick, setSentPick] = createSignal<Pick | null>(null);
  /* a choice every device shows that the server could not keep (`store-down`): "use" stays to send it again, though the stream
     has made it the server's current one */
  const [unkept, setUnkept] = createSignal<Pick | null>(null);
  const buttons = () => buttonsOf(current(), sentPick() ?? pick(), assignment().auto, unkept());

  /* the preview follows the pick while it differs from what the server holds, and lets go the moment the server holds it.
     the sheet's going clears it: closing is keeping */
  createEffect(() => setColourPreview(previewFor(repo(), current(), pick(), assignment().auto)));
  onCleanup(() => setColourPreview(null));
  createEffect(() => { pick(); key(); setRefused(null); });
  /* a refusal, a choice that was not kept and the label of one on its way all belong to the repo they were made for */
  createEffect(on(key, () => { setUnkept(null); setSentPick(null); }, { defer: true }));

  const phone = () => !matchMedia("(min-width: 700px)").matches;
  const rise = () => (reducedMotion() ? play(dialog, [{ opacity: 0 }, { opacity: 1 }], FADE) : play(dialog, phone() ? [{ transform: "translateY(110%)" }, { transform: "none" }] : [{ transform: "translateY(18px) scale(.96)", opacity: 0 }, { transform: "none", opacity: 1 }], SHEET));
  const sink = () => (reducedMotion() ? play(dialog, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" }) : play(dialog, phone() ? [{ transform: "none" }, { transform: "translateY(110%)" }] : [{ opacity: 1 }, { opacity: 0, transform: "translateY(18px) scale(.96)" }], SHEET, { fill: "forwards" }));

  onMount(() => {
    /* the card stands centred under the surface it belongs to, so the colour it repaints is the one behind it. the phone's
       sheet is the screen's width, as every sheet there is */
    if (props.within && !phone()) {
      const box = props.within.getBoundingClientRect();
      const width = Math.min(640, box.width - 28);
      Object.assign(dialog.style, { width: `${width}px`, left: `${box.left + (box.width - width) / 2}px`, right: "auto", margin: "0" });
    }
    dialog.showModal();
    rise();
    // the keyboard lands on the checked choice, where the arrows move it
    group.querySelector<HTMLElement>("[aria-checked=\"true\"]")?.focus({ preventScroll: true });
  });

  /* after a choice the server took, the sheet is out of sight and stays mounted until the stream's frame holds it (the
     preview lets go then, by itself) or the wait passes */
  const [settling, setSettling] = createSignal<Pick | null>(null);
  createEffect(() => {
    const after = settling();
    if (!after) return;
    if (holds(repo(), state.fleet.colours, after)) { props.onClose(); return; }
    const timer = setTimeout(() => props.onClose(), SETTLE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  let leaving = false;
  const leave = async (after: Pick | null) => {
    // a choice on its way is not taken back by closing: the sheet waits for the server's answer
    if (leaving || (!after && sending())) return;
    leaving = true;
    if (!after) setPick(current());
    await sink()?.finished.catch(() => undefined);
    if (dialog.open) dialog.close();
    if (after) setSettling(after);
    else props.onClose();
  };
  onCleanup(() => { if (dialog.open) dialog.close(); });

  const use = async () => {
    const tried = pick();
    const was = unkept();
    const retry = was !== null && samePick(was, tried);
    if (sending() || (samePick(tried, current()) && !retry)) return;
    setSending(true);
    setSentPick(tried);
    const sentTo = key();
    const outcome = await chooseColour(props.host, props.root, sentFor(tried));
    setSending(false);
    setSentPick(null);
    // the sheet moved to another repo meanwhile: this answer is the old repo's, and the stream repaints it there
    if (key() !== sentTo) return;
    if (!outcome.ok) {
      const heard = heardBeforeRefused("code" in outcome ? outcome.code : null);
      setUnkept(heard ? tried : null);
      setRefused(refusedLine(props.name, outcome.error, heard ? shownBy(tried, assignment().auto).name : null));
      return;
    }
    setUnkept(null);
    void leave(tried);
  };

  /* a radio group: one stop for the tab key (the checked choice), the arrows move the choice and the keyboard with it */
  const onArrows = (e: KeyboardEvent) => {
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!by || sending()) return;
    e.preventDefault();
    const next = stepPick(pick(), by);
    setPick(next);
    queueMicrotask(() => group.querySelector<HTMLElement>(`[data-pick="${next.kind === "auto" ? "auto" : next.name}"]`)?.focus());
  };

  const titleId = createUniqueId();
  const autoId = createUniqueId();
  const noteId = createUniqueId();
  return (
    <dialog
      ref={dialog}
      class="cs-sheet plane-window"
      style={colourStyle(shown())}
      aria-labelledby={titleId}
      on:cancel={(e) => { e.preventDefault(); void leave(null); }}
      on:keydown={(e) => e.key === "Escape" && e.stopPropagation()}
      onClick={(e) => e.target === dialog && void leave(null)}
    >
      <i class="cs-grab" aria-hidden="true" />
      <header class="cs-head">
        <div>
          <h2 id={titleId}>{props.name}'s colour</h2>
          <p>on {props.host} · every window, thread and chip of {props.name}</p>
        </div>
        <Close label={`close ${props.name}'s colour`} onClick={() => void leave(null)} />
      </header>

      {/* the windows in words are the note's; these show them */}
      <div class="cs-preview" aria-hidden="true">
        <div class="cs-win cs-own plane-window" style={colourStyle(shown())}>
          <div class="cs-win-hd">
            <RepoMark host={props.host} root={props.root} name={props.name} colour={shown()} size={18} />
            <span class="cs-win-name">{props.name}</span>
            <Show when={own().chip}>{(chip) => <span class="cs-win-chip" data-lit={own().ask ? "" : undefined}>{chip()}</span>}</Show>
          </div>
          <b class="cs-win-title">{own().title ?? "no threads here yet"}</b>
          <Show when={own().ask}>{(ask) => <span class="cs-win-ask"><span>{ask()}</span><b>answer</b></span>}</Show>
        </div>
        <Show when={neighbours().length > 0}>
          <div class="cs-beside">
            <span class="cs-beside-l">beside your other repos on {props.host}</span>
            <For each={neighbours().slice(0, NEIGHBOUR_WINDOWS)}>{(n) => {
              const mini = () => miniOf(newestIn(n.root));
              return (
                <div class="cs-win plane-window" style={colourStyle(n.colour)}>
                  <div class="cs-win-hd">
                    <RepoMark host={props.host} root={n.root} name={n.name} colour={n.colour} size={16} />
                    <span class="cs-win-name">{n.name}</span>
                  </div>
                  <b class="cs-win-title">{mini().title ?? ""}</b>
                </div>
              );
            }}</For>
          </div>
        </Show>
      </div>

      <div ref={group} class="cs-choices" role="radiogroup" aria-labelledby={titleId} aria-describedby={note() ? noteId : undefined} onKeyDown={onArrows}>
        <button
          type="button"
          class="cs-auto"
          role="radio"
          data-pick="auto"
          aria-checked={pick().kind === "auto" ? "true" : "false"}
          aria-describedby={autoId}
          tabIndex={pick().kind === "auto" ? 0 : -1}
          disabled={sending()}
          onClick={() => setPick({ kind: "auto" })}
        >
          <span class="cs-auto-sw plane-window" style={colourStyle(assignment().auto)} aria-hidden="true"><i /></span>
          <span class="cs-auto-words">
            <b>automatic</b>
            <span id={autoId}>{autoLine(props.name, assignment().auto, assigned())}</span>
          </span>
          <span class="cs-radio" aria-hidden="true" />
        </button>
        <div class="cs-grid">
          <For each={swatches()}>{(s) => (
            <button
              type="button"
              class="cs-sw"
              role="radio"
              data-pick={s.colour.name}
              aria-checked={s.picked ? "true" : "false"}
              aria-label={s.label}
              tabIndex={s.picked ? 0 : -1}
              classList={{ shown: s.shown, picked: s.picked }}
              disabled={sending()}
              onClick={() => setPick({ kind: "chosen", name: s.colour.name })}
            >
              <span class="cs-chip plane-window" style={colourStyle(s.colour)}>
                <i class="cs-dot" />
                <Show when={s.picked}><svg class="cs-tick" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" /></svg></Show>
                <Show when={s.badge}>{(b) => <b class="cs-badge">{b()}</b>}</Show>
              </span>
              <span class="cs-sw-name">{s.colour.name}<Show when={s.auto}><em>auto</em></Show></span>
            </button>
          )}</For>
        </div>
      </div>

      <Show when={note()}>{(line) => <p id={noteId} class="cs-note"><Show when={noteBadge()}>{(b) => <b class="cs-badge inline" aria-hidden="true">{b()}</b>}</Show>{line()}</p>}</Show>
      <Show when={refused()}>{(why) => <p class="cs-refused" role="alert">{why()}</p>}</Show>
      <div class="cs-do">
        <button type="button" class="cs-keep" disabled={sending()} onClick={() => void leave(null)}>{buttons().keep}</button>
        <Show when={buttons().use}>{(label) => <button type="button" class="cs-use" disabled={sending()} onClick={() => void use()}>{label()}</button>}</Show>
      </div>
    </dialog>
  );
}
