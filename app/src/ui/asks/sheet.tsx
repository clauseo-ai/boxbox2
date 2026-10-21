/* what a thread needs, answered from home (the native app's decision 24): every pending ask of the thread, each the thread's
   own card (asks/card.tsx: its options, its typed answer, pick any, several questions, a permission's replies and deny and
   say why), on the repo's deep window material, with "open the thread" at its foot. it follows the live asks: an answered
   one leaves while the rest stay, and when the last has gone the sheet closes on the card it had.

   on the deck it is a sheet from the foot, where a thumb reaches; on the strip and the rail it is a popover hung from the
   window that asked (below it on the strip, beside it on the rail), so the stage beside it stays in view. a window's tray
   opens it (window.tsx); escape, a press outside it and "open the thread" close it, and focus goes back to the tray. */

import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js";
import { play } from "../../motion/animate";
import { FADE, SHEET } from "../../motion/springs";
import { state } from "../../store";
import type { Ask } from "../../sync/protocol";
import { askActions } from "../thread/asks";
import { RepoMark } from "../repo-mark/repo-mark";
import { needOf, permissionWhat } from "../window/need";
import { colourMap } from "../window/colours";
import { colourStyle } from "../window/repo";
import { windowView } from "../window/view";
import { AskCard, type AskBody, AskContext, PermissionCard, type PermissionBody } from "./card";
import { headerWords, questionsOf } from "./words";
import "./card.css";
import "./sheet.css";

export type AskSheetProps = {
  /** the window whose asks these are */
  windowKey: string;
  /** the window whose tray opened it: the popover hangs from it, and focus goes back to its tray */
  from: HTMLElement;
  arrangement: "deck" | "strip" | "rail";
  onClose: () => void;
  /** "open the thread": the stage opens on it with its ask in front, as the window's own tap does */
  onOpenThread: (key: string, from: HTMLElement, event: Event) => void;
};

/** the popover's width, a phone's column so the cards read as they do in the thread, and its margins from the screen */
const POPOVER_WIDTH = 400;
const MARGIN = 12;
const LEAST = 320;

/** an ask as the card's body: what the thread's rows build from the same request (thread/rows.ts) */
export function bodyOf(ask: Ask): AskBody | PermissionBody {
  if (ask.kind === "permission") {
    const permission = ask.permission?.title ?? "use";
    const patterns = ask.permission?.patterns ?? [];
    return { k: "permission", askID: ask.id, what: permissionWhat(ask), permission, patterns };
  }
  const questions = questionsOf(ask).map((q) => ({ header: q.header, question: q.question, options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })), custom: q.custom, multiple: q.multiple }));
  return { k: "ask", askID: ask.id, questions, dismissed: false, pending: true };
}

