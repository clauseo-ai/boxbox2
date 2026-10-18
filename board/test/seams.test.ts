/* the native daemon's seams, each against a tiny client standing in for
   the daemon: the fake board on its unix socket, the recording proxy in
   front of a server, and the radio's say recorder and meter log. the
   daemon is not needed for any of it; the gate (replay.ts --world v2) is
   where they meet the real one. */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYER, OP, REPORT_LEN, WIRE_NL } from "../trace/firmware";
import { nativeConfig } from "../trace/native";
import { normalize, V2_CROSS } from "../trace/normalize";
import { traceRun } from "../trace/run";
import type { World } from "../trace/world";
import { sseFrames, startProxy } from "../trace/proxy";
import { MIC_WINDOWS, MIC_WINDOW_MS, startRadio } from "../trace/radio";
import type { Record } from "../trace/records";
import { HELLO_ACK_MS, SocketBoard } from "../trace/socket-board";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-seams-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const frame = (op: number, ...payload: number[]) => {
  const bytes = new Uint8Array(REPORT_LEN);
  bytes.set([op, ...payload]);
  return bytes;
};

/** a host on the board's socket: what it received, in 32-byte reports */
async function host(path: string) {
  const reports: number[][] = [];
  let pending: number[] = [];
  let closed = false;
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_s, data) {
        pending.push(...data);
        while (pending.length >= REPORT_LEN) {
          reports.push(pending.slice(0, REPORT_LEN));
          pending = pending.slice(REPORT_LEN);
        }
      },
      close() {
        closed = true;
      },
    },
  });
  cleanups.push(() => socket.end());
  return { socket, reports, closed: () => closed };
}

