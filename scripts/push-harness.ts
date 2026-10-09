/* `just push-harness`: a push delivered to a real browser, end to end
   (docs/push.md, verification).

   against a running boxbox (the release binary on the bench config that
   `just cmx2` wrote) and its dev daemon:

   1. makes a real thread on the daemon, so the deep link names one.
   2. launches google chrome (not chrome for testing, which has no push
      service keys) on a throwaway profile with a devtools port, and grants
      the boxbox origin notification permission over the devtools protocol.
   3. drives the real ui with agent-browser, by accessible name: sign in,
      "turn on notifications", until the row says on.
   4. closes every page, so the app is closed and only the service worker
      is left, then asks the server for a test push of the chosen kind.
   5. waits for the service worker to show it, and prints what it received
      (read back from the worker's own `getNotifications()`), with the
      push.decided, push.sent and push.delivered rows for its id.
   6. with --await-tap, waits for the banner to be clicked (by a person or
      a gui driver; nothing in the browser can click an os notification),
      then prints the window the click opened and the push.tapped row.

   flags: --kind ask|done|fault|ready (ask), --cdp <port> (9230),
   --headed (show chrome; the os banner only appears headed),
   --await-tap <seconds>, --need permission|matrix. everything it starts
   it stops.

   --need permission: instead of a test push, a real permission: boxbox's
   prompt route sends the bench model's `[bench:asks]` script, the daemon
   asks permission to read a file, the fleet raises the need and push
   delivers it; a tap opens the app on the ask card, which the run reads
   back from the accessibility tree.
   --need matrix: with this browser subscribed and the app closed, runs
   `bun bench/needs.ts --expect-sent` (the push matrix), then shows every
   push it decided to send arriving in the worker. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = join(ROOT, ".cmx2", "bench");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const KIND = flag("--kind") ?? "ask";
const CDP_PORT = Number(flag("--cdp") ?? 9230);
const HEADED = process.argv.includes("--headed");
const AWAIT_TAP_S = Number(flag("--await-tap") ?? 0);
/** leave the page open: tells a closed-app failure from a delivery failure */
const KEEP_OPEN = process.argv.includes("--keep-open");
const NEED = flag("--need");
if (NEED !== undefined && NEED !== "permission" && NEED !== "matrix") {
  console.error(`push-harness: --need is permission or matrix, not ${NEED}`);
  process.exit(2);
}

function say(line: string) {
  console.log(`push-harness: ${line}`);
}

function fail(message: string): never {
  console.error(`push-harness: ${message}`);
  teardown();
  process.exit(1);
}

/* ——— the bench, as `just cmx2` wrote it ——— */

function benchValue(key: string): string {
  const config = readFileSync(join(BENCH, "boxbox.toml"), "utf8");
  const match = config.match(new RegExp(`^${key} = "([^"]*)"`, "m"));
  if (!match?.[1]) fail(`no ${key} in .cmx2/bench/boxbox.toml; run \`just cmx2\` first`);
  return match[1];
}

if (!existsSync(join(BENCH, "boxbox.toml"))) fail("no bench config; run `just cmx2 --port <n> --boxbox-port <n>` first");
const BOXBOX = `http://${benchValue("listen")}`;
const DATA_DIR = benchValue("data_dir");
const DAEMON = benchValue("url");
const GATE = readFileSync(join(BENCH, "gate-password"), "utf8").trim();
const DAEMON_AUTH = `Basic ${btoa(`cmx2:${readFileSync(join(BENCH, "password"), "utf8").trim()}`)}`;

/* ——— the devtools protocol, the few calls the harness needs ——— */

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

