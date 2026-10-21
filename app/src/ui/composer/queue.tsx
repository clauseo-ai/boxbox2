/* the queue folded into one strip above the window (docs/composer.md, sending; decision 23 of the ios app): what is on its
   way never covers the thread. the strip shows the message that matters first (one that did not go, else the first in
   line) with its label and when it goes ("steer, at its next step"), how many wait behind it as "+N", and the edges of
   the ones behind peeking over its top, as a stack of notifications does. its own verbs are at hand: the cross takes a
   waiting message back (retry and edit on one that did not go), a swipe left does too, a long press or a right click offers
   every verb, and a wide screen shows steer now and run now on the strip itself. a tap opens every message with its
   verbs in a list that floats over the thread, as the plus menu does, so nothing under it moves.

   the strip keeps one height whatever waits (52 px, and the edges' room above it), so a second message moves nothing. */

import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { play } from "../../motion/animate";
import { ROLL_IN, SNAP } from "../../motion/springs";
import { QueueList, QueueVerbs, warmOn, whenLoaded } from "../later";
import { Icon } from "./icons";
import { type Agent, type Card, cardVerbs, cardWhen, cardWords, leadOf, stripName, swipeUnsends, UNSEND_AT } from "./words";

/** a message on its way, as the strip and its list show it */
/** `photos` counts the photos and files on the message together, `files` the files among them */
export type QueueItem = { id: string; text: string; card: Card; photos: number; files?: number };

export type QueueVerb = "retry" | "edit" | "editWaiting" | "steerNow" | "runNow" | "unsend";

export type QueueProps = {
  items: readonly QueueItem[];
  agent: Agent;
  /** the draft holds nothing: a waiting message can be edited (taken back into it) */
  draftEmpty: boolean;
  /** the ones being taken back: faded, their cross off, until the daemon answers */
  unsending: ReadonlySet<string>;
  onVerb: (verb: QueueVerb, id: string) => void;
  /** the element a message is drawn in, for the flight into the thread when it lands; returns its undoing */
  register: (id: string, el: HTMLElement) => () => void;
  /** a card that arrives now is a send, not a replay: it settles in */
  live: () => boolean;
};

/** a press held this long on a touch screen offers every verb */
const LONG_PRESS_MS = 480;
/** a finger that moves this far is a swipe or a scroll, not a press */
const SLOP = 8;

/** the screen is wide enough for steer now and run now on the strip itself (the composer's own breakpoint) */
function useWide(): () => boolean {
  const query = matchMedia("(min-width: 700px)");
  const [wide, setWide] = createSignal(query.matches);
  const change = () => setWide(query.matches);
  query.addEventListener("change", change);
  onCleanup(() => query.removeEventListener("change", change));
  return wide;
}

/** what each verb is called for a screen reader, with the message it acts on */
export function verbName(verb: QueueVerb, item: QueueItem): string {
  switch (verb) {
    case "retry":
      return `retry: ${item.text}`;
    case "edit":
    case "editWaiting":
      return `back to the draft: ${item.text}`;
    case "steerNow":
      return `steer now: ${item.text}`;
    case "runNow":
      return item.card.state === "steer" ? `stop the turn and run now: ${item.text}` : "stop the turn and run the queue now";
    case "unsend":
      return `unsend: ${item.text}`;
    default:
      return verb satisfies never;
  }
}

const counted = (n: number, one: string) => (n ? [`${n} ${one}${n === 1 ? "" : "s"}`] : []);
export const withPhotos = (item: QueueItem) => {
  const files = item.files ?? 0;
  const said = [...counted(item.photos - files, "photo"), ...counted(files, "file")];
  return said.length ? `${item.text}, ${said.join(", ")}` : item.text;
};

