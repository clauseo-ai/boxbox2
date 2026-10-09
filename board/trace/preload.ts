/* the harness side of a traced board daemon, loaded with `bun --preload`
   into the daemon's own process so the daemon under test runs unmodified.

   three seams, and nothing else is touched:

     - `node-hid` resolves to a virtual module whose one device is the fake
       board (firmware.ts). every host write reaches the fake firmware and
       is recorded; every report the firmware sends back is recorded too.
     - `fetch` is wrapped: every call the daemon makes to its server is
       recorded as a request and a response, with its body. the stream's
       body is passed through unread.
     - `Bun.spawn` of `say` and `sox` is answered here: `say` is recorded and
       never speaks, and `sox` is a scripted microphone (a fixed run of
       level windows, 150ms apart, then quiet) so the voice meter draws the
       same frames every run. anything else spawns for real.

   records go to the parent over bun's ipc channel. the parent plugs the
   board in and sends the key presses. nothing here writes to the terminal or the filesystem. */

import { plugin } from "bun";
import { FakeFirmware } from "./firmware";

export type Record =
  | { ch: "hid"; t: number; bytes: number[] }
  | { ch: "board"; t: number; bytes: number[] }
  | { ch: "key"; t: number; wire: number; down: boolean }
  | {
      ch: "http";
      t: number;
      id: number;
      method: string;
      path: string;
      directory: string | null;
      body: unknown;
    }
  | { ch: "http-done"; t: number; id: number; status: number | null }
  | { ch: "exec"; t: number; cmd: string; args: string[] }
  | { ch: "exec-end"; t: number; cmd: string };

export type Command = { kind: "plug" } | { kind: "key"; wire: number; down: boolean };

const send = (record: Record) => process.send?.(record);

/* ——— the fake board ——— */

/* a real board answers after the write resolves, over its own interrupt
   endpoint; answering inside write() would land the hello ack before the
   daemon arms its hello timeout, which then fires on a live board. the
   hello ack waits HELLO_ACK_MS: the daemon's render loop draws as soon as
   the device opens, before the ack, and a fixed latency longer than one
   render tick (16ms) makes that first frame land before the palette push
   every time, instead of when the scheduler says. */
const REPORT_MS = 1;
const HELLO_ACK_MS = 40;

const firmware = new FakeFirmware((bytes) => {
  setTimeout(
    () => {
      send({ ch: "board", t: Date.now(), bytes });
      for (const listener of listeners) listener(Buffer.from(bytes));
    },
    bytes[0] === 0x81 ? HELLO_ACK_MS : REPORT_MS,
  );
});
const listeners = new Set<(data: Buffer) => void>();
const watchdog = setInterval(() => firmware.housekeeping(Date.now()), 50);
watchdog.unref();

/* the board is plugged in when the parent says so, not at launch: the
   daemon's stream and its device start together, and a board present from
   the first instant races the first snapshot for the formation lap. the
   daemon finds it on its own hotplug scan, as it would a real replug. */
let plugged = false;

process.on("message", (message: Command) => {
  if (message.kind === "plug") {
    plugged = true;
    return;
  }
  const t = Date.now();
  send({ ch: "key", t, wire: message.wire, down: message.down });
  firmware.press(message.wire, message.down, t);
});

const FAKE_PATH = "fake-board";

class FakeHid {
  on(event: string, listener: (data: Buffer) => void) {
    if (event === "data") listeners.add(listener);
    return this;
  }
  async write(report: number[]): Promise<number> {
    const t = Date.now();
    send({ ch: "hid", t, bytes: [...report] });
    firmware.receive(report, t);
    return report.length;
  }
  async close() {
    listeners.clear();
  }
}

const hid = {
  devicesAsync: async () => (plugged ? [{ vendorId: 0x3a54, productId: 0x4f5d, usagePage: 0xff60, usage: 0x61, path: FAKE_PATH }] : []),
  HIDAsync: { open: async (path: string) => (path === FAKE_PATH ? new FakeHid() : Promise.reject(new Error(`no device at ${path}`))) },
};

plugin({
  name: "board-trace-hid",
  setup(build) {
    build.module("node-hid", () => ({ exports: { default: hid, ...hid }, loader: "object" }));
  },
});

/* ——— the server calls ——— */

let nextId = 0;
const realFetch = globalThis.fetch;

function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return null;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return init.body;
  }
}

function directoryOf(init: RequestInit | undefined): string | null {
  const headers = new Headers(init?.headers);
  return headers.get("x-opencode-directory");
}

const tracedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const id = ++nextId;
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  send({
    ch: "http",
    t: Date.now(),
    id,
    method: (init?.method ?? "GET").toUpperCase(),
    path: `${url.pathname}${url.search}`,
    directory: directoryOf(init),
    body: bodyOf(init),
  });
  try {
    const res = await realFetch(input, init);
    send({ ch: "http-done", t: Date.now(), id, status: res.status });
    return res;
  } catch (error) {
    send({ ch: "http-done", t: Date.now(), id, status: null });
    throw error;
  }
};
globalThis.fetch = Object.assign(tracedFetch, { preconnect: realFetch.preconnect });

/* ——— the radio's processes ——— */

/** the scripted microphone: square-wave windows at these amplitudes, so
    each window's rms is exactly its amplitude and the meter's auto-gain
    lands on the same bars every run */
const MIC_WINDOWS = [0.3, 0.15, 0.3, 0.08, 0.3, 0.15];
const MIC_WINDOW_MS = 150;
const WINDOW_SAMPLES = 200;

function micWindow(amplitude: number): Uint8Array {
  const bytes = new Uint8Array(WINDOW_SAMPLES * 2);
  const view = new DataView(bytes.buffer);
  const level = Math.round(amplitude * 32767);
  for (let i = 0; i < WINDOW_SAMPLES; i++) view.setInt16(i * 2, i % 2 === 0 ? level : -level, true);
  return bytes;
}

function fakeProcess(cmd: string, stdout: ReadableStream<Uint8Array> | null, onKill: () => void) {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let ended = false;
  const end = (code: number) => {
    if (ended) return;
    ended = true;
    onKill();
    send({ ch: "exec-end", t: Date.now(), cmd });
    resolveExit(code);
  };
  return { proc: { stdout, exited, pid: 0, kill: () => end(0) }, end };
}

function fakeSox() {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const [i, amplitude] of MIC_WINDOWS.entries()) {
        timers.push(setTimeout(() => controller?.enqueue(micWindow(amplitude)), MIC_WINDOW_MS * (i + 1)));
      }
    },
  });
  return fakeProcess("sox", stdout, () => {
    for (const timer of timers) clearTimeout(timer);
    try {
      controller?.close();
    } catch {
      /* the reader already let go */
    }
  }).proc;
}

const realSpawn = Bun.spawn.bind(Bun);
const tracedSpawn = ((command: string[] | { cmd: string[] }, options?: unknown) => {
  const argv = Array.isArray(command) ? command : command.cmd;
  const cmd = argv[0] ?? "";
  if (cmd === "say" || cmd === "sox") {
    send({ ch: "exec", t: Date.now(), cmd, args: argv.slice(1) });
    if (cmd === "sox") return fakeSox();
    const { proc, end } = fakeProcess("say", null, () => {});
    end(0);
    return proc;
  }
  return realSpawn(command as string[], options as Parameters<typeof Bun.spawn>[1]);
}) as typeof Bun.spawn;
/* writable but not configurable: assignment is the only way in */
Bun.spawn = tracedSpawn;
