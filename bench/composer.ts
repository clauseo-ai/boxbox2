/* the composer's drive (docs/composer.md, verification): a real pinned
   cmx2 daemon (4970, the bench model on 4971) and the release binary
   (3091), driven through the real ui with agent-browser at 390, 820 and
   1512. it sends, queues two, unsends one, runs now, steers, attaches a
   photo, picks a model and reads it back from the next reply, cuts the
   connection mid-send and checks each prompt is in the daemon's
   transcript once after it comes back, then sends fifty and reads send-to-acknowledged from the
   telemetry boxbox wrote. every claim it prints is read back from the
   daemon or from boxbox's own files; it stops everything it started.

   just build && bun bench/composer.ts */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.WINDOWS_DAEMON_PORT ??= "4970";
process.env.WINDOWS_BOXBOX_PORT ??= "3091";
process.env.WINDOWS_WORLD ??= "/tmp/boxbox-composer-world";
const { APP, World, WORLD, log, until } = await import("./windows");

const SESSION = "composer-drive";
const SHOTS = join(WORLD, "shots");
const WIDTHS: Array<[string, number, number]> = [["phone", 390, 844], ["ipad", 820, 1180], ["mac", 1512, 945]];

function ab(...argv: string[]): string {
  const out = spawnSync("agent-browser", ["--session", SESSION, ...argv], { encoding: "utf8", timeout: 90_000 });
  if (out.status !== 0) throw new Error(`agent-browser ${argv[0]} failed: ${out.stderr.trim().slice(0, 300)}`);
  return out.stdout.trim();
}
const js = (code: string): string => {
  const raw = ab("eval", code);
  try {
    return String(JSON.parse(raw));
  } catch {
    return raw;
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** types into the composer the way a person does, through the input event solid listens to */
function type(text: string): void {
  js(`(() => { const t = document.querySelector('.stage-dock textarea'); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' })); return t.value.length; })()`);
}
function tap(selector: string): void {
  const hit = js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
  if (hit !== "ok") throw new Error(`nothing to tap at ${selector}`);
}
/** holds send past the steer threshold, then lets go */
async function holdSend(): Promise<void> {
  js(`(() => { const b = document.querySelector('.stage-dock .cz-send'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return 'held'; })()`);
  await sleep(700);
  js(`(() => { const b = document.querySelector('.stage-dock .cz-send'); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return 'released'; })()`);
}
const shoot = (name: string, label: string) => ab("screenshot", join(SHOTS, `${name}-${label}.png`));

const world = new World();
let failures = 0;
function check(what: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
}

type Wire = { info: { id: string; role: string; clientID?: string; queued?: boolean; modelID?: string; providerID?: string }; parts: Array<{ type: string; text?: string; mime?: string; synthetic?: boolean }> };
async function transcript(id: string): Promise<Wire[]> {
  return (await (await world.daemon("GET", `/session/${id}/message`)).json()) as Wire[];
}
async function count(id: string, text: string): Promise<number> {
  return (await transcript(id)).filter((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && !p.synthetic && p.text === text)).length;
}
async function busy(id: string): Promise<boolean> {
  return (await world.status())[id]?.type === "busy";
}
async function idle(id: string): Promise<void> {
  await until("the turn to end", async () => !(await busy(id)), 120_000);
}

try {
  await world.start();
  spawnSync("mkdir", ["-p", SHOTS]);
  await world.run([{ repo: "ledger", title: "the composer drive", prompt: "[bench:words 20 10] say hello" }]);
  const { id, key } = world.sessions[0] ?? (() => { throw new Error("no session"); })();
  await idle(id);

  ab("set", "viewport", "390", "844");
  ab("open", `${APP}/`);
  js(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(world.gate)} }) }).then(r => r.status)`);
  ab("open", `${APP}/?thread=${encodeURIComponent(key)}`);
  await until("the composer under the thread", () => js("!!document.querySelector('.stage-dock textarea')") === "true", 30_000);

  /* send */
  const first = "the composer drive: one plain send";
  type(first);
  tap(".stage-dock .cz-send");
  await until("the send's echo", async () => (await count(id, first)) === 1);
  check("send lands in the daemon's transcript once", (await count(id, first)) === 1);
  await idle(id);

  /* queue two behind a long turn, unsend one, run now */
  type("[bench:words 3000 25] a long turn to queue behind");
  tap(".stage-dock .cz-send");
  await until("the long turn to start", () => busy(id));
  const q1 = "queued one: update the docs";
  const q2 = "queued two: then push";
  type(q1);
  tap(".stage-dock .cz-send");
  type(q2);
  tap(".stage-dock .cz-send");
  await until("two queued cards", () => js("document.querySelectorAll('.stage-dock .cz-card[data-state=queued]').length") === "2", 15_000);
  const words = js("[...document.querySelectorAll('.stage-dock .cz-why')].map(e => e.textContent).join(' | ')");
  check("each queued card says why it waits and what sends it", /waiting for this turn to end/.test(words) && /waiting behind/.test(words), words);
  shoot("queued", "phone");
  tap(`.stage-dock [aria-label="unsend: ${q2}"]`);
  await until("the unsent card to leave", () => js("document.querySelectorAll('.stage-dock .cz-card[data-state=queued]').length") === "1", 15_000);
  const draftBack = js("document.querySelector('.stage-dock textarea').value");
  check("unsend with an empty draft brings the text back", draftBack === q2, draftBack);
  type("");
  tap('.stage-dock [aria-label="stop the turn and run the queue now"]');
  await until("run now to land the queued message", async () => (await count(id, q1)) === 1, 60_000);
  check("run now runs the queued message", (await count(id, q1)) === 1);
  check("the unsent message never reached the daemon's transcript", (await count(id, q2)) === 0);
  await idle(id);

  /* steer */
  // a steer lands at the next tool boundary, so the turn it steers runs a slow command
  type("[bench:slow] run the slow check");
  tap(".stage-dock .cz-send");
  await until("the turn to start", () => busy(id));
  const steer = "steer: keep it to the greeting line";
  type(steer);
  await holdSend();
  await until("the steer to land", async () => (await count(id, steer)) === 1, 60_000);
  check("hold to steer lands in the running turn", (await count(id, steer)) === 1);
  await world.daemon("POST", `/session/${id}/abort`, {});
  await idle(id);

  /* run now on a steer: a turn stuck on a slow command keeps a steer waiting for a boundary that is far off. a stop alone takes
     the steer into the thread as the turn ends and leaves it there unanswered (the pinned daemon does), so run now takes it back,
     stops the turn and sends its words as a prompt: the agent answers it, once */
  type("[bench:slow] run the slow check once more");
  tap(".stage-dock .cz-send");
  await until("the turn to start", () => busy(id));
  await sleep(1500);
  const stuck = "steer: say hello after the stop";
  type(stuck);
  await holdSend();
  await until("the steer's card", () => js("document.querySelectorAll('.stage-dock .cz-card[data-state=steer]').length") === "1", 15_000);
  shoot("steer", "phone");
  tap(`.stage-dock [aria-label="stop the turn and run now: ${stuck}"]`);
  const answered = async () => {
    const wire = await transcript(id);
    const at = wire.findIndex((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text === stuck));
    return at >= 0 && wire.slice(at + 1).some((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && Boolean(p.text)));
  };
  await until("the steer to be answered", answered, 60_000);
  check("run now on a steer ran it: it is in the daemon's transcript once and the agent answered it", (await count(id, stuck)) === 1 && (await answered()));
  await idle(id);

  /* a photo, clamped on the device */
  const png = join(WORLD, "gap.png");
  writeFileSync(png, Buffer.from(js(`(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = '#1b4a33'; g.fillRect(0, 0, 2400, 1200); g.fillStyle = '#fff'; g.fillRect(200, 200, 1400, 120); return c.toDataURL('image/png').split(',')[1]; })()`), "base64"));
  js("document.querySelector('.stage-dock textarea').focus()");
  ab("upload", ".stage-dock .cz-picker", png);
  await until("the photo in the tray", () => js("document.querySelectorAll('.stage-dock .cz-photo').length") === "1", 15_000);
  const width = Number(js("document.querySelector('.stage-dock .cz-photo img').naturalWidth"));
  check("the photo is fitted to 1568 px on the device", width === 1568, `${width} px wide`);
  shoot("photo", "phone");
  const withPhoto = "see the gap right?";
  type(withPhoto);
  tap(".stage-dock .cz-send");
  await until("the photo's message", async () => (await count(id, withPhoto)) === 1, 30_000);
  const photoMessage = (await transcript(id)).find((m) => m.parts.some((p) => p.text === withPhoto));
  check("the photo reached the daemon with its message", Boolean(photoMessage?.parts.some((p) => p.type === "file" && p.mime === "image/jpeg")));
  await idle(id);

  /* a model for this message, read back from the reply */
  js("document.querySelector('.stage-dock textarea').focus()");
  tap(`.stage-dock [aria-label^="model:"]`);
  await until("the models", () => js("document.querySelectorAll('.stage-dock .cz-option.model').length > 1") === "true", 15_000);
  shoot("model", "phone");
  // the words were focused before the tap: a tap on the chip must not move focus onto the chip (it never takes focus, so the
  // keyboard neither rises nor falls). a finger's pointerdown on the chip is cancelled, which is what stops the browser moving
  // focus (and raising a keyboard). with a mouse and keyboard the menu's filter takes focus by design (the type-to-find), so
  // the words or that filter holding it both mean the chip did not
  const focusKept = js(`(() => { const b = document.querySelector('.stage-dock [aria-label^="model:"]'); const e = new PointerEvent('pointerdown', { bubbles: true, cancelable: true }); b.dispatchEvent(e); const on = document.activeElement; return e.defaultPrevented && (on?.tagName === 'TEXTAREA' || (on?.tagName === 'INPUT' && (on.getAttribute('aria-label') || '').startsWith('find a model'))); })()`) === "true";
  check("the model chip never takes focus: a tap on it neither raises nor drops the keyboard (the words keep it, or the filter that took it on a fine pointer)", focusKept);
  const picked = js("(() => { const o = [...document.querySelectorAll('.stage-dock .cz-option.model')].find(b => b.getAttribute('aria-current') !== 'true'); o.click(); return o.querySelector('.cz-name').textContent; })()");
  /* effort is its own control: one tap opens the dial, one tap picks, and the chip shows it */
  tap(`.stage-dock [aria-label^="effort:"]`);
  await until("the effort dial", () => js("document.querySelectorAll('.stage-dock .cz-dial [role=radio]').length > 1") === "true", 10_000);
  shoot("effort", "phone");
  const effort = js("(() => { const r = [...document.querySelectorAll('.stage-dock .cz-dial [role=radio]')].find(b => b.getAttribute('aria-checked') !== 'true'); r.click(); return r.textContent; })()");
  check("the effort chip shows the pick", js("document.querySelector('.stage-dock .cz-top').innerText").includes(effort), effort);
  const asked = "[bench:words 5 10] which model answered";
  type(asked);
  tap(".stage-dock .cz-send");
  await until("the reply", async () => (await count(id, asked)) === 1, 30_000);
  await idle(id);
  const reply = (await transcript(id)).filter((m) => m.info.role === "assistant").at(-1);
  const session = (await (await world.daemon("GET", `/session/${id}`)).json()) as { model?: { id: string; providerID: string } };
  await until("the chip to follow the thread", () => js(`document.querySelector('.stage-dock [aria-label^="model:"]').textContent`).includes(picked), 10_000).catch(() => undefined);
  const chip = js(`document.querySelector('.stage-dock [aria-label^="model:"]').textContent`);
  check("after the pick has gone the chip shows the thread's model as the daemon reports it", Boolean(session.model?.id && chip.includes(picked)), `daemon ${session.model?.providerID}/${session.model?.id}, chip "${chip}"`);
  check("the next reply ran on the picked model", Boolean(reply?.info.modelID && picked.replace(/\s+/g, "-").length > 0 && reply.info.modelID.includes(picked.split(" ")[0] ?? "")), `picked ${picked}, replied ${reply?.info.providerID}/${reply?.info.modelID}`);

  /* the connection cut mid-send, then back: each prompt lands once.
     agent-browser's offline switch does not reach the sync worker's fetch,
     so the cut is boxbox itself dying with no goodbye, the way a phone
     loses the network: the stream and any post in flight fail together */
  const midSend = `sent as the connection dropped ${Date.now()}`;
  const whileDown = `written while the connection was down ${Date.now()}`;
  type(midSend);
  tap(".stage-dock .cz-send");
  await world.cut();
  await until("the composer to see the connection gone", () => js("document.querySelector('.stage-dock .cz-card[data-state=waiting]') !== null || document.querySelector('.stage-dock .cz-card') === null") === "true", 30_000);
  type(whileDown);
  tap(".stage-dock .cz-send");
  await until("the card waiting on the device", () => js("document.querySelectorAll('.stage-dock .cz-card[data-state=waiting]').length > 0") === "true", 15_000);
  const waiting = js("[...document.querySelectorAll('.stage-dock .cz-card[data-state=waiting]')].map(c => c.querySelector('small')?.textContent + ': ' + c.querySelector('.cz-why')?.textContent).join(' | ')");
  check("with the connection down the message waits on the device, in words", /on this device: the connection is down/.test(waiting), waiting);
  shoot("offline", "phone");
  const heldDown = await count(id, whileDown);
  check("nothing written while down reached the daemon", heldDown === 0, `${heldDown} times`);
  await world.serve();
  // a post that failed three times while the page still thought it was live ends as "not sent"; retry sends it with the same id
  await sleep(4000);
  const failed = js("JSON.stringify([...document.querySelectorAll('.stage-dock .cz-card[data-state=failed] [aria-label^=\"retry: \"]')].map(b => (b.click(), b.getAttribute('aria-label'))))");
  log(`after the cut: ${failed === "[]" ? "nothing needed a retry" : `retried ${failed}`}`);
  await until("both cut sends to land", async () => (await count(id, midSend)) >= 1 && (await count(id, whileDown)) >= 1, 90_000);
  // a landed send leaves the outbox; one still there after 45 s (past the 30 s echo watch) is a card that lies
  await until("the outbox to empty", () => js("document.querySelectorAll('.stage-dock .cz-card').length") === "0", 45_000).catch(() => undefined);
  await sleep(31_000);
  const left = js("[...document.querySelectorAll('.stage-dock .cz-card')].map(c => c.querySelector('small')?.textContent + ': ' + c.querySelector('.cz-card-text p')?.textContent).join(' | ')");
  check("after the connection is back no card is left, so none says \"not sent\" for a message that landed", left === "", left || "no cards");
  check("the send cut mid-flight is in the daemon's transcript exactly once", (await count(id, midSend)) === 1, `${await count(id, midSend)} times`);
  check("the send written while down is in the daemon's transcript exactly once", (await count(id, whileDown)) === 1, `${await count(id, whileDown)} times`);
  await idle(id);

  /* fifty sends, for send to acknowledged */
  for (let n = 1; n <= 50; n++) {
    type(`[bench:words 3 5] count ${n}`);
    tap(".stage-dock .cz-send");
    await sleep(350);
  }
  await until("the fifty to land", async () => (await transcript(id)).filter((m) => m.parts.some((p) => p.text?.includes("] count "))).length >= 50, 240_000);
  await idle(id);
  // the worker's telemetry flushes every 10 s and its rows die with the page (docs/gotchas.md), so the page stays past one flush
  await sleep(11_000);
  ab("open", "about:blank");
  await sleep(1500);

  /* screenshots at each width, looked at after */
  for (const [label, w, h] of WIDTHS) {
    ab("set", "viewport", String(w), String(h));
    ab("open", `${APP}/?thread=${encodeURIComponent(key)}`);
    await until("the composer", () => js("!!document.querySelector('.stage-dock textarea')") === "true", 30_000);
    await sleep(800);
    shoot("thread", label);
    js("document.querySelector('.stage-dock textarea').focus()");
    type("a draft, kept in indexeddb");
    await sleep(400);
    shoot("focused", label);
  }
  ab("open", `${APP}/?thread=${encodeURIComponent(key)}`);
  await until("the composer after a reload", () => js("!!document.querySelector('.stage-dock textarea')") === "true", 30_000);
  await sleep(1200);
  check("the draft survives a reload", js("document.querySelector('.stage-dock textarea').value") === "a draft, kept in indexeddb");
  type("");
  await sleep(600);
  ab("open", "about:blank");
  await sleep(12_000);

  /* send to acknowledged, from the rows boxbox wrote */
  const dir = join(WORLD, "boxbox", "boxbox-data", "telemetry");
  const rows = readdirSync(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".ndjson")).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n")).filter(Boolean).map((l) => JSON.parse(l) as { kind: string; ms?: number; ok?: boolean | number; props?: Record<string, unknown> }).filter((r) => r.kind === "perf.send");
  const ms = rows.filter((r) => r.ok === true || r.ok === 1).map((r) => r.ms ?? 0).sort((a, b) => a - b);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? Number.NaN;
  const byVerb = Object.entries(rows.reduce<Record<string, number>>((acc, r) => ((acc[String(r.props?.verb)] = (acc[String(r.props?.verb)] ?? 0) + 1), acc), {})).map(([v, n]) => `${v} ${n}`).join(", ");
  log(`perf.send rows: ${rows.length} (${byVerb}); acknowledged ${ms.length}; p50 ${p(0.5)} ms, p90 ${p(0.9)} ms, max ${ms.at(-1)} ms`);
  // rows written in boxbox's last 500 ms before the cut die with it (the ingest's write window); the rest must all be acknowledged
  check("every send boxbox recorded was acknowledged by its echo", ms.length === rows.length, `${rows.length - ms.length} not`);
  check("send to acknowledged p90 under 400 ms over at least 50 sends", ms.length >= 50 && p(0.9) < 400, `${ms.length} sends, p90 ${p(0.9)} ms`);
} catch (error) {
  failures++;
  log(`FAIL the drive stopped: ${error instanceof Error ? error.message : String(error)}`);
  /* what the page knew when it stopped: its errors, and the outbox as indexeddb holds it */
  try {
    log(`page errors: ${ab("errors").slice(0, 800) || "none"}`);
    log(`console: ${ab("console").split("\n").slice(-12).join(" | ").slice(0, 1200)}`);
    ab("eval", "new Promise(r => { const q = indexedDB.open('boxbox'); q.onsuccess = () => { const t = q.result.transaction('outbox').objectStore('outbox').getAll(); t.onsuccess = () => r(JSON.stringify(t.result.map(e => ({ verb: e.verb, state: e.state, error: e.error, attempts: e.attempts })))); }; q.onerror = () => r('no db'); })");
    log(`outbox: ${ab("eval", "new Promise(r => { const q = indexedDB.open('boxbox'); q.onsuccess = () => { const t = q.result.transaction('outbox').objectStore('outbox').getAll(); t.onsuccess = () => r(JSON.stringify(t.result.map(e => ({ verb: e.verb, state: e.state, error: e.error, attempts: e.attempts })))); }; q.onerror = () => r('no db'); })")}`);
    log(`composer: ${js("document.querySelector('.stage-dock')?.innerText.slice(0, 300) ?? 'no composer'")}`);
  } catch (dump) {
    log(`the page could not be read: ${dump instanceof Error ? dump.message : String(dump)}`);
  }
} finally {
  spawnSync("agent-browser", ["--session", SESSION, "close"]);
  await world.stop();
  log(failures ? `${failures} failed` : "every check passed");
  process.exit(failures ? 1 : 0);
}
