/* the form the shell takes: home's arrangement (the deck under 700 wide,
   the rail at 1000 and up in landscape, the strip between; design.md, one
   layout law for three devices), and whether the terminal sits beside the
   machines (1000 wide and up, in either orientation; design.md, the
   terminal). home decides its arrangement by the same rule, so the shell
   and home never disagree about which form is up. */

import { type Accessor, createSignal, onCleanup } from "solid-js";
import { arrangementOf } from "../ui/home/home";
import { type Layout, TERMINAL_BESIDE_WIDTH } from "./routes";

export function layoutOf(width: number, height: number): Layout {
  return { form: arrangementOf(width, height), wide: width >= TERMINAL_BESIDE_WIDTH };
}

/** the layout, following the window's size once a frame; the listener goes with its owner */
export function createLayout(): Accessor<Layout> {
  const [layout, setLayout] = createSignal(layoutOf(innerWidth, innerHeight), { equals: (a, b) => a.form === b.form && a.wide === b.wide });
  let frame: number | undefined;
  const onResize = () => {
    frame ??= requestAnimationFrame(() => {
      frame = undefined;
      setLayout(layoutOf(innerWidth, innerHeight));
    });
  };
  addEventListener("resize", onResize);
  onCleanup(() => {
    removeEventListener("resize", onResize);
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  return layout;
}
