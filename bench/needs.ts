/* `bun bench/needs.ts`: m4's drive against a real cmx2 daemon, through
   boxbox's own api (docs/verification.md, the push matrix).

   against the release binary on the bench config and the pinned daemon
   `just cmx2` wrote, it makes real threads and real turns (the bench
   model's scripts), plays the presence of other devices over
   `POST /api/presence`, and prints, per row of the push matrix, the
   `push.decided` row the server wrote for it. then it opens two stream
   clients and answers an ask on one, printing when each saw it settle;
   replies to the settled ask and prints who answered and when; and prints
   `GET /api/needs` with its `x-boxbox-seq`.

   phases, so a server restart can sit between them:
     (default)            the matrix, the cross-client clear, the settled reply
     --phase leave-open   raises an ask and leaves it open (prints its need id)
     --phase replayed ID  after a boxbox restart: the replayed row for ID
     --phase stage        leaves a permission, a question and a done open,
                          for a drive of the inbox (prints them as json)

   --expect-sent: at least one device is subscribed, so asks and done
   decide `sent` (else `no-subscriptions`). the ids it expects delivered
   are written to /tmp/boxbox-needs-sent.json for the push harness. */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = join(ROOT, ".cmx2", "bench");

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const PHASE = flag("--phase") ?? "matrix";
const EXPECT_SENT = process.argv.includes("--expect-sent");
const SENT_FILE = "/tmp/boxbox-needs-sent.json";

function say(line: string) {
  console.log(`needs: ${line}`);
}

function fail(message: string): never {
  console.error(`needs: FAIL ${message}`);
  process.exit(1);
}

function benchValue(key: string): string {
  const config = readFileSync(join(BENCH, "boxbox.toml"), "utf8");
  const match = config.match(new RegExp(`^${key} = "([^"]*)"`, "m"));
  if (!match?.[1]) fail(`no ${key} in .cmx2/bench/boxbox.toml; run \`just cmx2\` first`);
  return match[1];
}

if (!existsSync(join(BENCH, "boxbox.toml"))) fail("no bench config; run `just cmx2 --port <n> --boxbox-port <n>` first");
const BOXBOX = `http://${benchValue("listen")}`;
const DATA_DIR = benchValue("data_dir");
const DAEMON = benchValue("url").replace(/\/$/, "");
const HOST =
  readFileSync(join(BENCH, "boxbox.toml"), "utf8").match(/^\[\[host\]\]\s*\nname = "([^"]+)"/m)?.[1] ??
  fail("no [[host]] name in .cmx2/bench/boxbox.toml");
const GATE = readFileSync(join(BENCH, "gate-password"), "utf8").trim();
const DAEMON_AUTH = `Basic ${btoa(`cmx2:${readFileSync(join(BENCH, "password"), "utf8").trim()}`)}`;

const login = await fetch(`${BOXBOX}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: GATE }),
}).catch(() => undefined);
if (!login?.ok) fail(`boxbox at ${BOXBOX} did not sign in (${login?.status ?? "not answering"})`);
const COOKIE = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/* ——— the api, as a device would call it ——— */

type Device = { device: string; deviceClass: string };
const PHONE: Device = { device: "matrix-phone", deviceClass: "iphone" };
const IPAD: Device = { device: "matrix-ipad", deviceClass: "ipad" };
const MAC: Device = { device: "matrix-mac", deviceClass: "mac" };

async function boxbox(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; headers: Headers }> {
  const res = await fetch(`${BOXBOX}${path}`, {
    method,
    headers: { cookie: COOKIE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function daemon(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${DAEMON}${path}`, {
    method,
    headers: { authorization: DAEMON_AUTH, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function thread(title: string): Promise<{ id: string; key: string }> {
  const session = (await daemon("POST", "/session", { title })) as { id?: string };
  if (!session.id) fail(`the daemon made no session for ${title}`);
  // the fleet hears of it from the stream; wait until it holds the session
  const key = `${HOST}:${session.id}`;
  await until(`the fleet to hold ${key}`, 10, async () => {
    const fleet = (await boxbox("GET", "/api/fleet")).json as { sessions: { key: string }[] };
    return fleet.sessions.some((s) => s.key === key) ? true : undefined;
  });
  return { id: session.id, key };
}

async function prompt(t: { id: string }, text: string, from: Device = PHONE): Promise<void> {
  const sent = await boxbox("POST", `/api/hosts/${HOST}/sessions/${t.id}/prompt`, { ...from, clientID: crypto.randomUUID(), text });
  if (sent.status !== 202) fail(`the prompt was refused: ${sent.status} ${JSON.stringify(sent.json)}`);
}

async function presence(from: Device, visible: boolean, focused: boolean, key: string | null): Promise<void> {
  const sent = await boxbox("POST", "/api/presence", { device: from.device, visible, focused, thread: key, windowsInView: [] });
  if (sent.status !== 204) fail(`presence was refused: ${sent.status} ${JSON.stringify(sent.json)}`);
}

async function hidden(): Promise<void> {
  for (const d of [PHONE, IPAD, MAC]) await presence(d, false, false, null);
}

type Need = { id: string; kind: string; key: string; ask?: string; rank: number; raisedAt: number; title: string; body: string };

async function needOf(key: string, kind: string, seconds = 20): Promise<Need> {
  return until(`a ${kind} need on ${key}`, seconds, async () => {
    const list = (await boxbox("GET", "/api/needs")).json as { open: Need[] };
    return list.open.find((n) => n.key === key && n.kind === kind);
  });
}

/* ——— telemetry, read from the server's own day files ——— */

type Row = { kind: string; ok?: number; ms?: number; session?: string; props?: Record<string, unknown> };

function rows(): Row[] {
  const dir = join(DATA_DIR, "telemetry");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row);
}

function decided(match: (row: Row) => boolean, seconds: number): Promise<Row> {
  return until("the push.decided row", seconds, async () => rows().find((r) => r.kind === "push.decided" && match(r)));
}

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(200);
  }
  return fail(`${what} did not happen within ${seconds} s`);
}

