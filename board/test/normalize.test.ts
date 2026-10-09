/* the normalizer decides what "identical behaviour" means, so each of its
   rules is pinned here: what it keeps byte for byte, what it reduces and
   why, and how v1's wire decodes into intents. */

import { describe, expect, test } from "bun:test";
import { lineDiff } from "../trace/diff";
import { BRIEF_FRAME_MS, decodeV1, normalize } from "../trace/normalize";
import type { Record } from "../trace/preload";
import type { TracedStep } from "../trace/run";
import { scrub } from "../trace/trace";

const frame = (t: number, fill: number): Record => ({ ch: "hid", t, bytes: [0, 0x03, ...Array<number>(17).fill(fill), ...Array<number>(14).fill(0)] });
const write = (t: number, op: number, ...payload: number[]): Record => ({ ch: "hid", t, bytes: [0, op, ...payload] });
let nextId = 0;
function call(t: number, method: string, path: string, body: unknown = null, status = 200, directory: string | null = null): Record[] {
  const id = ++nextId;
  return [
    { ch: "http", t, id, method, path, directory, body },
    { ch: "http-done", t: t + 5, id, status },
  ];
}
function step(label: string, kind: TracedStep["kind"], startedAt: number, endedAt: number, records: Record[]): TracedStep {
  return { label, kind, startedAt, endedAt, keys: [], records };
}

describe("decodeV1", () => {
  test("reads the pit's answers as intents with their host, id, reply and directory", () => {
    expect(decodeV1("POST", "/api/hosts/h1/proxy/permission/per_1/reply", "/p", { reply: "once" })).toEqual({
      verb: "replyPermission",
      host: "h1",
      id: "per_1",
      reply: "once",
      directory: "/p",
    });
    expect(decodeV1("POST", "/api/hosts/h1/proxy/question/que_1/reply", null, { answers: [["two"]] })).toEqual({
      verb: "replyQuestion",
      host: "h1",
      id: "que_1",
      answers: [["two"]],
      directory: null,
    });
  });

  test("reads the glass channels and the flush", () => {
    expect(decodeV1("POST", "/api/board/focus", null, { session: "h1:s" })).toEqual({ verb: "focus", session: "h1:s" });
    expect(decodeV1("POST", "/api/read", null, { device: "d", marks: [{ session: "h1:s", at: 5 }] })).toEqual({ verb: "markRead", session: "h1:s" });
    expect(decodeV1("POST", "/api/hosts/h1/proxy/session/s/abort", "/p", null)).toEqual({ verb: "abort", host: "h1", session: "h1:s", directory: "/p" });
    expect(decodeV1("GET", "/api/hosts/h1/proxy/session?scope=project&roots=true&limit=1000", null, null)).toEqual({
      verb: "sessions",
      host: "h1",
      directory: null,
    });
  });

  test("names anything it does not know, so a new call can never pass unseen", () => {
    expect(decodeV1("DELETE", "/api/something", null, null)).toEqual({ verb: "unknown", method: "DELETE", path: "/api/something", body: null });
  });
});

