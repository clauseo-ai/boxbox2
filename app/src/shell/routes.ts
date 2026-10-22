/* the route table (docs/architecture.md, the frontend: the route table).
   navigation is app state mirrored into the url with replaceState only, so
   the system back swipe has no history to peel, a relaunch lands where it
   left, and a pasted link opens the same place. this module is the table
   as data and pure functions over a query string: no dom, no store, so it
   is tested alone (routes.test.ts).

   | route    | url                                          | parent   |
   |----------|----------------------------------------------|----------|
   | home     | /                                            |          |
   | thread   | /?thread=<host:session>[&at=][&part=][&cut=][&btw=] | home |
   | machines | /?screen=machines                            | home     |
   | history  | /?screen=history                             | home     |
   | settings | /?screen=settings                            | machines |
   | terminal | /?terminal=<host>:<id>                       | machines |

   a push's link, /?thread=&ask=&push=, is the thread route plus a focus
   the push module takes and clears (push/links.ts). the thread's own
   params are written by the sync client (openThread, closeThread,
   markPlace); the shell writes only `screen` and `terminal`, and each
   writer keeps the other's params. */

/** a terminal: the host it lives on and its id there (ui/term/types.ts has the same shape) */
export type TerminalAt = { host: string; id: string };

export type Route =
  | { name: "home" }
  | { name: "thread"; thread: string; at: string | null; part: string | null }
  | { name: "machines" }
  | { name: "history" }
  | { name: "settings" }
  | { name: "terminal"; terminal: TerminalAt };

export type RouteName = Route["name"];

/** home's three arrangements (design.md, one layout law for three devices); the shell's form follows home's */
export type Form = "deck" | "strip" | "rail";

/** what back depends on: the form, and whether the terminal sits beside the machines (1000 wide and up) */
export type Layout = { form: Form; wide: boolean };

/** at this width and up the terminal sits beside the machines column, with no back (design.md, the terminal) */
export const TERMINAL_BESIDE_WIDTH = 1000;

/** how a person asked to go back: the in-app control, the `esc` key, or the deck's edge swipe */
export type BackVia = "control" | "escape" | "gesture";

/** the telemetry `surface` a route is seen on (telemetry/schema.ts, the surface column) */
export type Surface = "home" | "thread" | "machines" | "history" | "settings" | "term";

const SCREEN = "screen";
const TERMINAL = "terminal";
const THREAD = "thread";
const AT = "at";
const PART = "part";
/** the sync client's: where a fork of the thread was cut (client.ts, ThreadPlace) */
const CUT = "cut";
/** the sync client's: a btw card to land on (client.ts, ThreadPlace) */
const BTW = "btw";
const ASK = "ask";
const PUSH = "push";

/** the server's host name rule (server/src/config.rs) and the shape of a daemon's ids */
const HOST = "[a-z0-9-]{1,32}";
const ID = "[A-Za-z0-9_-]{1,128}";
const THREAD_KEY = new RegExp(`^${HOST}:${ID}$`);
const TERMINAL_KEY = new RegExp(`^(${HOST}):(${ID})$`);

/** the route a query string names. when a hand-edited url names several, the
    terminal wins over a screen, and a screen over a thread: the most specific
    place, which is also the one a reload must not lose. values that do not
    parse are ignored, never guessed at. */
export function parseRoute(search: string): Route {
  const query = new URLSearchParams(search);
  const terminal = terminalOf(query.get(TERMINAL));
  if (terminal) return { name: "terminal", terminal };
  const screen = query.get(SCREEN);
  if (screen === "machines" || screen === "history" || screen === "settings") return { name: screen };
  const thread = query.get(THREAD);
  if (thread !== null && THREAD_KEY.test(thread)) {
    return { name: "thread", thread, at: query.get(AT) || null, part: query.get(PART) || null };
  }
  return { name: "home" };
}

/** `<host>:<id>`, the terminal param's value */
export function terminalOf(raw: string | null): TerminalAt | null {
  const match = raw === null ? null : TERMINAL_KEY.exec(raw);
  return match?.[1] && match[2] ? { host: match[1], id: match[2] } : null;
}

/** the query string with the shell's own params (`screen`, `terminal`) written for a route and every other param
    kept as it was, the thread's included: the sync client owns those */
export function withShellParams(search: string, route: Route): string {
  const query = new URLSearchParams(search);
  query.delete(SCREEN);
  query.delete(TERMINAL);
  if (route.name === "machines" || route.name === "history" || route.name === "settings") query.set(SCREEN, route.name);
  if (route.name === "terminal") query.set(TERMINAL, `${route.terminal.host}:${route.terminal.id}`);
  return queryString(query);
}

/** the query string a launch should settle on: the route it names, written the one way, with the params that
    lost (a thread under a screen, a screen under a terminal) or did not parse removed. a push's `ask` and `push`
    stay on a thread for the push module to take; anything this table does not know is left alone */
export function canonicalSearch(search: string): string {
  const route = parseRoute(search);
  const query = new URLSearchParams(search);
  if (route.name !== "thread") {
    for (const name of [THREAD, AT, PART, CUT, BTW, ASK, PUSH]) query.delete(name);
  } else {
    // an empty place is no place
    for (const name of [AT, PART, CUT, BTW]) if (!query.get(name)) query.delete(name);
  }
  return withShellParams(queryString(query), route);
}

/** the path a route is written as, for telemetry and links: the thread's place included, nothing else */
export function pathOf(route: Route): string {
  const query = new URLSearchParams(withShellParams("", route));
  if (route.name === "thread") {
    query.set(THREAD, route.thread);
    if (route.at) query.set(AT, route.at);
    if (route.part) query.set(PART, route.part);
  }
  return `/${queryString(query)}`;
}

/** where back goes from a route, whatever asked */
export function parentOf(route: Route): Route | null {
  switch (route.name) {
    case "home":
      return null;
    case "thread":
    case "machines":
    case "history":
      return { name: "home" };
    case "settings":
    case "terminal":
      return { name: "machines" };
    default:
      return route satisfies never;
  }
}

/** where back goes from a route at a layout, by the way it was asked; null when there is no back that way.

    - a thread on the deck covers home, so its `‹`, `esc` and the edge swipe all shrink it into its window. at
      strip and rail it sits on stage beside the windows, the stage never empties, and there is no back at all.
    - machines, history and settings each have a back control at every size (`‹ windows`, `‹ machines`); `esc` does the
      same, and the deck's edge swipe too.
    - the terminal under 1000 wide covers the machines: `‹`, `esc` (when the screen does not hold focus, the
      pane's rule) and the deck's edge swipe close it. at 1000 and up it sits beside them with no control; `esc`
      outside the screen still closes it, as `esc` dismisses anything that has a parent on screen. */
export function backOf(route: Route, layout: Layout, via: BackVia): Route | null {
  const parent = parentOf(route);
  if (!parent) return null;
  if (via === "gesture" && layout.form !== "deck") return null;
  switch (route.name) {
    case "thread":
      return layout.form === "deck" ? parent : null;
    case "terminal":
      return via === "control" && layout.wide ? null : parent;
    default:
      return parent;
  }
}

export function surfaceOf(route: Route): Surface {
  return route.name === "terminal" ? "term" : route.name;
}

/** two routes are the same place: the thread's position inside it does not make it another route */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === "thread" && b.name === "thread") return a.thread === b.thread;
  if (a.name === "terminal" && b.name === "terminal") return a.terminal.host === b.terminal.host && a.terminal.id === b.terminal.id;
  return true;
}

function queryString(query: URLSearchParams): string {
  const text = query.toString();
  return text ? `?${text}` : "";
}
