/* where focus goes when something on home that held it closes or leaves (a list over the windows, the undo toast): back to
   what opened it while that is still on the page, else the bar's first control, so focus never drops to the body when what
   opened it went with the change (the toast after its undo) or will go with the next flip (the away line once it is seen,
   after "bring all back" or its dismiss) */

type Focusable = { isConnected: boolean; focus: (options?: FocusOptions) => void };

/** focus `back` when it is still on the page and stays there, else the first of the fallback; says which it took. `leaving`
    says `back` is on the page now but goes with the next flip (the away line once it is seen: home takes it away only in a
    reorder's flip and calm, home.tsx), so focus lands where it will still be after that flip */
export function focusBack(back: Focusable | null, fallback: () => Focusable | null, leaving = false): "back" | "bar" | "none" {
  if (back?.isConnected && !leaving) {
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
