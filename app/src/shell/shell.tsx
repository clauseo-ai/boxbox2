/* the shell: the one app every surface lives in (docs/architecture.md,
   the frontend: the route table). it owns

   - the launch: the url settled on one route, a push's link taken, the
     screen and the terminal it names put in the store before the first
     frame (the thread is opened by the sync client, which reads the same
     url when it starts);
   - the gate: the sign-in screen, or the app. with a cache from an earlier
     visit the app paints at once, before the server has answered, so a cold
     launch shows the last known state on its first frame and an offline
     one still opens (design.md, honesty); a session the server no longer
     honours closes it again;
   - the surfaces per route: home (the windows, with a thread on its stage),
     the machines, history, settings, and the terminal over or beside the machines;
   - back: each surface's own control, `esc` and the deck's edge swipe all go
     to the route's parent (routes.ts, backOf);
   - what every surface shares, started once: the sync worker, push links,
     notifications, presence, this device's prefs, the service worker and
     `surface.view`. */

import { type Accessor, createEffect, createMemo, lazy, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { play } from "../motion/animate";
import { takeTransitioned } from "../motion/screen";
import { FADE } from "../motion/springs";
import { followWorkerLinks, takeLaunchLink } from "../push/links";
import { startNotifications } from "../push/notifications";
import { reportPresence } from "../push/presence";
import { composeHost, focusable } from "../board/requests";
import { boardCompose, boardFocus, refreshHosts, state } from "../store";
import { emit, forgetSync, startSync } from "../sync/client";
import { Home } from "../ui/home/home";
import { warmLater } from "../ui/later";
import { loadPrefs } from "../ui/settings/actions";
import { SignIn } from "../ui/sign-in";
import { createLayout } from "./form";
import { edgeSwipe } from "./gesture";
import { currentRoute, goBack, navigate, routeFromUrl } from "./navigation";
import { canonicalSearch, type Layout, parentOf, pathOf, type Route, sameRoute, type Surface, surfaceOf } from "./routes";
import { registerServiceWorker, takeWaitingBuild } from "./worker";
import "./shell.css";

/* the first load is what a cold launch paints: the gate, home and a thread on its stage. the machines, history, settings
   and the terminal are split by route and loaded when first asked for (the service worker has them precached, so that is
   a read from disk); the surfaces that open at a press are split in ui/later.ts and warmed once the launch has painted
   and the page is idle */
const loadMachines = () => import("../ui/machines");
const loadHistory = () => import("../ui/history");
const loadSettings = () => import("../ui/settings");
const loadTerminal = () => import("../ui/term/pane");
const Machines = lazy(() => loadMachines().then((module) => ({ default: module.Machines })));
const History = lazy(() => loadHistory().then((module) => ({ default: module.History })));
const Settings = lazy(() => loadSettings().then((module) => ({ default: module.Settings })));
const TerminalPane = lazy(() => loadTerminal().then((module) => ({ default: module.TerminalPane })));
/** after the launch, how long the page waits for an idle moment before warming the press surfaces */
const WARM_AFTER_MS = 2000;

/** the app, started: the launch, then everything every surface shares */
export function Shell() {
  settleUrl();
  takeLaunchLink();
  routeFromUrl();

  // the worker starts with the page, beside the gate check, so the cache paints on the first frame; signing out,
  // or a session the server no longer honours, makes it forget what it cached
  createEffect(on(() => state.gate, (gate) => (gate === "signed-out" ? void forgetSync() : startSync())));
  followWorkerLinks();
  // notifications and this device's appearance need the session: they start each time the gate opens (the boot
  // copy of the appearance painted the first frame)
  createEffect(
    on(
      () => state.gate === "signed-in",
      (signedIn) => {
        if (!signedIn) return;
        void startNotifications();
        void loadPrefs();
      },
    ),
  );
  reportPresence();
  // a launch that could not reach the server asks again once the stream (which carries the session) is back
  createEffect(on(() => state.stream.state, (stream) => stream === "live" && state.gate === "checking" && void refreshHosts()));
  const onOnline = () => state.gate === "checking" && void refreshHosts();
  addEventListener("online", onOnline);
  onCleanup(() => removeEventListener("online", onOnline));
  // a protocol break's only button reloads: the newest build takes over first, so the reload lands on it
  createEffect(on(() => state.needsReload, (needs) => needs && void takeWaitingBuild()));
  onMount(() => {
    void refreshHosts();
    // every visit, not only when notifications turn on: the worker is what opens the app with no network
    void registerServiceWorker();
  });
  let idle: number | undefined;
  const warm = setTimeout(() => {
    const load = () => void warmLater().catch(() => undefined);
    // safari has no idle callback; by then the launch has long painted
    if ("requestIdleCallback" in window) idle = requestIdleCallback(load);
    else load();
  }, WARM_AFTER_MS);
  onCleanup(() => {
    clearTimeout(warm);
    if (idle !== undefined) cancelIdleCallback(idle);
  });

  return <ShellView />;
}

export type ShellViewProps = {
  /** a fixed clock for home, for the stories */
  at?: number;
  /** false in the stories, which have no server to send telemetry to */
  measure?: boolean;
};

/** the surfaces for the route the store names, with back and the shell's telemetry. the stories mount this alone,
    over a store they filled from fixtures */
export function ShellView(props: ShellViewProps) {
  const layout = createLayout();
  const route = createMemo(currentRoute, undefined, { equals: sameRoute });
  /** a fleet with hosts in it came from a server that let this device in: enough to paint while the gate is asked */
  const cached = () => state.fleet.hostNames.length > 0;
  const inside = createMemo(() => state.gate === "signed-in" || (state.gate === "checking" && cached()));

  /* —— back by `esc`. home's layer owns a thread's (the shrink), the pane owns the terminal's (esc is the shell's
     while its screen has focus); this takes the machines and settings. a key something on the page already acted
     on (the route moved under it, or it was prevented) is left alone —— */
  let pressedOn: Route | null = null;
  const onKeyCapture = (event: KeyboardEvent) => {
    if (event.key === "Escape") pressedOn = currentRoute();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    const was = pressedOn;
    pressedOn = null;
    if (!was || event.defaultPrevented || event.isComposing || !inside()) return;
    if (!sameRoute(was, currentRoute()) || (was.name !== "machines" && was.name !== "history" && was.name !== "settings")) return;
    // a form being filled (pairing a machine, a select open) keeps its esc
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable], form")) return;
    if (goBack("escape")) event.preventDefault();
  };
  addEventListener("keydown", onKeyCapture, { capture: true });
  addEventListener("keydown", onKey);
  onCleanup(() => {
    removeEventListener("keydown", onKeyCapture, { capture: true });
    removeEventListener("keydown", onKey);
  });

  /* a board key reaches for home from wherever the app is (docs/board.md, the app), and home takes the request once it is up.
     one the app cannot take (no window for the key, a machine the sheet cannot start a thread on) is dropped where it is,
     and so is any while a terminal holds the keyboard: someone is typing into a shell, and a key press elsewhere must not
     take the screen from under them (an open terminal the trip closes keeps its shell, which the relay replays when it is
     opened again, but the person's place in it is theirs) */
  createEffect(
    on(
      () => state.board.focus ?? state.board.compose,
      (asked) => {
        if (!asked) return;
        const takes = "key" in asked ? focusable(state.fleet, asked.key, Date.now()) : composeHost(state.fleet.hostNames, asked.machine) !== null;
        const typing = state.terminals.open !== null && document.activeElement?.closest(".term") != null;
        if (!takes || typing) {
          if ("key" in asked) boardFocus(null);
          else boardCompose(null);
          return;
        }
        if (state.screen !== "home") navigate({ name: "home" });
      },
    ),
  );

  /* —— who is driving: focus follows a screen change for the keyboard only; a finger gets no ring —— */
  let keyboard = false;
  const onInput = (event: Event) => (keyboard = event.type === "keydown");
  addEventListener("keydown", onInput, { capture: true, passive: true });
  addEventListener("pointerdown", onInput, { capture: true, passive: true });
  onCleanup(() => {
    removeEventListener("keydown", onInput, { capture: true });
    removeEventListener("pointerdown", onInput, { capture: true });
  });

  /* —— a screen change: the content fade (never on the first paint), focus for the keyboard, and surface.view —— */
  let frame: HTMLElement | undefined;
  let painted = false;
  onMount(() => (painted = true));
  let from: Surface | undefined;
  createEffect(
    on(
      () => (inside() ? route() : null),
      (now, before) => {
        if (!now) return;
        const surface = surfaceOf(now);
        // the thread's stage reports its own view when it mounts (ui/thread/stage.tsx)
        if (props.measure !== false && surface !== "thread") emit("surface.view", { route: pathOf(now), ...(from ? { from } : {}) }, { surface });
        from = surface;
        if (!before || !painted) return;
        queueMicrotask(() => arrive(now, before));
      },
    ),
  );
  const arrive = (now: Route, before: Route) => {
    const moved = now.name !== before.name && now.name !== "terminal" && before.name !== "terminal" && now.name !== "thread" && before.name !== "thread";
    const surface = frame?.querySelector<HTMLElement>(":scope > .surface");
    // a view transition (motion/screen.ts) has already moved the screen; the fade is for a back swipe and for browsers without one
    const handled = takeTransitioned();
    if (moved && surface && !handled) play(surface, [{ opacity: 0 }, { opacity: 1 }], FADE);
    if (!keyboard || !moved) return;
    // going in, the screen's title; coming back, the control that went in
    const target = parentOf(before)?.name === now.name ? frame?.querySelector<HTMLElement>(`[data-opens="${before.name}"]`) : frame?.querySelector<HTMLElement>("[data-screen-title]");
    target?.focus({ preventScroll: true });
  };

  return (
    <main class="frame" ref={frame} data-route={route().name} data-form={layout().form}>
      <Switch>
        <Match when={state.gate === "signed-out"}>
          <SignIn />
        </Match>
        <Match when={inside()}>
          <Show when={state.screen === "home"} fallback={<Screens layout={layout} />}>
            <div class="surface surface-home">
              <Home onMachines={() => navigate({ name: "machines" })} onHistory={() => navigate({ name: "history" })} {...(props.at !== undefined ? { at: props.at } : {})} {...(props.measure === false ? { measure: false } : {})} />
            </div>
          </Show>
        </Match>
        <Match when={state.gate === "checking"}>
          {/* no spinner (design.md, motion law): the first answer paints the right screen; only a failure says
              anything, and says what to do */}
          <Show when={state.problem}>
            {(problem) => (
              <div class="unreached">
                <p class="problem" role="alert">
                  {problem()}
                </p>
                <button class="quiet" type="button" onClick={() => void refreshHosts()}>
                  try again
                </button>
              </div>
            )}
          </Show>
        </Match>
      </Switch>
    </main>
  );
}

