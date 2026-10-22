import { describe, expect, test } from "bun:test";
import { FORK_IDS_KEPT, type Shelf, cutKey, forkDone, forkId, settles } from "./fork-ids";

const shelf = (): Shelf & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};
const minter = () => { let n = 0; return () => `c-${++n}`; };

describe("a fork's client id", () => {
  test("is the same for every try of one cut until that fork is answered", () => {
    const s = shelf(), mint = minter();
    const cut = cutKey("desk:ses_1", "msg_9");
    const first = forkId(s, cut, mint);
    // a retry after a 502, a second tap, or the same stage after a reload (the shelf is the tab's sessionStorage)
    expect(forkId(s, cut, mint)).toBe(first);
    expect(forkId(s, cut, mint)).toBe(first);
  });

  test("is new for a new cut, and for the whole thread apart from any turn", () => {
    const s = shelf(), mint = minter();
    const a = forkId(s, cutKey("desk:ses_1", "msg_9"), mint);
    const b = forkId(s, cutKey("desk:ses_1", "msg_12"), mint);
    const whole = forkId(s, cutKey("desk:ses_1", undefined), mint);
    const other = forkId(s, cutKey("desk:ses_2", "msg_9"), mint);
    expect(new Set([a, b, whole, other]).size).toBe(4);
  });

  test("goes once its fork is made, so the next fork of that cut is a new fork", () => {
    const s = shelf(), mint = minter();
    const cut = cutKey("desk:ses_1", "msg_9");
    const first = forkId(s, cut, mint);
    forkDone(s, cut);
    expect(forkId(s, cut, mint)).not.toBe(first);
  });

  test("letting one cut's id go keeps the others", () => {
    const s = shelf(), mint = minter();
    const a = cutKey("desk:ses_1", "msg_9"), b = cutKey("desk:ses_1", "msg_12");
    const kept = forkId(s, b, mint);
    forkId(s, a, mint);
    forkDone(s, a);
    expect(forkId(s, b, mint)).toBe(kept);
  });

  test("keeps at most its cap of cuts, the oldest let go first", () => {
    const s = shelf(), mint = minter();
    const oldest = forkId(s, cutKey("desk:ses_0", undefined), mint);
    for (let i = 1; i <= FORK_IDS_KEPT; i++) forkId(s, cutKey(`desk:ses_${i}`, undefined), mint);
    expect((JSON.parse(s.map.get("boxbox.forks") ?? "[]") as unknown[]).length).toBe(FORK_IDS_KEPT);
    expect(forkId(s, cutKey("desk:ses_0", undefined), mint)).not.toBe(oldest);
  });

  test("a shelf that holds something else, or refuses, still gives an id", () => {
    const s = shelf();
    s.map.set("boxbox.forks", "{not json");
    expect(forkId(s, "x|", () => "c-1")).toBe("c-1");
    const refusing: Shelf = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(forkId(refusing, "x|", () => "c-2")).toBe("c-2");
  });
});

describe("which answers let a fork's id go", () => {
  test("made, or refused in a way a repeat cannot change (a client id the agent saw elsewhere is one)", () => {
    for (const status of [201, 400, 404, 409, 422]) expect(settles(status)).toBe(true);
  });

  test("no answer, a lost one, or a busy agent keep it, so the retry is the same fork", () => {
    for (const status of [null, 408, 429, 500, 502, 503, 504]) expect(settles(status)).toBe(false);
  });
});
