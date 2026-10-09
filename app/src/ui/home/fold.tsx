/* the folded rail (design.md, one layout law: the rail is the switcher and the watch, so folded it is a column of
   swatches and not nothing). top to bottom: the toggle that unfolds it, the new-thread disc, one swatch per window in
   the inbox order, and at the foot history and machines as marks. a swatch is a window folded to its colour: two
   letters of its repo, its state on its corner, and, with a fine pointer, a small card beside it after a moment.
   what a swatch says is decided in swatch.ts; the motion between this and the open rail is edge.ts. */

import { createSignal, For, onCleanup, Show } from "solid-js";
import { colourStyle } from "../window/repo";
import { openSuffix } from "../window/clear";
import { type WindowView, windowName } from "../window/view";
import { RepoMark } from "../repo-mark/repo-mark";
import { markOf, stateWords } from "./swatch";
import "./fold.css";

/** the pointer rests on a swatch this long before its card shows */
const CARD_AFTER_MS = 250;
/** and leaves it this long before the card goes, so crossing the gap to the next swatch keeps it */
const CARD_LINGER_MS = 120;

/** a rounded rectangle with a rule near its left edge: the sidebar the toggle folds, its pane filled while the sidebar is
    open and an outline while it is folded, so the glyph says the state and the toggle never changes colour. the details
    toggle in the stage's bar (app/src/ui/thread/details.tsx) draws its mirror, so the two read as a pair at the stage's
    two edges */
function SidebarGlyph(props: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4.5" width="16" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
      <Show when={props.open}>
        <path class="pane" d="M4 7.5a3 3 0 0 1 3-3h2.5v15H7a3 3 0 0 1-3-3z" />
      </Show>
    </svg>
  );
}

/** the open rail's column of windows (home.tsx), which the toggles disclose */
export const RAIL_WINDOWS = "rail-windows";

/** a disclosure of the windows column, named for what it opens and closes and never for the way it would go: "windows", with
    its state in `aria-expanded` (and in the glyph's filled pane). a button of each, one in the open bar and one in the folded
    column; whichever is not on screen is inert, so the name is on the screen once */
export function FoldToggle(props: { folded: boolean; onToggle: () => void }) {
  return (
    <button
      class="pill icon fold-toggle"
      type="button"
      aria-label="windows"
      aria-expanded={props.folded ? "false" : "true"}
      aria-controls={RAIL_WINDOWS}
      aria-keyshortcuts="["
      onClick={() => props.onToggle()}
    >
      <SidebarGlyph open={!props.folded} />
    </button>
  );
}

const TICK = (
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <path d="M4 11.5l4.5 4.5L18 6.5" />
  </svg>
);
const CROSS = (
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <path d="M6.5 6.5l9 9M15.5 6.5l-9 9" />
  </svg>
);

export type SwatchProps = {
  view: WindowView;
  /** on the stage */
  current: boolean;
  onOpen: (el: HTMLElement, event: Event) => void;
  ref: (el: HTMLElement) => void;
  /** the pointer or the keyboard came to it, and left it: the card beside it follows */
  onLead: (el: HTMLElement, key: string) => void;
  onLag: () => void;
};

function Swatch(props: SwatchProps) {
  const mark = () => markOf(props.view.state);
  return (
    <button
      ref={props.ref}
      class="swatch plane-window"
      type="button"
      style={colourStyle(props.view.colour)}
      data-state={props.view.state}
      data-current={props.current ? "" : undefined}
      aria-label={`${windowName(props.view)}${openSuffix(props.view.key)}`}
      aria-current={props.current ? "true" : undefined}
      onClick={(event) => props.onOpen(event.currentTarget, event)}
      onPointerEnter={(event) => event.pointerType !== "touch" && props.onLead(event.currentTarget, props.view.key)}
      onPointerLeave={() => props.onLag()}
      onFocus={(event) => event.currentTarget.matches(":focus-visible") && props.onLead(event.currentTarget, props.view.key)}
      onBlur={() => props.onLag()}
    >
      <RepoMark host={props.view.host} root={props.view.root} name={props.view.repo} colour={props.view.colour} size={30} bare />
      <Show when={mark()}>
        {(shown) => (
          <span class="sw-mark" data-mark={shown()} aria-hidden="true">
            {shown() === "tick" ? TICK : shown() === "cross" ? CROSS : null}
          </span>
        )}
      </Show>
    </button>
  );
}

