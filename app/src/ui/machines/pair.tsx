/* adding a machine by pairing (cmx2-asks a12): run `cmx2 pair` on it and
   paste what it prints. the server trades the one-time token for the
   host's own bearer credential and keeps it; the browser never sees it. a
   paste of the whole output fills the address and the token at once.

   at rest it is the place the next machine goes: a ghost window after the
   others, a hairline on the ground (design.md, the machines; home's empty
   deck). pressed, it opens in its place as a deeper card of the window
   plane, as the new-thread sheet is. */

import { createSignal, Show } from "solid-js";
import { prefersReducedMotion } from "../../motion/animate";
import { pairMachine, readPairOutput } from "./actions";

export function PairMachine() {
  const [open, setOpen] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [token, setToken] = createSignal("");
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [paired, setPaired] = createSignal<string | null>(null);
  let ghost: HTMLButtonElement | undefined;
  let sheet: HTMLFormElement | undefined;
  let address: HTMLInputElement | undefined;

  const onPaste = (event: ClipboardEvent) => {
    const read = readPairOutput(event.clipboardData?.getData("text") ?? "");
    if (!read) return;
    event.preventDefault();
    setUrl(read.url);
    setToken(read.token);
  };

  /* open, the sheet is taller than the ghost and may run past the fold: it is brought into view, since it is what was
     asked for (design.md, motion: no scroll you did not ask for), and the address takes focus */
  const show = () => {
    setPaired(null);
    setOpen(true);
    queueMicrotask(() => {
      sheet?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      address?.focus({ preventScroll: true });
    });
  };

  const close = () => {
    setOpen(false);
    setProblem(null);
    queueMicrotask(() => ghost?.focus({ preventScroll: true }));
  };

  /* esc cancels the sheet, and is the sheet's while a pairing is on its way too, so the shell never takes it as back */
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (!busy()) close();
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setProblem(null);
    const outcome = await pairMachine(url().trim(), token().trim(), name().trim());
    setBusy(false);
    if (!outcome.ok) return setProblem(outcome.error);
    const host = outcome.value;
    setPaired(`paired ${host.name}. cmx2 ${host.version}, contract ${host.contract}${host.contractMatches ? "" : ", boxbox speaks another"}.`);
    setUrl("");
    setToken("");
    setName("");
    setOpen(false);
    // back on the ghost, which now says what was paired
    queueMicrotask(() => ghost?.focus({ preventScroll: true }));
  };

  return (
    <li class="host-add" data-open={open() ? "" : undefined}>
      <Show
        when={open()}
        fallback={
          <>
            <span class="host-add-plus" aria-hidden="true" />
            <button ref={ghost} class="host-add-open" type="button" onClick={show}>
              add a machine
            </button>
            <Show
              when={paired()}
              fallback={
                <p class="host-add-note">
                  run <code>cmx2 pair</code> on it, then paste what it prints.
                </p>
              }
            >
              {(said) => (
                <p class="host-add-note" data-done="" role="status">
                  {said()}
                </p>
              )}
            </Show>
          </>
        }
      >
        <form ref={sheet} class="pair-sheet plane-window" aria-labelledby="pair-title" onSubmit={(e) => void submit(e)} onKeyDown={onKey}>
          <div class="pair-intro">
            <h2 id="pair-title">add a machine</h2>
            <p class="pair-how">
              run <code>cmx2 pair</code> on the machine, then paste what it prints. the token works once, for 10 minutes.
            </p>
          </div>
          <div class="pair-fields">
            <label class="field">
              <span class="field-label">address</span>
              <input
                ref={address}
                type="url"
                inputmode="url"
                autocomplete="off"
                spellcheck={false}
                placeholder="http://machine:4096"
                required
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
                onPaste={onPaste}
              />
            </label>
            <label class="field">
              <span class="field-label">token</span>
              <input
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                required
                value={token()}
                onInput={(e) => setToken(e.currentTarget.value)}
                onPaste={onPaste}
              />
            </label>
            <label class="field">
              <span class="field-label">name, if not from the address</span>
              <input
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                pattern="[a-z0-9\-]{1,32}"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>
          </div>
          <Show when={problem()}>
            {(said) => (
              <p class="problem" role="alert">
                {said()}
              </p>
            )}
          </Show>
          <div class="pair-actions">
            <button class="primary" type="submit" disabled={busy()}>
              {busy() ? "pairing" : "pair"}
            </button>
            <button class="quiet" type="button" disabled={busy()} onClick={close}>
              cancel
            </button>
          </div>
        </form>
      </Show>
    </li>
  );
}
