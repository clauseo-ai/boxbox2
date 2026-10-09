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
