/* the one writer of where the app is (docs/architecture.md, the route
   table). the route is read from the store: the screen, the terminal on
   screen, and the thread on stage. moving writes the store and mirrors the
   shell's params into the url with replaceState, never a history entry; the
   thread's own params are the sync client's (openThread, closeThread), and
   each writer keeps what the other wrote. */

import { batch } from "solid-js";
import { setBehind, setOpenTerminal, setScreen, setTerminalLink, setWindowsInView, state } from "../store";
import { travel } from "../motion/screen";
import { closeThread, openThread, placeInUrl } from "../sync/client";
import { layoutOf } from "./form";
import { type BackVia, backOf, parentOf, parseRoute, type Route, withShellParams } from "./routes";

/** where the app is now, from the store */
export function currentRoute(): Route {
  const terminal = state.terminals.open;
  if (terminal) return { name: "terminal", terminal };
  if (state.screen !== "home") return { name: state.screen };
  const thread = state.openThread;
  if (thread) return { name: "thread", thread, ...placeInUrl() };
  return { name: "home" };
}

/** how deep a route sits: going deeper is forward, coming up is back. the thread and the terminal have motions of
    their own and are not here */
const DEPTH: Partial<Record<Route["name"], number>> = { home: 0, thread: 0, machines: 1, history: 1, settings: 2 };

/** the screen transition a move makes, or null when it has its own motion (a thread, the terminal) */
function directionOf(from: Route, to: Route): "forward" | "back" | null {
  // a thread coming up is home's own morph (shrink into its window); leaving one for a screen is a plain forward
  if (to.name === "thread") return null;
  const a = DEPTH[from.name];
  const b = DEPTH[to.name];
  if (a === undefined || b === undefined || a === b) return null;
  return b > a ? "forward" : "back";
}

/** moves to a route: the store first, then the url. `still` is for a move the finger already made (the back swipe) */
export function navigate(route: Route, still = false): void {
  const direction = still ? null : directionOf(currentRoute(), route);
  if (direction) travel(direction, () => apply(route));
  else apply(route);
  mirror(route);
}

function apply(route: Route): void {
  batch(() => {
    const leavingHome = route.name !== "home" && route.name !== "thread";
    // the machines, settings and the terminal are not home's: the thread steps off the stage and the windows out
    // of view (presence must not report either as looked at), and the thread comes back with the windows
    if (leavingHome) {
      if (state.openThread) {
        setBehind(state.openThread);
        closeThread();
      }
      setWindowsInView([]);
    } else setBehind(null);
    switch (route.name) {
      case "home":
        setScreen("home");
        setOpenTerminal(null);
        break;
      case "thread":
        setScreen("home");
        setOpenTerminal(null);
        openThread(route.thread, { at: route.at, part: route.part });
        break;
      case "machines":
      case "history":
      case "settings":
        setScreen(route.name);
        setOpenTerminal(null);
        break;
      case "terminal": {
        setScreen("machines");
        const open = state.terminals.open;
        if (open?.host !== route.terminal.host || open.id !== route.terminal.id) {
          setTerminalLink("connecting");
          setOpenTerminal(route.terminal);
        }
        break;
      }
      default:
        route satisfies never;
    }
  });
}

/** back from a surface to its parent, by its own back control (`‹ windows`, `‹ machines`, the terminal's `‹`).
    coming back to the windows puts back the thread that was on stage when they were left, if it still has one */
export function leave(from: Route, still = false): void {
  const to = parentOf(from);
  if (!to) return;
  const behind = state.behind;
  if (to.name === "home" && behind && state.fleet.threads[behind]) navigate({ name: "thread", thread: behind, at: null, part: null }, still);
  else navigate(to, still);
}

/** back from where the app is, the way it was asked, at the window's size now; false when there is no back that
    way here (routes.ts, backOf), so the caller can leave the key or the gesture alone */
export function goBack(via: BackVia): boolean {
  const route = currentRoute();
  if (!backOf(route, layoutOf(innerWidth, innerHeight), via)) return false;
  leave(route, via === "gesture");
  return true;
}

/** the route the url names at launch, applied to the store. the thread is opened by the sync client when it
    starts (it reads the same url), so only the screen and the terminal are set here */
export function routeFromUrl(): Route {
  const route = parseRoute(location.search);
  if (route.name === "machines" || route.name === "history" || route.name === "settings") setScreen(route.name);
  if (route.name === "terminal") {
    setScreen("machines");
    setTerminalLink("connecting");
    setOpenTerminal(route.terminal);
  }
  return route;
}

function mirror(route: Route) {
  const search = withShellParams(location.search, route);
  if (search === location.search) return;
  const url = new URL(location.href);
  url.search = search;
  history.replaceState(history.state, "", url);
}
