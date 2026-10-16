/* the viewer (docs/thread.md, pictures and files: the viewer; design.md, motion: the media viewer): every image of the
   thread the window holds, in order, the pressed one in view. it fits the image; pinch, a wheel with ctrl, double tap and
   `+` `-` zoom to 4x about the point; a pan moves a zoomed image; a sideways swipe at fit steps to the next or previous;
   a swipe down at fit closes it. its header holds the name, "2 of 5", save, share (where the browser shares files), and
   close. escape, close and a press outside the image close it, and focus goes back to the card that opened it.

   only the image in view and its two neighbours are mounted at full size (design.md, buttery: images). */

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../composer/icons";
import { isHashName, timeOf } from "../words";
import "./media.css";

export type ViewerImage = { id: string; src: string; filename?: string; alt?: string; at: number; width?: number; height?: number };

export type ViewerProps = {
  images: readonly ViewerImage[];
  start: number;
  agent: string;
  /** the card that opened it: the viewer grows from its rect and focus returns to it */
  from?: HTMLElement;
  onClose: () => void;
};

const MAX_ZOOM = 4;

/** what the viewer calls an image: its name, or "image from <name>, 11:34" */
export const viewerTitle = (img: ViewerImage, agent: string): string => (img.filename && !isHashName(img.filename) ? img.filename : `image from ${agent}, ${timeOf(img.at)}`);

