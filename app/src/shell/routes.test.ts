import { describe, expect, test } from "bun:test";
import { type Form, type Layout, type Route, backOf, canonicalSearch, parentOf, parseRoute, pathOf, sameRoute, surfaceOf, withShellParams } from "./routes";

const home: Route = { name: "home" };
const thread: Route = { name: "thread", thread: "desk:ses_1", at: null, part: null };
const machines: Route = { name: "machines" };
const history: Route = { name: "history" };
const settings: Route = { name: "settings" };
const terminal: Route = { name: "terminal", terminal: { host: "desk", id: "pty_7" } };

/** the three sizes every route is checked at: a phone, an ipad in portrait, a mac */
const PHONE: Layout = { form: "deck", wide: false };
const IPAD: Layout = { form: "strip", wide: false };
const MAC: Layout = { form: "rail", wide: true };

describe("a url names one route", () => {
  test("the root is home", () => {
    expect(parseRoute("")).toEqual(home);
    expect(parseRoute("?")).toEqual(home);
  });

  test("a thread, with the place inside it", () => {
    expect(parseRoute("?thread=desk:ses_1")).toEqual(thread);
    expect(parseRoute("?thread=desk%3Ases_1&at=msg_4&part=prt_9")).toEqual({ ...thread, at: "msg_4", part: "prt_9" });
  });

  test("a push's link is the thread route; its ask and push are the push module's", () => {
    expect(parseRoute("?thread=desk:ses_1&ask=que_1&push=ask:que_1")).toEqual(thread);
  });

  test("machines, history and settings are screens", () => {
    expect(parseRoute("?screen=machines")).toEqual(machines);
    expect(parseRoute("?screen=history")).toEqual(history);
    expect(parseRoute("?screen=settings")).toEqual(settings);
  });

  test("a terminal names its host and its id", () => {
    expect(parseRoute("?terminal=desk:pty_7")).toEqual(terminal);
  });

  test("when several are named, the terminal beats a screen and a screen beats a thread", () => {
    expect(parseRoute("?thread=desk:ses_1&screen=settings")).toEqual(settings);
    expect(parseRoute("?screen=settings&terminal=desk:pty_7")).toEqual(terminal);
  });

  test("values that do not parse are ignored, never guessed at", () => {
    expect(parseRoute("?screen=inbox")).toEqual(home);
    expect(parseRoute("?thread=not a key")).toEqual(home);
    expect(parseRoute("?thread=Desk:ses_1")).toEqual(home);
    expect(parseRoute("?terminal=desk")).toEqual(home);
    expect(parseRoute("?terminal=:pty_7")).toEqual(home);
    expect(parseRoute("?terminal=desk:")).toEqual(home);
    expect(parseRoute("?terminal=desk:pty_7&screen=nope")).toEqual(terminal);
  });
});

describe("the shell writes only its own params", () => {
  test("the thread's params survive a screen being written, and the other way round", () => {
    const written = withShellParams("?thread=desk%3Ases_1&at=msg_4", machines);
    expect(new URLSearchParams(written).get("thread")).toBe("desk:ses_1");
    expect(new URLSearchParams(written).get("at")).toBe("msg_4");
    expect(new URLSearchParams(written).get("screen")).toBe("machines");
  });

  test("going home or to a thread removes the screen and the terminal", () => {
    expect(withShellParams("?screen=settings", home)).toBe("");
    expect(withShellParams("?terminal=desk%3Apty_7", thread)).toBe("");
  });

  test("a terminal is written without a screen: it implies the machines", () => {
    expect(withShellParams("?screen=machines", terminal)).toBe("?terminal=desk%3Apty_7");
  });

  test("params this table does not know are left alone", () => {
    expect(withShellParams("?debug=1", settings)).toBe("?debug=1&screen=settings");
  });
});

