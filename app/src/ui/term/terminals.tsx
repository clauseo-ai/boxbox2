/* a host's terminals, on its machine window: the ones open there, and
   "new terminal" with the shell picker. the host's list is read when the
   window mounts, while the page is visible and the machine connected every
   5 s (the pace of the machines list), the moment it connects again, and
   after anything this device does to a terminal. */

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { state } from "../../store";
import { createTerminal, refreshShells, refreshTerminals } from "./api";
import { openTerminal } from "./navigation";
import type { PtyInfo, Shell } from "./types";
import "./term.css";

const REFRESH_MS = 5000;
/** the gap between the picker and its menu (term.css, .shell-menu) */
const MENU_GAP = 6;

/** the tail of a path, the part a person recognises: `~/src/api` becomes `api` */
export function place(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? "/";
}

/** names that tell terminals apart: a title shared by several gets its place, then a number */
export function labels(list: readonly PtyInfo[]): Map<string, string> {
  const names = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const pty of list) {
    const shared = list.filter((p) => p.title === pty.title).length > 1;
    const base = shared ? `${pty.title} in ${place(pty.cwd)}` : pty.title;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    names.set(pty.id, n > 1 ? `${base} ${n}` : base);
  }
  return names;
}

/** the next free title for a new terminal running `name`: "bash", then "bash 2" */
function freshTitle(name: string, list: readonly PtyInfo[]): string {
  const taken = new Set(list.map((p) => p.title));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

/** what the list shows: every terminal a person opened, and a session's while it runs */
export function shown(host: string): PtyInfo[] {
  return (state.terminals.byHost[host] ?? []).filter((p) => p.origin === "tui" || p.status === "running");
}

export function HostTerminals(props: { host: string; reachable: boolean }) {
  const [problem, setProblem] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  /* a machine that is not connected is not asked: its window already says why, and the list keeps what it last held */
  const read = async () => {
    if (document.visibilityState !== "visible" || !props.reachable) return;
    const result = await refreshTerminals(props.host);
    setProblem(result.ok ? null : result.problem);
  };
  const onVisibility = () => void read();
  // read when the window mounts and again the moment the machine is back, with its shells if they were never read
  createEffect(
    on(
      () => props.reachable,
      (reachable) => {
        if (!reachable) {
          setProblem(null);
          return;
        }
        void read();
        if ((state.terminals.shells[props.host] ?? []).length === 0) void refreshShells(props.host);
      },
    ),
  );
  onMount(() => {
    timer = setInterval(() => void read(), REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
  });
  onCleanup(() => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  });
  const names = () => labels(shown(props.host));

  return (
    <section class="terminals" aria-label={`terminals on ${props.host}`}>
      {/* the section's name says it to a screen reader; this says it to the eye */}
      <p class="terminals-label" aria-hidden="true">
        terminals
      </p>
      {/* one surface pressed into the window: the open terminals, then the row that makes another */}
      <div class="terminal-well">
        <Show when={shown(props.host).length > 0}>
          <ul class="terminal-list">
            <For each={shown(props.host)}>
              {(pty) => (
                <li>
                  <button
                    class="terminal-row"
                    type="button"
                    aria-label={`open terminal ${names().get(pty.id) ?? pty.title} on ${props.host}`}
                    data-status={pty.status}
                    onClick={() => openTerminal({ host: props.host, id: pty.id })}
                  >
                    <span class="terminal-name">{names().get(pty.id) ?? pty.title}</span>
                    <span class="terminal-meta">
                      {place(pty.cwd)}
                      {pty.origin === "model" ? " · an agent's" : ""}
                      {pty.status === "exited" ? " · ended" : ""}
                    </span>
                    <span class="terminal-go" aria-hidden="true" />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <ShellPicker host={props.host} disabled={!props.reachable} onProblem={setProblem} />
      </div>
      <Show when={problem()}>{(text) => <p class="terminal-problem">{text()}</p>}</Show>
    </section>
  );
}

/** "new terminal": one tap opens the host's own login shell; the picker beside it offers the others */
function ShellPicker(props: { host: string; disabled: boolean; onProblem: (text: string | null) => void }) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  /* the menu opens below the picker; when the screen has more room above it (a machine low on a phone), it opens up and
     is held to the room it has, so it is never cut by the frame's edge or left to be scrolled to */
  const [side, setSide] = createSignal<{ up: boolean; room: number | null }>({ up: false, room: null });
  let menu: HTMLDivElement | undefined;
  let toggle: HTMLButtonElement | undefined;
  const shells = () => state.terminals.shells[props.host] ?? [];

  const start = async (shell: Shell | null) => {
    setOpen(false);
    setBusy(true);
    const list = state.terminals.byHost[props.host] ?? [];
    const name = shell?.name ?? shells()[0]?.name ?? "shell";
    const result = await createTerminal(props.host, { title: freshTitle(name, list), ...(shell ? { shell } : {}) });
    setBusy(false);
    if (!result.ok) {
      props.onProblem(result.problem);
      return;
    }
    props.onProblem(null);
    void refreshTerminals(props.host);
    openTerminal({ host: props.host, id: result.value.id });
  };

  const placeMenu = () => {
    if (!toggle) return;
    const box = toggle.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - MENU_GAP;
    const above = box.top - MENU_GAP;
    const up = menu !== undefined && menu.scrollHeight > below && above > below;
    setSide({ up, room: Math.max(120, (up ? above : below) - MENU_GAP) });
  };

  // the menu's esc is the menu's: prevented, so the shell does not also take it as back (shell.tsx)
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      setOpen(false);
      toggle?.focus();
    }
  };
  const onOutside = (event: PointerEvent) => {
    if (open() && menu && !menu.contains(event.target as Node) && event.target !== toggle) setOpen(false);
  };
  onMount(() => document.addEventListener("pointerdown", onOutside));
  onCleanup(() => document.removeEventListener("pointerdown", onOutside));

  return (
    <div class="shell-picker" onKeyDown={onKey}>
      <button
        class="terminal-new"
        type="button"
        aria-label={`new terminal on ${props.host}`}
        disabled={props.disabled || busy()}
        onClick={() => void start(null)}
      >
        <span class="terminal-plus" aria-hidden="true" />
        new terminal
      </button>
      <button
        ref={toggle}
        class="terminal-shells"
        type="button"
        aria-label={`pick a shell on ${props.host}`}
        aria-haspopup="menu"
        aria-expanded={open()}
        disabled={props.disabled || busy() || shells().length === 0}
        onClick={() => {
          setOpen(!open());
          if (open())
            queueMicrotask(() => {
              placeMenu();
              menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
            });
        }}
      >
        {shells()[0]?.name ?? "shell"}
        <span class="terminal-caret" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div
          ref={menu}
          class="shell-menu"
          data-up={side().up ? "" : undefined}
          style={side().room === null ? undefined : { "--room": `${side().room}px` }}
          role="menu" aria-label={`shells on ${props.host}`}>
          <For each={shells()}>
            {(shell, index) => (
              <button
                type="button"
                role="menuitem"
                aria-label={`open ${shell.name} on ${props.host}`}
                disabled={!shell.acceptable}
                onClick={() => void start(index() === 0 ? null : shell)}
              >
                <span class="shell-name">{shell.name}</span>
                <span class="shell-path">{index() === 0 ? "your login shell" : shell.acceptable ? shell.path : "not installed"}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
