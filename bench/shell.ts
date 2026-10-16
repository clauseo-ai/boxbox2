/* the shell's goal drive: every surface of the app, reached the way a person
   reaches it, against a real boxbox and the real cmx2 daemon behind it. it
   drives agent-browser through the accessibility tree at 390 (deck), 820
   (strip) and 1512 (rail), checks what painted against the server's own
   reads, and prints one line per check (`ok ...` / `FAIL ...`); any failure
   exits 1.

   before the widths, one scratch session is made in --session-dir. at each
   width, in a fresh browser (viewport set before the first page, signed in
   through the sign-in form by accessible name):

     0. at the strip and rail, an ask answered in its thread from its
        window: the stage first reads another thread, the scratch session
        asks, and its window keeps the size it rests at and previews the ask
        (design.md: an asking window never grows). the window's "answer"
        pill, by its name, swaps the stage to the asking thread with the
        ask's card focused, and the ask is answered there by the option's
        name. across the arrival, the swap and the answer nothing on the
        stage or in the other windows may move (the page's own
        layout-shift entries, each put where it happened: the stage and the
        other windows, the asking window's own content, the bar), and the
        stage's title is the element at its centre, with the stage's own
        right under its bar, before, during and after
     1. home: every window names a real session (its key is in /api/fleet)
        and at least one line of its tail is in that session's transcript;
        each window's title is the element at its own centre (a named
        control a pointer cannot reach is a bug too)
     2. a thread opened by its window's accessible name: rows on the stage.
        that is the asking thread (the strip and rail read another one since
        step 0); were it already on the stage, another window is poured
     3. the asking thread (the strip and rail open it by the bar's "<repo>
        wants you" when it is not on the stage already), its ask answered by
        the option's name: gone from the fleet's asks, the answer and the
        reply in the daemon's transcript
     4. back at home (the deck's back control; the strip and rail keep their
        stage): the thread no longer wants you, in its window or the bar
     5. machines by the bar's pill: the host's window shows the daemon's
        version, equal to GET /api/hosts
     6. a new terminal: `echo shell-$((40+2))` answers shell-42 on screen,
        then the terminal is killed by its own control and leaves the daemon
     7. settings: appearance changed, kept over a reload (the control and
        GET /api/prefs agree), then set back
     8. a reload on home, the thread, machines, settings and the terminal
        lands on the same route and surface
     9. each route's url opens that surface in a second signed-in browser
        (a second tab in the drive's own browser now and then stayed blank)
    10. a screenshot at every step, named by width and step
   then 11: the server's telemetry for the drive's devices and time window,
   every perf.* kind counted by width with p50 and p90; a kind whose trigger
   the drive performed and which has no rows is a gap, and fails.

     bun bench/shell.ts --origin http://127.0.0.1:3040 --password-file <file> \
       --host <name> --session-dir <scratch repo> [--shots /tmp/boxbox-shell-drive/shots] \
       [--agent-session <name>] [--data-dir ~/.local/share/boxbox] [--widths 390,820,1512] \
       [--session-id <ses_...>] [--bench [--daemon-password-file .cmx2/bench/password]]

   the scratch session: `cmx2 run --port <the host's port> --model
   anthropic/claude-haiku-4-5 "reply with the word ready"` in --session-dir
   (the installed cmx2 at ~/.local/share/cmx2/bin/cmx2), and each width's ask
   is a prompt asking haiku to use its question tool. --bench is the pinned
   dev daemon with the bench model (`just cmx2`): the session is made with
   the daemon's own POST /session in --session-dir, and the ask comes from the
   bench model's `[bench:tools]` script. --session-id reuses a scratch session
   made by an earlier run, and an ask it left pending is dismissed first.
   --data-dir is the server's data dir, where scripts/telemetry.ts reads the
   telemetry it wrote. --widths runs some of the three.

   every agent-browser command has a deadline, and a page that gives no frame
   is opened again in a fresh browser (docs/gotchas.md). the drive leaves no
   terminal running and no ask pending, and closes both browsers. */

import { $ } from "bun";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { shortWords } from "../app/src/ui/asks/words";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}
function required(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`shell drive: ${name} is required (see the head of bench/shell.ts)`);
    process.exit(2);
  }
  return value;
}
const tilde = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

const ORIGIN = required("--origin").replace(/\/$/, "");
const GATE = readFileSync(tilde(required("--password-file")), "utf8").trim();
const HOST = required("--host");
const SESSION_DIR = realpathSync(tilde(required("--session-dir")));
const SHOTS = tilde(flag("--shots") ?? "/tmp/boxbox-shell-drive/shots");
const AGENT = flag("--agent-session") ?? `shell-drive-${process.pid}`;
const DATA_DIR = tilde(flag("--data-dir") ?? join(homedir(), ".local/share/boxbox"));
const BENCH = args.includes("--bench");
const DAEMON_PASSWORD_FILE = tilde(flag("--daemon-password-file") ?? join(ROOT, ".cmx2/bench/password"));
const CMX2 = join(homedir(), ".local/share/cmx2/bin/cmx2");
const HEIGHTS: Record<number, number> = { 390: 844, 820: 1180, 1512: 945 };
const WIDTHS = (flag("--widths") ?? "390,820,1512").split(",").map(Number);
for (const w of WIDTHS) {
  if (!HEIGHTS[w]) {
    console.error(`shell drive: --widths takes 390, 820 and 1512, not ${w}`);
    process.exit(2);
  }
}
const PROMPT = BENCH
  ? "[bench:tools] use your question tool to ask me which greeting to use, with the options hello and hi, then reply with the one i pick and nothing else"
  : "use your question tool to ask me which greeting to use, with the options hello and hi, then reply with the one i pick and nothing else";
/** the option the drive picks, by its label */
const PICK = "hi";

/* ---------- evidence ---------- */
const started = Date.now();
let failures = 0;
function log(line: string) {
  console.log(line);
}
function check(ok: boolean, what: string, detail = ""): boolean {
  if (!ok) failures++;
  log(`${ok ? "ok" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  return ok;
}
async function until<T>(test: () => Promise<T | undefined | null | false>, ms = 15_000, every = 300): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await Bun.sleep(every);
  }
}

/* ---------- boxbox's api, signed in as the drive ---------- */
let cookie = "";
async function signInApi() {
  const res = await fetch(`${ORIGIN}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: GATE }) });
  if (!res.ok) throw new Error(`POST /api/login answered ${res.status}; check --password-file`);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}
async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: T }> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as T };
}

type Part = { id: string; type: string; text?: string; tool?: string; callID?: string; state?: { status?: string; input?: unknown; output?: unknown; title?: string } };
type Message = { info: { id: string; role: string }; parts: Part[] };
type Ask = { key: string; host: string; id: string; kind: string; request: { questions?: Array<{ question: string; options: Array<{ label: string }> }>; tool?: { messageID: string; callID: string } } };
type Fleet = { sessions: Array<{ key: string; host: string; id: string; status: { type?: string } | null }>; asks: Ask[] };
type HostStatus = { name: string; url: string; health: { version: string } | null };

const fleet = async () => (await api<Fleet>("/api/fleet")).json;
async function transcript(key: string, limit?: number): Promise<Message[]> {
  const [host, ...rest] = key.split(":");
  const id = rest.join(":");
  const query = limit ? `?limit=${limit}` : "";
  const { status, json } = await api<Message[]>(`/api/hosts/${encodeURIComponent(host ?? "")}/sessions/${encodeURIComponent(id)}/messages${query}`);
  return status === 200 && Array.isArray(json) ? json : [];
}
/** every string a transcript shows: text parts, and each tool's title, input and output */
function corpus(messages: Message[]): string {
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const message of messages) for (const part of message.parts) {
    if (part.text) strings.push(part.text);
    if (part.state) walk([part.state.title, part.state.input, part.state.output]);
  }
  return squash(strings.join("\n"));
}
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/* ---------- the scratch session ---------- */
async function hostStatus(): Promise<HostStatus> {
  const hosts = (await api<HostStatus[]>("/api/hosts")).json;
  const host = hosts.find((h) => h.name === HOST);
  if (!host) throw new Error(`the origin has no host named ${HOST}; it has ${hosts.map((h) => h.name).join(", ")}`);
  return host;
}