export type FoldedRailProps = {
  /** the windows in the inbox order */
  keys: readonly string[];
  viewOf: (key: string) => WindowView | null;
  /** the thread on the stage */
  current: string | null;
  onOpen: (key: string, el: HTMLElement, event: Event) => void;
  onUnfold: () => void;
  /** absent where no new thread can start yet */
  onNew?: (() => void) | undefined;
  onHistory?: (() => void) | undefined;
  onMachines: () => void;
  /** where a keyboard's focus lands again after history or machines (app/src/shell): only on the rail that is on screen */
  returns: boolean;
  /** whether nothing in it can be reached: it is the rail that is not on screen */
  inert: boolean;
  /** the swatch of a window, kept by home so a reorder moves them with the snap spring and a tap pours from them */
  swatchRef: (key: string, el: HTMLElement | null) => void;
  ref: (el: HTMLElement) => void;
};

export function FoldedRail(props: FoldedRailProps) {
  /* the card: one element that follows the swatch the pointer is on. with the pointer already on one, the next shows at
     once; from rest it waits. only a fine pointer has one: a finger has no hover and a long press means something else */
  const [card, setCard] = createSignal<{ key: string; y: number } | null>(null);
  const [shown, setShown] = createSignal(false);
  let wait: ReturnType<typeof setTimeout> | undefined;
  let linger: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(wait);
    clearTimeout(linger);
  });
  const lead = (el: HTMLElement, key: string) => {
    if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    clearTimeout(linger);
    clearTimeout(wait);
    const show = () => {
      const box = el.getBoundingClientRect();
      setCard({ key, y: box.top + box.height / 2 });
      setShown(true);
    };
    if (shown()) show();
    else wait = setTimeout(show, CARD_AFTER_MS);
  };
  const lag = () => {
    clearTimeout(wait);
    clearTimeout(linger);
    linger = setTimeout(() => setShown(false), CARD_LINGER_MS);
  };
  const cardView = () => {
    const at = card();
    return at ? props.viewOf(at.key) : null;
  };

  return (
    <div class="fold" ref={props.ref} role="group" aria-label="threads, folded" inert={props.inert}>
      <FoldToggle folded onToggle={props.onUnfold} />
      <Show when={props.onNew}>
        {(start) => (
          <button class="fold-new" type="button" aria-label="new thread" aria-keyshortcuts="Meta+N" onClick={() => start()()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </Show>
      <ul class="fold-list" aria-label="live threads" onScroll={() => setShown(false)}>
        <For each={props.keys}>
          {(key) => (
            <Show when={props.viewOf(key)}>
              {(view) => (
                <li>
                  <Swatch
                    view={view()}
                    current={props.current === key}
                    onOpen={(el, event) => props.onOpen(key, el, event)}
                    ref={(el) => {
                      props.swatchRef(key, el);
                      onCleanup(() => props.swatchRef(key, null));
                    }}
                    onLead={lead}
                    onLag={lag}
                  />
                </li>
              )}
            </Show>
          )}
        </For>
      </ul>
      <div class="fold-foot">
        <Show when={props.onHistory}>
          {(history) => (
            <button class="pill icon" type="button" aria-label="history" data-opens={props.returns ? "history" : undefined} onClick={() => history()()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.8" />
                <path d="M4.5 4.5v4.3h4.3" />
                <path d="M12 8v4.3l2.7 1.7" />
              </svg>
            </button>
          )}
        </Show>
        <button class="pill icon" type="button" aria-label="machines" data-opens={props.returns ? "machines" : undefined} onClick={() => props.onMachines()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="4.5" width="16" height="6.5" rx="2.2" />
            <rect x="4" y="13" width="16" height="6.5" rx="2.2" />
            <path d="M8 7.75h.01M8 16.25h.01" />
          </svg>
        </button>
      </div>
      <div class="fold-card" data-on={shown() ? "" : undefined} aria-hidden="true" style={{ "--y": `${card()?.y ?? 0}px` }}>
        <Show when={cardView()}>
          {(view) => (
            <div class="fold-card-body" style={colourStyle(view().colour)}>
              <b>
                <RepoMark host={view().host} root={view().root} name={view().repo} colour={view().colour} size={20} />
                {view().repo}
              </b>
              <span>{view().title}</span>
              <small>{stateWords(view())}</small>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
