/* the window checks: the scroll law of a long thread, held as numbers, in
   chrome and in webkit, against a real cmx2 dev daemon (docs/thread.md, the
   stage, live, navigation, links, accessibility, budgets; docs/design.md,
   the scroll law and the layout-shift budget).

   written before the stage mounts a long thread's turns progressively, as
   the independent check of that change; it runs against any checkout's dev
   server, and on main it records what main does. each invariant is a named
   check that prints its evidence and fails the run:

   1 no drift              scrolling up through the whole thread in steps
                           (programmatic, wheel, and a touch fling where the
                           engine can make one), the first visible text line
                           moves only by what the reader scrolled: in every
                           frame with no input in flight it moves 0 px
                           (at most 1, rounding), and each step moves it by
                           the step, at most 1 px off. while a finger or its
                           momentum is moving, nothing above that line
                           changes height (no fill-in above the eye during a
                           touch scroll). at every width given (390x844 and
                           1512x945). every pass starts from the thread
                           opened afresh at its end: mount-once fills every
                           turn a pass goes by, so a second pass on the same
                           page would meet no fill-in at all
   2 pinned stays pinned   opened at the end while a reply streams, the end
                           is in view (scroll gap at most 1 px) in every
                           painted frame from the landing to a second after
                           the reply ends; scrolled up three screens, a reply
                           that arrives does not move the view (frames as in
                           1) and "N new messages below" counts exactly the
                           messages that arrived
   3 every turn reachable  the ruler, the turns panel, `at=` and `part=` links
                           to an early turn land it with its top just under
                           the bar, within the band the bar's fade covers
                           (bar foot to bar foot + 36 px), the url naming it;
                           a part's row is opened. an ask (a push's `ask=`,
                           the dock's "wants you" line, the window's
                           "answer" pill) lands with its top at the bar's
                           foot + 36 px, or where the end stops it, whole,
                           and once more with three messages queued under
                           it (sent with the page open, so their bubbles are
                           drawn). the turns panel also goes to a turn two
                           screens up (the smooth move, from a thread no
                           finger has touched), and to a queued message once
                           it has run and replaced its bubble. each is read
                           again 1 s later and has not moved (1 px), and the
                           turn holds its rows
   4 nothing resets        a row opened, a bed scrolled sideways and a
                           control holding keyboard focus in an early turn,
                           and words typed into a pending ask's card, all
                           survive scrolling to the far end and back
   5 no layout shift       the browser's layout-shift entries (no recent
                           input) over each drift pass, and the app's own
                           perf.shift rows for the lane, are 0 in the
                           telemetry's thousandths: design.md's budget is 0
   6 names unique          no two controls in the accessibility tree share a
                           name (thread.md, accessibility), read from the
                           engine's tree every few steps of the programmatic
                           pass and at every step where the dom's labels
                           show a repeat
   7 dom bound on open     opened at the end and settled, a turn holds its
                           rows only if it is within three screens of the
                           view, one of the last four turns, or holds a
                           pending ask; every turn in view holds its rows
   8 nothing blank in view no painted frame shows an empty turn box below
                           the bar, in the programmatic and wheel passes and
                           in a fast wheel (150 wheels of 600 px back to back
                           from the end). a touch fling is printed, not
                           judged: while a finger moves the window lets
                           turns above the view wait by design. frames over
                           50 ms are printed as timing, not judged
   9 nothing blanks at a   with the thread on stage, at its end, scrolled up
     settle                two screens, and sent from the composer, a turn
                           runs to its end and settles (a streamed reply, a
                           turn with tool steps, one that starts an agent
                           that streams on after it): from the prompt to 5 s
                           after the settle, every painted frame has the
                           stage on screen, the thread in the store with its
                           messages, no "reading" or "nothing here" line, a
                           turn with rows in the view and no empty turn box
                           in it, and no painted frame draws fewer turns than
                           the one before or loses more than 200 px of
                           content while the row in view moves (the stage
                           re-opening the thread for a frame; a box out of
                           the view measured again with the row in view held
                           still is printed, not judged). and the shape that
                           blanked a reader's thread, 5ffff12: at 1512x945 and
                           1728x1117 with home's windows beside
                           the stage, a long reply streams in a thread of
                           about 140 messages while the drive taps the
                           windows of two other threads and back every 2.5 s,
                           through the settle: no layout shift away from a
                           tap in the stage, the inspector or the composer's
                           chips (score 0, each on its own line; webkit
                           reports none; home's shifts, its window cards
                           with their tails, its rail and its bar, are
                           printed and not judged, home's lane), no re-open
                           as above (every engine), no second of more than 3
                           scroll writes away from a tap on a still thread
                           (a write while the turn count rose in the last
                           500 ms keeps the place under a log coming in, and
                           a view at the end moved down by what the content
                           grew, less than a screen, is the streaming
                           thread's follow: neither counts), no blank frame.
                           the first blank, the first re-open and the first
                           write on a still thread are printed with their
                           dom, a dip with what changed height and whether
                           the view moved, and the screens are saved

   the thread: bench/long.ts's seeded thread (`[bench:long K A T]`, mixed tool
   steps, written files, long markdown with fences, agents), found by its
   title or seeded through `bun bench/long.ts --seed-only`; this run adds
   its own turns at the end ([bench:words] replies, a [bench:tools] ask it
   answers before it leaves). `--thread <session>` uses another one.

   needs the stack of bench/thread.ts, on ports of your own decade:
     just cmx2 --port 4990 --boxbox-port 3091
     BOXBOX_PORT=3091 just dev
     bun bench/window.ts [--boxbox http://127.0.0.1:3091] [--bench <dir with daemon.json>]
       [--engines chromium,webkit] [--widths 390x844,1512x945] [--only 1,2,3,4,5,6,7,8,9]
       [--thread <session>] [--turns 150] [--agents 36] [--flings 24] [--names-every N] [--chrome <binary>]
   `--bench` is the `.cmx2/bench` of the checkout whose daemon the boxbox at
   `--boxbox` talks to (another worktree's stack). chrome is agent-browser's
   build, started by the run (its profile under /tmp, killed when the lane
   ends) and driven over cdp; webkit is playwright's (`bunx playwright-core
   install webkit` once). what an engine cannot do is reported as n/a with
   the reason, never faked. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, type Page, webkit } from "playwright-core";
import { PAGE } from "./window-page";

const ROOT = new URL("../", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const BOXBOX = flag("--boxbox", `http://127.0.0.1:${process.env["BOXBOX_PORT"] ?? "3091"}`);
const BENCH = resolve(flag("--bench", join(ROOT, ".cmx2/bench")));
const ENGINES = flag("--engines", "chromium,webkit").split(",") as Engine[];
const WIDTHS = flag("--widths", "390x844,1512x945")
  .split(",")
  .map((w) => w.split("x").map(Number) as [number, number]);
const ONLY = new Set(flag("--only", "1,2,3,4,5,6,7,8,9").split(","));
/** where check 9 keeps the screen of a blank frame */
const SHOTS = join(ROOT, "bench/shots");
const THREAD = flag("--thread", "");
const TURNS = Number(flag("--turns", "150"));
const AGENTS = Number(flag("--agents", "36"));
const FLINGS = Number(flag("--flings", "24"));
/** how often the programmatic pass reads the accessibility tree: by default about 40 reads a pass, since a tree of a whole long thread takes seconds to read */
const NAMES_EVERY = flag("--names-every", "auto");
const NAME_READS = 40;
/** the band under the bar a landing may use: the bar's fade is whole 36 px under its foot (ask-landing.ts, CLEAR_OF_BAR) */
const CLEAR_OF_BAR = 36;
/** a step of the drift passes, as a share of the scroller's height: the step's anchor line stays in view across it */
const STEP_OF_VIEW = 0.75;
/** screens either side of the view a mounted turn may be in (the approved design: filled within two to three screens) */
const SCREENS = 3;
/** the turns at the end that are always mounted (the live turn and the last few) */
const LAST_FEW = 4;
const MAX_STEPS = 4000;
/** this run, in the prompts it sends: a turn is named by its prompt in the turns list, so a prompt an earlier run sent too would land
    a tap on the earlier turn */
const RUN = Date.now().toString(36);
/** check 8's fast wheel: this many wheels upward of this many px, sent as fast as the engine takes them */
const FAST_WHEELS = 150;
const FAST_WHEEL = 600;

type Engine = "chromium" | "webkit";
type Verdict = "pass" | "FAIL" | "n/a";

const daemon = JSON.parse(readFileSync(join(BENCH, "daemon.json"), "utf8")) as { url: string };
const daemonPassword = readFileSync(join(BENCH, "password"), "utf8").trim();
const gatePassword = readFileSync(join(BENCH, "gate-password"), "utf8").trim();
const auth = `Basic ${Buffer.from(`cmx2:${daemonPassword}`).toString("base64")}`;
const TELEMETRY = join(BENCH, "boxbox-data/telemetry");

/* ---------- the report ---------- */
const CHECKS: Record<string, string> = {
  "1": "no drift",
  "2": "pinned stays pinned",
  "3": "every turn reachable",
  "4": "nothing resets",
  "5": "no layout shift",
  "6": "names unique",
  "7": "dom bound on open",
  "8": "nothing blank in view",
  "9": "nothing blanks at a settle",
};
const results: Array<{ check: string; engine: Engine; where: string; verdict: Verdict; evidence: string }> = [];
const log = (line = "") => console.log(line);
function record(check: string, engine: Engine, where: string, ok: boolean | null, evidence: string) {
  const verdict: Verdict = ok === null ? "n/a" : ok ? "pass" : "FAIL";
  results.push({ check, engine, where, verdict, evidence });
  log(`${verdict === "pass" ? "pass" : verdict === "FAIL" ? "FAIL" : "n/a "} ${check} ${CHECKS[check]} [${engine} ${where}]: ${evidence}`);
}
const only = (check: string) => ONLY.has(check);
const r1 = (n: number) => Math.round(n * 10) / 10;

/* ---------- the daemon ---------- */
type Part = { id: string; type: string; tool?: string; text?: string; synthetic?: boolean; mail?: unknown; notice?: unknown; state?: { status?: string } };
type Message = { info: { id: string; role: string; mail?: unknown }; parts: Part[] };
async function daemonCall<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${daemon.url}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}
const messagesOf = async (session: string) => (await daemonCall<Message[]>("GET", `/session/${session}/message`)).json;
/** a user message the reader typed (not a report, a brief, a notice or the daemon's own context), and its first line: the label the ruler's card and the turns list show */
function promptOf(m: Message): string | null {
  if (m.info.role !== "user" || m.info.mail) return null;
  const typed = m.parts.filter((p) => p.type === "text" && !p.synthetic && !p.mail && !p.notice);
  if (!typed.length) return null;
  return typed.map((p) => p.text ?? "").join("\n").split("\n").find((l) => l.trim())?.trim() ?? null;
}
async function busy(session: string): Promise<boolean> {
  const status = (await daemonCall<Record<string, { type: string }>>("GET", "/session/status")).json;
  const s = status[session];
  return !!s && s.type !== "idle";
}
/** at work, or parked on the agents or jobs it started: the status read with `parked=true`, as bench/windows.ts reads it */
async function working(session: string): Promise<boolean> {
  const status = (await daemonCall<Record<string, { type: string; parked?: unknown }>>("GET", "/session/status?parked=true")).json;
  const s = status[session];
  return !!s && (s.type !== "idle" || !!s.parked);
}
type Question = { id: string; sessionID: string; questions: Array<{ options?: Array<{ label: string }> }> };
const questionsOf = async (session: string) => (await daemonCall<Question[]>("GET", "/question")).json.filter((q) => q.sessionID === session);
/** the thread idle with nothing pending: a question left by an earlier run is answered with its first option */
async function settleThread(session: string) {
  for (const q of await questionsOf(session)) {
    const label = q.questions[0]?.options?.[0]?.label ?? "hi";
    const r = await daemonCall("POST", `/question/${q.id}/reply`, { answers: [[label]] });
    log(`     answered a question left pending (${q.id}, "${label}"): ${r.status}`);
  }
  const t0 = Date.now();
  while (await busy(session)) {
    if (Date.now() - t0 > 180_000) throw new Error(`the thread ${session} is still busy after 3 minutes`);
    await Bun.sleep(500);
  }
}
async function prompt(session: string, text: string) {
  const r = await daemonCall("POST", `/session/${session}/prompt_async`, { text });
  /* 202 for a turn that starts; a session that is busy queues it and answers its id */
  if (r.status !== 202 && r.status !== 200) throw new Error(`prompt answered ${r.status}`);
}

