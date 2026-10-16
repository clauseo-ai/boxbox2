/* the live waveform while recording (docs/design.md, motion: the live waveform): one bar per 100 ms of input, its height
   the slice's peak. new bars enter at the right and the strip moves left by `transform`, one step per bar, with no easing;
   each bar is painted to the canvas once, never per frame. under reduced motion the bars are replaced in place instead
   of moving. aria-hidden: the timer says what matters. */

import { createEffect, on, onCleanup, onMount } from "solid-js";

const STEP = 5;
const BAR = 3;
const H = 28;
/** bars the canvas holds before it starts over from the ring */
const ROOM = 240;

export function LiveWave(props: { ring: Uint8Array; bars: () => number }) {
  let box!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let g: CanvasRenderingContext2D | null = null;
  let base = 0;
  let colour = "#fff";
  const still = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;

  const paint = (n: number, x: number) => {
    if (!g) return;
    const v = props.ring[n % props.ring.length] ?? 0;
    const h = Math.max(3, (v / 255) * H);
    g.clearRect(x, 0, STEP, H);
    g.beginPath();
    g.roundRect(x, (H - h) / 2, BAR, h, BAR / 2);
    g.fill();
  };

  /** starts the canvas over with the last bars the ring holds, so the strip carries on seamlessly */
  const restart = (n: number) => {
    if (!g) return;
    g.clearRect(0, 0, ROOM * STEP, H);
    base = Math.max(0, n - props.ring.length);
    for (let k = base; k < n; k++) paint(k, (k - base) * STEP);
  };

  onMount(() => {
    g = canvas.getContext("2d");
    colour = getComputedStyle(box).color;
    canvas.width = ROOM * STEP * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${ROOM * STEP}px`;
    canvas.style.height = `${H}px`;
    g?.scale(dpr, dpr);
    if (g) g.fillStyle = colour;
  });

  createEffect(
    on(props.bars, (n) => {
      if (n === 0) {
        base = 0;
        g?.clearRect(0, 0, ROOM * STEP, H);
        canvas.style.transform = `translateX(${box.clientWidth}px)`;
        return;
      }
      const width = box.clientWidth;
      if (still) {
        // replaced in place: the visible bars painted again from the ring, right aligned, nothing moves
        const shown = Math.min(n, Math.floor(width / STEP), props.ring.length);
        g?.clearRect(0, 0, ROOM * STEP, H);
        for (let k = 0; k < shown; k++) paint(n - shown + k, width - (shown - k) * STEP);
        canvas.style.transform = "none";
        return;
      }
      if (n - base > ROOM) restart(n - 1);
      paint(n - 1, (n - 1 - base) * STEP);
      canvas.style.transform = `translateX(${width - (n - base) * STEP}px)`;
    }),
  );
  onCleanup(() => {
    g = null;
  });

  return (
    <div class="rec-wave" ref={box} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