/** one reader of GET /api/stream, as a second client would hold it */
class StreamClient {
  readonly ready: Promise<void>;
  private text = "";
  private readonly seen: { at: number; line: string }[] = [];
  private readonly abort = new AbortController();

  constructor(readonly name: string) {
    this.ready = this.read();
  }

  private read(): Promise<void> {
    return new Promise((ready, broke) => {
      void (async () => {
        const res = await fetch(`${BOXBOX}/api/stream`, { headers: { cookie: COOKIE }, signal: this.abort.signal });
        if (!res.ok || !res.body) return broke(new Error(`stream ${this.name}: ${res.status}`));
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            this.text += value;
            let cut = this.text.indexOf("\n\n");
            while (cut !== -1) {
              const frame = this.text.slice(0, cut);
              this.text = this.text.slice(cut + 2);
              this.seen.push({ at: Date.now(), line: frame });
              if (frame.includes(`"type":"reset"`) || frame.includes(`"type":"hello"`)) ready();
              cut = this.text.indexOf("\n\n");
            }
          }
        } catch {
          /* closed */
        }
      })();
    });
  }

  saw(type: string, id: string): Promise<number> {
    return until(`client ${this.name} to see ${type} for ${id}`, 5, async () => this.seen.find((f) => f.line.includes(type) && f.line.includes(`"${id}"`))?.at);
  }

  close() {
    this.abort.abort();
  }
}

/* ——— the matrix ——— */

type Result = { row: string; expected: string; got: string; id: string; line: string };
const results: Result[] = [];
const sentIds: string[] = [];

function record(row: string, expected: string, got: Row) {
  const reason = String(got.props?.reason);
  const id = String(got.props?.id);
  results.push({ row, expected, got: reason, id, line: JSON.stringify(got) });
  say(`${reason === expected ? "ok  " : "MISS"} ${row}: push.decided reason=${reason} (expected ${expected})\n        ${JSON.stringify(got)}`);
  if (reason === "sent") sentIds.push(id);
}

/** a question raised by [bench:tools] in a fresh thread; returns the thread and its need */
async function askIn(title: string, from: Device = PHONE): Promise<{ t: { id: string; key: string }; need: Need }> {
  const t = await thread(title);
  await prompt(t, "[bench:tools] matrix", from);
  const need = await needOf(t.key, "question", 30);
  return { t, need };
}

async function answer(need: Need, from: Device, label = "hello"): Promise<{ status: number; json: unknown }> {
  return boxbox("POST", `/api/hosts/${HOST}/questions/${need.ask}`, { ...from, clientID: crypto.randomUUID(), answers: [[label]] });
}

const ask = EXPECT_SENT ? "sent" : "no-subscriptions";

