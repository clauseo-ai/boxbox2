/* `bun bench/board.ts`: the board channel's drive against a real cmx2
   daemon, through boxbox's own api (docs/board.md, the channel).

   against a boxbox server whose boxbox.toml has `[board]` (no machines is
   fine) and a `[[host]]` on the pinned daemon `just cmx2` started, it plays
   the board's daemon and one app window on the board's mac, both from this
   machine:

     stream   GET /api/board/stream?protocol=1&device=bench-board&addrs=127.0.0.1
              answers `hello`, then `view` frames, with no `id:` lines
     here     GET /api/stream?board=1 gets `{"type":"board.here","seats":[]}`
     reply    a real thread whose turn asks a question (the bench model's
              `[bench:tools]` script, as bench/needs.ts raises one) shows in a
              view with `need: question` and the option labels; the board
              answers option 0 through POST /api/board/act and the need goes
     read     the read verb answers 204 and moves the thread's read mark
     focus    the focus verb answers 204 and reaches the window as
              `board.focus`; with the window closed it answers 409
              `no-board-window`
     gone     the gone verb answers 204, an open window hears `board.gone`,
              and a window opened after it gets no `board.here`

   each step prints `board: <step> ok|FAILED <detail>`; any failure exits 1.

   flags (defaults from the bench `just cmx2` wrote in .cmx2/bench/):
     --url URL            boxbox, http://127.0.0.1:3011
     --gate PASSWORD      boxbox's gate password, else .cmx2/bench/gate-password
     --daemon URL         the cmx2 daemon, else .cmx2/bench/daemon.json's url
     --daemon-password P  else .cmx2/bench/password
     --host NAME          the daemon's [[host]] name in boxbox.toml, bench

   setup, for example:
     just cmx2 --port 4840 --boxbox-port 3011
     (a boxbox.toml like .cmx2/bench/boxbox.toml, plus `[board]`, mode 0600)
     cargo run -p boxbox -- serve --config <that file>
     bun bench/board.ts */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BENCH = join(ROOT, ".cmx2", "bench");

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function benchFile(name: string): string {
  const path = join(BENCH, name);
  if (!existsSync(path)) {
    console.error(`board: no ${path}; run \`just cmx2\` first or pass the flag`);
    process.exit(1);
  }
  return readFileSync(path, "utf8").trim();
}

const BOXBOX = (flag("--url") ?? "http://127.0.0.1:3011").replace(/\/$/, "");
const GATE = flag("--gate") ?? benchFile("gate-password");
const DAEMON = (flag("--daemon") ?? (JSON.parse(benchFile("daemon.json")) as { url: string }).url).replace(/\/$/, "");
const DAEMON_AUTH = `Basic ${btoa(`cmx2:${flag("--daemon-password") ?? benchFile("password")}`)}`;
const HOST = flag("--host") ?? "bench";
const DEVICE = "bench-board";

let failures = 0;

function ok(step: string, detail: string) {
  console.log(`board: ${step} ok ${detail}`);
}

class Failed extends Error {}

function failed(step: string, detail: string) {
  failures++;
  console.log(`board: ${step} FAILED ${detail}`);
}

async function step(name: string, body: () => Promise<string>) {
  try {
    ok(name, await body());
  } catch (e) {
    failed(name, e instanceof Error ? e.message : String(e));
  }
}

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await Promise.resolve()
      .then(probe)
      .catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Failed(`${what} did not happen within ${seconds} s`);
}

/* the api */

