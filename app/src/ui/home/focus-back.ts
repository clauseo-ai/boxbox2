/* where focus goes when something on home that held it closes or leaves (a list over the windows, the undo toast): back to
   what opened it while that is still on the page, else the bar's first control, so focus never drops to the body when what
   opened it went with the change (the away line after "bring all back", the toast after its undo) */

type Focusable = { isConnected: boolean; focus: (options?: FocusOptions) => void };

/** focus `back` when it is still on the page, else the first of the fallback; says which it took */
export function focusBack(back: Focusable | null, fallback: () => Focusable | null): "back" | "bar" | "none" {
  if (back?.isConnected) {
    back.focus({ preventScroll: true });
    return "back";
  }
  const bar = fallback();
  if (!bar) return "none";
  bar.focus({ preventScroll: true });
  return "bar";
}

/** home's bar's first control (home.tsx, `.bar`) */
export function barControl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".home > .bar")?.querySelector<HTMLElement>("button:not([disabled]), a[href], input, [tabindex]:not([tabindex='-1'])") ?? null;
}
