/* when a mounted mark asks again: after the wait its verdict says, and never while the page is hidden. a hidden page
   (a phone in a pocket, a tab behind another) makes no request of its own: the ask waits for the page to be shown and
   is made then, if it is still due (ensureRepoIcon decides that). the timer and the listener belong to the mark, and the
   returned cancel clears both. */

/** the part of the document this needs (a Document is one), so a test can stand in for it */
export type Visibility = {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export function askWhenDue(wait: number, ask: () => void, page: Visibility): () => void {
  let due = false;
  const shown = () => {
    if (!due || page.hidden) return;
    due = false;
    ask();
  };
  const timer = setTimeout(() => {
    due = true;
    shown();
  }, wait);
  page.addEventListener("visibilitychange", shown);
  return () => {
    clearTimeout(timer);
    page.removeEventListener("visibilitychange", shown);
  };
}