/** the machines or settings, and the terminal over or beside them */
function Screens(props: { layout: Accessor<Layout> }) {
  let screens: HTMLDivElement | undefined;
  // under 1000 wide the terminal covers the frame: what is behind it is out of reach for fingers, focus and
  // screen readers (design.md, the terminal)
  const covered = () => state.terminals.open !== null && !props.layout().wide;
  const wireEdge = (edge: HTMLDivElement) => {
    const unwire = edgeSwipe(edge, () => (state.terminals.open ? document.querySelector<HTMLElement>(".term") : (screens ?? null)), () => goBack("gesture"));
    onCleanup(unwire);
  };
  return (
    <>
      <div class="surface signed-in" ref={screens} data-terminal={state.terminals.open ? "open" : undefined} inert={covered()}>
        <Switch fallback={<Machines />}>
          <Match when={state.screen === "settings"}>
            <Settings />
          </Match>
          <Match when={state.screen === "history"}>
            <History />
          </Match>
        </Switch>
      </div>
      <Show when={state.terminals.open} keyed>
        {(terminal) => <TerminalPane terminal={terminal} />}
      </Show>
      <Show when={props.layout().form === "deck"}>
        <div class="shell-edge" ref={wireEdge} aria-hidden="true" />
      </Show>
    </>
  );
}

/** the url a launch lands on, written the one way (routes.ts, canonicalSearch), before anything reads it */
function settleUrl() {
  const search = canonicalSearch(location.search);
  if (search === location.search) return;
  const url = new URL(location.href);
  url.search = search;
  history.replaceState(history.state, "", url);
}
