/* the ios viewport law (decision 19) for the terminal: the keyboard's
   height counts only while an editable holds focus, read from the visual
   viewport, never guessed. the pane stands on it, so the keys row sits on
   the keyboard and the grid loses rows instead of hiding under it. */

import { type Accessor, createSignal, onCleanup } from "solid-js";

function editableHasFocus(): boolean {
  const focused = document.activeElement;
  return focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement || (focused instanceof HTMLElement && focused.isContentEditable);
}

/** the keyboard's height in css px while an editable holds focus, else 0. owned by the calling component. */
export function createKeyboardInset(): Accessor<number> {
  const [inset, setInset] = createSignal(0);
  const viewport = window.visualViewport;
  let frame: number | undefined;
  const measure = () => {
    frame = undefined;
    if (!viewport || !editableHasFocus()) {
      setInset(0);
      return;
    }
    setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
  };
  // focus moves after focusout fires, so the measure waits a frame to see where it went
  const schedule = () => {
    frame ??= requestAnimationFrame(measure);
  };
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    document.removeEventListener("focusin", schedule);
    document.removeEventListener("focusout", schedule);
  });
  return inset;
}