const login = await fetch(`${BOXBOX}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: GATE }),
}).catch(() => undefined);
if (!login?.ok) {
  console.log(`board: login FAILED boxbox at ${BOXBOX} did not sign in (${login?.status ?? "not answering"})`);
  process.exit(1);
}
const COOKIE = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function boxbox(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
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
  return { status: res.status, json, text };
}

async function act(body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  return boxbox("POST", "/api/board/act", body);
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

type Ask = { id: string; kind: string; options?: string[] };
type BoardThread = { key: string; title?: string; need?: string; working?: boolean; ask?: Ask };
type View = { type: "view"; machines: unknown[]; threads: BoardThread[]; bindings: unknown[] };
type ReadMark = { at: number; message: string; device: string; markedAt: number };
type Session = { key: string; read?: ReadMark | null; needs?: { kind: string }[] };

/** one sse reader: every frame with its data lines parsed and whether it carried an `id:` */
class Sse {
  readonly frames: { at: number; id: boolean; data: string; json: unknown }[] = [];
  status = 0;
  ended = false;
  private readonly abort = new AbortController();
  readonly open: Promise<void>;

  constructor(readonly path: string) {
    this.open = this.read();
  }

  private async read(): Promise<void> {
    const res = await fetch(`${BOXBOX}${this.path}`, { headers: { cookie: COOKIE }, signal: this.abort.signal });
    this.status = res.status;
    if (!res.ok || !res.body) {
      this.ended = true;
      return;
    }
    void (async () => {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader(); // ok and a body, checked above
      let text = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += value;
          let cut = text.indexOf("\n\n");
          while (cut !== -1) {
            const frame = text.slice(0, cut);
            text = text.slice(cut + 2);
            const lines = frame.split("\n");
            const data = lines
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (data) {
              let json: unknown = null;
              try {
                json = JSON.parse(data);
              } catch {
                json = null;
              }
              this.frames.push({ at: Date.now(), id: lines.some((l) => l.startsWith("id:")), data, json });
            }
            cut = text.indexOf("\n\n");
          }
        }
      } catch {
        /* closed */
      }
      this.ended = true;
    })();
  }

  typed(type: string) {
    return this.frames.filter((f) => (f.json as { type?: string } | null)?.type === type);
  }

  close() {
    this.abort.abort();
  }
}

function lastView(board: Sse): View | undefined {
  return board.typed("view").at(-1)?.json as View | undefined;
}

async function fleetSession(key: string): Promise<Session | undefined> {
  const fleet = (await boxbox("GET", "/api/fleet")).json as { sessions: Session[] };
  return fleet.sessions.find((s) => s.key === key);
}

/* the drive */

console.log(`board: boxbox ${BOXBOX}, daemon ${DAEMON} (host "${HOST}"), device ${DEVICE}`);
const board = new Sse(`/api/board/stream?protocol=1&device=${DEVICE}&addrs=127.0.0.1`);
let app = new Sse("/api/stream?board=1");
let key = "";
let threadId = "";

await step("stream", async () => {
  await board.open;
  if (board.status !== 200) throw new Failed(`GET /api/board/stream -> ${board.status}`);
  await until("a view after hello", 5, () => (board.typed("view").length > 0 ? true : undefined));
  const first = board.frames[0]?.json as { type?: string; protocol?: number; version?: string } | undefined;
  if (first?.type !== "hello" || first.protocol !== 1) throw new Failed(`the first frame was ${board.frames[0]?.data}`);
  const withId = board.frames.filter((f) => f.id);
  if (withId.length > 0) throw new Failed(`${withId.length} frames carried an id line: ${withId[0]?.data}`);
  return `hello protocol ${first.protocol} version ${first.version}, then a view of ${lastView(board)?.threads.length} threads, no id lines`;
});

await step("here", async () => {
  await app.open;
  if (app.status !== 200) throw new Failed(`GET /api/stream?board=1 -> ${app.status}`);
  const here = await until("board.here", 5, () => app.frames.find((f) => f.data === `{"type":"board.here","seats":[]}`));
  if (here.id) throw new Failed("board.here carried an id line");
  return `${here.data}, id-less`;
});

await step("reply", async () => {
  const session = (await daemon("POST", "/session", { title: "board bench: a question" })) as { id?: string };
  if (!session.id) throw new Failed("the daemon made no session");
  threadId = session.id;
  key = `${HOST}:${session.id}`;
  await until(`the fleet to hold ${key}`, 10, async () => ((await fleetSession(key)) ? true : undefined));
  const sent = await boxbox("POST", `/api/hosts/${HOST}/sessions/${session.id}/prompt`, {
    device: DEVICE,
    deviceClass: "mac",
    clientID: crypto.randomUUID(),
    text: "[bench:tools] board",
  });
  if (sent.status !== 202) throw new Failed(`the prompt was refused: ${sent.status} ${sent.text}`);
  const asking = await until("a view with the question", 30, () =>
    lastView(board)?.threads.find((t) => t.key === key && t.need === "question" && t.ask && (t.ask.options?.length ?? 0) > 0),
  );
  const ask = asking.ask as Ask; // found above with an ask
  const labels = ask.options ?? [];
  const answered = await act({ verb: "reply", key, ask: ask.id, answer: { kind: "option", index: 0 } });
  if (answered.status !== 204) throw new Failed(`reply -> ${answered.status} ${answered.text}`);
  const after = await until("a view without the question", 10, () => {
    const t = lastView(board)?.threads.find((x) => x.key === key);
    return t && t.need !== "question" && t.ask?.id !== ask.id ? t : (t ? undefined : ({ key } as BoardThread));
  });
  return `${key} asked ${ask.id} with options ${JSON.stringify(labels)}; reply option 0 -> 204; next view need=${after.need ?? "none"}`;
});

await step("read", async () => {
  if (!key) throw new Failed("no thread from the reply step");
  // let the answered turn finish, so a done need and a newest message are there to read
  await until("the turn to finish", 30, () => {
    const t = lastView(board)?.threads.find((x) => x.key === key);
    return t && !t.working && t.need === "news" ? true : undefined;
  });
  const before = await fleetSession(key);
  const marked = await act({ verb: "read", key });
  if (marked.status !== 204) throw new Failed(`read -> ${marked.status} ${marked.text}`);
  const moved = await until("the read mark to move", 5, async () => {
    const s = await fleetSession(key);
    const mark = s?.read;
    return mark && mark.device === DEVICE && (before?.read?.markedAt ?? 0) < mark.markedAt ? s : undefined;
  });
  const news = await until("the done need to clear from the view", 5, () => {
    const t = lastView(board)?.threads.find((x) => x.key === key);
    return t?.need === "news" ? undefined : (t?.need ?? "none");
  });
  return `read -> 204; mark ${JSON.stringify(before?.read ?? null)} -> device ${moved.read?.device} message ${moved.read?.message}; view need now ${news}`;
});

await step("focus", async () => {
  if (!key) throw new Failed("no thread from the reply step");
  const focused = await act({ verb: "focus", key });
  if (focused.status !== 204) throw new Failed(`focus with a window open -> ${focused.status} ${focused.text}`);
  const seen = await until("board.focus on the window", 5, () =>
    app.frames.find((f) => f.data === JSON.stringify({ type: "board.focus", key })),
  );
  if (seen.id) throw new Failed("board.focus carried an id line");
  app.close();
  const closedAt = Date.now();
  // the server learns the window left when its body is dropped; give it the heartbeat's 15 s and say how long it took
  const refused = await until("focus to be refused with the window closed", 20, async () => {
    const r = await act({ verb: "focus", key });
    if (r.status === 204) return undefined;
    return r;
  });
  const code = (refused.json as { error?: { code?: string } } | null)?.error?.code;
  if (refused.status !== 409 || code !== "no-board-window") throw new Failed(`focus with no window -> ${refused.status} ${refused.text}`);
  return `focus -> 204 and the window got ${seen.data}; closed, focus -> 409 no-board-window after ${Date.now() - closedAt} ms`;
});

await step("gone", async () => {
  app = new Sse("/api/stream?board=1");
  await app.open;
  await until("board.here on the reopened window", 5, () => (app.typed("board.here").length > 0 ? true : undefined));
  const left = await act({ verb: "gone" });
  if (left.status !== 204) throw new Failed(`gone -> ${left.status} ${left.text}`);
  const heard = await until("board.gone on the window", 5, () => app.frames.find((f) => f.data === `{"type":"board.gone"}`));
  app.close();
  const late = new Sse("/api/stream?board=1");
  await late.open;
  await until("the late window's stream to start", 5, () => (late.frames.length > 0 ? true : undefined));
  await Bun.sleep(1500);
  late.close();
  const here = late.typed("board.here");
  if (here.length > 0) throw new Failed(`a window opened after gone got ${here[0]?.data}`);
  const composed = await act({ verb: "focus", key });
  return `gone -> 204; the open window got ${heard.data}; a window opened after got no board.here; focus now -> ${composed.status} ${(composed.json as { error?: { code?: string } } | null)?.error?.code ?? ""}`;
});

board.close();
if (threadId) await daemon("DELETE", `/session/${threadId}`).catch(() => undefined);
console.log(failures === 0 ? "board: every step ok" : `board: ${failures} step(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