async function makeSession(): Promise<string> {
  const host = await hostStatus();
  const port = new URL(host.url).port;
  if (BENCH) {
    const password = readFileSync(DAEMON_PASSWORD_FILE, "utf8").trim();
    const auth = `Basic ${Buffer.from(`cmx2:${password}`).toString("base64")}`;
    const daemon = (path: string, body: unknown) =>
      fetch(new URL(path, host.url), { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await daemon("/session", { directory: SESSION_DIR });
    if (!created.ok) throw new Error(`the daemon's POST /session answered ${created.status}: ${await created.text()}`);
    const { id } = (await created.json()) as { id: string };
    const sent = await daemon(`/session/${id}/prompt_async`, { text: "reply with the word ready" });
    if (sent.status !== 202) throw new Error(`the daemon's prompt_async answered ${sent.status}`);
    log(`     made the scratch session ${id} with the daemon's POST /session in ${SESSION_DIR}`);
    // a second window, so the strip and the rail have another thread to pour before the scratch one
    if (!(await fleet()).sessions.some((s) => s.key !== `${HOST}:${id}`)) {
      const other = (await (await daemon("/session", { directory: SESSION_DIR })).json()) as { id: string };
      await daemon(`/session/${other.id}/prompt_async`, { text: "[bench:words 12 5] say a few words" });
      log(`     and ${other.id} beside it, so the strip and rail have a window to pour first`);
    }
    return id;
  }
  if (!existsSync(CMX2)) throw new Error(`no installed cmx2 at ${CMX2}`);
  const child = spawn(CMX2, ["run", "--port", port, "--model", "anthropic/claude-haiku-4-5", "reply with the word ready"], { cwd: SESSION_DIR, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((done) => child.once("exit", done));
  const id = /cmx2: session (ses_[A-Za-z0-9]+)/.exec(stderr)?.[1];
  if (!id) throw new Error(`cmx2 run exited ${code} without naming a session; stderr: ${stderr.slice(0, 300)}`);
  log(`     cmx2 run --port ${port} in ${SESSION_DIR} answered "${squash(stdout).slice(0, 60)}" and made ${id} (exit ${code})`);
  return id;
}

/** dismisses what the session still asks (a run that stopped mid-ask leaves one), through boxbox's own reject */
async function settleLeftovers(key: string): Promise<void> {
  for (const ask of (await fleet()).asks.filter((a) => a.key === key)) {
    const route = ask.kind === "question" ? `questions/${encodeURIComponent(ask.id)}/reject` : `permissions/${encodeURIComponent(ask.id)}`;
    const verb = { device: "shell-drive", deviceClass: "automation", clientID: crypto.randomUUID() };
    const body = ask.kind === "question" ? verb : { ...verb, reply: "reject" };
    const done = await api(`/api/hosts/${encodeURIComponent(ask.host)}/${route}`, { method: "POST", body });
    log(`     ${ask.kind} ${ask.id} was still pending on ${key}; dismissed it: ${done.status}`);
  }
}

/** the session's turn is over: not busy on the fleet, and the last message is the assistant's with text */
async function idle(key: string): Promise<boolean> {
  const session = (await fleet()).sessions.find((s) => s.key === key);
  if (!session || (session.status && session.status.type && session.status.type !== "idle")) return false;
  const last = (await transcript(key, 5)).at(-1);
  return last?.info.role === "assistant" && last.parts.some((p) => p.type === "text" && (p.text ?? "").trim().length > 0);
}

/* ---------- the browsers ---------- */
/* uncaught errors and rejections go to the console, where `agent-browser console` can read them, and a frame pump
   keeps headless chrome painting between commands (docs/gotchas.md) */
const WATCH = "(() => { if (window.__watched) return 1; window.__watched = 1; addEventListener('error', (e) => console.error('page error: ' + e.message)); addEventListener('unhandledrejection', (e) => console.error('page error: ' + String(e.reason))); const pump = () => requestAnimationFrame(pump); requestAnimationFrame(pump); return 1; })()";
const FRAME = "new Promise((r) => { const t = setTimeout(() => r('no frame'), 1500); requestAnimationFrame(() => { clearTimeout(t); r('frame'); }); })";
type Answer = { stdout: string; stderr: string; exitCode: number };

/** one agent-browser session. every command has a deadline: a page that stops painting can leave agent-browser
    waiting for minutes (docs/gotchas.md), and a drive that hangs proves nothing */
class Browser {
  device = "";
  constructor(readonly session: string, readonly role: string) {}
  async run(args: string[], timeoutMs = 40_000): Promise<Answer> {
    const proc = Bun.spawn(["agent-browser", "--session", this.session, ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (proc.signalCode === "SIGKILL") log(`     the ${this.role} browser gave no answer to "${args[0]}" in ${timeoutMs / 1000} s`);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }
  async text(...args: string[]): Promise<string> {
    return (await this.run(args)).stdout;
  }
  /** the page answers `{"v": value}` as json and agent-browser may quote it once more: exactly one layer is unwrapped */
  async evaluate<T>(expression: string): Promise<T | null> {
    const out = await this.text("eval", `(async () => JSON.stringify({ v: await (${expression}) }))()`);
    try {
      let parsed = JSON.parse(out) as unknown;
      if (typeof parsed === "string") parsed = JSON.parse(parsed) as unknown;
      return ((parsed as { v?: T }).v ?? null) as T | null;
    } catch {
      return null;
    }
  }
  watch() {
    return this.run(["eval", WATCH]);
  }
  tree(interactive = true) {
    return interactive ? this.text("snapshot", "-i") : this.text("snapshot");
  }
  async url(): Promise<string> {
    return (await this.text("get", "url")).replace(ORIGIN, "") || "/";
  }
  async framed(): Promise<boolean> {
    return (await this.run(["eval", FRAME], 10_000)).stdout.includes('frame"');
  }
  /** opens a path in this browser's tab, and checks the page paints */
  async open(path: string): Promise<boolean> {
    await this.run(["open", `${ORIGIN}${path}`], 45_000);
    await this.watch();
    return this.framed();
  }
  /** a new browser: the viewport set before the first page, then the app (docs/gotchas.md) */
  async fresh(w: number, h: number): Promise<void> {
    await this.run(["close"]);
    await Bun.sleep(1500);
    await this.run(["set", "viewport", String(w), String(h)]);
    await this.open("/");
    // the first viewport of a freshly launched browser can be lost: the page is asked, and set again if so
    if ((await this.evaluate<number>("innerWidth")) !== w) {
      await this.run(["set", "viewport", String(w), String(h)]);
      await this.run(["reload"]);
      await this.watch();
    }
  }
  /** the sign-in form, by its accessible names, then home */
  async signIn(): Promise<boolean> {
    const form = await until(async () => {
      const s = await this.tree();
      return s.includes('textbox "password"') && s.includes('button "sign in"') ? s : undefined;
    }, 10_000);
    const field = form ? refIn(form, "textbox", "password") : null;
    if (!field) return false;
    await this.run(["fill", `@${field}`, GATE]);
    const button = refIn(await this.tree(), "button", "sign in");
    if (!button || (await this.run(["click", `@${button}`])).exitCode !== 0) return false;
    const home = await until(async () => homeShows(await this.tree()), 15_000);
    this.device = (await this.evaluate<string>("localStorage.getItem('boxbox.device')")) ?? "";
    return Boolean(home);
  }
}
const main = new Browser(AGENT, "drive's");
/** deep links are pasted into a second signed-in browser: one tab, always in front. a second tab in the drive's own
    browser now and then stayed on about:blank or never painted, and agent-browser waited minutes on it */
const link = new Browser(`${AGENT}-link`, "deep link");

const ab = (...a: string[]) => main.run(a);
const abText = (...a: string[]) => main.text(...a);
const evaluate = <T>(expression: string) => main.evaluate<T>(expression);
const watch = () => main.watch();
async function pageErrors(): Promise<string[]> {
  const lines = (await abText("console")).split("\n").filter((l) => l.startsWith("[error]"));
  await ab("console", "--clear");
  return lines;
}
const tree = (interactive = true) => main.tree(interactive);
const quoted = (name: string) => `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** the ref of the element with exactly this role and accessible name */
function refIn(snapshot: string, role: string, name: string): string | null {
  const needle = `${role} ${quoted(name)}`;
  for (const line of snapshot.split("\n")) {
    const at = line.indexOf(needle);
    if (at < 0) continue;
    const after = line.slice(at + needle.length);
    if (after !== "" && !after.startsWith(" [") && !after.startsWith(":")) continue;
    const ref = /\[(?:[^\]]*, )?ref=(e\d+)/.exec(after)?.[1];
    if (ref) return ref;
  }
  return null;
}
const has = async (role: string, name: string) => refIn(await tree(), role, name) !== null;
/* transitions still running: the windows' grows, pours and rises (infinite pulses and carets are not in the way) */
const MOVING = "document.getAnimations().filter((a) => a.playState === 'running' && !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && Number.isFinite(a.effect?.getTiming().iterations)).length";
async function still(): Promise<boolean> {
  if (((await evaluate<number>(MOVING)) ?? 0) > 0) return false;
  await Bun.sleep(120);
  return ((await evaluate<number>(MOVING)) ?? 0) === 0;
}
/** clicks by role and exact accessible name from the tree, once nothing is moving: a control drawn on its way to its
    place is refused by agent-browser as covered (docs/gotchas.md). a failure prints the last answer and the tree */
async function press(role: string, name: string, ms = 15_000, keyboardIfCovered = false): Promise<boolean> {
  let last = "";
  const done = await until(async () => {
    if (!(await still())) {
      last = "transitions still running";
      return false;
    }
    const ref = refIn(await tree(), role, name);
    if (!ref) {
      last = `no ${role} named ${quoted(name)} in the tree`;
      return false;
    }
    const result = await ab("click", `@${ref}`);
    last = `${result.stderr}${result.stdout}`.trim();
    if (result.exitCode !== 0 && keyboardIfCovered && last.includes("is covered by")) {
      // a pointer cannot reach it (step 1 fails the cover); the keyboard is the other way a person activates it
      log(`     ${quoted(name)} is covered for a pointer (${last.replace(/^.*covered by (<[^>]+>).*$/s, "$1")}); activated by the keyboard instead`);
      await ab("focus", `@${ref}`);
      return (await ab("press", "Enter")).exitCode === 0;
    }
    return result.exitCode === 0;
  }, ms, 300);
  if (!done) {
    const named = (await tree()).split("\n").filter((l) => /\[(?:[^\]]*, )?ref=/.test(l)).map((l) => l.trim()).join(" ; ");
    log(`     agent-browser said: ${last.slice(0, 240)}\n     the tree: ${named.slice(0, 900)}`);
  }
  return Boolean(done);
}
const url = () => main.url();
/** the route a url names, as the shell reads it: the terminal over a screen over a thread over home */
function route(path: string): string {
  const params = new URL(path, ORIGIN).searchParams;
  const terminal = params.get("terminal");
  if (terminal) return `terminal ${terminal}`;
  const screen = params.get("screen");
  if (screen) return `screen ${screen}`;
  const thread = params.get("thread");
  return thread ? `thread ${thread}` : "home";
}
let width = 0;
/** the arrangement the page at this width chose (deck, strip or rail) */
let arrangementNow = "";
let step = 0;
async function shot(name: string) {
  step++;
  await until(still, 3000, 150);
  const file = join(SHOTS, `${width}-${String(step).padStart(2, "0")}-${name}.png`);
  await ab("screenshot", file);
  log(`     screenshot ${file}`);
}
let viewport: [number, number] = [390, 844];
/** devices the drive's browser had at this width: a restarted browser is a new device */
let devices: string[] = [];
/** reloads the drive's page, seconds after a tap as a person does: what the page measured must reach the server as it
    unloads, under the service worker as without it (docs/gotchas.md); answers when the reload was sent */
async function reloadPage(): Promise<number> {
  const path = await url();
  const sent = Date.now();
  await ab("reload");
  await watch();
  if (!(await main.framed())) await restart(path, "the reloaded page gave no frame");
  return sent;
}
/** a fresh browser, signed in again, on the path that was open: for a page whose clock stopped (docs/gotchas.md) */
async function restart(path: string, why: string) {
  log(`     ${why}; starting the drive's browser again`);
  await main.fresh(...viewport);
  if (await main.signIn()) devices.push(main.device);
  await main.open(path);
}
/** the surface a route shows, in the tree; resolves once it is there, and prints what the tree held if it never is */
async function shows(test: (snapshot: string) => boolean, ms = 12_000): Promise<string | undefined> {
  let last = "";
  const seen = await until(async () => {
    last = await tree();
    return test(last) ? last : undefined;
  }, ms, 300);
  if (!seen) log(`     after ${ms} ms at ${await url()} the tree held: ${last.split("\n").map((l) => l.trim()).join(" ; ").slice(0, 600) || "(nothing)"}`);
  return seen;
}
/** a url pasted into the second browser's address bar: a new document on that route, checked by its surface */
async function deepLink(name: string, path: string, test: (snapshot: string) => boolean) {
  const t0 = Date.now();
  if (!(await link.open(path))) {
    log(`     the deep link browser gave no frame; starting it again`);
    await link.fresh(...viewport);
    await link.signIn();
    await link.open(path);
  }
  let last = "";
  const seen = await until(async () => {
    last = await link.tree();
    return test(last);
  }, 25_000);
  const took = Date.now() - t0;
  const landed = await link.url();
  if (!seen) log(`     after 25000 ms at ${landed} the deep link's tree held: ${last.split("\n").map((l) => l.trim()).join(" ; ").slice(0, 600) || "(nothing)"}`);
  check(Boolean(seen) && route(landed) === route(path), `${width} deep link: ${name} opens from its url`, `${path} -> ${landed}${took > 3000 ? `, after ${took} ms` : ""}`);
}
async function reloadsTo(name: string, test: (snapshot: string) => boolean) {
  const before = await url();
  const t0 = await reloadPage();
  const seen = await shows(test, 25_000);
  const took = Date.now() - t0;
  const after = await url();
  check(Boolean(seen) && route(after) === route(before), `${width} reload lands on the same route: ${name}`, `${before} -> ${after}${took > 3000 ? `, after ${took} ms` : ""}`);
}

/** a window as it painted: a tool line of its tail is read by its object (the file, the command), the part a
    transcript holds as it is; the verb and the result are the window's own words */
type WindowSeen = { key: string; state: string; name: string; tail: string[] };
const windows = async () =>
  (await evaluate<WindowSeen[]>(
    "[...document.querySelectorAll('article.win[data-key]')].map((w) => ({ key: w.dataset.key, state: w.dataset.state, name: w.querySelector('.win-open')?.getAttribute('aria-label') ?? '', tail: [...w.querySelectorAll('ol.tail > li')].map((l) => (l.classList.contains('tool') ? (l.querySelector('b')?.innerText ?? '') : l.innerText).replace(/\\s+/g, ' ').trim()).filter(Boolean) }))",
  )) ?? [];
const homeShows = (snapshot: string) => snapshot.includes('button "machines"') && /button "[^"]*: /.test(snapshot);
const threadShows = (snapshot: string) => /region "thread: /.test(snapshot);
const machinesShows = (snapshot: string) => snapshot.includes('heading "machines"');
const settingsShows = (snapshot: string) => snapshot.includes('heading "settings"');
const terminalShows = (snapshot: string) => /region "terminal [^"]+"/.test(snapshot) && /textbox "type into terminal /.test(snapshot);
/** what the stage shows of the thread: its ledger rows, the prompts it was given and the prose it answered with, in
    the newest layer (a thread poured onto the strip or rail lies over the one leaving) */
const stageRows = async () => (await evaluate<number>("[...document.querySelectorAll('.thread-stage')].at(-1)?.querySelectorAll('.row, .turn .you, [data-part-text]').length ?? 0")) ?? 0;

/** the terminals the drive made, so none is left running when it stops */
const madeTerminals = new Set<string>();

/* ---------- one width ---------- */
type WidthRun = { width: number; devices: string[]; arrangement: string; key: string; openedKey: string; opened: boolean; replied: boolean; poured: boolean; /** a window's answer pill was tapped */ pilled: boolean };

async function signInByForm(): Promise<boolean> {
  await main.fresh(...viewport);
  const form = await shows((s) => s.includes('textbox "password"') && s.includes('button "sign in"'), 10_000);
  check(Boolean(form), `${width} the sign-in form is named in the tree`);
  const signed = await main.signIn();
  if (signed) devices.push(main.device);
  return check(signed, `${width} signed in through the form by its names`, main.device ? `device ${main.device}` : "");
}

async function raiseAsk(key: string, id: string): Promise<Ask | undefined> {
  if (BENCH) writeFileSync(join(SESSION_DIR, "notes.md"), "# notes\n\ngreeting: hello\n");
  const clientID = crypto.randomUUID();
  const sent = await api<{ answer?: { messageID?: string } }>(`/api/hosts/${encodeURIComponent(HOST)}/sessions/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    body: { device: "shell-drive", deviceClass: "automation", clientID, text: PROMPT },
  });
  check(sent.status === 202, `${width} the ask's prompt went through boxbox's POST /api/hosts/${HOST}/sessions/:id/prompt`, `${sent.status} ${JSON.stringify(sent.json).slice(0, 120)}`);
  const ask = await until(async () => (await fleet()).asks.find((a) => a.key === key && a.kind === "question"), 90_000, 500);
  check(Boolean(ask), `${width} the fleet holds the session's question`, ask ? `${ask.id}: ${ask.request.questions?.[0]?.question ?? ""}` : "none after 90 s");
  return ask;
}

/* the page's own layout shift, counted from here by a layout-shift observer it keeps until it is reloaded (perf.ts
   reports a page's shift only when the page is hidden, so a moment in the middle of a page is measured here). every
   shift counts, the ones right after the drive's own taps too, and each is put where it happened: inside the asking
   window (its own content changing as its agent works and asks: the window lane's), in the bar (its line's words
   changing), or anywhere else (the stage and the other windows, which an ask must never move). each keeps the nodes it
   moved, so a shift says what moved */
const SHIFT = `(() => {
  if (!window.__driveShift) {
    const shift = (window.__driveShift = { all: 0, window: 0, bar: 0, rest: 0, moved: [] });
    const where = (node) => {
      const el = node && node.nodeType === 1 ? node : node?.parentElement;
      if (!el) return "rest";
      if (window.__askKey && el.closest(".win")?.dataset.key === window.__askKey) return "window";
      return el.closest(".home .bar") ? "bar" : "rest";
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const places = (e.sources ?? []).map((s) => where(s.node));
        const place = places.includes("rest") || places.length === 0 ? "rest" : places.includes("window") ? "window" : "bar";
        shift.all += e.value;
        shift[place] += e.value;
        for (const s of e.sources ?? []) {
          const el = s.node && s.node.nodeType === 1 ? s.node : s.node?.parentElement;
          if (shift.moved.length < 96) shift.moved.push(where(s.node) + ": " + (el ? el.tagName.toLowerCase() + "." + [...el.classList].join(".") : "?") + " " + Math.round(s.previousRect.y) + " to " + Math.round(s.currentRect.y) + " (" + Math.round(e.value * 10000) / 10 + ")");
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  }
  return window.__driveShift;
})()`;
type Shift = { all: number; window: number; bar: number; rest: number; moved: string[] };
const shiftNow = async (askKey: string) => {
  await evaluate(`(window.__askKey = ${JSON.stringify(askKey)}, true)`);
  return (await evaluate<Shift>(SHIFT)) ?? { all: Number.NaN, window: Number.NaN, bar: Number.NaN, rest: Number.NaN, moved: [] };
};
/** a layout shift between two readings, said in thousandths and by where it happened, with what moved */
function shiftBetween(before: Shift, after: Shift): { rest: number; line: string } {
  const part = (name: keyof Omit<Shift, "moved">) => Math.round((after[name] - before[name]) * 10000) / 10;
  const moved = after.moved.slice(before.moved.length);
  return {
    rest: part("rest"),
    line: `${part("rest")} on the stage and the other windows; ${part("window")} inside the asking window and ${part("bar")} in the bar (thousandths)${moved.length ? `; moved: ${moved.join(", ")}` : ""}`,
  };
}

/* the thread on the stage is never under the windows (design.md, one layout law: an asking window keeps its size, so
   nothing of home reaches over the stage): the element at the centre of the stage's title (the big title, or the bar's
   once the big one has gone by) is that title, and the element just under the stage's bar is the stage's own */
const STAGE_TITLE = `(() => {
  const layer = [...document.querySelectorAll(".stage .layer")].at(-1);
  if (!layer) return { which: "", covered: "no thread on the stage" };
  const bar = layer.querySelector(".stage-bar");
  const condensed = bar?.classList.contains("on") ?? false;
  const title = condensed ? layer.querySelector(".stage-bar-title b") : layer.querySelector(".tb-h1");
  if (!bar || !title) return { which: "", covered: "the stage has no title" };
  const name = (el) => el ? el.tagName.toLowerCase() + "." + [...el.classList].join(".") + (el.closest(".win") ? " in the window " + JSON.stringify(el.closest(".win").querySelector("h2")?.textContent ?? "") : "") : "nothing";
  const t = title.getBoundingClientRect();
  const atTitle = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
  const b = bar.getBoundingClientRect();
  const s = layer.getBoundingClientRect();
  const below = document.elementFromPoint(s.left + s.width / 2, b.bottom + 16);
  const covered = [atTitle && title.contains(atTitle) ? "" : "its centre (" + Math.round(t.left + t.width / 2) + ", " + Math.round(t.top + t.height / 2) + ") is " + name(atTitle), below && layer.contains(below) ? "" : "under its bar is " + name(below)].filter(Boolean).join("; ");
  return { which: (condensed ? "the bar's title " : "the big title ") + JSON.stringify(title.textContent.trim().slice(0, 60)) + " at y " + Math.round(t.top), covered };
})()`;
async function stageTitle(what: string) {
  const seen = (await evaluate<{ which: string; covered: string }>(STAGE_TITLE)) ?? { which: "", covered: "the page did not answer" };
  check(seen.covered === "", `${width} ${what}: the stage's title is the element at its own centre and nothing of home covers the stage under its bar`, seen.covered ? `${seen.which}: ${seen.covered}` : seen.which);
}

/** at the strip and rail, puts a thread other than the scratch session's on the stage by its window's title; false when
    there is no other window to read */
async function readAnother(key: string, when: string): Promise<boolean> {
  const views = await windows();
  const mine = views.find((v) => v.key === key);
  // two threads of one repo with one title and one state share a window name; the drive taps one it can tell apart
  const other = views.find((v) => v.key !== key && v.name !== mine?.name);
  if (!other) {
    log(`     ${width} ${when}: no window but the scratch session's, so the stage reads the asking thread itself`);
    return false;
  }
  if (route(await url()) !== `thread ${other.key}`) await press("button", other.name, 15_000, true);
  const there = await until(async () => route(await url()) === `thread ${other.key}`, 8000);
  // the pour settles on the sheet spring (508 ms)
  await Bun.sleep(800);
  return check(Boolean(there), `${width} ${when}: the stage reads another thread, ${quoted(other.name)}`, await url());
}

/** the option the drive picks, by its label */
function pickOf(ask: Ask): string {
  const labels = ask.request.questions?.[0]?.options.map((o) => o.label) ?? [];
  return labels.find((l) => l.toLowerCase() === PICK) ?? labels.find((l) => l.toLowerCase().startsWith(PICK)) ?? labels[1] ?? PICK;
}

/* step 0, at the strip and rail: the person reads another thread (design.md: you read one thread and answer another
   without losing your place) when the scratch session asks. its window keeps the size it rests at and previews the ask;
   the pill's tap swaps the stage to the asking thread, the ask's card focused, and the ask is answered there. across
   all three nothing on the stage or in the other windows may move, and the stage's title is never covered */
/** true once the window's pill was tapped */
async function askFromWindow(key: string, id: string): Promise<boolean> {
  if (!(await readAnother(key, "before the ask"))) return false;
  // tapping a window far along the strip scrolls the row to it; the person scrolls back to the front, where the scratch
  // session's window is, so its pill is in sight
  if (arrangementNow === "strip") {
    await evaluate("(document.querySelector('.wins')?.scrollTo({ left: 0 }), true)");
    await Bun.sleep(600);
    const seen = await evaluate<boolean>(`(() => { const r = document.querySelector('.win[data-key=' + JSON.stringify(${JSON.stringify(key)}) + ']')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth; })()`);
    check(Boolean(seen), `${width} the scratch session's window is in sight at the front of the strip`);
  }
  const sizeOf = async () => (await evaluate<number[]>(`(() => { const r = document.querySelector('.win[data-key=' + JSON.stringify(${JSON.stringify(key)}) + ']')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : []; })()`)) ?? [];
  await shiftNow(key);
  await Bun.sleep(1500);
  const quiet = await shiftNow(key);
  const resting = await sizeOf();
  await stageTitle("before the ask");
  const ask = await raiseAsk(key, id);
  const previewed = await until(async () => ((await windows()).find((v) => v.key === key)?.state === "wants" ? true : undefined), 20_000);
  check(Boolean(previewed), `${width} the scratch session's window says it wants you`);
  // the preview's rise settles on the snap spring (467 ms)
  await Bun.sleep(900);
  const arrived = await shiftNow(key);
  holds(shiftBetween(quiet, arrived), "while the ask arrived and its window previewed it");
  const kept = await sizeOf();
  check(resting.length === 2 && kept.join("x") === resting.join("x"), `${width} the asking window kept the size it rests at`, `${resting.join(" x ")} before the ask, ${kept.join(" x ") || "no window"} with it`);
  await stageTitle("with the ask previewed in its window");
  await shot("ask-previewed");
  if (!ask) return false;
  const repo = (await windows()).find((v) => v.key === key)?.name.split(":")[0] ?? "";
  const pill = answerPill(await tree(), repo, ask.request.questions?.[0]?.question ?? "");
  const tapped = pill !== "" && (await press("button", pill, 20_000));
  check(tapped, `${width} tapped ${quoted(pill || `answer ${repo}: ...`)} by its name in its window`);
  // the window's tray opens the answer sheet over home (asks/sheet.tsx); its "open the thread" goes to the ask on the stage
  const opened = tapped && (await press("button", "open the thread", 20_000));
  check(opened, `${width} tapped "open the thread" in the answer sheet the tray opened`);
  const swapped = await until(async () => (route(await url()) === `thread ${key}` && (await stageRows()) > 0 ? true : undefined), 12_000);
  check(Boolean(swapped), `${width} the stage swapped to the asking thread`, await url());
  // the pour settles on the sheet spring (508 ms), and the stage's scroll to the ask after it
  await Bun.sleep(1200);
  const focus = await until(async () => {
    const seen = await evaluate<{ card: boolean; name: string; inStage: boolean }>(FOCUS);
    return seen?.card && seen.inStage ? seen : undefined;
  }, 6000, 250);
  check(Boolean(focus), `${width} the ask's card has focus on the asking thread's stage`, focus ? quoted(focus.name) : "focus is elsewhere");
  holds(shiftBetween(arrived, await shiftNow(key)), "while the pill swapped the stage to the asking thread");
  await stageTitle("with the asking thread on the stage");
  await shot("ask-opened");
  const label = pickOf(ask);
  const answered = await press("button", `answer ${label}`, 20_000);
  check(answered, `${width} tapped "answer ${label}" by its name in the thread`);
  const gone = await until(async () => !(await fleet()).asks.some((a) => a.id === ask.id), 15_000, 250);
  check(Boolean(gone), `${width} the ask answered in its thread left /api/fleet's asks`, ask.id);
  const before = await shiftNow(key);
  await until(() => idle(key), 60_000, 500);
  await Bun.sleep(900);
  holds(shiftBetween(before, await shiftNow(key)), "while the ask settled and the thread ran on");
  await stageTitle("after the ask was answered in its thread");
  await shot("ask-answered-in-thread");
  return tapped;
}

/** what holds focus, for the card a pill or a push sends the stage to: the ask's own card, on the stage's top layer */
const FOCUS = `(() => {
  const a = document.activeElement;
  const layer = [...document.querySelectorAll(".stage .layer")].at(-1);
  return { card: !!a && a.classList.contains("ask-card"), name: a?.getAttribute("aria-label") ?? "", inStage: !!layer && layer.contains(a) };
})()`;

/* an asking window keeps the size it rests at (design.md, one layout law) and the other windows sit side by side, so an
   ask, and the stage swapping to it, move nothing outside the asking window itself: perf.shift's budget is 0 at the strip
   and at the rail, where the asking window used to grow in its column by layout */
function holds(shift: { rest: number; line: string }, when: string) {
  check(shift.rest === 0, `${width} nothing on the stage or in the other windows moved ${when} (perf.shift's budget is 0)`, shift.line);
}

/** the name of the window's "answer" pill for `repo` and `question` (window.tsx: "answer <repo>: <the question, cut at 60 characters>"),
    in the tree, or "" when no button has it: a window of another thread that asks too has a pill of its own, told apart by its words */
function answerPill(snapshot: string, repo: string, question: string): string {
  const name = `answer ${repo}: ${shortWords(question, 60)}`;
  for (const line of snapshot.split("\n")) {
    const found = /button "((?:[^"\\]|\\.)*)"/.exec(line)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
    if (found === name) return found;
  }
  return "";
}

async function runWidth(w: number, key: string, id: string, version: string): Promise<WidthRun> {
  width = w;
  step = 0;
  const run: WidthRun = { width: w, devices: [], arrangement: "", key, openedKey: "", opened: false, replied: false, poured: false, pilled: false };
  log(`\n== ${w} x ${HEIGHTS[w]}`);

  viewport = [w, HEIGHTS[w] ?? 844];
  devices = run.devices;
  if (!(await signInByForm())) return run;
  run.arrangement = (await evaluate<string>("document.querySelector('.home')?.dataset.arrangement ?? ''")) ?? "";
  arrangementNow = run.arrangement;
  log(`     the page: ${await evaluate<string>("innerWidth + ' x ' + innerHeight")}, arrangement ${run.arrangement}`);
  await link.fresh(...viewport);
  const linked = await link.signIn();
  if (linked) run.devices.push(link.device);
  check(linked, `${width} the deep link browser signed in through the form too`, link.device ? `device ${link.device}` : "");

  /* 0. at the strip and rail, the window's "answer" pill takes the stage to its ask, answered in the thread, while the stage reads another thread */
  if (run.arrangement !== "deck") run.pilled = await askFromWindow(key, id);
  const ask = await raiseAsk(key, id);

  /* 1. home: every window names a real session */
  const wanted = await until(async () => {
    const seen = await windows();
    return seen.find((v) => v.key === key && v.state === "wants") ? seen : undefined;
  }, 20_000);
  check(Boolean(wanted), `${width} home: the scratch session's window says it wants you`, (wanted ?? (await windows())).find((v) => v.key === key)?.name ?? "no window for it");
  const seen = wanted ?? (await windows());
  await shot("home");
  const snapshot = await tree();
  const sessions = new Set((await fleet()).sessions.map((s) => s.key));
  check(seen.length > 0, `${width} home shows windows`, `${seen.length}`);
  for (const view of seen) {
    const real = sessions.has(view.key);
    const named = refIn(snapshot, "button", view.name) !== null;
    let matched = "";
    if (view.tail.length) {
      const lines = view.tail.map((l) => squash(l.replace(/^you asked:\s*/, ""))).filter((l) => l.length >= 3);
      let text = corpus(await transcript(view.key, 200));
      matched = lines.find((l) => text.includes(l)) ?? "";
      if (!matched) {
        text = corpus(await transcript(view.key));
        matched = lines.find((l) => text.includes(l)) ?? "";
      }
    }
    const tailOk = view.tail.length === 0 || matched !== "";
    check(real && named && tailOk, `${width} window ${quoted(view.name)} names a real session`, `${view.key} ${real ? "is" : "is NOT"} in /api/fleet; ${named ? "named in the tree" : "NOT named in the tree"}; ${view.tail.length === 0 ? "its tail is empty" : matched ? `tail line in the transcript: "${matched.slice(0, 70)}"` : `none of ${view.tail.length} tail lines is in the transcript, first: "${view.tail[0]?.slice(0, 70)}"`}`);
  }
  /* a named control a pointer cannot reach is a bug as much as an unnamed one: each window's title is checked to be the
     element at its own centre */
  const covers = (await evaluate<Array<{ key: string; covered: string }>>(
    "[...document.querySelectorAll('article.win[data-key]')].map((w) => { const b = w.querySelector('.win-open'); const r = b.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2; const inView = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight; const at = inView ? document.elementFromPoint(x, y) : b; return { key: w.dataset.key, covered: !at || b.contains(at) ? '' : at.tagName.toLowerCase() + '.' + [...at.classList].join('.') + ' (title box ' + Math.round(r.width) + ' x ' + Math.round(r.height) + ', h2 ' + Math.round(w.querySelector('h2').getBoundingClientRect().height) + ' px tall)' }; })",
  )) ?? [];
  for (const view of seen) {
    const cover = covers.find((c) => c.key === view.key)?.covered ?? "";
    check(cover === "", `${width} window ${quoted(view.name)}: its title is the element at its own centre, so a tap reaches it`, cover ? `covered by ${cover}` : "");
  }
  const bar = /button "([^"]*) wants? you"|button "(\d+) want you"/.exec(snapshot);
  check(Boolean(bar), `${width} home's bar says something wants you`, bar?.[0] ?? "no wants-you button in the bar");
  const homeUrl = await url();
  await deepLink("home", homeUrl, homeShows);
  await reloadsTo("home", homeShows);

  /* 2. a thread, by its window's accessible name: on the deck the asking one grows open; the strip and rail already
     hold it on stage (a tap there does nothing), so another window is poured onto the stage instead */
  const views = await windows();
  const pick = run.arrangement === "deck" || route(await url()) !== `thread ${key}` ? views.find((v) => v.key === key) : (views.find((v) => v.key !== key) ?? views.find((v) => v.key === key));
  run.openedKey = pick?.key ?? "";
  // the strip and rail never empty their stage, so the one window there is can already be on it, where a tap does nothing
  const alreadyOn = Boolean(pick) && run.arrangement !== "deck" && route(await url()) === `thread ${pick?.key}`;
  if (alreadyOn) log(`     ${width}: the scratch session is the only window and already on stage; no tap can pour it`);
  const tappedOpen = pick && !alreadyOn ? await press("button", pick.name) : false;
  run.poured = run.arrangement !== "deck" && tappedOpen;
  const onThread = await until(async () => route(await url()) === `thread ${run.openedKey}`, 8000);
  const rows = await until(async () => {
    const n = await stageRows();
    return n > 0 && threadShows(await tree()) ? n : 0;
  }, 12_000);
  run.opened = check(Boolean(pick) && (tappedOpen || alreadyOn) && Boolean(onThread) && Boolean(rows), `${width} the thread opened by its window's name ${quoted(pick?.name ?? "")} shows its turns on the stage`, `${await url()}, ${rows ?? 0} rows, prompts and replies`);
  await shot("thread");
  await deepLink("the thread", `/?thread=${encodeURIComponent(run.openedKey)}`, threadShows);
  await reloadsTo("the thread", threadShows);
  check((await until(stageRows, 10_000)) !== undefined, `${width} the thread after the reload shows its turns`, `${await stageRows()} rows, prompts and replies`);

  /* the asking thread on stage: it is already there on the deck; the strip and rail open it by the bar's "<repo> wants
     you" when that names it alone, and by its window's title otherwise */
  if (route(await url()) !== `thread ${key}`) {
    const mine = (await windows()).find((v) => v.key === key);
    const repo = mine?.name.split(":")[0] ?? "";
    const byBar = refIn(await tree(), "button", `${repo} wants you`) !== null;
    const how = byBar ? `the bar's "${repo} wants you"` : `its window's title ${quoted(mine?.name ?? "")}`;
    const tapped = byBar ? await press("button", `${repo} wants you`) : await press("button", mine?.name ?? "", 15_000, true);
    const there = await until(async () => route(await url()) === `thread ${key}` && (await stageRows()) > 0, 10_000);
    check(tapped && Boolean(there), `${width} the asking thread opened by ${how}`, await url());
  }

  /* 3. the ask, answered by its option's name */
  if (ask) {
    const label = pickOf(ask);
    const tapped = await press("button", `answer ${label}`, 20_000);
    check(tapped, `${width} tapped "answer ${label}" by its name in the thread`);
    const gone = await until(async () => !(await fleet()).asks.some((a) => a.id === ask.id), 15_000, 250);
    check(Boolean(gone), `${width} the ask left /api/fleet's asks`, ask.id);
    const settled = await until(async () => {
      const messages = await transcript(key, 20);
      const at = messages.findIndex((m) => m.parts.some((p) => p.type === "tool" && p.callID === ask.request.tool?.callID));
      const part = messages[at]?.parts.find((p) => p.callID === ask.request.tool?.callID);
      if (!part || part.state?.status !== "completed") return undefined;
      const reply = messages.slice(at + 1).filter((m) => m.info.role === "assistant").flatMap((m) => m.parts).filter((p) => p.type === "text" && (p.text ?? "").trim()).map((p) => squash(p.text ?? "")).join(" ");
      if (!reply || !(await idle(key))) return undefined;
      return { answer: squash(String(part.state.output ?? "")), reply };
    }, 90_000, 500);
    const answered = Boolean(settled && settled.answer.toLowerCase().includes(`"${label.toLowerCase()}"`));
    const replied = Boolean(settled && (BENCH || new RegExp(`\\b${PICK}\\b`, "i").test(settled.reply)));
    check(answered, `${width} the daemon's transcript holds the answer`, settled?.answer.slice(0, 100) ?? "the question part never completed");
    run.replied = check(replied, `${width} the reply after it is in the transcript and the turn is over`, settled ? `"${settled.reply.slice(0, 80)}"` : "no reply");
    await shot("answered");
  }

  /* 4. back to home: the inbox clears */
  if (run.arrangement === "deck") {
    const back = await press("button", "back to all windows");
    const home = await until(async () => route(await url()) === "home" && homeShows(await tree()), 8000);
    check(back && Boolean(home), `${width} back at home by the thread's back control`, await url());
  } else log(`     ${width}: the ${run.arrangement} keeps the thread on stage beside home's order; the inbox is read there`);
  const cleared = await until(async () => {
    const views = await windows();
    const mine = views.find((v) => v.key === key);
    const wants = views.filter((v) => v.state === "wants");
    const s = await tree();
    const barWants = /button "[^"]* wants you"|button "\d+ want you"/.exec(s)?.[0] ?? "";
    const expected = wants.length === 0 ? "" : wants.length === 1 ? `button "${views.find((v) => v.state === "wants")?.name.split(":")[0] ?? ""} wants you"` : `button "${wants.length} want you"`;
    const ok = mine && mine.state !== "wants" && !mine.name.endsWith("wants you") && barWants === expected;
    return ok ? { mine, barWants: barWants || "(no wants-you in the bar)", others: wants.length } : undefined;
  }, 15_000, 400);
  const mineNow = (await windows()).find((v) => v.key === key);
  check(Boolean(cleared), `${width} the inbox cleared: the answered thread no longer wants you`, cleared ? `its window reads ${quoted(cleared.mine.name)}, state ${cleared.mine.state}; the bar: ${cleared.barWants} (${cleared.others} other windows want you)` : `its window: ${mineNow?.name ?? "missing"}, state ${mineNow?.state ?? "-"}`);
  await shot("inbox");

  /* 5. machines, by the bar's pill */
  const toMachines = await press("button", "machines");
  const machines = await shows(machinesShows);
  check(toMachines && Boolean(machines) && route(await url()) === "screen machines", `${width} machines by the bar's pill`, await url());
  const full = await tree(false);
  const lines = full.split("\n");
  const start = lines.findIndex((l) => l.includes(`listitem ${quoted(HOST)}`));
  const indent = start >= 0 ? (lines[start]?.search(/\S/) ?? 0) : 0;
  const block: string[] = [];
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.search(/\S/) <= indent) break;
    block.push(line.trim());
  }
  const shown = /cmx2 (\S+)/.exec(block.join(" "))?.[1] ?? "";
  check(shown === version, `${width} the ${HOST} window shows the daemon's version, equal to GET /api/hosts`, `the window says cmx2 ${shown || "(nothing)"}, /api/hosts says ${version}`);
  await shot("machines");
  await deepLink("machines", "/?screen=machines", machinesShows);
  await reloadsTo("machines", machinesShows);

  /* 6. the terminal */
  const madeTerminal = await press("button", `new terminal on ${HOST}`);
  const term = await shows(terminalShows, 15_000);
  const termUrl = await url();
  const termId = new URL(termUrl, ORIGIN).searchParams.get("terminal")?.split(":").slice(1).join(":") ?? "";
  const title = /region "terminal ([^"]+)"/.exec(term ?? "")?.[1] ?? "";
  if (termId) madeTerminals.add(termId);
  check(madeTerminal && Boolean(term) && termId.startsWith("pty_"), `${width} "new terminal on ${HOST}" opened a terminal`, `${termUrl}, ${title ? `named "terminal ${title}"` : "no terminal region"}`);
  const screenText = () => evaluate<string>("document.querySelector('.xterm-rows')?.innerText ?? ''");
  if (term) {
    await until(async () => ((await screenText()) ?? "").trim().length > 0, 10_000);
    const input = refIn(term, "textbox", `type into terminal ${title}`);
    await ab("type", `@${input}`, "echo shell-$((40+2))");
    await ab("press", "Enter");
    const answer = await until(async () => {
      const text = (await screenText()) ?? "";
      return /^shell-42\s*$/m.test(text) ? text : undefined;
    }, 10_000);
    const tailLines = (answer ?? (await screenText()) ?? "").split("\n").filter((l) => l.trim()).slice(-3).join(" / ");
    check(Boolean(answer), `${width} typed echo shell-$((40+2)) and the shell answered shell-42 on screen`, tailLines);
    await shot("terminal");
    await deepLink("the terminal", termUrl, terminalShows);
    await reloadsTo("the terminal", terminalShows);
    const killed = (await press("button", `kill terminal ${title}`)) && (await press("button", `yes, kill terminal ${title}`));
    const gone = await until(async () => {
      const ptys = (await api<Array<{ id: string; status: string }>>(`/api/hosts/${encodeURIComponent(HOST)}/pty`)).json;
      return Array.isArray(ptys) && !ptys.some((p) => p.id === termId && p.status === "running");
    }, 15_000, 400);
    check(killed && Boolean(gone), `${width} killed by its own control and confirmed: the daemon no longer runs ${termId}`);
    await shot("terminal-killed");
    const closeName = (await has("button", "close the ended terminal")) ? "close the ended terminal" : "close the terminal";
    if (await has("button", closeName)) await press("button", closeName);
    else await ab("press", "Escape");
    check(Boolean(await shows(machinesShows)) && route(await url()) === "screen machines", `${width} back to machines from the terminal`, await url());
  }

  /* 7. settings, from the machines */
  const toSettings = await press("button", "settings");
  const settings = await shows(settingsShows);
  check(toSettings && Boolean(settings) && route(await url()) === "screen settings", `${width} settings from the machines' head`, await url());
  const checkedTheme = (s: string) => /radio "(system|dark|light)" \[checked=true/.exec(s)?.[1] ?? "";
  const original = checkedTheme(settings ?? "");
  const changed = original === "light" ? "dark" : "light";
  const themeOf = async () => (await api<{ devices: Record<string, { theme?: string }> }>("/api/prefs")).json.devices?.[main.device]?.theme ?? "";
  await press("radio", changed);
  check(Boolean(await until(async () => (await themeOf()) === changed, 8000)), `${width} appearance ${original} -> ${changed}: GET /api/prefs says ${changed}`, await themeOf());
  await deepLink("settings", "/?screen=settings", settingsShows);
  await reloadsTo("settings", settingsShows);
  const after = checkedTheme((await tree()) ?? "");
  const painted = await evaluate<string>("document.documentElement.dataset.theme ?? ''");
  check(after === changed && (await themeOf()) === changed, `${width} after a reload the control still says ${changed} and /api/prefs agrees`, `control ${after}, page theme ${painted}, prefs ${await themeOf()}`);
  await shot(`settings-${changed}`);
  await press("radio", original);
  check(Boolean(await until(async () => (await themeOf()) === original, 8000)), `${width} appearance set back to ${original}`, `prefs ${await themeOf()}`);

  /* back the way it came, by each surface's own control */
  const toMachinesAgain = await press("button", "back to machines");
  check(toMachinesAgain && Boolean(await shows(machinesShows)), `${width} back to machines by its control`, await url());
  const toHome = await press("button", "back to the windows");
  check(toHome && Boolean(await shows(homeShows)), `${width} back to the windows by its control`, await url());

  const errors = await pageErrors();
  const linkErrors = (await link.text("console")).split("\n").filter((l) => l.startsWith("[error]"));
  check(errors.length === 0, `${width} no page errors in the drive's browser`, errors.length ? `${errors.length}, first: ${errors[0]?.slice(0, 160)}` : "");
  check(linkErrors.length === 0, `${width} no page errors in the deep link browser`, linkErrors.length ? `${linkErrors.length}, first: ${linkErrors[0]?.slice(0, 160)}` : "");
  // the page reports its layout shift and flushes its telemetry when it is hidden, here behind a blank tab
  await ab("tab", "new", "about:blank");
  await Bun.sleep(2000);
  await ab("close");
  await link.run(["close"]);
  return run;
}

