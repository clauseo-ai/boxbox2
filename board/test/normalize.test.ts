/* the normalizer decides what "identical behaviour" means, so each of its
   rules is pinned here: what it keeps byte for byte, what it reduces and
   why, and how v1's wire decodes into intents. */

import { describe, expect, test } from "bun:test";
import { lineDiff } from "../trace/diff";
import { BRIEF_FRAME_MS, crossVersion, decodeV1, decodeV2, normalize, V1_CROSS, V1_ONLY, V2_CROSS } from "../trace/normalize";
import type { Record } from "../trace/records";
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

describe("decodeV2", () => {
  const act = (body: unknown, options: [string, string[]][] = []) => decodeV2("POST", "/api/board/act", null, body, { askOptions: new Map(options) });

  test("reads the acts onto v1's intents", () => {
    expect(act({ verb: "focus", key: "h1:s" })).toEqual({ verb: "focus", session: "h1:s" });
    expect(act({ verb: "compose", machine: "h1" })).toEqual({ verb: "compose", machine: "h1" });
    expect(act({ verb: "read", key: "h1:s" })).toEqual({ verb: "markRead", session: "h1:s" });
    expect(act({ verb: "flush", key: "h1:s" })).toEqual({ verb: "flush", session: "h1:s" });
    expect(act({ verb: "bind", wire: 11, key: "h1:s", color: [1, 2, 3] })).toEqual({ verb: "bind", binds: [{ wire: 11, key: "h1:s", color: [1, 2, 3] }] });
    expect(act({ verb: "unbind", wire: 11 })).toEqual({ verb: "unbind", wire: 11 });
    expect(act({ verb: "gone" })).toEqual({ verb: "gone" });
    expect(decodeV2("POST", "/api/login", null, { password: "p" })).toEqual({ verb: "login" });
    expect(decodeV2("GET", "/api/stream?view=board&protocol=3&device=board-x&addrs=", null, null)).toEqual({ verb: "stream" });
    /* runs recorded before protocol 3 opened the board stream here */
    expect(decodeV2("GET", "/api/board/stream?protocol=1&device=board-x&addrs=", null, null)).toEqual({ verb: "stream" });
  });

  test("reads a reply as the pit's answer, a question's option by the label the view offered", () => {
    expect(act({ verb: "reply", key: "h1:s", ask: "per_1", answer: { kind: "once" } })).toEqual({ verb: "replyPermission", host: "h1", id: "per_1", reply: "once", directory: null });
    expect(act({ verb: "reply", key: "h1:s", ask: "per_1", answer: { kind: "reject" } })).toMatchObject({ reply: "reject" });
    expect(act({ verb: "reply", key: "h1:s", ask: "que_1", answer: { kind: "option", index: 1 } }, [["que_1", ["one", "two", "three"]]])).toEqual({
      verb: "replyQuestion",
      host: "h1",
      id: "que_1",
      answers: [["two"]],
      directory: null,
    });
    /* an index no view offered can never pass for a label */
    expect(act({ verb: "reply", key: "h1:s", ask: "que_9", answer: { kind: "option", index: 0 } })).toMatchObject({ answers: [["<option 0 of an ask no view offered>"]] });
  });

  test("reads the seat map as the seats on the keys, by digit", () => {
    expect(act({ verb: "seats", seats: [{ key: "h1:b", digit: 2 }, { key: "h1:a", digit: 1, bound: true }] })).toEqual({
      verb: "seats",
      map: { seats: [{ digit: 1, key: "h1:a", bound: true }, { digit: 2, key: "h1:b" }] },
    });
  });

  test("telemetry reads as v1's, and an unknown act is named", () => {
    const body = { device: "d", deviceClass: "board", events: [{ id: "x", at: 5, kind: "board.key", props: { wire: 11 }, ok: 1, ms: 3 }] };
    expect(decodeV2("POST", "/api/telemetry", null, body)).toEqual(decodeV1("POST", "/api/telemetry", null, body));
    expect(act({ verb: "dance" })).toEqual({ verb: "unknown", method: "POST", path: "/api/board/act", body: { verb: "dance" } });
  });
});

