/* the m3 gate: the thread read and answered through the real ui against a
   real cmx2 dev daemon (docs/plan.md m3; docs/verification.md, the thread
   drive). it drives agent-browser through the accessibility tree at phone,
   ipad and mac widths, looks at what painted, and prints the evidence:

   - a turn's rows on stage, opened from the fleet list and by url
   - a question and two permissions answered in place, each settled on
     the daemon and on the stream
   - a thread opened mid-answer shows the partial text; a reload
     mid-answer paints what was written and continues
   - a deep link opens and lights its row
   - screenshots at 390, 820 and 1512, each run through the craft check
   - `perf.send` for replies: p90 over at least 50, from the telemetry
     rows the server wrote
   - `perf.thread` for the thread's first paint and for stream events

   needs `just cmx2 --port <p>` and `BOXBOX_PORT=<b> just dev` running:
     bun bench/thread.ts [--boxbox http://127.0.0.1:3051] [--replies 50] [--only 1,2,3,4,5,6] [--keep]
   `--only` runs some scenarios (4 needs 1, 5 needs 2); screenshots land in
   bench/shots/ (gitignored). */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? fallback) : fallback; };
const BOXBOX = flag("--boxbox", `http://127.0.0.1:${process.env["BOXBOX_PORT"] ?? "3051"}`);
const REPLIES = Number(flag("--replies", "50"));
const KEEP = args.includes("--keep");
const ONLY = new Set(flag("--only", "1,2,3,4,5,6").split(","));
const only = (scenario: string) => ONLY.has(scenario);
const SHOTS = join(ROOT, "bench/shots");
const DATA = join(ROOT, ".cmx2/bench/boxbox-data/telemetry");
const CRAFT = readFileSync(join(ROOT, "app/.ladle/craft.js"), "utf8");
const WIDTHS: Array<[string, number, number]> = [["phone", 390, 844], ["ipad", 820, 1180], ["mac", 1512, 945]];

const daemon = JSON.parse(readFileSync(join(ROOT, ".cmx2/bench/daemon.json"), "utf8")) as { url: string };
const daemonPassword = readFileSync(join(ROOT, ".cmx2/bench/password"), "utf8").trim();
const gatePassword = readFileSync(join(ROOT, ".cmx2/bench/gate-password"), "utf8").trim();
const auth = `Basic ${Buffer.from(`cmx2:${daemonPassword}`).toString("base64")}`;