/* ---------- telemetry ---------- */
type Row = Record<string, string | number | null>;
async function query(sql: string): Promise<Row[]> {
  const since = new Date(started - 86_400_000).toISOString().slice(0, 10);
  const out = await $`bun ${join(ROOT, "scripts/telemetry.ts")} query ${sql} --json --since ${since}`.env({ ...process.env, BOXBOX_DATA_DIR: DATA_DIR } as Record<string, string>).quiet().nothrow();
  if (out.exitCode !== 0) throw new Error(`telemetry.ts query failed: ${out.stderr.toString().trim()}`);
  return (JSON.parse(out.stdout.toString()) as { data: Row[] }).data;
}
const pct = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? Number.NaN;
};
const PERF = ["perf.send", "perf.thread", "perf.launch", "perf.paint", "perf.input", "perf.shift", "perf.longtask", "perf.frames"] as const;
/** each kind's prop that says what was measured, for the breakdown */
const FACET: Record<(typeof PERF)[number], string> = { "perf.send": "verb", "perf.thread": "what", "perf.launch": "cached", "perf.paint": "control", "perf.input": "type", "perf.shift": "shifts", "perf.longtask": "during", "perf.frames": "transition" };

async function report(runs: WidthRun[]) {
  log("\n== 11. telemetry");
  const all = runs.flatMap((r) => r.devices).filter((d) => /^[A-Za-z0-9-]{8,64}$/.test(d));
  if (!check(runs.every((r) => r.devices.length > 0), "every width's device ids were read from its pages", runs.map((r) => `${r.width}: ${r.devices.join(", ")}`).join("; "))) return;
  const widthOf = new Map(runs.map((r) => [r.width, `${r.width}/${r.arrangement}`]));
  const list = all.map((d) => `'${d}'`).join(", ");
  // the worker flushes every 10 s and each page flushed as it was hidden; a late batch gets one more flush's time
  let rows: Row[] = [];
  await until(async () => {
    rows = await query(`SELECT kind, device, ms, ok, props, session FROM events WHERE kind LIKE 'perf.%' AND device IN (${list}) AND at >= ${started} ORDER BY at`);
    return runs.every((r) => !r.replied || rows.some((row) => r.devices.includes(String(row.device)) && row.kind === "perf.send"));
  }, 25_000, 2500);
  log(`     ${rows.length} perf rows from the drive's devices since ${new Date(started).toISOString()}, read by scripts/telemetry.ts from ${DATA_DIR}/telemetry`);
  const props = (row: Row) => JSON.parse(String(row.props ?? "{}")) as Record<string, string | number>;

  for (const run of runs) {
    const mine = rows.filter((r) => run.devices.includes(String(r.device)));
    const opened = mine.filter((r) => r.kind === "perf.thread" && props(r)["what"] === "thread" && r.session === run.openedKey);
    if (run.opened) check(opened.length > 0, `${run.width} perf.thread landed for the opened thread`, opened.map((r) => `${r.ms} ms cached ${props(r)["cached"]}`).join(", ") || "no rows");
    const replies = mine.filter((r) => r.kind === "perf.send" && props(r)["verb"] === "reply" && r.ok === 1);
    if (run.replied) check(replies.length > 0, `${run.width} perf.send verb=reply ok=1 landed`, replies.map((r) => `${r.ms} ms`).join(", ") || "no rows");
  }

  /* what the drive did that each kind measures, by width: each trigger it performed must have left its rows, and a
     kind with a trigger and no rows is a gap. `facet` narrows a kind to the rows that trigger makes */
  type Expect = { facet?: [string, string | number]; why: string };
  const expected = (kind: (typeof PERF)[number], run: WidthRun): Expect[] => {
    const deck = run.arrangement === "deck";
    switch (kind) {
      case "perf.send": return run.replied ? [{ facet: ["verb", "reply"], why: "an ask answered in the thread" }] : [];
      case "perf.thread": return run.opened ? [{ facet: ["what", "thread"], why: "a thread opened, linked and reloaded" }] : [];
      case "perf.launch": return [{ facet: ["cached", 0], why: "the launch at sign-in" }, { facet: ["cached", 1], why: "home reloaded and linked from the cache" }];
      case "perf.paint":
        return [
          ...(deck || run.poured ? [{ facet: ["control", "window"] as [string, string], why: `a window tapped open at ${run.arrangement}` }] : []),
          ...(run.pilled ? [{ facet: ["control", "answer"] as [string, string], why: "a window's answer pill tapped" }] : []),
          ...(deck ? [{ facet: ["control", "back"] as [string, string], why: "the thread's back control" }] : []),
        ];
      case "perf.input": return [{ why: "taps on controls" }];
      case "perf.shift": return [{ why: "the page hidden behind each fresh tab" }];
      case "perf.frames":
        return deck
          ? [{ facet: ["transition", "grow"], why: "a window grown into the thread" }, { facet: ["transition", "shrink"], why: "the thread shrunk back into its window" }]
          : run.poured ? [{ facet: ["transition", "pour"], why: "a thread poured onto the stage" }] : [];
      case "perf.longtask": return [];
    }
  };
  for (const kind of PERF) {
    const ofKind = rows.filter((r) => r.kind === kind);
    for (const run of runs) {
      const mine = ofKind.filter((r) => run.devices.includes(String(r.device)));
      // a layout shift is measured by its score (thousandths of cumulative shift), not a duration
      const measure = (r: Row) => (kind === "perf.shift" ? Number(props(r)["score"] ?? 0) : Number(r.ms ?? 0));
      const unit = kind === "perf.shift" ? "" : " ms";
      const ms = mine.map(measure);
      const facets = new Map<string, number[]>();
      for (const r of mine) {
        const p = props(r);
        if (kind === "perf.shift") continue;
        const facet = `${FACET[kind]}=${p[FACET[kind]] ?? "-"}${p["arrangement"] ? ` arrangement=${p["arrangement"]}` : ""}`;
        facets.set(facet, [...(facets.get(facet) ?? []), measure(r)]);
      }
      const breakdown = [...facets].map(([f, xs]) => `${f} n=${xs.length} p50 ${pct(xs, 0.5)} p90 ${pct(xs, 0.9)}`).join("; ");
      const line = `${kind} at ${widthOf.get(run.width)}: ${mine.length} rows${ms.length ? `, ${kind === "perf.shift" ? "score " : ""}p50 ${pct(ms, 0.5)}${unit}, p90 ${pct(ms, 0.9)}${unit}` : ""}${breakdown ? ` (${breakdown})` : ""}${kind === "perf.shift" && ms.length ? ` (scores in thousandths: ${ms.join(", ")}; the budget is 0)` : ""}`;
      const wants = expected(kind, run);
      if (kind === "perf.longtask") {
        log(`ok ${line}${mine.length === 0 ? "; none over 50 ms, the budget held" : ""}`);
        continue;
      }
      if (wants.length === 0) {
        log(`     ${line}; the drive performed no trigger for it at this width`);
        continue;
      }
      const gaps = wants.filter((want) => !mine.some((r) => !want.facet || props(r)[want.facet[0]] === want.facet[1]));
      check(gaps.length === 0, line, gaps.map((gap) => `a gap: the drive performed ${gap.why} and no ${gap.facet ? `${gap.facet[0]}=${gap.facet[1]} ` : ""}row came`).join("; "));
    }
  }
  log("     triggers the drive does not perform: perf.paint control=capsule and perf.frames capsule (another thread asking while one is open on the deck), perf.frames reorder and back (a reorder while home is in view; the deck's edge swipe), perf.longtask during scrolling");
}