async function until(what: string, check: () => boolean, ms = 2000) {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("the socket board", () => {
  test("is absent until plugged, and gone again once unplugged", () => {
    const path = join("/tmp", `board-seams-${process.pid}-a.sock`);
    const board = new SocketBoard({ path, onRecord: () => {} });
    cleanups.push(() => board.stop());
    expect(existsSync(path)).toBe(false);
    board.plug();
    expect(existsSync(path)).toBe(true);
    board.unplug();
    expect(existsSync(path)).toBe(false);
  });

  test("answers a hello with the mode echo at once and the ack 40ms later, recording both directions in v1's shape", async () => {
    const path = join("/tmp", `board-seams-${process.pid}-b.sock`);
    const records: Record[] = [];
    const board = new SocketBoard({ path, onRecord: (r) => records.push(r) });
    cleanups.push(() => board.stop());
    board.plug();
    const daemon = await host(path);
    await until("the connection", () => board.connected);
    const sentAt = Date.now();
    /* split across two writes: frames are reassembled from the stream */
    const hello = frame(OP.hello, 1);
    daemon.socket.write(hello.subarray(0, 10));
    daemon.socket.write(hello.subarray(10));
    await until("the hello ack", () => daemon.reports.some((r) => r[0] === OP.helloAck));
    const ackAt = Date.now();
    expect(daemon.reports.map((r) => r.slice(0, 4))).toEqual([
      [OP.modeEcho, LAYER.drive, 0, 0],
      [OP.helloAck, 5, 1, LAYER.drive],
    ]);
    expect(daemon.reports.every((r) => r.length === REPORT_LEN)).toBe(true);
    expect(ackAt - sentAt).toBeGreaterThanOrEqual(HELLO_ACK_MS - 2);
    const hid = records.filter((r) => r.ch === "hid");
    expect(hid).toHaveLength(1);
    expect(hid[0]?.ch === "hid" && hid[0].bytes.slice(0, 3)).toEqual([0, OP.hello, 1]);
    expect(hid[0]?.ch === "hid" && hid[0].bytes.length).toBe(REPORT_LEN + 1);
    expect(records.filter((r) => r.ch === "board").map((r) => (r.ch === "board" ? r.bytes[0] : 0))).toEqual([OP.modeEcho, OP.helloAck]);
  });

  test("reports keys to the connected host, and drops to calc on the watchdog when the host goes quiet", async () => {
    const path = join("/tmp", `board-seams-${process.pid}-c.sock`);
    let clock = 0;
    const board = new SocketBoard({ path, onRecord: () => {}, now: () => clock });
    cleanups.push(() => board.stop());
    board.plug();
    const daemon = await host(path);
    await until("the connection", () => board.connected);
    daemon.socket.write(frame(OP.hello, 1));
    await until("the hello ack", () => daemon.reports.length === 2);
    board.press(11, true);
    board.press(11, false);
    await until("two key reports", () => daemon.reports.length === 4);
    expect(daemon.reports.slice(2).map((r) => r.slice(0, 3))).toEqual([
      [OP.key, 11, 0],
      [OP.key, 11, 1],
    ]);
    clock = 2500;
    await until("the watchdog's echo", () => daemon.reports.length === 5, 500);
    expect(daemon.reports[4]?.slice(0, 3)).toEqual([OP.modeEcho, LAYER.calc, 2]);
    board.press(WIRE_NL, true);
    await Bun.sleep(20);
    expect(daemon.reports).toHaveLength(5);
  });

  test("unplugging closes the host's connection", async () => {
    const path = join("/tmp", `board-seams-${process.pid}-d.sock`);
    const board = new SocketBoard({ path, onRecord: () => {} });
    cleanups.push(() => board.stop());
    board.plug();
    const daemon = await host(path);
    await until("the connection", () => board.connected);
    board.unplug();
    await until("the close", () => daemon.closed());
  });
});

describe("the recording proxy", () => {
  test("records a call's method, path, body and status, and passes the answer through", async () => {
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => new Response(null, { status: req.method === "POST" ? 204 : 404 }) });
    cleanups.push(() => upstream.stop(true));
    const records: Record[] = [];
    const proxy = startProxy(`http://127.0.0.1:${upstream.port}`, (r) => records.push(r));
    cleanups.push(() => proxy.stop());
    const res = await fetch(`${proxy.origin}/api/board/act`, { method: "POST", body: JSON.stringify({ verb: "read", key: "h1:s" }) });
    expect(res.status).toBe(204);
    const missing = await fetch(`${proxy.origin}/api/nothing?x=1`);
    expect(missing.status).toBe(404);
    expect(records.map((r) => ({ ...r, t: 0 }))).toEqual([
      { ch: "http", t: 0, id: 1, method: "POST", path: "/api/board/act", directory: null, body: { verb: "read", key: "h1:s" } },
      { ch: "http-done", t: 0, id: 1, status: 204 },
      { ch: "http", t: 0, id: 2, method: "GET", path: "/api/nothing?x=1", directory: null, body: null },
      { ch: "http-done", t: 0, id: 2, status: 404 },
    ]);
  });

  test("streams an sse answer unbuffered and records each frame on the side", async () => {
    let push: (text: string) => void = () => {};
    let end: () => void = () => {};
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              push = (text) => c.enqueue(new TextEncoder().encode(text));
              end = () => c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    cleanups.push(() => upstream.stop(true));
    const records: Record[] = [];
    const proxy = startProxy(`http://127.0.0.1:${upstream.port}`, (r) => records.push(r));
    cleanups.push(() => proxy.stop());
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    let started = false;
    const pending = fetch(`${proxy.origin}/api/board/stream?protocol=1`, { signal: abort.signal });
    void pending.then(() => (started = true));
    /* the server's first frame may be what puts its headers on the wire */
    await until("the upstream stream", () => records.length > 0);
    await Bun.sleep(20);
    push('data: {"type":"hello","protocol":1,"version":"t"}\n\n');
    const res = await pending;
    expect(started).toBe(true);
    expect(records.find((r) => r.ch === "http-done")).toMatchObject({ status: 200 });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"hello"');
    /* the second frame arrives while the stream stays open: nothing waited for the end */
    push(': hb\n\ndata: {"type":"view","machines":[],"threads":[],"bindings":[]}\n\n');
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain('"view"');
    await until("both frames recorded", () => records.filter((r) => r.ch === "sse").length === 2);
    expect(records.filter((r) => r.ch === "sse").map((r) => (r.ch === "sse" ? (r.data as { type: string }).type : ""))).toEqual(["hello", "view"]);
    /* the server ends the stream, as a replaced board stream ends */
    end();
    expect((await reader.read()).done).toBe(true);
  });

  test("an unreachable server is a 502 and an unreachable outcome", async () => {
    const records: Record[] = [];
    const proxy = startProxy("http://127.0.0.1:9", (r) => records.push(r));
    cleanups.push(() => proxy.stop());
    const res = await fetch(`${proxy.origin}/api/login`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect(records.at(-1)).toMatchObject({ ch: "http-done", status: null });
  });

  test("sse frames split anywhere still read whole", () => {
    const seen: unknown[] = [];
    const feed = sseFrames((d) => seen.push(d));
    feed('data: {"a"');
    feed(":1}\n");
    feed("\ndata: plain\r\n\r\n");
    expect(seen).toEqual([{ a: 1 }, "plain"]);
  });
});