describe("crossVersion", () => {
  test("drops v1's twin mirror, spend poll and session reads, and lists each with its reason", () => {
    for (const verb of ["mirror", "spend", "sessions", "session"] as const) expect(V1_ONLY.map((d) => d.verb)).toContain(verb);
    expect(crossVersion({ verb: "spend" })).toBeNull();
    expect(crossVersion({ verb: "sessions", host: "h1", directory: null })).toBeNull();
    expect(crossVersion({ verb: "mirror", cells: [], palette: [] })).toBeNull();
    expect(crossVersion({ verb: "session", host: "h1", session: "h1:s" })).toBeNull();
  });

  test("folds v1's abort then loop into one flush, and its replies' directory away", () => {
    expect(crossVersion({ verb: "abort", host: "h1", session: "h1:s", directory: "/p" })).toEqual({ verb: "flush", session: "h1:s" });
    expect(crossVersion({ verb: "loop", host: "h1", session: "h1:s", directory: "/p" })).toBeNull();
    expect(crossVersion({ verb: "replyPermission", host: "h1", id: "p", reply: "once", directory: "/p" })).toEqual({ verb: "replyPermission", host: "h1", id: "p", reply: "once", directory: null });
  });

  test("a seat map is each side's own: read for the comparison, never a line of it", () => {
    const v1 = call(0, "POST", "/api/board/seats", { page: 1, pages: 2, seats: [{ digit: 1, key: "h1:a", visible: false }, { digit: 1, key: "h1:k", visible: true }] });
    const v2 = call(0, "POST", "/api/board/act", { verb: "seats", seats: [{ key: "h1:k", digit: 1 }] });
    const one = normalize([step("s", "keys", 0, 1000, v1)], V1_CROSS);
    const two = normalize([step("s", "keys", 0, 1000, v2)], V2_CROSS);
    expect(one.steps[0]?.calls).toEqual([]);
    expect(two.steps[0]?.calls).toEqual([]);
    /* the same records without the cross profile still show v1's map */
    expect(normalize([step("s", "keys", 0, 1000, v1)]).steps[0]?.calls[0]).toStartWith("seats ");
  });

  test("a v2 reply names the option the board stream's last view offered", () => {
    const view = { ch: "sse", t: 1, data: { type: "view", machines: [], bindings: [], threads: [{ key: "h1:c", need: "question", ask: { id: "<question 1>", kind: "question", options: ["one", "two", "three"] } }] } } as const;
    const reply = call(5, "POST", "/api/board/act", { verb: "reply", key: "h1:c", ask: "<question 1>", answer: { kind: "option", index: 1 } }, 204);
    const v2 = normalize([step("s", "keys", 0, 1000, [view, ...reply])], V2_CROSS);
    const v1 = normalize([step("s", "keys", 0, 1000, call(5, "POST", "/api/hosts/h1/proxy/question/<question 1>/reply", { answers: [["two"]] }, 200, "<project>"))], V1_CROSS);
    expect(v2.steps[0]?.calls).toEqual(['replyQuestion {"answers":[["two"]],"directory":null,"host":"h1","id":"<question 1>"} -> ok']);
    expect(v1.steps[0]?.calls).toEqual(v2.steps[0]?.calls ?? []);
  });

  test("the meter's start and stop read as v1's sox lines", () => {
    const view = normalize([step("hold", "keys", 0, 2000, [{ ch: "exec", t: 10, cmd: "sox", args: [] }, { ch: "exec-end", t: 1600, cmd: "sox" }])], V2_CROSS);
    expect(view.steps[0]?.radio).toEqual(["sox start", "sox stop"]);
  });
});

