import { describe, expect, test } from "bun:test";
import { type RawEvent, Telemetry } from "./telemetry";

/* a server that holds the first batch until told to answer, so a second flush can be tried while one is in flight:
   the page that hides a moment after its 10 s flush left */
function slowServer() {
  const batches: string[][] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const http = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { events: RawEvent[] };
      batches.push(body.events.map((e) => e.id));
      if (batches.length === 1) await held;
      return new Response(null, { status: 204 });
    },
  });
  const arrived = async (n: number) => {
    for (let waited = 0; batches.length < n && waited < 2000; waited += 10) await Bun.sleep(10);
  };
  return { url: `http://127.0.0.1:${http.port}/api/telemetry`, batches, release, arrived, stop: () => http.stop(true) };
}

describe("a flush while a batch is in flight", () => {
  test("waits for it while the page stays", async () => {
    const http = slowServer();
    const telemetry = new Telemetry("dev_1", "mac", () => {}, () => null, http.url);
    telemetry.emit("perf.paint", { control: "window", arrangement: "deck", frames: 1 }, { id: "a", ms: 20 });
    const first = telemetry.flush();
    await http.arrived(1);
    telemetry.emit("perf.shift", { score: 0, shifts: 0 }, { id: "b" });
    await telemetry.flush();
    expect(http.batches).toEqual([["a"]]);
    http.release();
    await first;
    telemetry.stop();
    http.stop();
  });

  test("goes beside it when the page is leaving, so the row written last is not left to die with the page", async () => {
    const http = slowServer();
    const telemetry = new Telemetry("dev_1", "mac", () => {}, () => null, http.url);
    telemetry.emit("perf.paint", { control: "window", arrangement: "deck", frames: 1 }, { id: "a", ms: 20 });
    const first = telemetry.flush();
    await http.arrived(1);
    telemetry.emit("perf.shift", { score: 0, shifts: 0 }, { id: "b" });
    await telemetry.flush(true);
    expect(http.batches).toEqual([["a"], ["b"]]);
    http.release();
    await first;
    telemetry.stop();
    http.stop();
  });

  test("once both answered, the next flush goes alone again", async () => {
    const http = slowServer();
    const telemetry = new Telemetry("dev_1", "mac", () => {}, () => null, http.url);
    telemetry.emit("perf.paint", { control: "window", arrangement: "deck", frames: 1 }, { id: "a", ms: 20 });
    const first = telemetry.flush();
    await http.arrived(1);
    telemetry.emit("perf.shift", { score: 0, shifts: 0 }, { id: "b" });
    await telemetry.flush(true);
    http.release();
    await first;
    telemetry.emit("perf.shift", { score: 0, shifts: 0 }, { id: "c" });
    await telemetry.flush();
    expect(http.batches).toEqual([["a"], ["b"], ["c"]]);
    telemetry.stop();
    http.stop();
  });
});

/* a server that answers 503 until told to take rows: telemetry failing for a long run, then coming back */
function failingServer() {
  let status = 503;
  let pending = 0;
  const took: string[] = [];
  const http = Bun.serve({
    port: 0,
    async fetch(req) {
      pending++;
      const body = (await req.json()) as { events: RawEvent[] };
      if (status < 300) took.push(...body.events.map((e) => e.id));
      pending--;
      return new Response(null, { status });
    },
  });
  return { url: `http://127.0.0.1:${http.port}/api/telemetry`, took, recover: () => (status = 204), idle: () => pending === 0, stop: () => http.stop(true) };
}

describe("a queue the server keeps refusing", () => {
  test("drops its oldest past the cap and says so, never as sent, and the rest are sent once the server is back", async () => {
    const http = failingServer();
    const flushed: string[] = [];
    const dropped: string[] = [];
    const telemetry = new Telemetry("dev_1", "mac", (ids) => flushed.push(...ids), () => null, http.url, (ids) => dropped.push(...ids));
    const settle = async () => {
      for (let waited = 0; waited < 2000; waited += 5) {
        await Bun.sleep(5);
        if (http.idle()) break;
      }
      await telemetry.flush();
    };
    const ids = Array.from({ length: 1200 }, (_, i) => `r${i}`);
    for (const [i, id] of ids.entries()) {
      telemetry.emit("perf.shift", { score: 0, shifts: 0 }, { id, at: i + 1 });
      if (i % 100 === 99) await settle();
    }
    await settle();
    expect(flushed).toEqual([]);
    expect(dropped).toEqual(ids.slice(0, 700));
    http.recover();
    await settle();
    expect(flushed).toEqual(ids.slice(700));
    expect(http.took).toEqual(ids.slice(700));
    telemetry.stop();
    http.stop();
  });
});