/* ---------- the drive ---------- */
mkdirSync(SHOTS, { recursive: true });
log(`shell drive: ${ORIGIN}, host ${HOST}, ${BENCH ? "the bench model" : "haiku through cmx2 run"}, widths ${WIDTHS.join(", ")}, agent-browser session ${AGENT}`);
const runs: WidthRun[] = [];
let exitCode = 1;
let sessionKey = "";
try {
  await signInApi();
  const host = await hostStatus();
  const version = host.health?.version ?? "";
  check(version !== "", `GET /api/hosts names ${HOST}'s daemon version`, `cmx2 ${version} at ${host.url}`);
  const id = flag("--session-id") ?? (await makeSession());
  const key = `${HOST}:${id}`;
  sessionKey = key;
  await settleLeftovers(key);
  const ready = await until(async () => (await fleet()).sessions.some((s) => s.key === key) && (await idle(key)), 120_000, 1000);
  check(Boolean(ready), "the scratch session is on the fleet and idle", key);
  for (const w of WIDTHS) runs.push(await runWidth(w, key, id, version));
  await report(runs);
  exitCode = failures ? 1 : 0;
} catch (error) {
  check(false, "the drive ran to its end", error instanceof Error ? error.message : String(error));
} finally {
  await ab("close");
  await link.run(["close"]);
  if (sessionKey) await settleLeftovers(sessionKey).catch(() => undefined);
  // nothing the drive opened is left running on the daemon: a terminal a failed step left behind is killed here
  const running = async () => {
    const ptys = (await api<Array<{ id: string; status: string }>>(`/api/hosts/${encodeURIComponent(HOST)}/pty`).catch(() => ({ json: [] }))).json;
    return Array.isArray(ptys) ? ptys.filter((p) => madeTerminals.has(p.id) && p.status === "running").map((p) => p.id) : [];
  };
  for (const leftover of await running()) {
    const killed = await api(`/api/hosts/${encodeURIComponent(HOST)}/pty/${encodeURIComponent(leftover)}`, { method: "DELETE" });
    log(`     ${leftover} was still running; DELETE answered ${killed.status}`);
  }
  const left = await running();
  log(`\nthe drive made ${madeTerminals.size} terminals on ${HOST}; running now: ${left.join(", ") || "none"}`);
}
log(`\n${failures ? `${failures} checks failed` : "every check passed"}; ${Math.round((Date.now() - started) / 1000)} s; screenshots in ${SHOTS}`);
process.exit(failures ? 1 : exitCode);