export function QueueStrip(props: QueueProps) {
  const wide = useWide();
  const lead = createMemo(() => {
    const at = leadOf(props.items);
    return at < 0 ? null : (props.items[at] ?? null);
  });
  const behind = () => Math.max(0, props.items.length - 1);
  const [open, setOpen] = createSignal<"list" | "verbs" | null>(null);
  let root: HTMLDivElement | undefined;
  let strip: HTMLDivElement | undefined;
  let face: HTMLButtonElement | undefined;
  let faceText: HTMLSpanElement | undefined;

  // the list closes by itself once nothing is left on its way
  createEffect(() => {
    if (!lead()) setOpen(null);
  });

  /* the strip is the lead message's element while it leads: it is what flies into the thread when that one lands */
  createEffect(
    on(
      () => lead()?.id,
      (id) => {
        if (!id || !strip) return;
        onCleanup(props.register(id, strip));
      },
    ),
  );
  /* another message taking the lead rolls in, as the live line's new row does; the same one changing state changes in place */
  createEffect(
    on(
      () => lead()?.id,
      (id, before) => {
        if (!faceText || !id || !before || id === before) return;
        play(faceText, [{ transform: "translateY(40%)", opacity: 0 }, { transform: "none", opacity: 1 }], ROLL_IN, { live: props.live() });
      },
      { defer: true },
    ),
  );

  /* —— closing: escape, or a press anywhere outside; focus that was inside comes back to the strip —— */
  const close = () => {
    const inside = root?.contains(document.activeElement) ?? false;
    setOpen(null);
    if (inside) face?.focus({ preventScroll: true });
  };
  createEffect(() => {
    if (!open()) return;
    const outside = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    });
  });

  const act = (verb: QueueVerb, id: string) => {
    // a verb that takes the message into the draft hands the words the focus; the rest leave it on the strip
    if (verb === "edit" || verb === "editWaiting") setOpen(null);
    else if (open() === "verbs") close();
    props.onVerb(verb, id);
  };

  /* —— the finger: a swipe left unsends, a long press offers every verb. the strip follows the finger by transform alone —— */
  let press: { id: number; x: number; y: number; t: number; dx: number; v: number; swiping: boolean; held: boolean } | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let swallowClick = false;
  onCleanup(() => clearTimeout(pressTimer));
  const canSwipe = () => {
    const now = lead();
    return Boolean(now && cardVerbs(now.card, props.agent).unsend);
  };
  const [offset, setOffset] = createSignal(0);
  const warmList = warmOn("QueueList");
  const warmVerbs = warmOn("QueueVerbs");
  /* the verbs menu's chunk (ui/later.ts) is in unless the press beat the warming; then it opens when it lands, if the
     strip is still there */
  const openVerbs = () => whenLoaded("QueueVerbs", () => lead() && setOpen("verbs"));
  const onPointerDown = (event: PointerEvent) => {
    warmList();
    warmVerbs();
    if (event.button !== 0 || (event.target as Element).closest(".cz-strip-keys")) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, dx: 0, v: 0, swiping: false, held: false };
    clearTimeout(pressTimer);
    if (event.pointerType !== "mouse") {
      pressTimer = setTimeout(() => {
        if (!press || press.swiping) return;
        press.held = true;
        openVerbs();
      }, LONG_PRESS_MS);
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!press || press.id !== event.pointerId) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!press.swiping) {
      if (Math.hypot(dx, dy) > SLOP) clearTimeout(pressTimer);
      if (!canSwipe() || press.held || Math.abs(dx) < SLOP || Math.abs(dx) <= Math.abs(dy)) return;
      press.swiping = true;
      strip?.setPointerCapture(event.pointerId);
    }
    const dt = Math.max(1, event.timeStamp - press.t);
    press.v = (dx - press.dx) / dt;
    press.dx = dx;
    press.t = event.timeStamp;
    setOffset(Math.min(0, dx));
  };
  const onPointerEnd = (event: PointerEvent) => {
    clearTimeout(pressTimer);
    if (!press || press.id !== event.pointerId) return;
    const was = press;
    press = null;
    if (was.held) swallowClick = true;
    if (!was.swiping) return;
    swallowClick = true;
    const from = offset();
    const item = lead();
    const gone = event.type === "pointerup" && item && swipeUnsends(from, was.v);
    setOffset(0);
    // it springs back from where the finger left it, either way: an unsent message leaves the strip when the daemon answers
    if (strip) play(strip, [{ transform: `translateX(${from}px)` }, { transform: "none" }], SNAP);
    if (gone && item) props.onVerb("unsend", item.id);
  };
  const onFaceClick = () => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (open() === "list") setOpen(null);
    // the list's chunk (ui/later.ts) is in unless the tap beat the warming; then it opens when it lands, if the strip is still there
    else whenLoaded("QueueList", () => lead() && setOpen("list"));
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    clearTimeout(pressTimer);
    if (press) press.held = true;
    openVerbs();
  };

  /* the verbs menu: arrows walk its rows; it opens with focus on its first row when a keyboard asked for it */
  let verbsEl: HTMLDivElement | undefined;
  createEffect(() => {
    if (open() !== "verbs") return;
    queueMicrotask(() => verbsEl?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true }));
  });
  const onVerbsKey = (event: KeyboardEvent) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step || !verbsEl) return;
    event.preventDefault();
    const rows = [...verbsEl.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    rows[(at + step + rows.length) % rows.length]?.focus({ preventScroll: true });
  };
  /* the list takes focus as it opens, so a keyboard is in it at once and escape is heard */
  let listEl: HTMLDivElement | undefined;
  createEffect(() => {
    if (open() === "list") queueMicrotask(() => listEl?.focus({ preventScroll: true }));
  });

  return (
    <Show when={lead()}>
      {(item) => {
        const words = () => cardWords(item().card, props.agent);
        const when = () => cardWhen(item().card, props.agent);
        const verbs = () => cardVerbs(item().card, props.agent, props.draftEmpty);
        const bad = () => item().card.state === "failed";
        return (
          <div class="cz-queue-strip" ref={root} role="group" aria-label="messages on their way" data-behind={Math.min(2, behind()) || undefined}>
            {/* the strip and its edges are surfaces of the window plane (styles.css), which gives them the repo's palette */}
            <span class="cz-edges" aria-hidden="true">
              <span class="cz-edge plane-window" data-n="1" />
              <span class="cz-edge plane-window" data-n="2" />
            </span>
            <Show when={offset() < 0}>
              <span class="cz-strip-unsend" data-past={offset() <= -UNSEND_AT ? "" : undefined} aria-hidden="true">unsend</span>
            </Show>
            <div
              class="cz-strip plane-window"
              ref={(el) => {
                strip = el;
                play(el, [{ opacity: 0, transform: "translateY(10px) scale(.96)" }, { opacity: 1, transform: "none" }], SNAP, { live: props.live(), fill: "backwards" });
              }}
              data-state={item().card.state}
              data-unsending={props.unsending.has(item().id) ? "" : undefined}
              style={offset() < 0 ? { transform: `translateX(${offset()}px)` } : {}}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onContextMenu={onContextMenu}
            >
              <button class="cz-strip-face" ref={face} type="button" aria-label={stripName(props.items.length, words().label, when(), item().text)} aria-haspopup="dialog" aria-expanded={open() === "list" ? "true" : "false"} onClick={onFaceClick}>
                <span class="cz-strip-words" ref={faceText}>
                  <span class="cz-strip-head">
                    <b>{words().label}</b>
                    <Show when={when()}>{(w) => <span>{w()}</span>}</Show>
                  </span>
                  <span class="cz-strip-text">{bad() ? (item().card.error ?? item().text) : withPhotos(item())}</span>
                </span>
                <Show when={behind() > 0}>
                  <span class="cz-count" aria-hidden="true">+{behind()}</span>
                </Show>
              </button>
              <div class="cz-strip-keys">
                <Show when={verbs().retry}>
                  <button class="cz-pill on" type="button" aria-label={verbName("retry", item())} onClick={() => act("retry", item().id)}>retry</button>
                </Show>
                <Show when={verbs().edit}>
                  <button class="cz-pill" type="button" aria-label={verbName("edit", item())} onClick={() => act("edit", item().id)}>edit</button>
                </Show>
                <Show when={wide() && verbs().steerNow}>
                  <button class="cz-pill" type="button" aria-label={verbName("steerNow", item())} onClick={() => act("steerNow", item().id)}>steer now</button>
                </Show>
                <Show when={wide() && verbs().runNow}>
                  <button class="cz-pill" type="button" aria-label={verbName("runNow", item())} onClick={() => act("runNow", item().id)}>run now</button>
                </Show>
                <Show when={verbs().unsend}>
                  <button class="cz-pill x" type="button" aria-label={verbName("unsend", item())} disabled={props.unsending.has(item().id)} onClick={() => act("unsend", item().id)}>
                    <Icon name="close" />
                  </button>
                </Show>
              </div>
            </div>

            <Show when={open() === "verbs"}>
              <QueueVerbs item={item()} verbs={verbs()} why={words().why} onVerb={act} onKeyDown={onVerbsKey} ref={(el) => (verbsEl = el)} />
            </Show>

            <Show when={open() === "list"}>
              <QueueList items={props.items} agent={props.agent} draftEmpty={props.draftEmpty} unsending={props.unsending} onVerb={act} onClose={close} ref={(el) => (listEl = el)} />
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