export function Viewer(props: ViewerProps) {
  const [index, setIndex] = createSignal(Math.max(0, Math.min(props.start, props.images.length - 1)));
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  /** a gesture at fit: sideways it steps, down it closes; followed 1:1 */
  const [drag, setDrag] = createSignal({ x: 0, y: 0 });
  const img = () => props.images[index()];
  const title = () => {
    const i = img();
    return i ? viewerTitle(i, props.agent) : "";
  };
  const count = () => `${index() + 1} of ${props.images.length}`;
  const canShare = createMemo(() => typeof navigator !== "undefined" && typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([], "x.png", { type: "image/png" })] }));
  let root!: HTMLDivElement;
  let stage!: HTMLDivElement;

  const fit = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const go = (step: number) => {
    const next = index() + step;
    if (next < 0 || next >= props.images.length) return;
    fit();
    setIndex(next);
  };
  /** zooms to `to` about a point of the stage (its centre by default), so the point under the finger stays put */
  const zoomTo = (to: number, at?: { x: number; y: number }) => {
    const z = Math.max(1, Math.min(MAX_ZOOM, to));
    const box = stage.getBoundingClientRect();
    const px = (at?.x ?? box.left + box.width / 2) - (box.left + box.width / 2);
    const py = (at?.y ?? box.top + box.height / 2) - (box.top + box.height / 2);
    const k = z / zoom();
    const p = pan();
    setPan(z === 1 ? { x: 0, y: 0 } : { x: px - (px - p.x) * k, y: py - (py - p.y) * k });
    setZoom(z);
  };

  const close = () => {
    const done = () => {
      props.onClose();
      props.from?.focus();
    };
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const a = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 120 : 180, easing: "ease-in" });
    a.onfinish = done;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return e.preventDefault(), close();
    if (e.key === "ArrowRight") return e.preventDefault(), go(1);
    if (e.key === "ArrowLeft") return e.preventDefault(), go(-1);
    if (e.key === "+" || e.key === "=") return e.preventDefault(), zoomTo(zoom() * 1.5);
    if (e.key === "-") return e.preventDefault(), zoomTo(zoom() / 1.5);
    if (e.key === "0") return e.preventDefault(), fit();
    if (e.key === "Tab") trap(e);
  };
  /** focus stays inside the dialog while it is open */
  const trap = (e: KeyboardEvent) => {
    const f = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")];
    const first = f[0];
    const last = f.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  };

  /* —— pointers: one finger pans (zoomed) or swipes (at fit); two pinch; a double tap zooms or fits —— */
  const pts = new Map<number, { x: number; y: number }>();
  let start: { x: number; y: number; pan: { x: number; y: number }; zoom: number; dist: number; mid: { x: number; y: number } } | null = null;
  let lastTap = 0;
  let moved = false;
  const dist = () => {
    const [a, b] = [...pts.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const mid = () => {
    const [a, b] = [...pts.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : (a ?? { x: 0, y: 0 });
  };
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    start = { x: e.clientX, y: e.clientY, pan: pan(), zoom: zoom(), dist: dist(), mid: mid() };
  };
  const onMove = (e: PointerEvent) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > 6) moved = true;
    if (pts.size === 2 && start.dist > 0) {
      zoomTo((start.zoom * dist()) / start.dist, mid());
      return;
    }
    if (zoom() > 1) setPan({ x: start.pan.x + dx, y: start.pan.y + dy });
    else setDrag(Math.abs(dx) > Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: Math.max(0, dy) });
  };
  const onUp = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pts.size > 0) {
      start = { x: [...pts.values()][0]?.x ?? 0, y: [...pts.values()][0]?.y ?? 0, pan: pan(), zoom: zoom(), dist: 0, mid: mid() };
      return;
    }
    const d = drag();
    setDrag({ x: 0, y: 0 });
    const h = stage.clientHeight;
    const w = stage.clientWidth;
    if (zoom() === 1 && d.y > h * 0.28) return close();
    if (zoom() === 1 && Math.abs(d.x) > w * 0.2) return go(d.x < 0 ? 1 : -1);
    if (!moved) {
      const now = performance.now();
      if (now - lastTap < 300) {
        zoom() > 1 ? fit() : zoomTo(2.5, { x: e.clientX, y: e.clientY });
        lastTap = 0;
        return;
      }
      lastTap = now;
      // a press outside the image closes it
      if (!(e.target as HTMLElement).closest("img")) setTimeout(() => lastTap !== 0 && performance.now() - lastTap >= 290 && close(), 300);
    }
    start = null;
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomTo(zoom() * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX, y: e.clientY });
  };

  onMount(() => {
    document.addEventListener("keydown", onKey);
    root.querySelector<HTMLElement>(".viewer-close")?.focus();
    // it grows from the card's rect (the sheet spring); under reduced motion it fades
    const from = props.from?.getBoundingClientRect();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const page = stage.querySelector<HTMLElement>(".viewer-page[data-current] img");
    if (from && page && !reduce) {
      const to = page.getBoundingClientRect();
      if (to.width > 0) {
        const s = from.width / to.width;
        page.animate([{ transform: `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(${s})` }, { transform: "none" }], { duration: 360, easing: "cubic-bezier(0.2, 0.9, 0.1, 1)" });
      }
    }
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 120 : 200, easing: "ease-out" });
  });
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const save = () => {
    const i = img();
    if (!i) return;
    const a = document.createElement("a");
    a.href = i.src;
    a.download = i.filename ?? `image-${timeOf(i.at).replace(":", "")}.png`;
    a.click();
  };
  const share = async () => {
    const i = img();
    if (!i) return;
    try {
      const blob = await (await fetch(i.src)).blob();
      await navigator.share({ files: [new File([blob], i.filename ?? "image.png", { type: blob.type })] });
    } catch {
      // the person closed the sheet, or the browser refused: nothing to say
    }
  };

  return (
    <Portal>
      <div class="viewer" ref={root} role="dialog" aria-modal="true" aria-label={`image ${title()}, ${count()}`}>
        <header class="viewer-h">
          <span class="viewer-title">
            <b>{title()}</b>
            <span>{count()}</span>
          </span>
          <span class="viewer-acts">
            <button type="button" aria-label="zoom out" disabled={zoom() <= 1} onClick={() => zoomTo(zoom() / 1.5)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM16 16l4.5 4.5M8 11h6" /></svg>
            </button>
            <button type="button" aria-label="zoom in" disabled={zoom() >= MAX_ZOOM} onClick={() => zoomTo(zoom() * 1.5)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM16 16l4.5 4.5M8 11h6M11 8v6" /></svg>
            </button>
            <button type="button" aria-label="fit the image" disabled={zoom() === 1} onClick={fit}>
              <Icon name="expand" />
            </button>
            <button type="button" aria-label={`save image ${title()}`} onClick={save}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></svg>
            </button>
            <Show when={canShare()}>
              <button type="button" aria-label={`share image ${title()}`} onClick={() => void share()}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 7.5 12 3.5l4 4M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1" /></svg>
              </button>
            </Show>
            <button type="button" class="viewer-close" aria-label={`close image ${title()}`} onClick={close}>
              <Icon name="close" />
            </button>
          </span>
        </header>
        <div class="viewer-stage" ref={stage} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel} style={{ opacity: String(1 - Math.min(0.6, drag().y / 600)) }}>
          <For each={props.images}>
            {(image, i) => (
              <Show when={Math.abs(i() - index()) <= 1}>
                <div class="viewer-page" data-current={i() === index() ? "" : undefined} style={{ transform: `translateX(calc(${(i() - index()) * 100}% + ${drag().x}px)) translateY(${i() === index() ? drag().y : 0}px)` }} aria-hidden={i() === index() ? undefined : "true"}>
                  <img
                    src={image.src}
                    alt={image.alt ?? ""}
                    draggable={false}
                    decoding="async"
                    style={i() === index() ? { transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})` } : {}}
                  />
                </div>
              </Show>
            )}
          </For>
          <Show when={props.images.length > 1}>
            <button type="button" class="viewer-step" data-side="prev" aria-label="previous image" disabled={index() === 0} onClick={() => go(-1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
            </button>
            <button type="button" class="viewer-step" data-side="next" aria-label="next image" disabled={index() === props.images.length - 1} onClick={() => go(1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
