/* the terminal pane (docs/design.md, the terminal; docs/terminal.md, the
   wire). it owns three resources and frees all of them when it closes:
   the screen (xterm, loaded on first open), the connection to the relay,
   and a resize observer. everything it shows about the terminal is read
   from the store. */

import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { setTerminalLink, state } from "../../store";
import { createTerminal, killTerminal, refreshTerminals, renameTerminal, resizeTerminal } from "./api";
import { CLOSE, type Ended, TermConnection } from "./connection";
import { createKeyboardInset } from "./keyboard";
import { closeTerminal, openTerminal } from "./navigation";
import type { Screen } from "./screen";
import { labels, place, shown } from "./terminals";
import type { PtyInfo, TerminalRef } from "./types";
import type { Effect } from "./wire";

/** a resize is sent once the size has held this long, so a keyboard sliding up is one call, not twenty */
const RESIZE_SETTLE_MS = 150;
/** the link may be down this long before the head says so (design.md, honesty) */
const QUIET_DOWN_MS = 5000;

/** the keys a touch keyboard lacks, in the order a shell needs them */
const KEYS: readonly { label: string; name: string; send: (app: boolean) => string }[] = [
  { label: "esc", name: "escape", send: () => "\x1b" },
  { label: "tab", name: "tab", send: () => "\t" },
  { label: "⌃c", name: "interrupt", send: () => "\x03" },
  { label: "←", name: "arrow left", send: (app) => (app ? "\x1bOD" : "\x1b[D") },
  { label: "↑", name: "arrow up", send: (app) => (app ? "\x1bOA" : "\x1b[A") },
  { label: "↓", name: "arrow down", send: (app) => (app ? "\x1bOB" : "\x1b[B") },
  { label: "→", name: "arrow right", send: (app) => (app ? "\x1bOC" : "\x1b[C") },
];

/** a letter typed while ctrl is latched, as the control character it names */
function control(data: string): string {
  const code = data.toUpperCase().charCodeAt(0);
  return data.length === 1 && code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : data;
}

function endedText(ended: Ended): string {
  switch (ended.code) {
    case CLOSE.exited:
      return "the shell exited.";
    case CLOSE.gone:
      return "this terminal is gone. its host no longer has it.";
    case CLOSE.refused:
      return "the host refused boxbox's credential. check its password in boxbox.toml.";
    default:
      return ended.reason || "the terminal closed.";
  }
}