describe("normalize", () => {
  test("keeps frames and reserved palette writes, drops pings and the two animated slots", () => {
    const view = normalize([
      step("start", "start", 0, 1000, [
        write(0, 0x01, 1),
        write(1, 0x02, 4, 255, 190, 0),
        write(2, 0x02, 14, 1, 2, 3),
        write(3, 0x02, 15, 1, 2, 3),
        frame(10, 0x03),
        write(510, 0x05),
        frame(600, 0x03),
      ]),
    ]);
    expect(view.steps[0]?.leds).toEqual(["hello proto 1", "palette 4 255,190,0", `frame ${Array(17).fill("03").join(" ")}`]);
    expect(view.keepaliveGapMs).toBe(500);
  });

  test("drops a frame that held under the brief threshold only in steps an agent drives", () => {
    /* a steady frame, a blip that holds BRIEF_FRAME_MS - 10, the steady frame again */
    const records = (base: number, steady: number) => [frame(base, steady), frame(base + 300, 0xe9), frame(base + 290 + BRIEF_FRAME_MS, steady)];
    const view = normalize([step("keys", "keys", 0, 999, records(0, 0x29)), step("agent", "world", 1000, 2000, records(1000, 0x2a))]);
    expect(view.steps[0]?.leds).toHaveLength(3);
    expect(view.steps[1]?.leds).toEqual([`frame ${Array(17).fill("2a").join(" ")}`]);
  });

  test("marks a brief repeat of a picture left long ago optional, never an animation's beat", () => {
    const view = normalize([
      step("before the pit", "keys", 0, 2000, [frame(0, 0x49)]),
      step("in the pit", "keys", 2000, 4000, [frame(2000, 0x4f)]),
      /* the answer: the stale drive frame for 120ms, then the new seats */
      step("answer", "keys", 4000, 6000, [frame(4000, 0x49), frame(4120, 0x29)]),
      /* a pulse: on, off, on again 410ms later, all brief */
      step("pulse", "world", 6000, 8000, [frame(6000, 0x5f), frame(6240, 0x03), frame(6410, 0x5f), frame(6650, 0x29)]),
    ]);
    expect(view.steps[2]?.ledsOptional).toEqual([true, false]);
    expect(view.steps[3]?.ledsOptional).toEqual([false, false, false, false]);
  });

  test("a brief return drawn while a key is down is the key's answer, and required", () => {
    /* the meter: a hold shows it, and a later tap opens it again for 70ms, under the finger */
    const key = (t: number, down: boolean): Record => ({ ch: "board", t, bytes: [0x82, 15, down ? 0 : 1] });
    const view = normalize([
      step("hold", "keys", 0, 3000, [key(0, true), frame(0, 0x29), frame(100, 0x1f), key(1600, false), frame(1600, 0x29)]),
      step("tap", "keys", 3000, 5000, [key(2999, true), frame(3000, 0x1f), key(3069, false), frame(3070, 0x29)]),
    ]);
    expect(view.steps[1]?.ledsOptional).toEqual([false, false]);
  });

  test("counts a seat map only when it changes, the first login and the first spend poll only", () => {
    const seats = (t: number, digit: number) => call(t, "POST", "/api/board/seats", { page: 0, pages: 1, seats: [{ key: "h1:a", digit, visible: true }] });
    const view = normalize([
      step("start", "start", 0, 5000, [
        ...call(0, "POST", "/api/login", { password: "p" }),
        ...call(1, "POST", "/api/login", { password: "p" }),
        ...call(2, "GET", "/api/spend"),
        ...seats(10, 1),
        ...seats(5010, 1),
        ...call(60_000, "GET", "/api/spend"),
      ]),
      step("tap", "keys", 5000, 6000, [...seats(5500, 2)]),
    ]);
    expect(view.steps[0]?.calls).toEqual(["login -> ok", 'seats {"page":0,"pages":1,"seats":[{"digit":1,"key":"h1:a","visible":true}]}', "spend -> ok"]);
    expect(view.steps[1]?.calls).toEqual(['seats {"page":0,"pages":1,"seats":[{"digit":2,"key":"h1:a","visible":true}]}']);
  });

  test("places each telemetry event by its own time, not by when its batch was posted", () => {
    const batch = call(9000, "POST", "/api/telemetry", {
      device: "d",
      deviceClass: "board",
      events: [
        { id: "x", at: 1200, kind: "board.key", props: { wire: 11, verb: "tap" }, ok: 1, ms: 37 },
        { id: "y", at: 2300, kind: "verb", props: { name: "markRead" }, session: "h1:a", ok: 1, ms: 12 },
      ],
    });
    const view = normalize([step("one", "keys", 1000, 2000, []), step("two", "keys", 2000, 3000, []), step("drain", "idle", 3000, 9500, batch)]);
    expect(view.steps[0]?.calls).toEqual(['telemetry board.key {"verb":"tap","wire":11} ok 1']);
    expect(view.steps[1]?.calls).toEqual(['telemetry verb {"name":"markRead"} session h1:a ok 1']);
    expect(view.steps[2]?.calls).toEqual([]);
  });

  test("keeps only the last twin mirror of a step, and groups calls by verb", () => {
    const view = normalize([
      step("tap", "keys", 0, 1000, [
        ...call(10, "POST", "/api/board/frame", { cells: [1], palette: ["#000000"] }),
        ...call(20, "POST", "/api/board/focus", { session: "h1:a" }),
        ...call(30, "POST", "/api/board/frame", { cells: [2], palette: ["#000000"] }),
      ]),
    ]);
    expect(view.steps[0]?.calls).toEqual(['focus {"session":"h1:a"} -> ok', 'mirror (last of step) {"cells":[2],"palette":["#000000"]}']);
  });

  test("an outcome is the call's own status, never assumed", () => {
    const view = normalize([step("tap", "keys", 0, 1000, call(10, "POST", "/api/board/compose", { machine: "h1" }, 404))]);
    expect(view.steps[0]?.calls).toEqual(['compose {"machine":"h1"} -> failed 404']);
  });
});

describe("scrub", () => {
  test("replaces session ids with aliases, numbers asks in order, hides the device and every machine path", () => {
    const steps = scrub(
      {
        steps: [
          step("s", "keys", 0, 1, [
            ...call(1, "POST", "/api/hosts/h1/proxy/permission/per_0f3c1efaf001alUqhZxEBULhGt/reply", { reply: "once" }, 200, "/tmp/w/project"),
            ...call(2, "POST", "/api/hosts/h1/proxy/question/que_0f3c1f827001FErjaDUKPIHmj2/reply", { answers: [["two"]] }),
            ...call(3, "POST", "/api/read", { device: "board-Ab3_x9Zq", marks: [{ session: "h1:ses_f0c3e14a7ffe5Z2cVyenhmwHNL", at: 1 }] }),
          ]),
        ],
      },
      { aliases: new Map([["ses_f0c3e14a7ffe5Z2cVyenhmwHNL", "alpha"]]), redactions: [["/tmp/w/project", "<project>"], ["/tmp/w", "<world>"]] },
    );
    const text = JSON.stringify(steps);
    expect(text).toContain("<permission 1>");
    expect(text).toContain("<question 1>");
    expect(text).toContain("h1:<alpha>");
    expect(text).toContain("<device>");
    expect(text).toContain('"directory":"<project>"');
    expect(text).not.toMatch(/per_|que_|ses_|board-Ab3|\/tmp\/w/);
  });
});

describe("lineDiff", () => {
  test("forgives an optional line only where the other side lacks it", () => {
    expect(lineDiff(["a", "stale", "b"], ["a", "b"], [false, true, false], [])).toEqual([]);
    expect(lineDiff(["a", "b"], ["a", "stale", "b"], [], [false, true, false])).toEqual([]);
    expect(lineDiff(["a", "stale", "b"], ["a", "other", "b"], [false, true, false], [false, false, false])).toEqual(["+ other"]);
  });

  test("is empty for equal lines and marks what only one side has", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c"])).toEqual(["+ x", "- b"]);
    expect(lineDiff(["a"], [])).toEqual(["- a"]);
  });
});