const startedAt = Date.now();
const lines: string[] = [];
let failures = 0;
function log(line: string) { lines.push(line); console.log(line); }
function check(ok: boolean, what: string, detail = "") { if (!ok) failures++; log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`); }

/* ---------- the daemon ---------- */
async function daemonCall<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${daemon.url}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? null : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}
async function newSession(title: string, prompt: string): Promise<string> {
  const { json } = await daemonCall<{ id: string }>("POST", "/session", { title });
  const sent = await daemonCall("POST", `/session/${json.id}/prompt_async`, { text: prompt });
  if (sent.status !== 202) throw new Error(`prompt answered ${sent.status}`);
  return json.id;
}
/* the daemon's pending asks for one session: other sessions (an earlier run's leftovers) do not count */
const pendingQuestions = async (session: string) => (await daemonCall<Array<{ sessionID: string }>>("GET", "/question")).json.filter((q) => q.sessionID === session).length;
/** the raised questions' ids for one session, as the fleet keys them (`<host>:<id>`) */
const questionKeys = async (session: string) => (await daemonCall<Array<{ id: string; sessionID: string }>>("GET", "/question")).json.filter((q) => q.sessionID === session).map((q) => `bench:${q.id}`);
const pendingPermissions = async (session: string) => (await daemonCall<Array<{ sessionID: string }>>("GET", "/permission")).json.filter((p) => p.sessionID === session).length;

/* ---------- the browser ---------- */
const session = (await $`agent-browser session id --scope worktree --prefix gate`.text()).trim();
const ab = (...a: string[]) => $`agent-browser --session ${session} ${a}`.quiet().nothrow();
async function evaluate<T>(js: string): Promise<T | null> {
  const out = (await ab("eval", js).text()).trim();
  try { const once = JSON.parse(out) as unknown; return (typeof once === "string" ? JSON.parse(once) : once) as T; } catch { return null; }
}
async function until(what: string, test: () => Promise<boolean>, ms = 15_000, every = 300): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await test()) return true; await Bun.sleep(every); }
  log(`     waited ${ms} ms for ${what}`);
  return false;
}
/* the stage's own transitions in flight (rises and slides); its pulses and carets run forever and are not in the way */
const MOVING = "(document.querySelector('.thread-stage') ?? document).getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && Number.isFinite(a.effect.getTiming().iterations)).length";
/** true once the stage has been still for two reads 150 ms apart: a card that appears between a read and a click is caught */
async function settled(): Promise<boolean> {
  if (((await evaluate<number>(MOVING)) ?? 0) > 0) return false;
  await Bun.sleep(150);
  return ((await evaluate<number>(MOVING)) ?? 0) === 0;
}
/** the accessibility tree's ref for the first button with exactly this name */
async function refOf(name: string): Promise<string | null> {
  const line = (await ab("snapshot", "-i").text()).split("\n").find((l) => l.includes(`button "${name}"`));
  return line?.match(/\[ref=(e\d+)\]/)?.[1] ?? null;
}
/** clicks a button by its accessible name, from the tree, once nothing on the stage is still moving: a card rising in
    is laid out at its resting place while it is drawn on its way there, so a click aimed at the layout box lands beside
    it, and agent-browser refuses it (and the refusal has stopped the page's clock, docs/gotchas.md). a failure prints
    agent-browser's last answer and the buttons the tree holds */
async function clickNamed(name: string, ms = 20_000): Promise<boolean> {
  let last = "";
  const ok = await until(`"${name}"`, async () => {
    if (!(await settled())) { last = "animations still running"; return false; }
    const ref = await refOf(name);
    if (!ref) { last = `no button named "${name}" in the tree`; return false; }
    if (!(await settled())) { last = "animations still running"; return false; }
    const result = await ab("click", `@${ref}`);
    last = `${result.stderr.toString()}${result.stdout.toString()}`.trim();
    if (result.exitCode === 0) return true;
    const clock = await evaluate<string>("new Promise((r) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else r(n + ' frames in 500 ms'); }; requestAnimationFrame(tick); setTimeout(() => r(n + ' frames in 500 ms (no more came)'), 900); })");
    last += ` | ${clock ?? "clock unknown"}`;
    // a click agent-browser refused ("covered") has left the page's clock stopped before: a tab with no frame is replaced
    if (!(await framed())) await restart("the click failed and the tab gave no frame");
    return false;
  }, ms, 400);
  if (!ok) {
    const buttons = (await ab("snapshot", "-i").text()).split("\n").filter((l) => l.includes("button")).map((l) => l.trim()).join(" ; ");
    log(`     agent-browser said: ${last.slice(0, 200)}\n     buttons in the tree: ${buttons.slice(0, 700) || "(none)"}`);
  }
  return ok;
}
/* agent-browser's console holds console.* calls, not uncaught errors or rejections: each page gets a listener that
   writes them as console.error, and every scenario ends by reading those lines. an animate() easing that threw inside a
   solid effect hid behind a passing craft check once (docs/gotchas.md). */
/* ...and a frame pump: headless chrome advanced the stage's rises only when something asked for a frame (an eval, a
   screenshot), so a 475 ms rise took seconds between the drive's commands and the clicks waited on it. a page with a
   running requestAnimationFrame loop ticks at 60 fps, the way a screen does (docs/gotchas.md) */
const WATCH_ERRORS = "(() => { if (window.__watched) return 1; window.__watched = 1; addEventListener('error', e => console.error('page error: ' + e.message)); addEventListener('unhandledrejection', e => console.error('page error: ' + String(e.reason))); const pump = () => requestAnimationFrame(pump); requestAnimationFrame(pump); return 1; })()";
async function watchErrors() { await ab("eval", WATCH_ERRORS); }
/* a long-lived headless tab can stop producing frames (docs/gotchas.md): nothing paints, the store never applies the
   worker's patches, and every check reads an empty stage. a page that gives no frame inside 1.5 s is opened again in a
   fresh browser, once */
const FRAME = "new Promise((r) => { const t = setTimeout(() => r('no frame'), 1500); requestAnimationFrame(() => { clearTimeout(t); r('frame'); }); })";
async function framed(): Promise<boolean> { return (await ab("eval", FRAME).text()).includes("frame\""); }
async function open(path: string) {
  lastPath = path;
  await ab("open", `${BOXBOX}${path}`);
  if (!(await framed())) await restart("the tab gave no frame");
  await watchErrors();
}
async function reload() { await ab("reload"); await watchErrors(); }
let lastViewport: [number, number] = [390, 844];
let lastPath = "/";
/** signs in through the gate from inside the page, so the cookie lands in the browser; a page still loading gets a moment */
async function signIn(): Promise<number | null> {
  let status: number | null = null;
  for (let attempt = 0; attempt < 4 && status !== 200; attempt++) {
    if (attempt) await Bun.sleep(1000);
    status = await evaluate<number>(`fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(gatePassword)}})}).then(r=>r.status)`);
  }
  return status;
}
/** closes the browser and lets it go: a launch on the heels of a close can collide with the dying one's profile lock */
async function closeBrowser() {
  await ab("close");
  await Bun.sleep(1500);
}
/** a fresh browser, signed in again, back on the page that was open: for a tab whose clock stopped (docs/gotchas.md) */
async function restart(why: string) {
  log(`     ${why}; starting the browser again`);
  await closeBrowser();
  await viewport(...lastViewport);
  await ab("open", `${BOXBOX}/`);
  await signIn();
  await ab("open", `${BOXBOX}${lastPath}`);
  await watchErrors();
}
/** the page errors since the last read, and clears the console */
async function pageErrors(): Promise<string[]> {
  const lines = (await ab("console").text()).split("\n").filter((l) => l.startsWith("[error]"));
  await ab("console", "--clear");
  return lines;
}
async function noPageErrors(scenario: string) {
  const errors = await pageErrors();
  check(errors.length === 0, `no page errors: ${scenario}`, errors.length ? `${errors.length}, first: ${errors[0]?.slice(0, 160)}` : "");
}
async function viewport(w: number, h: number) { lastViewport = [w, h]; await ab("set", "viewport", String(w), String(h)); }
async function shot(name: string): Promise<string> {
  const file = join(SHOTS, `${name}.png`);
  // a screenshot is of a resting stage: a row still rising in would read as text crowding its edge
  await until("the stage to settle for the shot", settled, 4000, 200);
  await ab("screenshot", file);
  // the craft check reads the thread's stage; home's windows lie beneath it on the deck and have their own gate
  await ab("eval", "window.__craftRoot = '.thread-stage'");
  const craft = await evaluate<{ crowding: number; touching: number; atEdge: number; crowdBy: unknown[]; touchBy: unknown[]; edgeBy: unknown[] }>(CRAFT);
  const worst = craft && (craft.crowding || craft.touching || craft.atEdge) ? ` ${JSON.stringify([craft.crowdBy[0], craft.touchBy[0], craft.edgeBy[0]].filter(Boolean)).slice(0, 240)}` : "";
  check(!!craft && craft.crowding === 0 && craft.touching === 0 && craft.atEdge === 0, `craft ${name}`, craft ? `crowding ${craft.crowding} touching ${craft.touching} edge ${craft.atEdge}${worst}` : "no answer");
  return file;
}
const domState = () => evaluate<{ rows: string[]; status: string; asks: string[]; painted: number }>("JSON.stringify({rows: [...document.querySelectorAll('.thread-stage .row')].map(r => (r.querySelector('.row-k')?.textContent ?? 'said') + '|' + (r.querySelector('.row-r')?.textContent ?? '')), status: document.querySelector('.tb-status')?.textContent ?? '', asks: window.boxbox.asks(), painted: window.boxbox.painted()})");

/* ---------- the drive ---------- */
mkdirSync(SHOTS, { recursive: true });
// a fresh browser every run: one left over from a stopped run may have stopped producing frames
await closeBrowser();
await open("/");
await viewport(390, 844);
const signedIn = await signIn();
check(signedIn === 200, "signed in through the gate", String(signedIn));

let s1 = "";
let s2 = "";

/* 1. a turn on stage: read, edit, run, ask; the question answered in place */
if (only("1")) {
log("\n— reading and answering, phone");
s1 = await newSession("gate: tidy the notes greeting", "[bench:tools] tidy the greeting line in notes.md and tell me what changed");
await until("the question to be raised", async () => (await pendingQuestions(s1)) > 0);
await open(`/?thread=bench:${s1}`);
const ready1 = await until("the rows to paint", async () => ((await domState())?.rows.length ?? 0) >= 4);
check(ready1, "the thread painted its rows from the worker");
const before = await domState();
check(!!before && before.rows.some((r) => r.startsWith("read|")) && before.rows.some((r) => r.startsWith("edit|")) && before.rows.some((r) => r.startsWith("run|")) && before.rows.some((r) => r.startsWith("ask|wants you")), "rows: read, edit, run and the pending ask", before?.rows.join(", "));
check(before?.status.startsWith("wants you") ?? false, "the status line says wants you", before?.status);
const names = (await ab("snapshot", "-i").text());
check(/answer hi/.test(names) && /answer hello/.test(names), "the ask's options are named in the accessibility tree");
await shot("1-ask-pending-phone");
// other sessions on the daemon may hold asks of their own, so the check is for this question's key, not an empty list
const raised1 = (await questionKeys(s1))[0] ?? "";
check(before?.asks.includes(raised1) ?? false, "the raised question is in the fleet's list", raised1);
const tapped = performance.now();
check(await clickNamed("answer hi"), "tapped answer hi by its name");
const settled1 = await until("the daemon to settle the question", async () => (await pendingQuestions(s1)) === 0, 10_000, 150);
check(settled1, "the daemon settled the question", `${Math.round(performance.now() - tapped)} ms after the tap`);
const gone = await until("the ask to leave the stream", async () => !((await domState())?.asks ?? [raised1]).includes(raised1), 10_000, 150);
check(gone, "the ask left the fleet's list on the stream");
const after = await until("the row to read answered", async () => (await domState())?.rows.some((r) => r.startsWith("ask|answered")) ?? false, 10_000, 200);
check(after, "the row settled to answered");
await shot("1-ask-answered-phone");
await noPageErrors("reading and answering");
}

/* 2. permissions and questions answered as the daemon raises them */
if (only("2")) {
log("\n— permissions and questions in place, ipad");
await viewport(820, 1180);
s2 = await newSession("gate: check the env files", "[bench:asks] read both env files and tell me which greeting and closing to use");
await until("the first permission", async () => (await pendingPermissions(s2)) > 0);
await open(`/?thread=bench:${s2}`);
await until("the permission card", async () => ((await domState())?.rows.some((r) => r.startsWith("read|wants you")) ?? false));
const risen = await evaluate<number>("document.querySelectorAll('.risen .ask-opt').length");
check((risen ?? 0) >= 3, "the pending permission rose out of the live window with its options", String(risen));
await shot("2-permission-risen-ipad");
for (const name of ["allow once", "allow once", "answer hi", "answer later"]) check(await clickNamed(name), `answered "${name}" as it was raised`);
const allSettled = await until("every ask to settle", async () => (await pendingPermissions(s2)) === 0 && (await pendingQuestions(s2)) === 0, 15_000, 200);
check(allSettled, "the daemon settled all four asks");
await Bun.sleep(1500);
await shot("2-asks-settled-ipad");
await noPageErrors("permissions and questions in place");
}

/* 3. mid-stream: the partial text shows; a reload paints it and continues */
if (only("3")) {
log("\n— a thread opened mid-answer, and a reload mid-answer, phone");
await viewport(390, 844);
const s3 = await newSession("gate: a long answer", "[bench:words 700 40] write me a long note");
await Bun.sleep(2500);
await open(`/?thread=bench:${s3}`);
const partial = await until("partial text", async () => ((await domState())?.painted ?? 0) > 0, 8000, 150);
const p1 = (await domState())?.painted ?? 0;
await Bun.sleep(1200);
const p2 = (await domState())?.painted ?? 0;
check(partial && p2 > p1, "opened mid-stream: the partial text is on screen and growing", `${p1} then ${p2} characters`);
await shot("3-mid-stream-phone");
await reload();
const reloadAt = Date.now();
let firstPaint = -1;
await until("the reloaded page to paint text", async () => { const n = (await evaluate<number>("window.boxbox ? window.boxbox.painted() : 0")) ?? 0; if (n > 0 && firstPaint < 0) firstPaint = Date.now() - reloadAt; return n > 0; }, 8000, 60);
const r1 = (await evaluate<number>("window.boxbox.painted()")) ?? 0;
await Bun.sleep(1500);
const r2 = (await evaluate<number>("window.boxbox.painted()")) ?? 0;
check(firstPaint >= 0 && firstPaint < 1500, "reload mid-answer: what was written painted quickly", `${firstPaint} ms after the reload command returned`);
check(r2 > r1, "and the answer continued after the reload", `${r1} then ${r2} characters`);
await shot("3-after-reload-phone");
await noPageErrors("mid-answer and the reload");
}

/* 4. a deep link opens and lights its row */
if (only("4") && !s1) log("\n— a deep link to a row: skipped, it needs scenario 1's session");
if (only("4") && s1) {
log("\n— a deep link to a row, mac");
await viewport(1512, 945);
const msgs = (await daemonCall<Array<{ info: { id: string }; parts: Array<{ id: string; type: string; tool?: string }> }>>("GET", `/session/${s1}/message`)).json;
const askPart = msgs.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "question");
await open(`/?thread=bench:${s1}&at=${msgs[0]?.info.id ?? ""}&part=${askPart?.id ?? ""}`);
const linked = await until("the linked row to open", async () => (await evaluate<boolean>(`(() => { const r = document.querySelector('.row[data-part~="${askPart?.id ?? ""}"]'); return !!r && r.classList.contains('open'); })()`)) === true, 8000, 200);
check(linked, "the linked row opened and showed its answer");
await evaluate("(() => { document.querySelector('.turnsbtn')?.click(); return 1; })()");
await Bun.sleep(700);
await shot("4-deep-link-turns-mac");
await noPageErrors("the deep link and the turns panel");
}

/* 5. the three widths, settled */
if (only("5") && !s2) log("\n— widths: skipped, it needs scenario 2's session");
if (only("5") && s2) {
log("\n— widths");
for (const [name, w, h] of WIDTHS) {
  await viewport(w, h);
  await open(`/?thread=bench:${s2}`);
  await until("rows", async () => ((await domState())?.rows.length ?? 0) > 3, 8000, 200);
  await shot(`5-settled-${name}`);
}
await noPageErrors("the three widths");
}

/* 6. replies enough for a p90 */
if (only("6")) {
log(`\n— ${REPLIES} replies for the perf row`);
await viewport(390, 844);
// scenarios 1 and 2 answered five between them; one short keeps the count honest if a click did not land
let replied = s1 && s2 ? 4 : 0;
while (replied < REPLIES) {
  const s = await newSession(`gate: asks ${replied}`, "[bench:asks] read both env files and tell me which greeting and closing to use");
  await until("the first permission", async () => (await pendingPermissions(s)) > 0);
  await open(`/?thread=bench:${s}`);
  /* a find issued while the page is still loading fails for the rest of that page: wait for the card first */
  const card = await until("the permission card", async () => ((await evaluate<number>("document.querySelectorAll('.risen .ask-opt').length")) ?? 0) > 0, 10_000, 200);
  if (!card) log(`     the page: ${JSON.stringify(await domState()).slice(0, 400)}`);
  let landed = 0;
  for (const name of ["allow once", "allow once", "answer hi", "answer later"]) { if (await clickNamed(name, 15_000)) landed++; }
  replied += landed;
  if (landed < 4) log(`     ${s}: ${landed} of 4 answered`);
  await until("settled", async () => (await pendingPermissions(s)) === 0 && (await pendingQuestions(s)) === 0, 10_000, 200);
}
log(`     ${replied} replies made`);
await noPageErrors("the replies");
}
/* the worker flushes telemetry every 10 s; a hidden page flushes at once */
await Bun.sleep(11_000);

/* ---------- the telemetry ---------- */
type Row = { at: number; kind: string; device_class: string; ok: number | null; ms: number | null; props: Record<string, unknown> };
const rows: Row[] = existsSync(DATA) ? readdirSync(DATA).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(DATA, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row)) : [];
const since = rows.filter((r) => r.at >= startedAt && r.device_class === "automation");
const p = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] ?? NaN; };
const sends = since.filter((r) => r.kind === "perf.send" && r.props["verb"] === "reply");
const sendMs = sends.filter((r) => r.ok === 1).map((r) => r.ms ?? 0);
log(`\nperf.send verb=reply: ${sends.length} rows, ${sendMs.length} ok, p50 ${p(sendMs, 0.5)} ms, p90 ${p(sendMs, 0.9)} ms, max ${Math.max(...sendMs)} ms`);
if (only("6")) check(sendMs.length >= REPLIES && p(sendMs, 0.9) < 400, `send to acknowledged p90 under 400 ms over ${REPLIES} replies`);
const paints = since.filter((r) => r.kind === "perf.thread");
for (const what of ["thread", "row", "event"]) {
  const ms = paints.filter((r) => r.props["what"] === what).map((r) => r.ms ?? 0);
  if (ms.length) log(`perf.thread what=${what}: ${ms.length} rows, p50 ${p(ms, 0.5)} ms, p90 ${p(ms, 0.9)} ms`);
}
const cached = paints.filter((r) => r.props["what"] === "thread" && r.props["cached"] === 1).map((r) => r.ms ?? 0);
if (cached.length) check(p(cached, 0.5) <= 300, "a thread from cache paints in 300 ms at p50", `p50 ${p(cached, 0.5)} ms over ${cached.length}`);

if (!KEEP) await ab("close");
log(`\n${failures ? `${failures} checks failed` : "every check passed"}; screenshots in ${SHOTS}`);
process.exit(failures ? 1 : 0);