/* ---------- the thread ---------- */
const longTitle = `long: bench thread, ${AGENTS} agents`;
async function findLong(): Promise<string | null> {
  const sessions = (await daemonCall<Array<{ id: string; title: string; parentID?: string }>>("GET", "/session")).json;
  return sessions.find((s) => s.title === longTitle && !s.parentID)?.id ?? null;
}
async function prepareThread(): Promise<string> {
  if (THREAD) return THREAD;
  let id = await findLong();
  const prompts = id ? (await messagesOf(id)).filter((m) => promptOf(m) !== null).length : 0;
  if (!id || prompts < TURNS) {
    const checkout = resolve(BENCH, "../..");
    if (!existsSync(join(checkout, "bench/long.ts"))) {
      throw new Error(`no seeded thread "${longTitle}" on the daemon, and ${checkout} has no bench/long.ts to seed one (merge perf-bench, or pass --thread <session>)`);
    }
    log(`seeding "${longTitle}" through bench/long.ts (${prompts} of ${TURNS} turns there): slow once, the daemon's data dir keeps it`);
    const seed = Bun.spawnSync(["bun", "bench/long.ts", "--seed-only", "--turns", String(TURNS), "--agents", String(AGENTS)], { cwd: checkout, stdout: "inherit", stderr: "inherit" });
    if (seed.exitCode !== 0) throw new Error(`bench/long.ts --seed-only exited ${seed.exitCode}`);
    id = await findLong();
    if (!id) throw new Error(`bench/long.ts finished and no thread is titled "${longTitle}"`);
  }
  return id;
}
/** what the thread is made of, from the daemon: the run says what it ran against */
async function shapeOf(session: string) {
  const msgs = await messagesOf(session);
  const parts = msgs.flatMap((m) => m.parts);
  const tools = parts.filter((p) => p.type === "tool");
  return {
    messages: msgs.length,
    prompts: msgs.filter((m) => promptOf(m) !== null).length,
    tools: tools.length,
    failed: tools.filter((p) => p.state?.status === "error").length,
    agents: tools.filter((p) => p.tool === "spawn" || p.tool === "task" || p.tool === "agent").length,
    writes: tools.filter((p) => p.tool === "write").length,
    fences: parts.filter((p) => p.type === "text" && (p.text ?? "").includes("```")).length,
  };
}

/* ---------- the engines: one surface for both ---------- */
type Driver = {
  engine: Engine;
  eval<T>(js: string): Promise<T>;
  goto(path: string): Promise<void>;
  viewport(w: number, h: number): Promise<void>;
  wheel(x: number, y: number, dx: number, dy: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
  down(x: number, y: number): Promise<void>;
  up(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: "Tab"): Promise<void>;
  /** every named control in the engine's accessibility tree, and how many it holds without a name */
  names(): Promise<{ names: string[]; unnamed: number; source: string }>;
  /** a touch fling of dy px upward from (x, y), or null where the engine cannot make one */
  touch: null | { on(): Promise<void>; off(): Promise<void>; fling(x: number, y: number, dy: number): Promise<void> };
  /** the page hidden behind another and brought back; false where the engine does not hide it */
  hide(): Promise<boolean>;
  /** the page as painted, saved as a png */
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
};
const INTERACTIVE = new Set(["button", "link", "slider", "textbox", "searchbox", "checkbox", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "combobox", "radio", "spinbutton", "option", "treeitem"]);

/* a cdp socket of our own, for chrome */
class Cdp {
  private id = 0;
  private waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result?: unknown };
      if (msg.id === undefined) {
        const method = (msg as { method?: string; params?: { reason?: string } }).method;
        if (method === "Inspector.detached" || method === "Inspector.targetCrashed") log(`     chrome: ${method} ${(msg as { params?: { reason?: string } }).params?.reason ?? ""}`);
        return;
      }
      const waiter = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) waiter?.no(new Error(msg.error.message));
      else waiter?.ok(msg.result);
    });
    socket.addEventListener("close", () => { for (const w of this.waiting.values()) w.no(new Error("the cdp socket closed")); this.waiting.clear(); });
  }
  static async open(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((ok, no) => { socket.addEventListener("open", () => ok()); socket.addEventListener("error", () => no(new Error(`cdp socket ${url} refused`))); });
    return new Cdp(socket);
  }
  /** a call that gets no answer in `ms` fails, so a page that hangs stops the lane instead of the run */
  send<T>(method: string, params: Record<string, unknown> = {}, ms = 60_000): Promise<T> {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((ok, no) => {
      const timer = setTimeout(() => { this.waiting.delete(id); no(new Error(`chrome gave no answer to ${method} in ${ms / 1000} s`)); }, ms);
      this.waiting.set(id, { ok: (v) => { clearTimeout(timer); (ok as (v: unknown) => void)(v); }, no: (e) => { clearTimeout(timer); no(e); } });
    });
  }
  close() { this.socket.close(); }
}

/** agent-browser's chrome for testing, newest first, unless --chrome names one */
function chromeBinary(): string {
  const given = flag("--chrome", "");
  if (given) return given;
  const dir = join(process.env["HOME"] ?? "", ".agent-browser/browsers");
  const builds = existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith("chrome-")).sort().reverse() : [];
  for (const b of builds) {
    const bin = join(dir, b, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if (existsSync(bin)) return bin;
    const linux = join(dir, b, "chrome");
    if (existsSync(linux)) return linux;
  }
  throw new Error(`no chrome under ${dir}: install agent-browser's (agent-browser install), or pass --chrome <binary>`);
}

/* chrome: agent-browser's own build, started by this run with a profile under /tmp and driven over cdp. agent-browser's daemon let
   its browser go a few minutes into a long pass, idle or kept busy (its page target closed under the drive, docs/gotchas.md), and a
   drift pass over a long thread takes minutes; playwright's connectOverCDP never opens its socket under bun. without
   --disable-field-trial-config, chrome 151's headless stops producing frames, and stops answering wheels, about a minute after it
   starts, even on a data: url (docs/gotchas.md) */