describe("across versions, a seat is the unit (decision 80)", () => {
  const v1Seats = (t: number, keys: string[]) => call(t, "POST", "/api/board/seats", { page: 0, pages: 1, seats: keys.map((key, i) => ({ digit: i + 1, key, visible: true })) });
  const v2Seats = (t: number, keys: string[]) => call(t, "POST", "/api/board/act", { verb: "seats", seats: keys.map((key, i) => ({ key, digit: i + 1 })) });

  test("a tap on k1 focuses digit 1's thread on each side, whoever sits there", () => {
    const one = normalize([step("tap k1", "keys", 0, 1000, [...v1Seats(0, ["h1:<alpha>", "h1:<bravo>"]), ...call(500, "POST", "/api/board/focus", { session: "h1:<alpha>" })])], V1_CROSS);
    const two = normalize([step("tap k1", "keys", 0, 1000, [...v2Seats(0, ["h1:<bravo>", "h1:<alpha>"]), ...call(500, "POST", "/api/board/act", { verb: "focus", key: "h1:<bravo>" }, 204)])], V2_CROSS);
    expect(one.steps[0]?.calls).toContain('focus {"session":"digit 1"} -> ok');
    expect(two.steps[0]?.calls).toEqual(one.steps[0]?.calls ?? []);
    /* focusing digit 2's thread is a different call */
    const wrong = normalize([step("tap k1", "keys", 0, 1000, [...v2Seats(0, ["h1:<bravo>", "h1:<alpha>"]), ...call(500, "POST", "/api/board/act", { verb: "focus", key: "h1:<alpha>" }, 204)])], V2_CROSS);
    expect(wrong.steps[0]?.calls).toContain('focus {"session":"digit 2"} -> ok');
  });

  test("a verb names the thread the press chose, even when its answer reseats before the call returns", () => {
    const press: Record = { ch: "board", t: 100, bytes: [0x82, 11, 0] };
    const records: Record[] = [
      ...v2Seats(0, ["h1:<bravo>", "h1:<alpha>"]),
      press,
      /* the answer lands and the order moves before the reply's own call is recorded */
      ...v2Seats(150, ["h1:<alpha>", "h1:<bravo>"]),
      ...call(160, "POST", "/api/board/act", { verb: "focus", key: "h1:<bravo>" }, 204),
    ];
    expect(normalize([step("s", "keys", 0, 1000, records)], V2_CROSS).steps[0]?.calls).toContain('focus {"session":"digit 1"} -> ok');
  });

  test("mark read and readback name the top call by its digit, the map in effect at that moment", () => {
    const records: Record[] = [
      ...v2Seats(0, ["h1:<charlie>", "h1:<bravo>"]),
      { ch: "exec", t: 100, cmd: "say", args: ["charlie has news, waiting 0 minutes"] },
      ...call(200, "POST", "/api/board/act", { verb: "read", key: "h1:<charlie>" }, 204),
      ...v2Seats(300, ["h1:<bravo>"]),
      ...call(400, "POST", "/api/board/act", { verb: "read", key: "h1:<bravo>" }, 204),
    ];
    const view = normalize([step("s", "keys", 0, 1000, records)], V2_CROSS);
    expect(view.steps[0]?.radio).toEqual(['say "digit 1 has news, waiting 0 minutes"']);
    expect(view.steps[0]?.calls.filter((c) => c.startsWith("markRead"))).toEqual(['markRead {"session":"digit 1"} -> ok', 'markRead {"session":"digit 1"} -> ok']);
  });

  test("a thread on no digit keeps its key, and a run without the cross profile keeps every key", () => {
    const records = [...v1Seats(0, ["h1:<alpha>"]), ...call(500, "POST", "/api/board/focus", { session: "h1:<kilo>" })];
    expect(normalize([step("s", "keys", 0, 1000, records)], V1_CROSS).steps[0]?.calls).toContain('focus {"session":"h1:<kilo>"} -> ok');
    expect(normalize([step("s", "keys", 0, 1000, records)]).steps[0]?.calls).toContain('focus {"session":"h1:<alpha>"} -> ok'.replace("alpha", "kilo"));
  });

  test("a frame is v1's seat memo when an answer redraws the picture from the pit's entry press for under 250ms", () => {
    const key = (t: number, wire: number, down: boolean): Record => ({ ch: "board", t, bytes: [0x82, wire, down ? 0 : 1] });
    const entered = call(1100, "POST", "/api/telemetry", { device: "d", deviceClass: "board", events: [{ at: 1070, kind: "board.key", props: { wire: 11, target: "pit" } }] });
    const steps = [
      step("drive", "keys", 0, 1000, [frame(0, 0x49)]),
      step("into the pit", "keys", 1000, 2000, [key(1000, 11, true), key(1070, 11, false), frame(1071, 0x4f), ...entered]),
      step("answer", "keys", 2000, 4000, [
        key(2000, 13, true),
        ...call(2080, "POST", "/api/hosts/h1/proxy/permission/p/reply", { reply: "reject" }),
        frame(2090, 0x49),
        frame(2310, 0x29),
      ]),
    ];
    const view = normalize(steps, V1_CROSS);
    expect(view.steps[2]?.ledsMemo).toEqual([true, false]);
    expect(view.steps[2]?.ledsHold?.[0]).toBe(220);
    /* no answer in the step, no memo */
    const noAnswer = normalize([steps[0] as TracedStep, steps[1] as TracedStep, step("tap", "keys", 2000, 4000, [frame(2090, 0x49), frame(2310, 0x29)])], V1_CROSS);
    expect(noAnswer.steps[2]?.ledsMemo).toEqual([false, false]);
  });

  test("a frame carries the seat map posted for its render, and whether it came before the first view", () => {
    const records: Record[] = [frame(10, 0x1d), { ch: "sse", t: 50, data: { type: "view", machines: [], threads: [], bindings: [] } }, frame(100, 0x29), ...v2Seats(105, ["h1:<a>"]), frame(900, 0x2a)];
    const view = normalize([step("start", "start", 0, 1000, records)], V2_CROSS);
    expect(view.steps[0]?.ledsBeforeView).toEqual([true, false, false]);
    expect(view.steps[0]?.ledsSeats?.[0]).toBeNull();
    expect(view.steps[0]?.ledsSeats?.[1]?.[0]).toBe("h1:<a>");
    expect(normalize([step("start", "start", 0, 1000, records)]).steps[0]?.ledsSeats).toBeUndefined();
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