describe("the radio", () => {
  test("the say shim records its words and exits 0 without speaking", async () => {
    const dir = scratch();
    const records: Record[] = [];
    const radio = startRadio(dir, (r) => records.push(r));
    cleanups.push(() => radio.stop());
    const out = Bun.spawnSync([radio.sayCommand, "-v", "Samantha", "alpha, done"]);
    expect(out.exitCode).toBe(0);
    await until("the say record", () => records.some((r) => r.ch === "exec"));
    expect(records.map((r) => ({ ...r, t: 0 }))).toEqual([
      { ch: "exec", t: 0, cmd: "say", args: ["-v", "Samantha", "alpha, done"] },
      { ch: "exec-end", t: 0, cmd: "say" },
    ]);
  });

  test("the meter script is v1's six windows, and the daemon's start and stop lines read as sox's", async () => {
    const dir = scratch();
    const records: Record[] = [];
    const radio = startRadio(dir, (r) => records.push(r));
    cleanups.push(() => radio.stop());
    expect(JSON.parse(readFileSync(radio.meterPath, "utf8"))).toEqual({ windowMs: MIC_WINDOW_MS, levels: MIC_WINDOWS });
    expect(MIC_WINDOWS).toEqual([0.3, 0.15, 0.3, 0.08, 0.3, 0.15]);
    appendFileSync(`${radio.meterPath}.log`, "start\n");
    appendFileSync(`${radio.meterPath}.log`, "stop\nsta");
    await until("the meter records", () => records.length === 2);
    expect(records.map((r) => r.ch)).toEqual(["exec", "exec-end"]);
    expect(records.every((r) => (r.ch === "exec" || r.ch === "exec-end") && r.cmd === "sox")).toBe(true);
  });
});

describe("a traced run of a native daemon", () => {
  test("starts it idle, plugs the board in, and records every seam per step", async () => {
    const dir = scratch();
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 204 }) });
    cleanups.push(() => upstream.stop(true));
    const binary = join(dir, "boxbox-board");
    writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fake-native.ts")}'\n`);
    chmodSync(binary, 0o755);
    const world: World = {
      origin: `http://127.0.0.1:${upstream.port}`,
      password: "trace-test",
      machineOrder: ["h1"],
      open: () => Promise.reject(new Error("not staged")),
      prompt: () => Promise.reject(new Error("not staged")),
      settled: () => Promise.resolve(),
      quiet: () => Promise.resolve(true),
      aliases: () => new Map(),
      redactions: () => [],
      stop: () => Promise.resolve(),
    };
    const run = await traceRun({
      scenario: { name: "seams", about: "", setup: () => Promise.resolve(), steps: [{ label: "tap k1", gesture: { kind: "tap", key: "k1" } }] },
      world,
      daemon: binary,
      runDir: join(dir, "run"),
      log: () => {},
    });
    const view = normalize(run.steps, V2_CROSS);
    expect(view.steps.map((s) => s.label)).toEqual(["the daemon starts, then the board is plugged in", "tap k1"]);
    expect(view.steps[0]?.leds).toEqual(["hello proto 1", `frame ${Array(17).fill("29").join(" ")}`]);
    expect(view.steps[0]?.board).toEqual(["mode drive (host)", "hello-ack fw 5 proto 1 mode 0"]);
    expect(view.steps[0]?.calls).toEqual(["login -> ok"]);
    expect(view.steps[1]?.board).toEqual(["key 11 down", "key 11 up"]);
    expect(view.steps[1]?.leds).toEqual([`frame ${Array(17).fill("2a").join(" ")}`]);
    expect(view.steps[1]?.calls).toEqual(['markRead {"session":"h1:s"} -> ok']);
    expect(view.steps[1]?.radio).toEqual(['say "alpha"', "sox start", "sox stop"]);
    expect(view.keepaliveGapMs).toBeLessThan(1000);
  }, 20_000);
});

describe("the native daemon's config", () => {
  test("pins the night curve and names the harness's seams, nothing machine-specific", () => {
    const text = nativeConfig({ origin: "http://127.0.0.1:5", passwordFile: "/w/password", sayCommand: "/w/say" });
    expect(text).toContain('origin = "http://127.0.0.1:5"');
    expect(text).toContain('password_file = "/w/password"');
    expect(text).toContain(`night_curve = [${Array(24).fill(255).join(", ")}]`);
    expect(text).toContain('voice = ""');
    expect(text).toContain("mic_meter = true");
    expect(text).toContain('say_command = "/w/say"');
  });
});