export function AskSheet(props: AskSheetProps) {
  let sheetEl: HTMLDivElement | undefined;
  let scrimEl: HTMLDivElement | undefined;
  const entry = () => state.fleet.threads[props.windowKey];
  const live = createMemo(() => Object.values(state.fleet.asks).filter((a) => a.key === props.windowKey));
  /* the asks the sheet shows: the live ones, and while the last leaves, the ones it had, so it closes on its card */
  let kept: Ask[] = [];
  const asks = createMemo(() => {
    const now = live();
    if (now.length) kept = now;
    return now.length ? now : kept;
  });
  /* the cards are kept by the ask's id: a fleet beat that hands over a new object for the same ask keeps what is typed */
  const ids = createMemo(() => asks().map((a) => a.id), [], { equals: (a, b) => a.join("|") === b.join("|") });
  const askOf = (id: string) => asks().find((a) => a.id === id);
  const view = createMemo(() => {
    const e = entry();
    return e ? windowView(e, asks(), colourMap()) : null;
  });
  const need = createMemo(() => needOf(asks()));
  const actions = askActions(() => entry()?.agent ?? asks()[0]?.agent ?? "");
  const deck = () => props.arrangement === "deck";

  /* the popover's place, measured once as it opens: under the window on the strip, beside it on the rail */
  const place = (): Record<string, string> => {
    if (deck()) return {};
    const box = props.from.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(POPOVER_WIDTH, vw - 2 * MARGIN);
    if (props.arrangement === "strip") {
      const top = Math.min(box.bottom + 10, vh - MARGIN - LEAST);
      const left = Math.max(MARGIN, Math.min(box.left, vw - MARGIN - width));
      return { top: `${top}px`, left: `${left}px`, width: `${width}px`, "max-height": `${vh - top - MARGIN}px` };
    }
    const top = Math.max(MARGIN, Math.min(box.top, vh - MARGIN - LEAST));
    const left = Math.min(box.right + 12, vw - MARGIN - width);
    return { top: `${top}px`, left: `${left}px`, width: `${width}px`, "max-height": `${vh - top - MARGIN}px` };
  };
  const placed = place();

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const out = sheetEl && play(sheetEl, deck() ? [{ transform: "none" }, { transform: "translateY(110%)" }] : [{ opacity: 1 }, { opacity: 0, transform: "scale(.97)" }], deck() ? SHEET : FADE, { fill: "forwards" });
    if (scrimEl) play(scrimEl, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
    await out?.finished.catch(() => undefined);
    // home under the sheet is inert until it closes: the focus goes back to the tray once it is not
    const back = props.from.querySelector<HTMLElement>(".wask") ?? props.from;
    props.onClose();
    queueMicrotask(() => back.isConnected && back.focus({ preventScroll: true }));
  };
  // the last ask answered or gone: the sheet closes on the card it had
  let had = false;
  createEffect(() => {
    if (live().length > 0) had = true;
    else if (had) void close();
  });

  onMount(() => {
    if (sheetEl) play(sheetEl, deck() ? [{ transform: "translateY(110%)" }, { transform: "none" }] : [{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }], deck() ? SHEET : FADE);
    if (scrimEl) play(scrimEl, [{ opacity: 0 }, { opacity: 1 }], FADE);
    // the first card takes the focus, so a keyboard answers it at once (its 1 to 9 keys)
    queueMicrotask(() => (sheetEl?.querySelector<HTMLElement>(".ask-card") ?? sheetEl)?.focus({ preventScroll: true }));
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    void close();
  };
  document.addEventListener("keydown", onKey, true);
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  return (
    <>
      <div class="asks-scrim" data-deck={deck() ? "" : undefined} ref={scrimEl} onClick={() => void close()} />
      <div
        ref={sheetEl}
        class="asks-sheet plane-window"
        data-arrangement={props.arrangement}
        role="dialog"
        aria-modal="true"
        aria-label={`answer ${view()?.repo ?? "the thread"}`}
        tabIndex={-1}
        style={{ ...(view() ? colourStyle((view() as NonNullable<ReturnType<typeof view>>).colour) : {}), ...placed }}
      >
        <Show when={view()}>
          {(v) => (
            <div class="asks-head">
              <RepoMark host={v().host} root={v().root} name={v().repo} colour={v().colour} size={22} />
              <b>{v().repo}</b>
              <span>{v().title}</span>
            </div>
          )}
        </Show>
        <Show when={asks().length > 1 && need()}>{(n) => <h2 class="asks-line">{n().line}</h2>}</Show>
        <AskContext.Provider value={actions}>
          <For each={ids()}>
            {(id) => (
              <Show when={askOf(id)}>
                {(ask) => {
                  const body = createMemo(() => bodyOf(ask()));
                  const single = () => ask().kind === "permission" || questionsOf(ask()).length <= 1;
                  return (
                    <section class="asks-one" aria-label={ask().kind === "permission" ? "permission" : "question"}>
                      <Show when={single()}>
                        <Show when={headerWords(ask())}>{(h) => <p class="asks-h">{h()}</p>}</Show>
                        <Show when={ask().kind !== "permission"}>
                          <p class="asks-q">{questionsOf(ask())[0]?.question || "the agent has a question"}</p>
                        </Show>
                      </Show>
                      {/* the card is made once per ask and follows its body, so what is typed or picked stays */}
                      <Show when={ask().kind === "permission"} fallback={<AskCard b={body() as AskBody} />}>
                        <PermissionCard b={body() as PermissionBody} />
                      </Show>
                    </section>
                  );
                }}
              </Show>
            )}
          </For>
        </AskContext.Provider>
        <button
          type="button"
          class="asks-open"
          aria-description="opens the thread at its question"
          onClick={(event) => {
            props.onOpenThread(props.windowKey, props.from, event);
            void close();
          }}
        >
          open the thread
        </button>
      </div>
    </>
  );
}