class Devtools {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: ((method: string, params: Record<string, unknown>) => void)[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message));
        else waiting?.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners) listener(message.method, message.params ?? {});
      }
    });
  }

  static async connect(url: string): Promise<Devtools> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot reach devtools at ${url}`)), { once: true });
    });
    return new Devtools(socket);
  }

  call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(listener: (method: string, params: Record<string, unknown>) => void) {
    this.listeners.push(listener);
  }

  close() {
    this.socket.close();
  }
}

type Target = { targetId: string; type: string; url: string };

async function targets(devtools: Devtools): Promise<Target[]> {
  const { targetInfos } = (await devtools.call("Target.getTargets")) as { targetInfos: Target[] };
  return targetInfos;
}

/** evaluates `expression` inside the boxbox service worker */
async function inWorker(devtools: Devtools, expression: string): Promise<unknown> {
  const worker = (await targets(devtools)).find((t) => t.type === "service_worker" && t.url.startsWith(BOXBOX));
  if (!worker) return undefined;
  const { sessionId } = (await devtools.call("Target.attachToTarget", { targetId: worker.targetId, flatten: true })) as {
    sessionId: string;
  };
  const { result } = (await devtools.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)) as {
    result: { value?: unknown };
  };
  await devtools.call("Target.detachFromTarget", { sessionId });
  return result.value;
}

/* ——— the processes it owns ——— */

let chrome: ChildProcess | undefined;
let profile: string | undefined;
const SESSION = spawnSync("agent-browser", ["session", "id", "--scope", "worktree", "--prefix", "push"], { encoding: "utf8" }).stdout.trim() || "push";

function teardown() {
  spawnSync("agent-browser", ["--session", SESSION, "close"], { stdio: "ignore" });
  if (chrome?.pid && chrome.exitCode === null) {
    try {
      process.kill(-chrome.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (profile) rmSync(profile, { recursive: true, force: true });
}

function browse(...args: string[]): string {
  const out = spawnSync("agent-browser", ["--session", SESSION, "--cdp", String(CDP_PORT), ...args], { encoding: "utf8" });
  const text = `${out.stdout}${out.stderr}`.trim();
  if (out.status !== 0) fail(`agent-browser ${args.join(" ")} failed:\n${text}`);
  return text;
}

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  return fail(`${what} did not happen within ${seconds} s`);
}

type Row = { kind: string; ok?: number; ms?: number; device?: string; props?: Record<string, unknown> };

function rowsFor(id: string): Row[] {
  const dir = join(DATA_DIR, "telemetry");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
    .filter((line) => line.includes(id))
    .map((line) => JSON.parse(line) as Row)
    .filter((row) => row.props?.id === id);
}

/* ——— the run ——— */

process.on("SIGINT", () => fail("interrupted"));

const health = await fetch(`${DAEMON}/global/health`, { headers: { authorization: DAEMON_AUTH } }).catch(() => undefined);
if (!health?.ok) fail(`the dev daemon at ${DAEMON} is not answering; start it with \`just cmx2\``);
say(`daemon ${DAEMON} -> ${JSON.stringify(await health.json())}`);