describe("a launch settles on the canonical url", () => {
  test("a thread under a screen goes, and so does the place it carried", () => {
    expect(canonicalSearch("?thread=desk:ses_1&at=msg_4&screen=machines")).toBe("?screen=machines");
  });

  test("a fork's cut stays on its thread, and goes with it under a screen or when empty", () => {
    expect(new URLSearchParams(canonicalSearch("?thread=desk:ses_1&cut=msg_9")).get("cut")).toBe("msg_9");
    expect(canonicalSearch("?thread=desk:ses_1&cut=msg_9&screen=history")).toBe("?screen=history");
    expect(new URLSearchParams(canonicalSearch("?thread=desk:ses_1&cut=")).has("cut")).toBe(false);
  });

  test("a screen under a terminal goes", () => {
    expect(canonicalSearch("?screen=settings&terminal=desk:pty_7")).toBe("?terminal=desk%3Apty_7");
  });

  test("a push's ask and push stay on a thread for the push module, and go anywhere else", () => {
    expect(new URLSearchParams(canonicalSearch("?thread=desk:ses_1&ask=que_1&push=ask:que_1")).get("ask")).toBe("que_1");
    expect(canonicalSearch("?ask=que_1&push=ask:que_1")).toBe("");
  });

  test("what does not parse is removed, and an empty place is no place", () => {
    expect(canonicalSearch("?screen=inbox")).toBe("");
    expect(canonicalSearch("?thread=not%20a%20key")).toBe("");
    expect(canonicalSearch("?thread=desk:ses_1&at=&part=")).toBe("?thread=desk%3Ases_1");
  });

  test("a canonical url is a fixed point", () => {
    for (const search of ["", "?thread=desk%3Ases_1&at=msg_4", "?screen=machines", "?screen=history", "?screen=settings", "?terminal=desk%3Apty_7"]) {
      expect(canonicalSearch(search)).toBe(search);
    }
  });

  test("every route reads back from the path it is written as", () => {
    const placed: Route = { ...thread, at: "msg_4", part: "prt_9" };
    for (const route of [home, placed, machines, history, settings, terminal]) expect(parseRoute(pathOf(route).slice(1))).toEqual(route);
    expect(pathOf(home)).toBe("/");
    expect(pathOf(history)).toBe("/?screen=history");
    expect(pathOf(machines)).toBe("/?screen=machines");
  });
});

describe("back goes to the route's parent, the same way by every means that exists", () => {
  test("the parents", () => {
    expect(parentOf(home)).toBeNull();
    expect(parentOf(thread)).toEqual(home);
    expect(parentOf(machines)).toEqual(home);
    expect(parentOf(history)).toEqual(home);
    expect(parentOf(settings)).toEqual(machines);
    expect(parentOf(terminal)).toEqual(machines);
  });

  /** what each way of going back does, as a row per layout: control, escape, gesture */
  const table = (route: Route, layout: Layout) => (["control", "escape", "gesture"] as const).map((via) => backOf(route, layout, via)?.name ?? null);

  test("home has no back anywhere", () => {
    for (const layout of [PHONE, IPAD, MAC]) expect(table(home, layout)).toEqual([null, null, null]);
  });

  test("a thread on the deck shrinks home by `‹`, esc and the edge; beside the windows it has no back", () => {
    expect(table(thread, PHONE)).toEqual(["home", "home", "home"]);
    expect(table(thread, IPAD)).toEqual([null, null, null]);
    expect(table(thread, MAC)).toEqual([null, null, null]);
  });

  test("history goes home, like the machines, at every size; the edge swipe only on the deck", () => {
    expect(table(history, PHONE)).toEqual(["home", "home", "home"]);
    expect(table(history, IPAD)).toEqual(["home", "home", null]);
    expect(table(history, MAC)).toEqual(["home", "home", null]);
  });

  test("machines go home and settings go to the machines, at every size; the edge swipe only on the deck", () => {
    expect(table(machines, PHONE)).toEqual(["home", "home", "home"]);
    expect(table(machines, IPAD)).toEqual(["home", "home", null]);
    expect(table(machines, MAC)).toEqual(["home", "home", null]);
    expect(table(settings, PHONE)).toEqual(["machines", "machines", "machines"]);
    expect(table(settings, MAC)).toEqual(["machines", "machines", null]);
  });

  test("the terminal covers the machines under 1000 wide; beside them it has no control, and esc still closes it", () => {
    expect(table(terminal, PHONE)).toEqual(["machines", "machines", "machines"]);
    expect(table(terminal, IPAD)).toEqual(["machines", "machines", null]);
    expect(table(terminal, MAC)).toEqual([null, "machines", null]);
    const widePortrait: Layout = { form: "strip" satisfies Form, wide: true };
    expect(table(terminal, widePortrait)).toEqual([null, "machines", null]);
  });
});

describe("telemetry and identity", () => {
  test("each route has its surface; the terminal's is term", () => {
    expect([home, thread, machines, history, settings, terminal].map(surfaceOf)).toEqual(["home", "thread", "machines", "history", "settings", "term"]);
  });

  test("a thread is the same route wherever it is scrolled; another thread or terminal is not", () => {
    expect(sameRoute(thread, { ...thread, at: "msg_4" })).toBe(true);
    expect(sameRoute(thread, { ...thread, thread: "desk:ses_2" })).toBe(false);
    expect(sameRoute(terminal, { name: "terminal", terminal: { host: "desk", id: "pty_8" } })).toBe(false);
    expect(sameRoute(machines, settings)).toBe(false);
    expect(sameRoute(machines, history)).toBe(false);
  });
});