async function chrome(): Promise<Driver> {
  /* a profile of its own per run (the boxbox port and this pid), so runs from other worktrees beside this one never share a browser */
  const profile = `/tmp/window-checks/chrome-${new URL(BOXBOX).port || "80"}-${process.pid}`;
  mkdirSync(profile, { recursive: true });
  const proc = Bun.spawn([chromeBinary(), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-field-trial-config", "--disable-hang-monitor", "--disable-features=PaintHolding", "--hide-scrollbars", "--mute-audio", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  log(`     chrome pid ${proc.pid}, profile ${profile}`);
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await Bun.sleep(100);
    const file = join(profile, "DevToolsActivePort");
    if (existsSync(file)) port = readFileSync(file, "utf8").split("\n")[0] ?? "";
  }
  if (!port) { proc.kill(); throw new Error("chrome did not open its debugging port within 10 s"); }
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{ id: string; type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((t) => t.type === "page");
  if (!target) { proc.kill(); throw new Error("chrome opened no page"); }
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Inspector.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE });
  const evaluate = async <T>(js: string): Promise<T> => {
    const r = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  };
  /* a navigation that has not loaded in 20 s is stopped and asked for once more (a fresh headless profile has hung on its first one) */
  const goto = async (path: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await cdp.send("Page.navigate", { url: `${BOXBOX}${path}` }, 20_000).catch(() => undefined);
      for (let i = 0; i < 200; i++) {
        await Bun.sleep(100);
        if ((await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: "location.href.startsWith(" + JSON.stringify(BOXBOX) + ") && document.readyState", returnByValue: true }, 2000).then((r) => r.result.value).catch(() => "")) === "complete") {
          await evaluate(PAGE);
          return;
        }
      }
      log(`     chrome: ${path} did not load in 20 s; stopping it and asking again`);
      await cdp.send("Page.stopLoading", {}, 5000).catch(() => undefined);
    }
    throw new Error(`chrome did not load ${BOXBOX}${path}`);
  };
  await goto("/");
  const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  return {
    engine: "chromium",
    eval: evaluate,
    goto,
    async viewport(w, h) { await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false }); await Bun.sleep(300); },
    async wheel(x, y, dx, dy) { await mouse("mouseWheel", x, y, { deltaX: dx, deltaY: dy }); },
    async click(x, y) { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 }); await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 }); },
    async down(x, y) { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 }); },
    async up(x, y) { await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 }); },
    async type(text) { await cdp.send("Input.insertText", { text }); },
    async press(key) {
      const k = { key, code: key, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
    },
    async names() {
      const tree = await cdp.send<{ nodes: Array<{ ignored: boolean; role?: { value: string }; name?: { value: string } }> }>("Accessibility.getFullAXTree", {}, 180_000);
      const controls = tree.nodes.filter((n) => !n.ignored && INTERACTIVE.has(n.role?.value ?? ""));
      return { names: controls.map((n) => (n.name?.value ?? "").trim()).filter(Boolean), unnamed: controls.filter((n) => !(n.name?.value ?? "").trim()).length, source: "chrome's accessibility tree (cdp, the tree agent-browser reads)" };
    },
    touch: {
      async on() { await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }); },
      async off() { await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }); },
      /* chrome's own synthetic touch gesture: touch events into the page, a compositor scroll and the fling after the lift */
      async fling(x, y, dy) { await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: dy, speed: 2400, gestureSourceType: "touch", preventFling: false }, 30_000); },
    },
    async screenshot(path) {
      const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, 20_000);
      await Bun.write(path, Buffer.from(shot.data, "base64"));
    },
    async hide() {
      const browserCdp = await Cdp.open(((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
      try {
        const { targetId } = await browserCdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
        await Bun.sleep(800);
        const hidden = (await evaluate<string>("document.visibilityState")) === "hidden";
        await browserCdp.send("Target.closeTarget", { targetId });
        await browserCdp.send("Target.activateTarget", { targetId: target.id });
        await Bun.sleep(400);
        return hidden;
      } finally {
        browserCdp.close();
      }
    },
    async close() {
      cdp.close();
      proc.kill();
      /* a hung chrome does not answer sigterm */
      if ((await Promise.race([proc.exited.then(() => "gone"), Bun.sleep(4000).then(() => "still")])) === "still") proc.kill("SIGKILL");
      await proc.exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/* webkit: playwright's, launched over its pipe */
async function safari(): Promise<Driver> {
  const browser: Browser = await webkit.launch();
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(PAGE);
  const page: Page = await context.newPage();
  await page.goto(`${BOXBOX}/`);
  return {
    engine: "webkit",
    eval: <T>(js: string) => page.evaluate(js) as Promise<T>,
    async goto(path) { await page.goto(`${BOXBOX}${path}`, { waitUntil: "load" }); await page.evaluate(PAGE); },
    async viewport(w, h) { await page.setViewportSize({ width: w, height: h }); await Bun.sleep(300); },
    async wheel(x, y, dx, dy) { await page.mouse.move(x, y); await page.mouse.wheel(dx, dy); },
    async click(x, y) { await page.mouse.click(x, y); },
    async down(x, y) { await page.mouse.move(x, y); await page.mouse.down(); },
    async up(x, y) { await page.mouse.move(x, y); await page.mouse.up(); },
    async type(text) { await page.keyboard.type(text); },
    async press(key) { await page.keyboard.press(key); },
    async names() {
      /* playwright's aria snapshot: its own reading of the tree (webkit's accessibility tree is not reachable from here) */
      const yaml = await page.locator("body").ariaSnapshot();
      const names: string[] = [];
      let unnamed = 0;
      for (const line of yaml.split("\n")) {
        const m = line.match(/^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/);
        if (!m || !INTERACTIVE.has(m[1] ?? "")) continue;
        if (m[2]) names.push(m[2].replace(/\\(.)/g, "$1").trim());
        else unnamed++;
      }
      return { names, unnamed, source: "playwright's aria snapshot of webkit" };
    },
    touch: null,
    async screenshot(path) { await page.screenshot({ path, timeout: 20_000 }); },
    async hide() {
      const other = await context.newPage();
      await other.bringToFront();
      await Bun.sleep(800);
      const hidden = (await page.evaluate("document.visibilityState")) === "hidden";
      await other.close();
      await page.bringToFront();
      return hidden;
    },
    async close() { await browser.close(); },
  };
}

/* ---------- the stage, from the drive ---------- */
type Facts = { st: number; sh: number; ch: number; gap: number; bar: number; turns: number; mounted: number; nodes: number };
async function signIn(d: Driver) {
  const status = await d.eval<number>(`fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(gatePassword)}})}).then(r=>r.status)`);
  if (status !== 200) throw new Error(`the gate answered ${status} to the bench password`);
}
async function until(d: Driver, js: string, ms: number, every = 200): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await d.eval<boolean>(js).catch(() => false)) return true;
    await Bun.sleep(every);
  }
  return false;
}
/** the thread opened by url and drawn: its stage holds turns with rows, and has been still for a moment */
async function openThread(d: Driver, session: string, extra = ""): Promise<Facts> {
  await d.goto(`/?thread=bench:${session}${extra}`);
  if (!(await until(d, "window.__win && __win.ready()", 90_000))) throw new Error(`the thread ${session} did not draw within 90 s`);
  await d.eval("__win.settle(400, 20000)");
  return d.eval<Facts>("__win.facts()");
}
const facts = (d: Driver) => d.eval<Facts>("__win.facts()");
/** what a tap at (x, y) lands on, for the evidence of a tap that did nothing */
const hitAt = (d: Driver, x: number, y: number) => d.eval<string>(`(() => { const h = document.elementFromPoint(${x}, ${y}); if (!h) return 'nothing'; const c = typeof h.className === 'string' && h.className ? '.' + h.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''; const named = h.closest('[aria-label]'); return h.nodeName.toLowerCase() + c + (named ? ' in "' + named.getAttribute('aria-label').slice(0, 40) + '"' : ''); })()`);
/** the middle of the scroller, for wheels and flings */
const middle = (d: Driver) => d.eval<{ x: number; y: number }>("(() => { const r = __win.sc().getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");

/* ---------- check 1 (and 5, 6): the drift passes ---------- */
type Rec = { blankFrames: number; blankWorst: number; blankViol: unknown[]; gaps: number; worstGap: number; label: string; frames: number; pairs: number; still: number; touch: number; fills: number; fillPx: number; stillFills: number; worst: number; worstTouch: number; lost: number; drift: number; touchFill: number; viol: unknown[]; touchViol: unknown[]; t0: number; t1: number };
type Shifts = { supported: boolean; entries: number; counted: number; sum: number; withInput: number; worst: unknown[] };
type Pass = { rec: Rec; travel: number; steps: number; stepMiss: number; stepWorst: number; stepViol: string[]; reachedTop: boolean; shifts: Shifts; names: NamesTally; ms: number };
type NamesTally = { every: number; reads: number; dupes: Map<string, string>; unnamedMax: number; source: string; domRepeats: number };

async function readNames(d: Driver, tally: NamesTally, where: string) {
  const { names, unnamed, source } = await d.names();
  tally.reads++;
  tally.source = source;
  tally.unnamedMax = Math.max(tally.unnamedMax, unnamed);
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  for (const [n, count] of seen) if (count > 1 && !tally.dupes.has(n)) tally.dupes.set(n, `"${n}" x${count} at ${where}`);
}

/** from the end to the top in steps of three quarters of the view, every step read for drift; the first move off the end is a wheel, the reader's */
async function passUp(d: Driver, kind: "programmatic" | "wheel" | "fling", label: string, names: NamesTally | null): Promise<Pass> {
  const t0 = Date.now();
  const at = await middle(d);
  await d.eval(`__win.mark(${JSON.stringify(`${label}: the drive's jump to the end before it`)})`);
  await d.eval("__win.toEnd()");
  await d.eval("__win.settle(400, 15000)");
  await d.eval(`__win.mark(${JSON.stringify(`${label}: the reader's wheel off the end`)})`);
  await d.wheel(at.x, at.y, 0, -120);
  await d.eval("__win.settle(300, 5000)");
  await d.eval(`__win.mark(${JSON.stringify(`${label}: the pass`)})`);
  await d.eval(`__win.start(${JSON.stringify(label)})`);
  const stepViol: string[] = [];
  const startFacts = await facts(d);
  const namesEvery = NAMES_EVERY === "auto" ? Math.max(1, Math.ceil(startFacts.st / (startFacts.ch * STEP_OF_VIEW) / NAME_READS)) : Math.max(1, Number(NAMES_EVERY));
  if (names) names.every = namesEvery;
  let steps = 0, stepMiss = 0, stepWorst = 0, reachedTop = false, travel = 0;
  for (; steps < (kind === "fling" ? FLINGS : MAX_STEPS); steps++) {
    const before = await d.eval<{ y: number; st: number; line: string } | null>("__win.snap()");
    const f = await facts(d);
    if (f.st <= 0.5) { reachedTop = true; break; }
    const dist = Math.min(Math.round(f.ch * STEP_OF_VIEW), Math.floor(f.st));
    if (kind === "programmatic") await d.eval(`__win.prog(${dist})`);
    else if (kind === "wheel") {
      await d.eval("__win.mode('input') && __win.stepNext()");
      await d.wheel(at.x, at.y, 0, -dist);
      await d.eval(`__win.moved(${f.st})`);
      await d.eval("__win.mode('still')");
    } else if (d.touch) {
      await d.eval("__win.mode('touch') && __win.stepNext()");
      await d.touch.fling(at.x, at.y, dist);
      await d.eval("__win.scrollIdle(250, 8000)");
      await d.eval("__win.mode('still')");
      travel += f.st - (await facts(d)).st;
    }
    await d.eval("__win.settle(100, 3000)");
    if (kind !== "fling" && before) {
      const after = await d.eval<{ y: number; st: number; lost: boolean } | null>("__win.since()");
      const off = after ? after.y - before.y - dist : Number.NaN;
      stepWorst = Math.max(stepWorst, Math.abs(off));
      if (!(Math.abs(off) <= 1)) {
        stepMiss++;
        if (stepViol.length < 8) stepViol.push(`step ${steps + 1}: "${before.line}" moved ${after ? r1(after.y - before.y) : "out of the dom"} px for a ${dist} px step${after?.lost ? " (its node was replaced; read by its turn)" : ""}`);
      }
    }
    if ((steps + 1) % 200 === 0) log(`     ${label}: step ${steps + 1}, scrollTop ${Math.round(f.st)}, ${Math.round((Date.now() - t0) / 1000)} s`);
    if (names) {
      const repeats = await d.eval<string[]>("__win.domDupes()");
      if (repeats.length) names.domRepeats++;
      if (steps % namesEvery === 0 || repeats.length) await readNames(d, names, `step ${steps + 1} (scrollTop ${Math.round(f.st)})`);
    }
  }
  if (names) await readNames(d, names, "the top");
  const rec = await d.eval<Rec>("__win.stop()");
  await d.eval(`__win.mark(${JSON.stringify(`${label}: after the pass`)})`);
  const shifts = await d.eval<Shifts>(`__win.shiftsBetween(${rec.t0}, ${rec.t1})`);
  return { rec, travel, steps, stepMiss, stepWorst, stepViol, reachedTop, shifts, names: names ?? { every: 0, reads: 0, dupes: new Map(), unnamedMax: 0, source: "", domRepeats: 0 }, ms: Date.now() - t0 };
}

function judgeDrift(d: Driver, where: string, kind: string, p: Pass) {
  const r = p.rec;
  const frames = `${r.frames} frames, ${r.still} still, ${r.fills} with layout above the eye (${Math.round(r.fillPx)} px), ${r.stillFills} of them in still frames; worst still move ${r1(r.worst)} px`;
  const touch = kind === "fling" ? `; ${r.touch} touch frames, worst layout change above the eye ${r1(r.worstTouch)} px, ${r.touchFill} over 1 px` : "";
  const stepsLine = kind === "fling" ? `${p.steps} flings of ${Math.round(STEP_OF_VIEW * 100)}% of the view each, ${Math.round(p.travel)} px travelled with their momentum` : `${p.steps} steps${p.reachedTop ? " to the top" : ", did not reach the top"}, ${p.stepMiss} off by more than 1 px (worst ${r1(p.stepWorst)} px)`;
  const ok = r.drift === 0 && r.touchFill === 0 && p.stepMiss === 0 && (kind === "fling" || p.reachedTop) && r.still > 0;
  const firsts = [...p.stepViol.slice(0, 3), ...r.viol.slice(0, 3).map((v) => `frame drift ${JSON.stringify(v)}`), ...r.touchViol.slice(0, 3).map((v) => `fill-in under the finger ${JSON.stringify(v)}`)];
  record("1", d.engine, `${where} ${kind}`, ok, `${stepsLine}; ${frames}${touch}; anchor nodes replaced ${r.lost} times; ${Math.round(p.ms / 1000)} s${firsts.length ? `\n       ${firsts.join("\n       ")}` : ""}`);
}

/** check 8: no frame paints an empty turn box where the reader can see it (below the bar). a pass with no finger on the glass is held to it;
    a touch fling is printed, not judged: while a finger or its momentum moves, the window lets turns above the view wait (a fill there
    would move the eye or end an ios fling), so a turn entering from above is filled only once it is on screen */
function judgeBlank(d: Driver, where: string, kind: string, r: Rec, touch: boolean) {
  const evidence = `${r.frames} frames, ${r.blankFrames} with an empty turn box in view (worst ${r.blankWorst} px of the view); ${r.gaps} frames over 50 ms, the longest ${Math.round(r.worstGap)} ms (timing, printed, not judged)${r.blankViol.length ? `\n       ${JSON.stringify(r.blankViol.slice(0, 4))}` : ""}`;
  record("8", d.engine, `${where} ${kind}`, touch ? null : r.frames > 0 && r.blankFrames === 0, touch ? `by design a turn above the view waits while a finger moves: ${evidence}` : evidence);
}

/** a fast continuous scroll up past what is filled: wheels sent back to back, the frames read as they paint */
async function fastWheel(d: Driver, label: string): Promise<{ rec: Rec; wheels: number; moved: number; ms: number }> {
  const at = await middle(d);
  await d.eval("__win.settle(400, 15000)");
  const st0 = (await facts(d)).st;
  await d.eval(`__win.start(${JSON.stringify(label)}) && __win.mode('input')`);
  const t0 = Date.now();
  let wheels = 0;
  for (; wheels < FAST_WHEELS; wheels++) {
    await d.wheel(at.x, at.y, 0, -FAST_WHEEL);
    if ((await facts(d)).st <= 0.5) break;
  }
  const ms = Date.now() - t0;
  await d.eval("__win.settle(300, 5000)");
  const rec = await d.eval<Rec>("__win.stop()");
  return { rec, wheels, moved: Math.round(st0 - (await facts(d)).st), ms };
}

function judgeShift(d: Driver, where: string, kind: string, p: Pass) {
  if (!p.shifts.supported) return record("5", d.engine, `${where} ${kind}`, null, "the engine reports no layout-shift entries (PerformanceObserver.supportedEntryTypes has no layout-shift); check 1's frames are the stability reading here");
  const score = Math.round(p.shifts.sum * 1000);
  record("5", d.engine, `${where} ${kind}`, score === 0, `cumulative ${p.shifts.sum.toFixed(5)} over ${p.shifts.counted} entries without recent input (score ${score} of a budget of 0 thousandths); ${r1(p.shifts.withInput)} more after input${p.shifts.worst.length ? `; worst ${JSON.stringify(p.shifts.worst).slice(0, 300)}` : ""}`);
}

/* ---------- check 5's second half: the app's perf.shift rows ---------- */
type Row = { at: number; kind: string; device_class?: string; props?: Record<string, unknown>; surface?: string };
function telemetryRows(since: number): Row[] {
  if (!existsSync(TELEMETRY)) return [];
  return readdirSync(TELEMETRY)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(TELEMETRY, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row))
    .filter((r) => r.at >= since);
}
/** the page hidden and shown again: the app writes the perf.shift row for the visible stretch that ended, and starts a new one. the
    rows that reached the server in the moments after, or null where the page did not hide */
async function hideForShift(d: Driver): Promise<Row[] | null> {
  const from = Date.now();
  if (!(await d.hide())) return null;
  await Bun.sleep(2500);
  return telemetryRows(from - 50).filter((r) => r.kind === "perf.shift" && r.at <= from + 6000);
}
const scoresOf = (rows: Row[]) => rows.map((r) => `${String(r.props?.["score"])} (${String(r.props?.["shifts"])} shifts)`).join(", ");
/** the app's perf.shift for a stretch of scrolling alone, ended by a hide; the stretch before it was ended by one too */
async function perfShiftRows(d: Driver, where: string, what: string, before: Row[] | null, from: number) {
  const entries = await d.eval<Array<{ t: number; v: number; during: string; src: string[] }>>(`__win.shiftsLabelled(${from}, performance.now())`);
  if (entries.length) log(`     the layout-shift entries in the stretch of the ${what} passes, by what the drive was doing: ${JSON.stringify(entries.slice(0, 8)).slice(0, 900)}`);
  const rows = await hideForShift(d);
  if (rows === null || before === null) return record("5", d.engine, `${where} perf.shift ${what}`, null, "the page did not hide behind another tab, so the app wrote no perf.shift row");
  const scores = rows.map((r) => Number(r.props?.["score"] ?? Number.NaN));
  record("5", d.engine, `${where} perf.shift ${what}`, rows.length > 0 && scores.every((s) => s === 0), rows.length ? `the stretch of the ${what} passes: ${scoresOf(rows)} (thousandths; budget 0)` : `no perf.shift row reached ${TELEMETRY} after the page hid`);
}
/** a stretch the harness makes and a device never does (the thread opening, chrome's touch emulation switched on or off), ended by a
    hide so it stays out of the judged rows: printed with the layout-shift entries in it, not judged */
async function unjudged(d: Driver, what: string, since: number): Promise<Row[] | null> {
  const rows = await hideForShift(d);
  const inside = await d.eval<Shifts>(`__win.shiftsBetween(${since}, performance.now())`);
  log(`     outside the judged stretches, ${what}: perf.shift ${rows === null ? "not written (the page did not hide)" : rows.length ? scoresOf(rows) : "no row"}; layout-shift entries ${inside.counted} without input, ${inside.sum.toFixed(4)}${inside.worst.length ? `, ${JSON.stringify(inside.worst).slice(0, 260)}` : ""}`);
  return rows;
}
const pageNow = (d: Driver) => d.eval<number>("performance.now()");

/* ---------- check 9: hops between threads on a wide stage while one streams (a reader's blank, 5ffff12) ---------- */
/** the wide layouts home shows its windows beside the stage at */
const HOP_WIDTHS: Array<[number, number]> = [[1512, 945], [1728, 1117]];
const HOP_TITLE = "window: hop thread";
/** a thread of about 140 messages, the size of the one that blanked: seeded once through the bench model, kept by the daemon */
async function hopThread(): Promise<string> {
  const sessions = (await daemonCall<Array<{ id: string; title: string; parentID?: string }>>("GET", "/session")).json;
  const found = sessions.find((s) => s.title === HOP_TITLE && !s.parentID);
  if (found) return found.id;
  const id = (await daemonCall<{ id: string }>("POST", "/session", { title: HOP_TITLE })).json.id;
  const kinds = ["[bench:code 0]", "[bench:think 30 0]", "[bench:words 300 0]", "[bench:code 0]", "[bench:words 120 0]"];
  for (let i = 0; i < 50; i++) {
    await prompt(id, `${kinds[i % kinds.length]} hop turn ${i}`);
    const t0 = Date.now();
    while ((await busy(id)) || Date.now() - t0 < 200) await Bun.sleep(200);
  }
  return id;
}
type HopSecond = { writes: number; writesQuiet: number; writesGrowing: number; writesFollow: number; writesStill: number; shifts: number; shiftsQuiet: number; score: number; tailShifts: number; tailScore: number; inspectorShifts: number; inspectorScore: number; chipShifts: number; chipScore: number; pageShifts: number; pageScore: number; blank: number; eyeDown: number; eyeDownPx: number; drops: number; dips: number; dipsHeld: number; keys: Record<string, number>; phase: string };
type HopWatch = { t0: number; seconds: Record<string, HopSecond>; frames: number; blankFrames: number; first: Record<string, unknown> | null; firstAt: number; drop: Record<string, unknown> | null; dip: Record<string, unknown> | null; dipHeld: Record<string, unknown> | null; still: Record<string, unknown> | null };
/** a long reply streams in the hop thread while the drive taps home's windows of two other threads and back, every 2.5 s, through the
    settle and 6 s past it; layout shifts and scroll writes are counted per second, away from the reader's own taps (a second after one) */
async function hops(d: Driver, session: string) {
  const a = await hopThread();
  const others = (await daemonCall<Array<{ id: string; title: string; parentID?: string }>>("GET", "/session")).json.filter((s) => !s.parentID && s.id !== a && s.id !== session).slice(0, 1).map((s) => s.id);
  const three = [a, session, ...others];
  /* each of the three gets a window on home: a thread shows one once it has done something */
  for (const id of three) { await settleThread(id); await prompt(id, `[bench:words 3 0] (hop ${RUN}) wake`); }
  for (const id of three) await settleThread(id);
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of HOP_WIDTHS) {
    const where = `${w}x${h} hops`;
    await d.viewport(w, h);
    await openThread(d, a);
    const windows = await d.eval<string[]>("[...document.querySelectorAll('.win[data-key]')].map((x) => x.getAttribute('data-key'))");
    const tap = async (id: string) => {
      const at = await d.eval<{ x: number; y: number } | null>(`(() => { const w = document.querySelector('.win[data-key="bench:${id}"]'); if (!w) return null; w.scrollIntoView({ block: 'nearest' }); const r = w.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(40, r.height / 2) }; })()`);
      if (at) await d.click(at.x, at.y);
      return at !== null;
    };
    await d.eval("__win.watchHops()");
    await prompt(a, `[bench:words 1200 15] (hop ${RUN}) a long reply while the reader hops between threads`);
    const t0 = Date.now();
    while (!(await working(a)) && Date.now() - t0 < 10_000) await Bun.sleep(100);
    await d.eval("__win.hopPhase('streaming')");
    const order = [three[2] ?? three[1] ?? a, three[1] ?? a, a];
    let i = 0, settledAt = 0, taps = 0, missed = 0, blankShot = "", stormShot = "";
    while (Date.now() - t0 < 150_000) {
      const id = order[i++ % order.length] as string;
      if (await tap(id)) taps++; else missed++;
      for (let k = 0; k < 10; k++) {
        await Bun.sleep(250);
        if (!blankShot && (await d.eval<number>("__win.hopWatch ? __win.hopWatch.blankFrames : 0")) > 0) { blankShot = join(SHOTS, `9-${d.engine}-${w}-hops-blank.png`); await d.screenshot(blankShot).catch(() => { blankShot = ""; }); }
      }
      if (id === a && !settledAt && !stormShot) { stormShot = join(SHOTS, `9-${d.engine}-${w}-hops-streaming.png`); await d.screenshot(stormShot).catch(() => { stormShot = ""; }); }
      if (!settledAt && !(await working(a))) { settledAt = Date.now(); await d.eval("__win.hopPhase('after the settle')"); }
      if (settledAt && Date.now() - settledAt > 6000) break;
    }
    await tap(a);
    await Bun.sleep(5000);
    const hw = await d.eval<HopWatch>("__win.stopHops()");
    const secs = Object.entries(hw.seconds);
    const supported = await d.eval<boolean>("__win.shiftSupported");
    const shifts = secs.reduce((n, [, s]) => n + s.shiftsQuiet, 0);
    const score = Math.round(secs.reduce((n, [, s]) => n + s.score, 0) * 1000);
    /* shifts by where their sources are (window-page.ts, shiftClass). check 9 is the stage's check: home's are counted and printed,
       not judged, its windows' live tails (`.win .tail`, the streaming thread's window rotating its lines) and the rest of home (its
       rail, its window cards' chip and clock, its bar's summary: home's lane, docs/open.md). judged at 0, each on its own line: the
       stage (every entry a source of the stage's moved in, and one with no source), the inspector (the details panel), the composer's
       chips */
    const total = (f: (s: HopSecond) => number) => secs.reduce((n, [, s]) => n + f(s), 0);
    const tailShifts = total((s) => s.tailShifts);
    const tailScore = Math.round(total((s) => s.tailScore) * 1000);
    const inspectorShifts = total((s) => s.inspectorShifts);
    const inspectorScore = Math.round(total((s) => s.inspectorScore) * 1000);
    const chipShifts = total((s) => s.chipShifts);
    const chipScore = Math.round(total((s) => s.chipScore) * 1000);
    const pageShifts = total((s) => s.pageShifts);
    const pageScore = Math.round(total((s) => s.pageScore) * 1000);
    /* writes away from a tap: one while the stage's turn count is growing (rose in the last 500 ms: a log coming in, a new turn) keeps
       the place under it, and a view at the end moved down by what the content grew, less than a screen, is the streaming thread's
       follow; neither is judged. more than 3 of any other in a second is a still thread being written to */
    const restless = secs.filter(([, s]) => s.writesStill > 3);
    const worst = secs.filter(([, s]) => s.shiftsQuiet > 0 || s.inspectorShifts > 0 || s.chipShifts > 0 || s.pageShifts > 0 || s.writesStill > 3 || s.blank > 0 || s.eyeDown > 0 || s.drops > 0 || s.dips > 0).sort((x, y) => y[1].drops - x[1].drops || y[1].score - x[1].score || y[1].eyeDownPx - x[1].eyeDownPx).slice(0, 6).map(([k, s]) => `s${k} ${s.phase} on ${Object.keys(s.keys).map((x) => x.slice(-6)).join("+")}: ${s.drops} drops, ${s.dips} dips, shifts: stage ${s.shiftsQuiet} (${Math.round(s.score * 1000)}), inspector ${s.inspectorShifts} (${Math.round(s.inspectorScore * 1000)}), chips ${s.chipShifts} (${Math.round(s.chipScore * 1000)}), page ${s.pageShifts} (${Math.round(s.pageScore * 1000)}), tails ${s.tailShifts}; writes: still ${s.writesStill}, follow ${s.writesFollow}, turns coming in ${s.writesGrowing}; eye down ${s.eyeDown} (${s.eyeDownPx} px), ${s.blank} blank`);
    const sources = supported ? await d.eval<string>(`(() => { const by = {}; for (const s of __win.shifts) { if (s.input || s.t < ${hw.t0}) continue; const c = s.cls || 'page'; const k = s.src.join(' | '); const m = (by[c] = by[c] || {}); m[k] = (m[k] || 0) + Math.round(s.v * 1000); } const out = {}; for (const c of Object.keys(by)) out[c] = Object.entries(by[c]).sort((x, y) => y[1] - x[1]).slice(0, 3); return JSON.stringify(out); })()`) : "";
    /* the eye's line going down the screen away from a tap, printed: following the end moves it up, but the end shrinking at the settle
       moves it down by right. the stage drawing fewer turns than the frame before on the same thread, or its content losing more than
       200 px, is judged in every engine: it is the re-open the shifts come from, and webkit reports no shifts */
    const eyeDown = secs.reduce((n, [, s]) => n + s.eyeDown, 0);
    const eyeDownPx = secs.reduce((n, [, s]) => n + s.eyeDownPx, 0);
    const drops = secs.reduce((n, [, s]) => n + s.drops, 0);
    const dips = secs.reduce((n, [, s]) => n + s.dips, 0);
    const dipsHeld = secs.reduce((n, [, s]) => n + s.dipsHeld, 0);
    const ok = (supported ? score === 0 && inspectorScore === 0 && chipScore === 0 : true) && drops === 0 && dips === 0 && restless.length === 0 && hw.blankFrames === 0 && missed === 0;
    const shiftLines = supported
      ? `\n       the stage: ${shifts} layout shifts away from a tap, score ${score} thousandths (budget 0)` +
        `\n       the inspector: ${inspectorShifts} shifts, score ${inspectorScore} thousandths (budget 0)` +
        `\n       the composer's chips: ${chipShifts} shifts, score ${chipScore} thousandths (budget 0)` +
        `\n       home's rail, window cards and bar (.wins, .win, outside the tail): ${pageShifts} shifts, score ${pageScore} thousandths, printed, not judged` +
        `\n       home's window tails (.win .tail): ${tailShifts} shifts, score ${tailScore} thousandths, printed, not judged`
      : "";
    const writeLine = `\n       scroll writes away from a tap: ${total((s) => s.writesQuiet)}, of them ${total((s) => s.writesGrowing)} while turns came in, ${total((s) => s.writesFollow)} the streaming thread's follow, ${total((s) => s.writesStill)} on a still thread`;
    record("9", d.engine, where, ok, `${taps} taps on ${windows.length} windows (${missed} missed) over ${secs.length} s, through the settle; ${supported ? "layout shifts by where, below" : "no layout-shift entries in this engine"}; ${drops} painted frames drew fewer turns than the one before on the same thread and ${dips} lost more than 200 px of content with the view moving (budget 0 each), ${dipsHeld} lost it out of the view with the row in view held still, printed; the eye's line went down the screen away from a tap in ${eyeDown} frames (${eyeDownPx} px), printed; ${restless.length} seconds of more than 3 scroll writes on a still thread (budget 0); ${hw.blankFrames} blank frames${shiftLines}${writeLine}${worst.length ? `\n       ${worst.join("\n       ")}` : ""}${sources ? `\n       sources by where: ${sources}` : ""}${hw.still ? `\n       first write on a still thread: ${JSON.stringify(hw.still)}` : ""}${hw.drop ? `\n       first drop: ${JSON.stringify(hw.drop).slice(0, 900)}` : ""}${hw.dip ? `\n       first dip with no drop: ${JSON.stringify(hw.dip).slice(0, 1800)}` : ""}${hw.dipHeld ? `\n       first held dip: ${JSON.stringify(hw.dipHeld["what"]).slice(0, 600)}` : ""}${hw.first ? `\n       first blank, ${hw.firstAt} ms in: ${JSON.stringify(hw.first).slice(0, 900)}` : ""}${blankShot ? `\n       blank screen: ${blankShot}` : ""}${stormShot ? `\n       streaming screen: ${stormShot}` : ""}`);
  }
}

/* ---------- check 9: a turn settling ---------- */
/** the turns check 9 lets run: a streamed reply, a turn with tool steps, and one that starts an agent (the turn answers at once and
    the agent streams on in its own session for about 3 s, inside the 5 s read after the settle) */
const SETTLE_TURNS: Array<{ name: string; marker: string }> = [
  { name: "a streamed reply", marker: "[bench:words 300 15]" },
  { name: "a turn with tool steps", marker: "[bench:code 12]" },
  { name: "a turn that starts an agent", marker: "[bench:agent 120 25]" },
];
/** how long after the settle the view is still read: the blank was reported "at the end of a turn" */
const AFTER_SETTLE_MS = 5000;
type ViewWatch = { frames: number; blankFrames: number; longest: number; first: Record<string, unknown> | null; firstAt: number; blankNow: boolean; phases: Record<string, number>; last: Record<string, unknown>; drops: number; dips: number; drop: Record<string, unknown> | null; dip: Record<string, unknown> | null; dipsHeld: number; dipHeld: Record<string, unknown> | null };
async function settles(d: Driver, session: string, where: string) {
  const key = `bench:${session}`;
  mkdirSync(SHOTS, { recursive: true });
  for (const turn of SETTLE_TURNS) {
    for (const place of ["at the end", "scrolled up", "sent from the composer"] as const) {
      await settleThread(session);
      await openThread(d, session);
      if (place === "scrolled up") {
        const at = await middle(d);
        const ch = (await facts(d)).ch;
        for (let i = 0; i < 2; i++) { await d.wheel(at.x, at.y, 0, -ch); await Bun.sleep(250); }
        await d.eval("__win.settle(400, 8000)");
      }
      await d.eval(`__win.watchView(${JSON.stringify(key)})`);
      const words = `${turn.marker} (settle ${RUN}) ${turn.name}, ${place}`;
      if (place !== "sent from the composer") await prompt(session, words);
      else {
        /* the reader's own send: typed into the dock's composer and sent by its button, as a person does */
        const box = await d.eval<{ x: number; y: number } | null>("(() => { const t = __win.stage()?.querySelector('.stage-dock textarea'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
        if (!box) { record("9", d.engine, `${where} ${turn.name}, ${place}`, false, "the stage's dock has no composer to type into"); await d.eval("__win.stopView()"); continue; }
        await d.click(box.x, box.y);
        await d.type(words);
        const send = await d.eval<{ x: number; y: number } | null>("(() => { const b = __win.stage()?.querySelector('.stage-dock button.cz-send'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
        if (send) await d.click(send.x, send.y);
      }
      const shot = join(SHOTS, `9-${d.engine}-${where}-${turn.name.replace(/\W+/g, "-")}-${place.replace(/\W+/g, "-")}.png`);
      let shotTaken = false;
      const blankShot = async () => {
        if (shotTaken || !(await d.eval<boolean>("!!(window.__win && __win.viewWatch && __win.viewWatch.blankNow)").catch(() => false))) return;
        shotTaken = true;
        await d.screenshot(shot).catch(() => { shotTaken = false; });
      };
      const t0 = Date.now();
      while (!(await working(session)) && Date.now() - t0 < 10_000) { await blankShot(); await Bun.sleep(100); }
      await d.eval("__win.viewPhase('running')");
      /* settled: not at work nor parked on its agent, and no new message for 2 s */
      let count = -1, stableSince = Date.now();
      while (Date.now() - t0 < 150_000) {
        await blankShot();
        const n = (await messagesOf(session)).length;
        if (n !== count) { count = n; stableSince = Date.now(); }
        if (!(await working(session)) && Date.now() - stableSince >= 2000) break;
        await Bun.sleep(150);
      }
      await d.eval("__win.viewPhase('after the settle')");
      const settledAt = Date.now();
      while (Date.now() - settledAt < AFTER_SETTLE_MS) { await blankShot(); await Bun.sleep(150); }
      const w = await d.eval<ViewWatch>("__win.stopView()");
      const stillBlank = (w.last["why"] as string[] | undefined)?.length ? ` and still blank at the end: ${JSON.stringify(w.last["why"])}` : "";
      record("9", d.engine, `${where} ${turn.name}, ${place}`, w.frames > 0 && w.blankFrames === 0 && w.drops === 0 && w.dips === 0,
        `${w.frames} frames from the prompt to ${AFTER_SETTLE_MS / 1000} s after the settle, ${w.blankFrames} blank (${JSON.stringify(w.phases)}), the longest run ${w.longest} frames; ${w.drops} painted frames drew fewer turns than the one before and ${w.dips} lost more than 200 px of content with the view moving (a re-open); ${w.dipsHeld} lost it out of the view with the row in view held still (a far box measured again), printed${w.drop ? `\n       first drop: ${JSON.stringify(w.drop).slice(0, 700)}` : ""}${w.dip ? `\n       first dip: ${JSON.stringify(w.dip).slice(0, 1800)}` : ""}${w.dipHeld ? `\n       first held dip: ${JSON.stringify(w.dipHeld["what"]).slice(0, 600)}` : ""}${stillBlank}${w.first ? `\n       first blank, ${w.firstAt} ms in: ${JSON.stringify(w.first).slice(0, 1400)}${shotTaken ? `\n       screen: ${shot}` : ""}` : ""}`);
    }
  }
}

/* ---------- check 7 ---------- */
type Census = { ch: number; st: number; sh: number; nodes: number; turns: Array<{ i: number; top: number; bottom: number; mounted: boolean; ask: boolean }> };
async function domBound(d: Driver, where: string) {
  await d.eval("__win.settle(800, 20000)");
  await Bun.sleep(1000);
  const c = await d.eval<Census>("__win.census()");
  const n = c.turns.length;
  const near = (t: Census["turns"][number]) => t.bottom >= -SCREENS * c.ch && t.top <= c.ch + SCREENS * c.ch;
  const allowed = (t: Census["turns"][number]) => near(t) || t.i >= n - LAST_FEW || t.ask;
  const mounted = c.turns.filter((t) => t.mounted);
  const extra = mounted.filter((t) => !allowed(t));
  const inView = c.turns.filter((t) => t.bottom > 0 && t.top < c.ch);
  const blank = inView.filter((t) => !t.mounted);
  record("7", d.engine, where, extra.length === 0 && blank.length === 0 && n > 0, `${n} turns, ${mounted.length} holding rows, ${n - mounted.length} empty boxes; allowed ${c.turns.filter(allowed).length} (within ${SCREENS} screens of the view, the last ${LAST_FEW}, a pending ask); ${extra.length} mounted outside that${extra.length ? ` (turns ${extra.slice(0, 6).map((t) => t.i).join(", ")}${extra.length > 6 ? ", ..." : ""})` : ""}; ${blank.length} turns in view without rows; ${c.nodes} elements, scrollHeight ${c.sh}`);
}

/* ---------- check 3 ---------- */
type Place = { found: boolean; bar: number; st: number; max: number; ch: number; at: string | null; top?: number; bottom?: number; open?: boolean; lit?: boolean; mounted?: boolean; focused?: boolean };
/** the turn band: the target's top between the bar's foot and the foot plus its fade (a turn link lands at 72 on main, a row at 96) */
const inBand = (p: Place) => p.found && p.top !== undefined && p.top >= p.bar - 1 && p.top <= p.bar + CLEAR_OF_BAR + 1;
/** an ask: its top at the bar's foot plus the fade, or, when the end stops it short of that, the view at the end with the row whole */
const askLanded = (p: Place) => p.found && p.top !== undefined && p.bottom !== undefined && (Math.abs(p.top - (p.bar + CLEAR_OF_BAR)) <= 1 || (p.st >= p.max - 1 && p.top >= p.bar + CLEAR_OF_BAR - 1 && p.bottom <= p.ch + 1));
const describePlace = (p: Place) => (p.found ? `top ${r1(p.top ?? 0)} px (bar foot ${p.bar}, band ${p.bar} to ${p.bar + CLEAR_OF_BAR}), scrollTop ${Math.round(p.st)} of ${Math.round(p.max)}, url at=${p.at ?? "none"}${p.open !== undefined ? `, open ${p.open}` : ""}${p.focused ? ", card focused" : ""}` : `not in the dom (scrollTop ${Math.round(p.st)} of ${Math.round(p.max)})`);
async function landing(d: Driver, selector: string): Promise<{ first: Place; later: Place }> {
  await d.eval("__win.scrollIdle(300, 6000)");
  await d.eval("__win.settle(200, 4000)");
  await Bun.sleep(300);
  const first = await d.eval<Place>(`__win.place(${JSON.stringify(selector)})`);
  await Bun.sleep(1000);
  const later = await d.eval<Place>(`__win.place(${JSON.stringify(selector)})`);
  return { first, later };
}
function judgeTurnLanding(d: Driver, where: string, how: string, turnId: string, l: { first: Place; later: Place }, extra: { needOpen?: boolean; note?: string } = {}) {
  const held = l.first.top !== undefined && l.later.top !== undefined && Math.abs(l.later.top - l.first.top) <= 1;
  const named = extra.needOpen ? true : l.later.at === turnId;
  const opened = extra.needOpen ? l.later.open === true : true;
  /* a turn landed on and left an empty box is a turn not reached */
  const filled = l.later.mounted === true;
  record("3", d.engine, `${where} ${how}`, inBand(l.first) && inBand(l.later) && held && named && opened && filled, `landed ${describePlace(l.first)}; 1 s later ${describePlace(l.later)}${named ? "" : `; the url names ${l.later.at ?? "nothing"}, not the target ${turnId}`}${filled ? "" : "; the turn's box holds no rows"}${extra.note ? `; ${extra.note}` : ""}`);
}
/** opens the turns from the thread menu and taps the line named `label` after its clock (or, failing that, the one whose name starts with
    its first 60 characters); true, or what stopped it */
async function tapTurnLine(d: Driver, label: string): Promise<true | string> {
  const menu = await d.eval<{ x: number; y: number } | null>("(() => { const b = __win.stage()?.querySelector('button.more'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  if (!menu) return "no thread menu button on the stage";
  await d.click(menu.x, menu.y);
  await Bun.sleep(400);
  const item = await d.eval<{ x: number; y: number } | null>("(() => { const b = [...document.querySelectorAll('#stage-menu [role=menuitem]')].find((x) => x.textContent.startsWith('turns')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  if (!item) return "the thread menu has no turns item";
  await d.click(item.x, item.y);
  await Bun.sleep(900);
  const line = await d.eval<{ x: number; y: number } | null>(`(() => { const want = ${JSON.stringify(label.replace(/\s+/g, " ").trim())}; const name = (x) => (x.getAttribute('aria-label') || '').replace(/^turn at [^,]*, /, '').replace(/\\s+/g, ' ').trim(); const lines = [...document.querySelectorAll('button.ti')]; const b = lines.find((x) => name(x) === want) || lines.find((x) => name(x).startsWith(want.slice(0, 60))); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!line) return `no line in the turns list is named "${label.slice(0, 50)}"`;
  await Bun.sleep(300);
  await d.click(line.x, line.y);
  return true;
}
type Prompt = { id: string; label: string; m: Message };
/** the near landing (check 3, review a): the last prompt whose box is at least 1.2 screens above the view, put two screens above the place
    a landing gives it; the move is traced for how far it travelled and how many turns filled on the way */
async function reachNear(d: Driver, session: string, where: string, prompts: Prompt[]) {
  await openThread(d, session);
  /* a target the turns list names once: a prompt an earlier run sent twice would take the tap to its first sending */
  const key = (p: Prompt) => p.label.replace(/\s+/g, " ").trim().slice(0, 60);
  const counts = new Map<string, number>();
  for (const p of prompts) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  const ids = JSON.stringify(prompts.filter((p) => counts.get(key(p)) === 1).map((p) => p.id));
  const placeIt = `(() => { const s = __win.sc(); const ids = new Set(${ids}); const els = __win.turnEls(); const ch = s.clientHeight; let t = null;
    for (let i = els.length - 1; i >= 0; i--) { if (!ids.has(els[i].dataset.turn)) continue; if (__win.layoutTop(els[i], s) - s.scrollTop - 72 <= -1.2 * ch) { t = els[i]; break; } }
    if (!t) return null; t.dataset.windowNear = '1'; s.scrollTop = __win.layoutTop(t, s) - 72 + 2 * ch; return t.dataset.turn; })()`;
  const again = "(() => { const s = __win.sc(); const t = s.querySelector('[data-window-near]'); if (!t) return null; s.scrollTop = __win.layoutTop(t, s) - 72 + 2 * s.clientHeight; return Math.round(__win.layoutTop(t, s) - s.scrollTop); })()";
  const id = await d.eval<string | null>(placeIt);
  const target = prompts.find((p) => p.id === id);
  if (!id || !target) return record("3", d.engine, `${where} turns panel, near`, false, "no prompt turn lies more than 1.2 screens above the end");
  await d.eval("__win.settle(500, 10000)");
  await d.eval(again);
  await d.eval("__win.settle(500, 10000)");
  const startTop = await d.eval<number | null>(again);
  await d.eval("__win.settle(500, 10000)");
  await d.eval("(() => { const s = __win.sc(); window.__nearTrace = { moves: 0, fills: 0, from: s.scrollTop, last: s.scrollTop, mounted: __win.turnEls().filter(__win.mounted).length }; const t0 = performance.now(); const f = () => { const n = window.__nearTrace; if (s.scrollTop !== n.last) { n.moves++; n.last = s.scrollTop; } const m = __win.turnEls().filter(__win.mounted).length; if (m !== n.mounted) { n.fills += Math.max(0, m - n.mounted); n.mounted = m; } if (performance.now() - t0 < 4000) requestAnimationFrame(f); }; requestAnimationFrame(f); return 1; })()");
  const tapped = await tapTurnLine(d, target.label);
  if (tapped !== true) return record("3", d.engine, `${where} turns panel, near`, false, tapped);
  const l = await landing(d, `section.turn[data-turn="${target.id}"]`);
  const trace = await d.eval<{ moves: number; fills: number; from: number; last: number }>("window.__nearTrace");
  judgeTurnLanding(d, where, "turns panel, near", target.id, l, { note: `the target's top at ${startTop ?? "?"} px before the tap, moved ${Math.round(trace.from - trace.last)} px in ${trace.moves} frames, ${trace.fills} turns filled on the way` });
}
function judgeAskLanding(d: Driver, where: string, how: string, l: { first: Place; later: Place }, rule: "ask" | "band") {
  const held = l.first.top !== undefined && l.later.top !== undefined && Math.abs(l.later.top - l.first.top) <= 1;
  const ok = rule === "ask" ? askLanded(l.first) && askLanded(l.later) : (inBand(l.first) || askLanded(l.first)) && (inBand(l.later) || askLanded(l.later));
  record("3", d.engine, `${where} ${how}`, ok && held, `${rule === "ask" ? `the row's top wanted at ${l.first.bar + CLEAR_OF_BAR} px or where the end stops it` : "the row's top wanted in the band under the bar, or where the end stops it"}; landed ${describePlace(l.first)}; 1 s later ${describePlace(l.later)}`);
}

async function reachTurns(d: Driver, session: string, where: string, msgs: Message[]) {
  const prompts = msgs.flatMap((m) => { const label = promptOf(m); return label === null ? [] : [{ id: m.info.id, label, m }]; });
  /* the ruler: a reader holds its third hairline. the card says which turn that is; the landing is read for that turn */
  await openThread(d, session);
  const at = await middle(d);
  await d.wheel(at.x, at.y, 0, -60);
  await Bun.sleep(500);
  const tick = await d.eval<{ x: number; y: number; ticks: number } | null>("(() => { const r = document.querySelector('.thread-stage:not([inert]) .ruler, .ruler'); const b = r && r.children[2]; if (!b) return null; const box = b.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), ticks: r.children.length }; })()");
  let target = prompts[2];
  if (!tick) record("3", d.engine, `${where} ruler`, false, "the stage has no ruler with three hairlines");
  else {
    await d.down(tick.x, tick.y);
    await Bun.sleep(400);
    const card = await d.eval<string | null>("document.querySelector('.rcard span')?.textContent ?? null");
    await d.up(tick.x, tick.y);
    const named = prompts.find((p) => p.label === card?.trim());
    if (named) target = named;
    if (!target) record("3", d.engine, `${where} ruler`, false, "the thread has fewer than three prompts");
    else {
      const l = await landing(d, `section.turn[data-turn="${target.id}"]`);
      judgeTurnLanding(d, where, `ruler (hairline 3 of ${tick.ticks}, card "${(card ?? "none").slice(0, 40)}")`, target.id, l);
    }
  }
  if (!target) return;
  const turnSel = `section.turn[data-turn="${target.id}"]`;
  /* the turns panel, from the thread menu, the target's line tapped */
  await openThread(d, session);
  const tapped = await tapTurnLine(d, target.label);
  if (tapped !== true) record("3", d.engine, `${where} turns panel`, false, tapped);
  else judgeTurnLanding(d, where, "turns panel", target.id, await landing(d, turnSel));
  /* the turns panel to a turn about two screens up, from a thread opened afresh that no finger has touched: the smooth move
     (windowing.ts, SMOOTH_SCREENS), with turns coming within reach and filling while it travels. the view is put two screens under
     the target by a script, which is no finger either */
  await reachNear(d, session, where, prompts);
  /* the links: a turn, and a row of it */
  await openThread(d, session, `&at=${target.id}`);
  judgeTurnLanding(d, where, "link at=", target.id, await landing(d, turnSel));
  /* a row: the first tool step of the earliest prompt from the target on whose turn has one */
  let linked: { turn: string; part: Part } | null = null;
  for (let k = prompts.indexOf(target); k >= 0 && k < prompts.length && !linked; k++) {
    const from = msgs.indexOf((prompts[k] as (typeof prompts)[number]).m);
    const next = prompts[k + 1];
    const to = next ? msgs.indexOf(next.m) : msgs.length;
    const part = msgs.slice(from + 1, to).flatMap((m) => m.parts).find((p) => p.type === "tool");
    if (part) linked = { turn: (prompts[k] as (typeof prompts)[number]).id, part };
  }
  if (!linked) record("3", d.engine, `${where} link part=`, false, "no turn from the target on has a tool step to link");
  else {
    await openThread(d, session, `&at=${linked.turn}&part=${linked.part.id}`);
    judgeTurnLanding(d, where, `link part= (${linked.part.tool ?? "tool"} row, turn ${prompts.findIndex((p) => p.id === linked?.turn) + 1})`, linked.turn, await landing(d, `.row[data-part~="${linked.part.id}"]`), { needOpen: true });
  }
}

/* ---------- check 2 ---------- */
type PinWatch = { frames: number; landedAt: number; after: number; off: number; worst: number; offs: unknown[]; grew: number };
async function pinned(d: Driver, session: string, where: string) {
  await settleThread(session);
  /* a reply streaming as the thread opens: the stage lands at the end while turns above it fill in and the reply grows */
  await prompt(session, `[bench:words 360 22] (pin ${RUN}) write me a long note for the pin`);
  const t0 = Date.now();
  while (!(await busy(session)) && Date.now() - t0 < 10_000) await Bun.sleep(100);
  await Bun.sleep(1200);
  await d.goto(`/?thread=bench:${session}`);
  await d.eval("__win.watchPin()");
  const painted0 = await until(d, "window.boxbox && window.boxbox.painted() > 0", 30_000);
  const p0 = await d.eval<number>("window.boxbox.painted()");
  while (await busy(session)) await Bun.sleep(250);
  await Bun.sleep(1000);
  const w = await d.eval<PinWatch>("__win.stopPin()");
  const p1 = await d.eval<number>("window.boxbox.painted()");
  record("2", d.engine, `${where} pinned`, painted0 && w.landedAt >= 0 && w.off === 0 && w.after > 0, `landed at the end ${w.landedAt} ms after the rows drew; ${w.after} frames after it, ${w.off} with the end out of view (worst gap ${r1(w.worst)} px); the content grew in ${w.grew} frames; painted text ${p0} then ${p1} characters${w.offs.length ? `\n       ${JSON.stringify(w.offs).slice(0, 400)}` : ""}`);

  /* scrolled up: a reply arrives below, the view holds and the pill counts it */
  await d.eval("__win.settle(400, 8000)");
  const at = await middle(d);
  const ch = (await facts(d)).ch;
  for (let i = 0; i < 3; i++) { await d.wheel(at.x, at.y, 0, -ch); await Bun.sleep(250); }
  await d.eval("__win.settle(400, 8000)");
  const before = (await messagesOf(session)).length;
  const snap = await d.eval<{ y: number; st: number; line: string } | null>("__win.snap()");
  await d.eval("__win.start('scrolled up')");
  await prompt(session, `[bench:words 240 22] (read ${RUN}) and one more note while I read above`);
  const t1 = Date.now();
  while (!(await busy(session)) && Date.now() - t1 < 10_000) await Bun.sleep(100);
  while (await busy(session)) await Bun.sleep(250);
  await Bun.sleep(1200);
  const rec = await d.eval<Rec>("__win.stop()");
  const since = await d.eval<{ y: number; st: number; lost: boolean } | null>("__win.since()");
  const arrived = (await messagesOf(session)).length - before;
  const pill = await d.eval<string | null>("__win.stage()?.querySelector('.new-below')?.textContent ?? null");
  const counted = Number(pill?.match(/^(\d+) new messages? below$/)?.[1] ?? Number.NaN);
  const moved = snap && since ? since.y - snap.y : Number.NaN;
  record("2", d.engine, `${where} scrolled up`, rec.drift === 0 && Math.abs(moved) <= 1 && counted === arrived && arrived > 0, `the eye's line ("${snap?.line ?? "none"}") moved ${r1(moved)} px over the reply; ${rec.still} frames, worst ${r1(rec.worst)} px, ${rec.drift} over 1 px; the pill says "${pill ?? "nothing"}" for ${arrived} messages that arrived${rec.viol.length ? `\n       ${JSON.stringify(rec.viol.slice(0, 3))}` : ""}`);
}

/* ---------- the ask: check 3's landings and check 4 ---------- */
/** the messages queued behind the pending ask (review c), each of its own length: ten of one length clamp to ten "show all 476
    characters" controls of one name, a naming fault of the bubble that is not the window's to answer for here. a page shows a queued
    message as a bubble at the end only when the stream brings it: one sent before the page loaded is not drawn at all (the daemon's
    transcript does not list its queue), so they are sent with the page open */
const QUEUED = 3;
const queuedText = (k: number) => `queued ${RUN} note ${k}: ${"read this once the greeting is settled. ".repeat(3 + 2 * k).trim()}`;
/** a [bench:tools] turn that asks; answered at the end of the lane */
async function raiseAsk(session: string): Promise<string> {
  await settleThread(session);
  await prompt(session, `[bench:tools] (ask ${RUN}) tidy the greeting line in notes.md and tell me what changed`);
  const t0 = Date.now();
  for (;;) {
    const q = (await questionsOf(session))[0];
    if (q) return q.id;
    if (Date.now() - t0 > 60_000) throw new Error("the [bench:tools] question was not raised within 60 s");
    await Bun.sleep(300);
  }
}
/** review c: with the page open, the ask is answered, its turn ends, and the queued messages run, each replacing its queued bubble; then
    the turns panel goes to the first of them: it lands, and its box holds its rows */
async function queuedJump(d: Driver, session: string, where: string) {
  await openThread(d, session);
  for (let k = 1; k <= QUEUED; k++) await prompt(session, queuedText(k));
  const shown = await until(d, `[...document.querySelectorAll('.stage-scroll section.turn .you')].filter((y) => y.innerText.includes('queued ${RUN} note')).length >= ${QUEUED}`, 15_000);
  /* with them drawn under the ask, the dock's "wants you" line, tapped from the top of the thread, brings the ask (review a, at 390) */
  if (!shown) record("3", d.engine, `${where} dock line, queued under the ask`, false, `the ${QUEUED} queued messages were not drawn at the end within 15 s`);
  else {
    await d.eval("__win.toTop()");
    await d.eval("__win.settle(400, 8000)");
    await Bun.sleep(600);
    const line = await d.eval<{ x: number; y: number; hit: string } | null>("(() => { const b = __win.stage()?.querySelector('.stage-dock button.pinned:not([data-kind])'); if (!b) return null; const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const h = document.elementFromPoint(x, y); return { x, y, hit: h && b.contains(h) ? 'the line' : (h ? h.nodeName.toLowerCase() + '.' + h.className : 'nothing') }; })()");
    if (!line) record("3", d.engine, `${where} dock line, queued under the ask`, false, "scrolled to the top, the dock shows no \"wants you\" line");
    else {
      await d.click(line.x, line.y);
      judgeAskLanding(d, where, `dock line, ${QUEUED} queued messages under the ask (the tap hit ${line.hit})`, await landing(d, ASK_ROW), "band");
    }
  }
  /* then the ask is answered, its turn ends, the queued messages run and each replaces its bubble; the turns panel goes to the first */
  const q = (await questionsOf(session))[0];
  if (q) await daemonCall("POST", `/question/${q.id}/reply`, { answers: [[q.questions[0]?.options?.[0]?.label ?? "hi"]] });
  const t0 = Date.now();
  while ((await busy(session)) && Date.now() - t0 < 240_000) await Bun.sleep(500);
  await d.eval("__win.settle(600, 15000)");
  const first = (await messagesOf(session)).find((m) => promptOf(m)?.startsWith(`queued ${RUN} note 1:`));
  if (!first) return record("3", d.engine, `${where} queued, then landed`, false, "the first queued message never landed in the transcript");
  const tapped = await tapTurnLine(d, promptOf(first) ?? "");
  if (tapped !== true) return record("3", d.engine, `${where} queued, then landed`, false, tapped);
  judgeTurnLanding(d, where, "turns panel to a queued message once it landed", first.info.id, await landing(d, `section.turn[data-turn="${first.info.id}"]`));
}

const ASK_ROW = ".row[data-ask]";
async function reachAsk(d: Driver, session: string, ask: string, where: string, wide: boolean) {
  /* a push tapped: the url names the ask */
  await openThread(d, session, `&ask=${ask}`);
  judgeAskLanding(d, where, "push ask=", await landing(d, ASK_ROW), "ask");
  /* the dock's line, from the top of the thread, far from the ask */
  await d.eval("__win.toTop()");
  await d.eval("__win.settle(400, 8000)");
  await Bun.sleep(600);
  const line = await d.eval<{ x: number; y: number } | null>("(() => { const b = __win.stage()?.querySelector('.stage-dock button.pinned:not([data-kind])'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  if (!line) record("3", d.engine, `${where} dock line`, false, "scrolled to the top, the dock shows no \"wants you\" line");
  else {
    const hit = await hitAt(d, line.x, line.y);
    await d.click(line.x, line.y);
    judgeAskLanding(d, where, `dock line (the tap hit ${hit})`, await landing(d, ASK_ROW), "band");
  }
  /* the window's "answer" pill, with the stage already on the thread and far from the ask (the rail; the deck's windows are under the stage) */
  if (!wide) return record("3", d.engine, `${where} answer pill`, null, "on the deck home's windows lie under the open stage; the pill is reached through back, which closes the stage, so the stage's own go to an ask is driven by the dock line and the push here");
  await d.eval("__win.toTop()");
  await d.eval("__win.settle(400, 8000)");
  const pill = await d.eval<{ x: number; y: number } | null>(`(() => { const b = document.querySelector('.win[data-key="bench:${session}"] .wask'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!pill) return record("3", d.engine, `${where} answer pill`, false, "home shows no window with an \"answer\" tray for the thread");
  await d.click(pill.x, pill.y);
  // the tray opens the answer sheet over home (asks/sheet.tsx); its "open the thread" goes to the ask on the stage
  await Bun.sleep(600);
  const open = await d.eval<{ x: number; y: number } | null>("(() => { const b = document.querySelector('.asks-sheet .asks-open'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  if (!open) return record("3", d.engine, `${where} answer pill`, false, "the tray opened no answer sheet with \"open the thread\"");
  await d.click(open.x, open.y);
  judgeAskLanding(d, where, "answer pill", await landing(d, ASK_ROW), "ask");
}

type Kept = { ok: boolean; why: string };
type Spot = { x: number; y: number };
/** the middle of a row's head, the place a finger taps it */
const headOf = (part: string) => `(() => { const b = __win.sc().querySelector('.row[data-part="${part}"] > button.row-h'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + Math.min(60, r.width / 2), y: r.top + Math.min(12, r.height / 2) }; })()`;
async function nothingResets(d: Driver, session: string, msgs: Message[], where: string) {
  /* the early turn: the first prompt after the first whose turn wrote a file (an open write row has a wide bed), else one with any tool step */
  const prompts = msgs.flatMap((m, i) => (promptOf(m) === null ? [] : [i]));
  const turnWith = (test: (p: Part) => boolean) => {
    for (let k = 1; k < prompts.length; k++) {
      const from = prompts[k] ?? 0, to = prompts[k + 1] ?? msgs.length;
      if (msgs.slice(from + 1, to).some((m) => m.parts.some(test))) return msgs[from]?.info.id ?? "";
    }
    return "";
  };
  const turnId = turnWith((p) => p.type === "tool" && p.tool === "write") || turnWith((p) => p.type === "tool");
  const turnSel = `section.turn[data-turn="${turnId}"]`;
  await openThread(d, session);
  /* words typed into the pending ask's card, at the end */
  /* the ask is a few screens above the end, with the queued messages under it: brought into view by a script first */
  await d.eval("(() => { const s = __win.sc(); const i = s.querySelector('.row[data-ask] .ask-card input.ask-input'); if (i) s.scrollTop = __win.layoutTop(i, s) - 300; return 1; })()");
  await d.eval("__win.settle(400, 8000)");
  const input = await d.eval<Spot | null>("(() => { const i = __win.sc()?.querySelector('.row[data-ask] .ask-card input.ask-input'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  const words = "kept while i read far above";
  let inputHit = "no input";
  if (input) {
    inputHit = await hitAt(d, input.x, input.y);
    await d.click(input.x, input.y);
    await d.type(words);
  }
  const typed = await d.eval<string | null>("__win.sc()?.querySelector('.row[data-ask] input.ask-input')?.value ?? null");
  /* far from the ask: the early turn, brought into view (twice: rows above it settle as they come into the view) */
  const toTurn = `(() => { const s = __win.sc(); const t = s.querySelector('${turnSel}'); s.scrollTop = t ? __win.layoutTop(t, s) - 120 : 0; return !!t; })()`;
  await d.eval(toTurn);
  await d.eval("__win.settle(500, 10000)");
  await d.eval(toTurn);
  await d.eval("__win.settle(400, 8000)");
  let rowHit = "no row";
  /* a row opened: a closed row of the turn with something to open, a write row first */
  const part = await d.eval<string | null>(`(() => { const s = __win.sc(); const t = s.querySelector('${turnSel}'); if (!t) return null; const rows = [...t.querySelectorAll('.row:not(.open)')].filter((r) => r.querySelector(':scope > button.row-h')); const row = rows.find((r) => r.querySelector('.row-k')?.textContent === 'write') || rows[0]; if (!row) return null; s.scrollTop = __win.layoutTop(row, s) - 140; return row.dataset.part || null; })()`);
  if (part) {
    await Bun.sleep(300);
    const head = await d.eval<Spot | null>(headOf(part));
    if (head) { rowHit = await hitAt(d, head.x, head.y); await d.click(head.x, head.y); }
    await Bun.sleep(900);
  }
  /* a bed scrolled sideways by the reader's wheel: in the opened row first, else any code in the turn */
  const bed = await d.eval<Spot | null>(`(() => { const s = __win.sc(); const t = s.querySelector('${turnSel}'); if (!t) return null; const open = ${part ? `t.querySelector('.row[data-part="${part}"]')` : "null"}; const pool = [...(open ? open.querySelectorAll('*') : []), ...t.querySelectorAll('pre, .bed, code')]; const el = pool.find((e) => e.scrollWidth > e.clientWidth + 16 && /auto|scroll/.test(getComputedStyle(e).overflowX)); if (!el) return null; el.dataset.windowKept = '1'; const sr = s.getBoundingClientRect(); const r = el.getBoundingClientRect(); if (r.top < sr.top + 80 || r.top + 40 > sr.bottom) s.scrollTop += r.top - sr.top - 160; const r2 = el.getBoundingClientRect(); return { x: r2.left + r2.width / 2, y: r2.top + Math.min(20, r2.height / 2) }; })()`);
  if (bed) {
    await Bun.sleep(200);
    await d.wheel(bed.x, bed.y, 140, 0);
    await Bun.sleep(500);
  }
  /* keyboard focus: from the opened row's head, tab to the next control; a short turn's next control may be in the turn after, and
     then the focus stays on the row's own head */
  if (part) {
    await d.eval(`__win.sc().querySelector('.row[data-part="${part}"] > button.row-h').focus()`);
    await d.press("Tab");
    await Bun.sleep(200);
    if (!(await d.eval<boolean>(`document.activeElement?.closest('section.turn')?.dataset.turn === "${turnId}"`))) {
      await d.eval(`__win.sc().querySelector('.row[data-part="${part}"] > button.row-h').focus()`);
    }
  }
  type State = { open: boolean | null; scrolled: number | null; focus: string | null; focusTurn: boolean; typed: string | null };
  const STATE = `(() => { const s = __win.sc(); const row = ${part ? `s.querySelector('.row[data-part="${part}"]')` : "null"}; const bed = s.querySelector('[data-window-kept]'); const a = document.activeElement; const ft = a && a.closest && a.closest('section.turn'); return { open: row ? row.classList.contains('open') : null, scrolled: bed ? bed.scrollLeft : null, focus: a && a !== document.body ? (a.getAttribute('aria-label') || a.textContent || a.nodeName).trim().slice(0, 60) : null, focusTurn: !!ft && ft.dataset.turn === "${turnId}", typed: s.querySelector('.row[data-ask] input.ask-input')?.value ?? null }; })()`;
  await d.eval("(() => { window.__keptBed = document.querySelector('[data-window-kept]'); window.__keptFocus = document.activeElement; return 1; })()");
  const set = await d.eval<State>(STATE);
  /* far away and back: to the end (the ask in view), then to the early turn again */
  await d.eval("__win.toEnd()");
  await d.eval("__win.settle(500, 10000)");
  await Bun.sleep(1500);
  const atEnd = await d.eval<State>(STATE);
  await d.eval(toTurn);
  await d.eval("__win.settle(500, 10000)");
  await Bun.sleep(1500);
  const back = await d.eval<State>(STATE);
  const same = await d.eval<{ bed: boolean; focus: boolean }>("({ bed: !!window.__keptBed && window.__keptBed.isConnected, focus: !!window.__keptFocus && window.__keptFocus === document.activeElement })");
  const kept: Kept[] = [
    { ok: set.open === true && back.open === true, why: `the ${part ? "row" : "(no closed row found)"} opened: ${set.open} before, ${back.open} after${set.open ? "" : ` (the tap hit ${rowHit})`}` },
    { ok: (set.scrolled ?? 0) > 0 && back.scrolled !== null && Math.abs(back.scrolled - (set.scrolled ?? 0)) <= 1, why: `the bed scrolled sideways: ${set.scrolled ?? "no scrollable bed"} px before, ${back.scrolled ?? "gone"} after${same.bed ? " (same node)" : ""}` },
    { ok: set.focusTurn && back.focus === set.focus && back.focusTurn, why: `keyboard focus on "${set.focus ?? "nothing"}" in the early turn ${set.focusTurn ? "" : "(focus was not in the turn) "}before, on "${back.focus ?? "nothing"}" after${same.focus ? " (same node)" : ""}` },
    { ok: typed === words && atEnd.typed === words && back.typed === words, why: `the ask's words: "${typed ?? "no input"}" typed, "${atEnd.typed ?? "gone"}" at the end, "${back.typed ?? "gone"}" back at the early turn${typed === words ? "" : ` (the tap on the input hit ${inputHit})`}` },
  ];
  record("4", d.engine, where, kept.every((k) => k.ok), kept.map((k) => `${k.ok ? "kept" : "LOST"}: ${k.why}`).join("; "));
}

/* ---------- a lane: one engine, every check ---------- */
async function lane(engine: Engine, session: string) {
  log(`\n— ${engine}`);
  let d: Driver;
  try {
    d = engine === "chromium" ? await chrome() : await safari();
  } catch (e) {
    for (const c of ONLY) record(c, engine, "all", false, `the engine did not start: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  try {
    await signIn(d);
    for (const [w, h] of WIDTHS) {
      const where = `${w}x${h}`;
      await d.viewport(w, h);
      if (only("7") || only("1") || only("5") || only("6") || only("8")) {
        const f = await openThread(d, session);
        log(`     ${where}: opened at the end, scrollTop ${Math.round(f.st)} of ${f.sh - f.ch}, ${f.turns} turns, ${f.mounted} holding rows, ${f.nodes} elements`);
        if (only("7")) await domBound(d, where);
      }
      if (only("1") || only("5") || only("6") || only("8")) {
        const names: NamesTally = { every: 0, reads: 0, dupes: new Map(), unnamedMax: 0, source: "", domRepeats: 0 };
        /* every pass starts from the thread opened afresh at its end: once a pass has gone up through it, mount-once has filled every
           turn, and a second pass on the same page would meet no fill-in at all. the app's perf.shift rows are per visible stretch, and a
           hide ends one: the harness's own stretches (the opening, chrome's touch emulation switched on, which changes the page's
           pointer and hover media and lays it out again) are each ended by a hide of their own, so the judged row of a pass holds that
           pass's scrolling alone */
        const rowsOn = only("5") && (await d.eval<boolean>("__win.shiftSupported"));
        if (only("5") && !rowsOn) record("5", engine, `${where} perf.shift`, null, "the app's perf.shift sums layout-shift entries, which this engine does not report: its rows would read 0 whatever moved");
        let fresh = true;
        for (const kind of ["programmatic", "wheel", "fling"] as const) {
          if (kind === "fling" && !d.touch) {
            const why = "playwright's webkit has no touch scrolling to drive (its touchscreen only taps), so no fling or momentum can be made";
            if (only("1")) record("1", engine, `${where} fling`, null, `${why}; the rule that nothing fills in above the eye under a finger is unchecked here`);
            if (only("8")) record("8", engine, `${where} fling`, null, why);
            continue;
          }
          if (!fresh) await openThread(d, session);
          fresh = false;
          if (kind === "fling" && d.touch) { await d.touch.on(); await d.eval("__win.settle(400, 5000)"); }
          const before = rowsOn ? await unjudged(d, kind === "fling" ? "the thread opening and chrome's touch emulation switched on" : "the thread opening", 0) : null;
          const from = await pageNow(d);
          const pass = await passUp(d, kind, `${where} ${kind}`, kind === "programmatic" && only("6") ? names : null);
          if (only("1")) judgeDrift(d, where, kind, pass);
          if (only("5")) judgeShift(d, where, kind, pass);
          if (only("8")) judgeBlank(d, where, kind, pass.rec, kind === "fling");
          if (rowsOn) await perfShiftRows(d, where, kind, before, from);
          if (kind === "fling" && d.touch) await d.touch.off();
        }
        if (only("8")) {
          await openThread(d, session);
          const fast = await fastWheel(d, `${where} fast wheel`);
          judgeBlank(d, where, `fast wheel (${fast.wheels} wheels of ${FAST_WHEEL} px in ${fast.ms} ms, ${fast.moved} px)`, fast.rec, false);
        }
        if (only("6")) record("6", engine, where, names.reads > 0 && names.dupes.size === 0, `${names.reads} reads of ${names.source || "the tree"} over the programmatic pass (every ${names.every} steps and wherever the dom's labels repeated, ${names.domRepeats} steps); ${names.dupes.size} names repeated${names.dupes.size ? `: ${[...names.dupes.values()].slice(0, 5).join("; ")}` : ""}; at most ${names.unnamedMax} controls without a name`);
      }
      if (only("3")) await reachTurns(d, session, where, await messagesOf(session));
      if (only("9")) await settles(d, session, where);
    }
    if (only("9")) await hops(d, session);
    const [pw, ph] = WIDTHS[0] ?? [390, 844];
    const first = `${pw}x${ph}`;
    if (only("2")) {
      await d.viewport(pw, ph);
      await pinned(d, session, first);
    }
    if (only("3") || only("4")) {
      const ask = await raiseAsk(session);
      try {
        if (only("3")) {
          for (const [w, h] of WIDTHS) {
            await d.viewport(w, h);
            await reachAsk(d, session, ask, `${w}x${h}`, w >= 1400);
          }
        }
        if (only("4")) {
          await d.viewport(pw, ph);
          await nothingResets(d, session, await messagesOf(session), first);
        }
        if (only("3")) {
          await d.viewport(pw, ph);
          await queuedJump(d, session, first);
        }
      } finally {
        await settleThread(session);
      }
    }
    const errors = await d.eval<string[]>("window.__win ? __win.errors : []").catch(() => [] as string[]);
    log(`     page errors on the last page: ${errors.length ? errors.slice(0, 3).join(" | ") : "none"}`);
  } catch (e) {
    log(`FAIL ${engine}: the lane stopped: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    results.push({ check: "-", engine, where: "lane", verdict: "FAIL", evidence: e instanceof Error ? e.message : String(e) });
  } finally {
    await d.close().catch(() => undefined);
  }
}

/* ---------- the run ---------- */
const session = await prepareThread();
/* a run that only reads (checks 1, 5, 6, 7) leaves the thread as it found it: it answers no question, it waits for a busy turn */
if (only("2") || only("3") || only("4")) await settleThread(session);
else {
  const t0 = Date.now();
  while (await busy(session)) {
    if (Date.now() - t0 > 180_000) throw new Error(`the thread ${session} is still busy after 3 minutes`);
    await Bun.sleep(500);
  }
}
const shape = await shapeOf(session);
log(`the thread bench:${session}: ${shape.prompts} prompts, ${shape.messages} messages, ${shape.tools} tool steps (${shape.failed} failed, ${shape.writes} writes, ${shape.agents} agents), ${shape.fences} texts with fenced code`);
log(`boxbox ${BOXBOX}, daemon ${daemon.url}, engines ${ENGINES.join(", ")}, widths ${WIDTHS.map(([w, h]) => `${w}x${h}`).join(", ")}`);
if (shape.prompts < TURNS && !THREAD) log(`     the thread has fewer than ${TURNS} prompts`);
for (const engine of ENGINES) await lane(engine, session);

log("\ncheck                      engine    verdict  (each line above has its evidence)");
for (const [id, name] of Object.entries(CHECKS)) {
  if (!only(id)) continue;
  for (const engine of ENGINES) {
    const mine = results.filter((r) => r.check === id && r.engine === engine);
    const verdict = !mine.length ? "not run" : mine.some((r) => r.verdict === "FAIL") ? "FAIL" : mine.every((r) => r.verdict === "n/a") ? "n/a" : "pass";
    const parts = mine.map((r) => `${r.where} ${r.verdict}`).join(", ");
    log(`${`${id} ${name}`.padEnd(27)}${engine.padEnd(10)}${verdict.padEnd(9)}${parts}`);
  }
}
const failed = results.filter((r) => r.verdict === "FAIL").length;
log(`\n${failed ? `${failed} results failed` : "every check passed"}`);
process.exit(failed ? 1 : 0);