if (PHASE === "matrix") {
  say(`boxbox ${BOXBOX}, daemon ${DAEMON} (host "${HOST}"), expecting ${ask} for pushes`);
  await hidden();

  {
    const t = await thread("matrix: watched here");
    await presence(PHONE, true, true, t.key);
    await prompt(t, "[bench:tools] matrix");
    const need = await needOf(t.key, "question", 30);
    record("ask, the thread on stage on this device", "watched", await decided((r) => r.props?.id === need.id, 10));
    await answer(need, PHONE);
    await presence(PHONE, false, false, null);
  }
  {
    const t = await thread("matrix: watched elsewhere");
    await presence(IPAD, true, true, t.key);
    await prompt(t, "[bench:tools] matrix", MAC);
    const need = await needOf(t.key, "question", 30);
    record("ask, the thread watched on another device", "watched", await decided((r) => r.props?.id === need.id, 10));
    await answer(need, MAC);
    await presence(IPAD, false, false, null);
  }
  {
    const t = await thread("matrix: visible not focused");
    await presence(MAC, true, false, t.key);
    await prompt(t, "[bench:tools] matrix");
    const need = await needOf(t.key, "question", 30);
    record("ask, visible but not focused (another app in front)", ask, await decided((r) => r.props?.id === need.id, 10));
    await answer(need, PHONE);
    await presence(MAC, false, false, null);
  }
  {
    const { need } = await askIn("matrix: all hidden");
    record("ask, every device hidden", ask, await decided((r) => r.props?.id === need.id, 10));
    await answer(need, PHONE);
  }
  {
    const t = await thread("matrix: done armed");
    const started = Date.now();
    await prompt(t, "[bench:words 5 20] matrix");
    const need = await needOf(t.key, "done", 20);
    const row = await decided((r) => r.props?.id === need.id, 20);
    say(`        the done need was raised ${need.raisedAt - started} ms after the send; decided after ${Date.now() - need.raisedAt} ms`);
    record("done, a turn the user started, all hidden (after 10 s)", ask, row);
  }
  {
    const t = await thread("matrix: done continued");
    await prompt(t, "[bench:words 5 20] matrix");
    const need = await needOf(t.key, "done", 20);
    await prompt(t, "[bench:words 40 50] carry on");
    record("done, then the agent continues within 10 s", "continued", await decided((r) => r.props?.id === need.id, 15));
  }
  {
    const t = await thread("matrix: done not armed");
    await daemon("POST", `/session/${t.id}/prompt_async`, { text: "[bench:words 5 20] from another client" });
    const need = await needOf(t.key, "done", 20);
    record("done, a turn nobody started here", "not-armed", await decided((r) => r.props?.id === need.id, 10));
  }
  {
    const t = await thread("matrix: own interrupt");
    await prompt(t, "[bench:words 400 40] a long answer");
    await until("the turn to stream", 10, async () => {
      const fleet = (await boxbox("GET", "/api/fleet")).json as { sessions: { key: string; status: { type?: string } | null }[] };
      return fleet.sessions.find((s) => s.key === t.key)?.status?.type === "busy" ? true : undefined;
    });
    await Bun.sleep(600);
    const stopped = await boxbox("POST", `/api/hosts/${HOST}/sessions/${t.id}/abort`, { ...PHONE, clientID: crypto.randomUUID() });
    say(`        POST .../abort -> ${stopped.status} ${JSON.stringify(stopped.json)}`);
    record(
      "the user's own interrupt",
      "own-action",
      await decided((r) => String(r.props?.id).startsWith(`fault:${t.key}:`), 10),
    );
  }
  {
    const t = await thread("matrix: subagent");
    const started = Date.now();
    await prompt(t, "[bench:agent] matrix");
    // the subagent is a child session of this thread: its own done, decided after this send
    const child = await until("the subagent's session", 20, async () => {
      const fleet = (await boxbox("GET", "/api/fleet")).json as { sessions: { key: string; info: { parentID?: string } }[] };
      return fleet.sessions.find((s) => s.info.parentID === t.id)?.key;
    });
    say(`        ${t.key} spawned ${child}`);
    record(
      "a subagent finishing",
      "subagent",
      await decided((r) => (r as Row & { at: number }).at >= started && String(r.props?.id).startsWith(`done:${child}:`), 30),
    );
  }

  /* ——— an ask answered on one client clears on another ——— */
  {
    const t = await thread("clear: two clients");
    const a = new StreamClient("a");
    const b = new StreamClient("b");
    await Promise.all([a.ready, b.ready]);
    await prompt(t, "[bench:tools] clear");
    const need = await needOf(t.key, "question", 30);
    await Promise.all([a.saw(`"type":"ask"`, need.ask ?? ""), b.saw(`"type":"ask"`, need.ask ?? "")]);
    const sentAt = Date.now();
    const answered = await answer(need, PHONE);
    const answeredAt = Date.now();
    const [seenA, seenB] = await Promise.all([a.saw(`"type":"ask.settled"`, need.ask ?? ""), b.saw(`"type":"ask.settled"`, need.ask ?? "")]);
    say(`the ask ${need.ask} answered from ${PHONE.device} (${answered.status}) at ${new Date(sentAt).toISOString()}, acknowledged ${answeredAt - sentAt} ms later`);
    say(`  client a saw ask.settled at ${new Date(seenA).toISOString()}: ${seenA - sentAt} ms after the tap`);
    say(`  client b saw ask.settled at ${new Date(seenB).toISOString()}: ${seenB - sentAt} ms after the tap`);
    if (Math.max(seenA, seenB) - sentAt >= 1000) fail("an ask took a second or more to clear on another client");
    a.close();
    b.close();

    const late = await answer(need, MAC, "hi");
    say(`a reply from ${MAC.device} to the settled ask -> ${late.status} ${JSON.stringify(late.json)}`);
    const settled = (late.json as { error?: { code?: string; settled?: { by: string; at: number | null } } }).error;
    if (late.status !== 409 || settled?.code !== "settled" || !settled.settled) fail("a reply to a settled ask did not say who answered");
    const at = settled.settled.at === null ? "" : ` at ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(settled.settled.at)}`;
    say(`  the card says: "answered on ${settled.settled.by}${at}"`);
    const served = rows().filter((r) => (r.kind === "need.served" || r.kind === "push.acted") && r.props?.id === need.id);
    for (const row of served) say(`  ${JSON.stringify(row)}`);
  }

  /* ——— the needs route ——— */
  {
    const { t, need } = await askIn("needs: the route");
    const listed = await boxbox("GET", "/api/needs");
    say(`GET /api/needs -> ${listed.status}, x-boxbox-seq: ${listed.headers.get("x-boxbox-seq")}`);
    const open = (listed.json as { open: Need[] }).open.find((n) => n.id === need.id);
    say(`  ${JSON.stringify(open)}`);
    await answer(need, PHONE);
    // the answered question's turn runs on to its end, so nothing is left streaming for the next run
    await needOf(t.key, "done", 20);
  }

  say("\nthe push matrix:");
  console.log("  row                                                       expected          push.decided");
  for (const r of results) console.log(`  ${r.row.padEnd(58)}${r.expected.padEnd(18)}${r.got}${r.got === r.expected ? "" : "   MISS"}`);
  writeFileSync(SENT_FILE, JSON.stringify(sentIds));
  const missed = results.filter((r) => r.got !== r.expected).length;
  say(`${results.length - missed} of ${results.length} rows as expected; ids pushed: ${JSON.stringify(sentIds)}`);
  if (missed > 0) process.exit(1);
} else if (PHASE === "stage") {
  // real needs for the ui drive: a permission, a question and a done, left for the inbox
  await hidden();
  const perm = await thread("stage: permission");
  await prompt(perm, "[bench:asks] stage");
  const permission = await needOf(perm.key, "permission", 30);
  const { need: question } = await askIn("stage: question");
  const done = await thread("stage: done");
  await daemon("POST", `/session/${done.id}/prompt_async`, { text: "[bench:words 12 10] stage" });
  const finished = await needOf(done.key, "done", 20);
  console.log(JSON.stringify({ permission, question, done: finished }));
} else if (PHASE === "leave-open") {
  await hidden();
  const { need } = await askIn("replayed: left open");
  const row = await decided((r) => r.props?.id === need.id, 10);
  say(`an ask left open: ${need.id}; first decided ${row.props?.reason}`);
  console.log(need.id);
} else if (PHASE === "replayed") {
  const id = process.argv[process.argv.indexOf("replayed") + 1];
  if (!id) fail("name the need id left open");
  const row = await decided((r) => r.props?.id === id && r.props?.reason === "replayed", 20);
  record("a replayed event after a reconnect (boxbox restarted)", "replayed", row);
  const listed = (await boxbox("GET", "/api/needs")).json as { open: Need[] };
  const still = listed.open.find((n) => n.id === id);
  say(`the need survived the restart, raised once: ${JSON.stringify(still)}`);
  const raised = rows().filter((r) => r.kind === "need.raised" && r.props?.id === id);
  say(`need.raised rows for it across both runs: ${raised.length}`);
  if (raised.length !== 1) fail("the ask was raised again after the restart");
} else {
  fail(`no phase ${PHASE}`);
}
