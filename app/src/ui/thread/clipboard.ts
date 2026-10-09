/* one way to put text on the clipboard (docs/thread.md, copy). the async clipboard api is there only on a secure origin,
   and boxbox is often served over a tailnet on plain http, where it is missing or refuses; then the old way
   (a hidden textarea and `execCommand("copy")`) still works in every browser the app runs in. both paths leave the page
   as they found it: the focus, the selection and the scroll are where they were. the browser is reached through a
   small environment so the paths can be tested without one. */

/** the parts of a textarea the fallback touches */
export type Field = {
  value: string;
  readOnly: boolean;
  style: { cssText: string };
  setAttribute(name: string, value: string): void;
  focus(options?: { preventScroll?: boolean }): void;
  select(): void;
  setSelectionRange(start: number, end: number): void;
};

/** what the fallback needs of the page: a field it can put in and take out, the command, and what to put back */
export type Page = {
  field(): Field;
  attach(field: Field): void;
  detach(field: Field): void;
  /** `document.execCommand`; false when the browser refuses */
  command(name: "copy"): boolean;
  /** the element that has focus now, and a way to give it focus back without scrolling */
  focused(): { focus(options?: { preventScroll?: boolean }): void } | null;
  /** the selection as it stands, as a function that puts it back */
  selection(): () => void;
};

export type Env = {
  clipboard?: { writeText(text: string): Promise<void> } | undefined;
  page?: Page | undefined;
};

/** the textarea fallback. it sits fixed at the top left, out of sight and out of the way, at 16 px so ios does not zoom on its focus, and is selected by range because ios ignores `select()` on a readonly field */
export function copyWithField(text: string, page: Page): boolean {
  const restoreFocus = page.focused();
  const restoreSelection = page.selection();
  const field = page.field();
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.setAttribute("tabindex", "-1");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;pointer-events:none";
  page.attach(field);
  let done = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    done = page.command("copy");
  } catch {
    done = false;
  } finally {
    page.detach(field);
    restoreSelection();
    restoreFocus?.focus({ preventScroll: true });
  }
  return done;
}

/** the browser's own environment, read when a copy is asked for and not before */
export function browserEnv(): Env {
  const doc = typeof document === "undefined" ? undefined : document;
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!doc) return { clipboard };
  const page: Page = {
    field: () => doc.createElement("textarea"),
    attach: (f) => { doc.body.append(f as unknown as HTMLTextAreaElement); },
    detach: (f) => { (f as unknown as HTMLTextAreaElement).remove(); },
    command: (name) => doc.execCommand(name),
    focused: () => (doc.activeElement instanceof HTMLElement ? doc.activeElement : null),
    selection: () => {
      const sel = doc.getSelection();
      const ranges = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
      return () => { if (!sel) return; sel.removeAllRanges(); for (const r of ranges) sel.addRange(r); };
    },
  };
  return { clipboard, page };
}

/** copies `text` and says whether it landed. the async api first; when it is missing or refuses (not a secure origin, no permission, a browser that wants the gesture back) the textarea. false only when both failed */
export async function copyText(text: string, env: Env = browserEnv()): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // refused: the fallback may still be allowed
    }
  }
  return env.page ? copyWithField(text, env.page) : false;
}