export function TerminalPane(props: { terminal: TerminalRef }) {
  const { host, id } = props.terminal;
  // the last the host said about it: a terminal that ends leaves the host's list, and its pane still names it (scars.md, line 1912)
  const info = createMemo<PtyInfo | undefined>((last) => (state.terminals.byHost[host] ?? []).find((p) => p.id === id) ?? last);
  const title = () => labels(shown(host)).get(id) ?? info()?.title ?? "terminal";
  // three ways, because each lies somewhere (scars.md, line 1864): an ipad with a trackpad reports a fine primary pointer
  const touch = matchMedia("(pointer: coarse)").matches || matchMedia("(any-pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  const inset = createKeyboardInset();

  const [size, setSize] = createSignal<{ cols: number; rows: number } | null>(null);
  const [ctrl, setCtrl] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  const [confirmKill, setConfirmKill] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [quietDown, setQuietDown] = createSignal(false);
  const [ready, setReady] = createSignal(false);

  let pane: HTMLElement | undefined;
  let bed: HTMLDivElement | undefined;
  let screen: Screen | undefined;
  let connection: TermConnection | undefined;
  let observer: ResizeObserver | undefined;
  let fitFrame: number | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let downTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** replayed output being parsed: the emulator's answers to its old queries are dropped, not typed into the shell */
  let muted = 0;

  const sendSize = () => {
    const now = screen?.size();
    if (now) void resizeTerminal(host, id, now.cols, now.rows);
  };

  const fitNow = () => {
    fitFrame = undefined;
    const next = screen?.fit();
    if (!next) return;
    setSize(next);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendSize, RESIZE_SETTLE_MS);
  };
  const scheduleFit = () => {
    fitFrame ??= requestAnimationFrame(fitNow);
  };

  const apply = (effects: Effect[]) => {
    for (const effect of effects) {
      switch (effect.type) {
        case "write":
          if (effect.replay) {
            muted++;
            screen?.write(effect.text, () => muted--);
          } else screen?.write(effect.text);
          break;
        case "reset":
          screen?.reset();
          break;
        case "note":
          screen?.note(effect.text);
          break;
        case "live":
          // the terminal takes the size of the screen in front of you
          sendSize();
          break;
        default:
          effect satisfies never;
      }
    }
    pane?.setAttribute("data-cursor", String(connection?.cursor ?? ""));
  };

  const type = (data: string) => {
    if (muted > 0) return;
    let text = data;
    if (ctrl()) {
      text = control(data);
      setCtrl(false);
    }
    connection?.send(text);
  };

  onMount(async () => {
    const { openScreen } = await import("./screen");
    if (closed || !bed) return;
    const opened = await openScreen(bed, `terminal ${title()}`);
    if (closed) {
      opened.dispose();
      return;
    }
    screen = opened;
    setReady(true);
    screen.onInput(type);
    fitNow();
    setSize(screen.size());
    connection = new TermConnection(host, id, {
      effects: apply,
      link: (next, detail) => setTerminalLink(next, detail),
      ended: (ended) => {
        screen?.seal();
        setTerminalLink("ended", endedText(ended));
        void refreshTerminals(host);
      },
    });
    observer = new ResizeObserver(scheduleFit);
    observer.observe(bed);
    // a finger gets the keyboard when it taps the screen; a pointer can type at once
    if (!touch) screen.focus();
  });

  onCleanup(() => {
    closed = true;
    observer?.disconnect();
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
    clearTimeout(resizeTimer);
    clearTimeout(downTimer);
    connection?.dispose();
    screen?.dispose();
  });

  // xterm names its input once; the name follows a rename
  createEffect(() => {
    if (ready()) bed?.querySelector("textarea")?.setAttribute("aria-label", `type into terminal ${title()}`);
  });

  createEffect(
    on(
      () => state.terminals.link.state,
      (link) => {
        clearTimeout(downTimer);
        setQuietDown(false);
        if (link === "down") downTimer = setTimeout(() => setQuietDown(true), QUIET_DOWN_MS);
      },
    ),
  );

  const linkLine = () => {
    const link = state.terminals.link;
    if (link.state === "ended") return "ended";
    if (link.state === "down" && quietDown()) return link.detail ?? "not connected. trying again";
    return null;
  };

  const rename = async (event: SubmitEvent) => {
    event.preventDefault();
    const field = (event.currentTarget as HTMLFormElement).elements.namedItem("title");
    const next = field instanceof HTMLInputElement ? field.value.trim() : "";
    setRenaming(false);
    if (!next || next === info()?.title) return;
    const result = await renameTerminal(host, id, next);
    setProblem(result.ok ? null : result.problem);
    void refreshTerminals(host);
  };

  const kill = async () => {
    setConfirmKill(false);
    const result = await killTerminal(host, id);
    setProblem(result.ok ? null : result.problem);
    void refreshTerminals(host);
  };

  const again = async () => {
    const cwd = info()?.cwd;
    const result = await createTerminal(host, { title: info()?.title ?? "shell", ...(cwd ? { cwd } : {}) });
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    void refreshTerminals(host);
    openTerminal({ host, id: result.value.id });
  };

  const press = (send: (app: boolean) => string) => {
    connection?.send(send(screen?.applicationCursor() ?? false));
  };

  return (
    <section
      ref={pane}
      class="term"
      aria-label={`terminal ${title()}`}
      data-link={state.terminals.link.state}
      data-size={size() ? `${size()?.cols}x${size()?.rows}` : undefined}
      style={{ "--keyboard": `${inset()}px` }}
      onKeyDown={(event) => {
        // esc belongs to the shell while the screen has focus; elsewhere in the pane it closes it
        if (event.key === "Escape" && !(event.target instanceof HTMLTextAreaElement) && !renaming()) closeTerminal();
      }}
    >
      <header class="term-head">
        <button class="term-back" type="button" aria-label="close the terminal" onClick={closeTerminal}>
          ‹
        </button>
        <div class="term-titles">
          <Show
            when={renaming()}
            fallback={
              <button class="term-title" type="button" aria-label={`rename terminal ${title()}`} onClick={() => setRenaming(true)}>
                {title()}
              </button>
            }
          >
            <form class="term-rename" onSubmit={(event) => void rename(event)}>
              <input
                name="title"
                aria-label="terminal name"
                value={info()?.title ?? ""}
                maxLength={80}
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                ref={(field) =>
                  queueMicrotask(() => {
                    field.focus();
                    field.select();
                  })
                }
                onBlur={() => setRenaming(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRenaming(false);
                }}
              />
            </form>
          </Show>
          <p class="term-meta">
            {host} · {info() ? place(info()?.cwd ?? "") : "…"}
            <Show when={size()}>
              {(now) => (
                <>
                  {" · "}
                  {now().cols}×{now().rows}
                </>
              )}
            </Show>
            <Show when={linkLine()}>{(line) => <span class="term-link"> · {line()}</span>}</Show>
          </p>
        </div>
        <Show
          when={confirmKill()}
          fallback={
            <button
              class="quiet term-kill"
              type="button"
              aria-label={`kill terminal ${title()}`}
              disabled={state.terminals.link.state === "ended"}
              onClick={() => setConfirmKill(true)}
            >
              kill
            </button>
          }
        >
          <div class="term-confirm" role="group" aria-label="kill this shell?">
            <button class="term-kill-yes" type="button" aria-label={`yes, kill terminal ${title()}`} onClick={() => void kill()}>
              kill
            </button>
            <button class="quiet" type="button" aria-label="keep the terminal" onClick={() => setConfirmKill(false)}>
              keep
            </button>
          </div>
        </Show>
      </header>
      <Show when={problem()}>
        {(text) => (
          <p class="term-problem" role="alert">
            {text()}
          </p>
        )}
      </Show>
      <div class="term-bed">
        <div ref={bed} class="term-screen" />
        <Show when={state.terminals.link.state === "ended"}>
          <div class="term-plate" role="status">
            <p>{state.terminals.link.detail}</p>
            <div class="term-plate-actions">
              <button class="primary" type="button" aria-label={`new terminal on ${host} here`} onClick={() => void again()}>
                new terminal
              </button>
              <button class="quiet" type="button" aria-label="close the ended terminal" onClick={closeTerminal}>
                close
              </button>
            </div>
          </div>
        </Show>
      </div>
      <Show when={touch}>
        <div class="term-keys" role="toolbar" aria-label="terminal keys">
          <button
            type="button"
            class="term-key"
            aria-label="control"
            aria-pressed={ctrl()}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setCtrl(!ctrl())}
          >
            ctrl
          </button>
          <For each={KEYS}>
            {(key) => (
              <button
                type="button"
                class="term-key"
                aria-label={key.name}
                // the screen keeps focus, so the keyboard stays up
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => press(key.send)}
              >
                {key.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