const login = await fetch(`${BOXBOX}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: GATE }),
}).catch(() => undefined);
if (!login?.ok) fail(`boxbox at ${BOXBOX} did not sign in (${login?.status ?? "not answering"}); start the release binary on the bench config`);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
say(`boxbox ${BOXBOX} signed in`);

const created = await fetch(`${DAEMON}/session`, {
  method: "POST",
  headers: { authorization: DAEMON_AUTH, "content-type": "application/json" },
  body: JSON.stringify({ title: "push harness" }),
});
const session = (await created.json()) as { id?: string };
if (!session.id) fail(`the daemon did not make a session (${created.status})`);
const thread = `bench:${session.id}`;
say(`a real thread on the daemon: ${thread}`);

profile = mkdtempSync(join(tmpdir(), "boxbox-push-harness-"));
chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(HEADED ? [] : ["--headless=new"]),
    "about:blank",
  ],
  { detached: true, stdio: "ignore" },
);
const version = await until("chrome's devtools port", 20, async () => {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  return res.ok ? ((await res.json()) as { Browser: string; webSocketDebuggerUrl: string }) : undefined;
});
say(`chrome ${version.Browser} on devtools ${CDP_PORT}, ${HEADED ? "headed" : "headless"}, throwaway profile`);
const devtools = await Devtools.connect(version.webSocketDebuggerUrl);
await devtools.call("Browser.grantPermissions", { origin: BOXBOX, permissions: ["notifications"] });
say(`granted notifications to ${BOXBOX} over devtools`);

// the notifications row lives in settings (design.md, until m5)
browse("open", `${BOXBOX}/?screen=settings`);
browse("find", "label", "password", "fill", GATE);
browse("find", "role", "button", "click", "--name", "sign in");
browse("wait", "--text", "what reaches this device");
// the app may already be subscribing on its own (permission is granted
// before the first paint), in which case the row goes straight to on
const row = browse("snapshot", "-s", "section[aria-labelledby=notify-title]");
if (row.includes("turn on notifications")) browse("find", "role", "button", "click", "--name", "turn on notifications");
const on = spawnSync("agent-browser", ["--session", SESSION, "--cdp", String(CDP_PORT), "wait", "--text", "turn off notifications"], {
  encoding: "utf8",
});
if (on.status !== 0) fail(`notifications did not turn on; the row says:\n${browse("snapshot", "-s", "section[aria-labelledby=notify-title]")}`);
say(`the notifications row, from the accessibility tree:\n${browse("snapshot", "-s", "section[aria-labelledby=notify-title]")}`);
const device = JSON.parse(browse("eval", "localStorage.getItem('boxbox.device')").split("\n").pop() ?? "null") as
  | string
  | null;
if (!device) fail("the page minted no device id");
const pushState = (await (await fetch(`${BOXBOX}/api/push`, { headers: { cookie } })).json()) as {
  devices: { device: string; deviceClass: string; kinds: string[] }[];
};
const mine = pushState.devices.find((d) => d.device === device);
if (!mine) fail(`the server holds no subscription for ${device}`);
say(`GET /api/push holds this device: ${JSON.stringify(mine)}`);

// chrome keeps its own log of push messages for the origin (devtools,
// application, background services); recording it lets the run show
// whether a message reached the browser at all
const page = (await targets(devtools)).find((t) => t.type === "page" && t.url.startsWith(BOXBOX));
if (page) {
  const { sessionId } = (await devtools.call("Target.attachToTarget", { targetId: page.targetId, flatten: true })) as { sessionId: string };
  await devtools.call("BackgroundService.setRecording", { shouldRecord: true, service: "pushMessaging" }, sessionId);
  await devtools.call("Target.detachFromTarget", { sessionId });
}

if (KEEP_OPEN) {
  say("the page stays open (--keep-open)");
} else {
  // the app is closed: every boxbox page goes and only its service worker
  // is left. one blank tab keeps the browser's profile loaded, as any
  // running chrome has; closing a profile's last window stops its push
  // delivery altogether (docs/gotchas.md, push)
  await devtools.call("Target.createTarget", { url: "about:blank" });
  for (const target of await targets(devtools)) {
    if (target.type === "page" && target.url.startsWith(BOXBOX)) {
      await devtools.call("Target.closeTarget", { targetId: target.targetId });
    }
  }
  await Bun.sleep(1500);
  const left = (await targets(devtools)).map((t) => `${t.type} ${t.url}`);
  say(`app closed; targets left: ${JSON.stringify(left)}`);
  if (left.some((t) => t.startsWith(`page ${BOXBOX}`))) fail("a boxbox page is still open");
}

/** the notifications the worker shows, read back from the worker itself */
async function shownNow(): Promise<{ title: string; body: string; tag: string; data?: { id?: string; need?: string } }[]> {
  const list = await inWorker(
    devtools,
    `self.registration.getNotifications().then((all) => all.map((n) => ({ title: n.title, body: n.body, tag: n.tag, actions: n.actions, data: n.data })))`,
  );
  return (list as { title: string; body: string; tag: string; data?: { id?: string; need?: string } }[] | undefined) ?? [];
}

let id: string;
if (NEED === "matrix") {
  const run = spawnSync("bun", [join(ROOT, "bench/needs.ts"), "--expect-sent"], { stdio: "inherit" });
  if (run.status !== 0) fail("the push matrix did not pass");
  const sent = JSON.parse(readFileSync("/tmp/boxbox-needs-sent.json", "utf8")) as string[];
  say(`the matrix decided to send ${sent.length} pushes; each must arrive in the worker with no page open`);
  for (const one of sent) {
    const delivered = await until(`the delivered row for ${one}`, 30, async () => rowsFor(one).find((r) => r.kind === "push.delivered"));
    say(`  ${one}: ${JSON.stringify(delivered)}`);
  }
  const shown = await shownNow();
  say(`the worker's notifications now (one per thread tag, the newest news):\n${JSON.stringify(shown, null, 2)}`);
  id = sent[0] ?? fail("the matrix sent nothing");
} else if (NEED === "permission") {
  const sent = await fetch(`${BOXBOX}/api/hosts/bench/sessions/${session.id}/prompt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ device: "harness-desk", deviceClass: "automation", clientID: crypto.randomUUID(), text: "[bench:asks] harness" }),
  });
  say(`POST /api/hosts/bench/sessions/${session.id}/prompt [bench:asks] -> ${sent.status} ${await sent.text()}`);
  const shown = await until("the permission notification", 40, async () => (await shownNow()).find((n) => n.data?.need === "permission"));
  say(`the service worker received and showed a real permission, with no page open:\n${JSON.stringify(shown, null, 2)}`);
  id = shown.data?.id ?? fail("the notification carries no id");
} else {
  const askId = `que_harness_${Date.now().toString(36)}`;
  const test = await fetch(`${BOXBOX}/api/push/test`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ device, kind: KIND, thread, ...(KIND === "ask" ? { ask: askId } : {}) }),
  });
  id = ((await test.json()) as { id: string }).id;
  say(`POST /api/push/test ${KIND} -> ${test.status} ${JSON.stringify({ id })}`);
  const shown = await until("the notification", 30, async () => (await shownNow()).find((n) => n.data?.id === id));
  say(`the service worker received and showed, with no page open:\n${JSON.stringify(shown, null, 2)}`);
}

const funnel = await until("the delivered row", 10, async () => {
  const rows = rowsFor(id);
  return rows.some((r) => r.kind === "push.delivered") ? rows : undefined;
});
say(`telemetry for ${id}:`);
for (const row of funnel) console.log(`  ${JSON.stringify(row)}`);

if (AWAIT_TAP_S > 0) {
  await devtools.call("Target.setDiscoverTargets", { discover: true });
  const opened = new Promise<string>((resolve) =>
    devtools.on((method, params) => {
      const info = params.targetInfo as Target | undefined;
      // the window may be created blank and then navigate: take the first
      // url that is the deep link (the app clears it with replaceState)
      const seen = method === "Target.targetCreated" || method === "Target.targetInfoChanged";
      if (seen && info?.type === "page" && info.url.includes("thread=")) resolve(info.url);
    }),
  );
  say(`waiting ${AWAIT_TAP_S} s for the banner to be clicked`);
  const url = await Promise.race([opened, Bun.sleep(AWAIT_TAP_S * 1000).then(() => undefined)]);
  if (!url) fail("nobody clicked the banner");
  say(`the click opened a window at ${url}`);
  const tapped = await until("the tapped row", 10, async () => rowsFor(id).find((r) => r.kind === "push.tapped"));
  console.log(`  ${JSON.stringify(tapped)}`);
  if (NEED === "permission") {
    // the tap opened the app on the ask: read the card back from the accessibility tree
    await Bun.sleep(1500);
    const tabs = browse("tab", "list");
    const at = tabs.split("\n").find((line) => line.includes(BOXBOX))?.match(/\[(\d+)\]/)?.[1];
    if (at) browse("tab", at);
    say(`the page the tap opened, its focused ask card:\n${browse("snapshot", "-s", ".ask-card:focus")}`);
    say(`focus is on: ${browse("eval", "document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName")}`);
  }
}

devtools.close();
teardown();
say("done; chrome stopped and its profile removed");
