import { describe, expect, test } from "bun:test";
import {
  ABSENT_FOR_MS,
  askAgainIn,
  classify,
  dueAt,
  evictions,
  ICON_CAP,
  iconKey,
  iconUrl,
  needsProbe,
  READ_MS,
  READY_FOR_MS,
  reading,
  RETRY_CAP_MS,
  RETRY_FIRST_MS,
  type RepoIcon,
  retryDelay,
  settled,
} from "./icons";

describe("where a repo's icon is served from", () => {
  test("the host and the root are each one escaped segment or value", () => {
    expect(iconUrl("studio", "/home/me/src/api")).toBe("/api/hosts/studio/repo-icon?root=%2Fhome%2Fme%2Fsrc%2Fapi");
    expect(iconUrl("my box", "/tmp/a b&c")).toBe("/api/hosts/my%20box/repo-icon?root=%2Ftmp%2Fa%20b%26c");
  });

  test("the same folder on two machines is two repos", () => {
    expect(iconKey("a", "/x")).not.toBe(iconKey("b", "/x"));
    expect(iconKey("a", "/x")).not.toBe(iconKey("a/x", ""));
  });
});

describe("how a reply from the server reads", () => {
  test("only a 200 is an image", () => {
    expect(classify(200, null)).toBe("image");
    expect(classify(200, "none")).toBe("image");
  });

  test("a 404 is the class the server names", () => {
    expect(classify(404, "none")).toBe("none");
    expect(classify(404, "unsupported")).toBe("unsupported");
    expect(classify(404, "unproven")).toBe("unproven");
    expect(classify(404, "refused")).toBe("refused");
    expect(classify(404, "retry")).toBe("retry");
  });

  test("a class this app does not know is read as none, and so is a 404 with no header (an older server)", () => {
    expect(classify(404, "somewhere-new")).toBe("none");
    expect(classify(404, "home")).toBe("none");
    expect(classify(404, null)).toBe("none");
  });

  test("a refused request is none; a reply that says nothing about the repo is a retry", () => {
    expect(classify(400, null)).toBe("none");
    expect(classify(403, null)).toBe("none");
    for (const status of [401, 408, 425, 429, 500, 502, 503, 504, 304, 302]) expect(classify(status, null)).toBe("retry");
  });
});

describe("when each answer is asked again", () => {
  const at = 1_000_000;
  test("an image after six hours, none after thirty minutes, refused after an hour, unsupported after five, unproven after one", () => {
    expect(dueAt({ state: "ready", plate: "dark", at })).toBe(at + 6 * 3_600_000);
    expect(READY_FOR_MS).toBe(6 * 3_600_000);
    expect(dueAt({ state: "absent", why: "none", at })).toBe(at + 30 * 60_000);
    expect(dueAt({ state: "absent", why: "unsupported", at })).toBe(at + 5 * 60_000);
    expect(dueAt({ state: "absent", why: "unproven", at })).toBe(at + 60_000);
    expect(dueAt({ state: "absent", why: "refused", at })).toBe(at + 3_600_000);
    expect(ABSENT_FOR_MS.refused).toBeGreaterThan(ABSENT_FOR_MS.none);
    expect(ABSENT_FOR_MS.none).toBeGreaterThan(ABSENT_FOR_MS.unsupported);
    expect(ABSENT_FOR_MS.unsupported).toBeGreaterThan(ABSENT_FOR_MS.unproven);
  });

  test("a retry waits 15 s and doubles to a cap of twenty minutes, and stays there", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelay)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 960_000]);
    expect([8, 9, 20, 1000].map(retryDelay)).toEqual([RETRY_CAP_MS, RETRY_CAP_MS, RETRY_CAP_MS, RETRY_CAP_MS]);
    expect(RETRY_CAP_MS).toBe(20 * 60_000);
    expect(RETRY_FIRST_MS).toBe(15_000);
    expect(dueAt({ state: "retry", attempts: 3, at })).toBe(at + 60_000);
  });

  test("a host asleep for eight hours is asked about thirty times, not the 240 a two-minute cap would", () => {
    let asks = 0;
    for (let waited = 0, attempt = 1; waited < 8 * 3_600_000; attempt++, asks++) waited += retryDelay(attempt);
    expect(asks).toBeLessThanOrEqual(32);
  });

  test("a repo never asked about, or whose answer has fallen due, is read; one that holds is left alone", () => {
    expect(needsProbe(undefined, at)).toBe(true);
    const unproven: RepoIcon = { state: "absent", why: "unproven", at };
    expect(needsProbe(unproven, at + 59_999)).toBe(false);
    expect(needsProbe(unproven, at + 60_000)).toBe(true);
    expect(needsProbe({ state: "ready", plate: "light", at }, at + 5 * 3_600_000)).toBe(false);
  });

  test("a read in flight is not asked for again, until it is clearly dead", () => {
    expect(needsProbe({ state: "probing", at }, at + 1000)).toBe(false);
    expect(needsProbe({ state: "probing", at }, at + READ_MS * 2)).toBe(true);
    const refreshing = reading({ state: "retry", attempts: 2, at }, at + 40_000);
    expect(needsProbe(refreshing, at + 41_000)).toBe(false);
    expect(needsProbe(refreshing, at + 40_000 + READ_MS * 2)).toBe(true);
  });

  test("a mounted mark waits out a verdict that is not an image, and not one that is, nor one being read", () => {
    expect(askAgainIn({ state: "retry", attempts: 1, at: 100 }, 100)).toBe(15_000);
    expect(askAgainIn({ state: "absent", why: "unproven", at: 100 }, 30_100)).toBe(30_000);
    expect(askAgainIn({ state: "absent", why: "none", at: 100 }, 100 + 40 * 60_000)).toBe(0);
    expect(askAgainIn({ state: "ready", plate: "dark", at: 100 }, 100)).toBeNull();
    expect(askAgainIn({ state: "probing", at: 100 }, 100)).toBeNull();
  });
});

describe("what a read comes to", () => {
  const now = 5_000_000;
  test("a first read marks itself in flight, a later one keeps what was known so nothing blanks", () => {
    expect(reading(undefined, now)).toEqual({ state: "probing", at: now });
    const ready: RepoIcon = { state: "ready", plate: "dark", at: 1 };
    expect(reading(ready, now)).toEqual({ ...ready, reading: now });
    expect(reading({ state: "probing", at: 1 }, now)).toEqual({ state: "probing", at: now });
  });

  test("an image becomes a plate, a stated absence is kept as that", () => {
    expect(settled(undefined, { kind: "plate", plate: "bleed" }, now)).toEqual({ state: "ready", plate: "bleed", at: now });
    expect(settled(undefined, { kind: "absent", why: "unsupported" }, now)).toEqual({ state: "absent", why: "unsupported", at: now });
  });

  test("a transient is never remembered as no icon: it counts up the retries", () => {
    const first = settled(undefined, { kind: "retry" }, now);
    expect(first).toEqual({ state: "retry", attempts: 1, at: now });
    const second = settled({ ...first, reading: now } as RepoIcon, { kind: "retry" }, now + 15_000);
    expect(second).toEqual({ state: "retry", attempts: 2, at: now + 15_000 });
    expect(settled(second, { kind: "absent", why: "none" }, now + 60_000)).toEqual({ state: "absent", why: "none", at: now + 60_000 });
    expect(settled(second, { kind: "plate", plate: "light" }, now + 60_000)).toEqual({ state: "ready", plate: "light", at: now + 60_000 });
  });

  test("a transient after an absence is a retry, since the server's last word no longer holds", () => {
    expect(settled({ state: "absent", why: "none", at: 1 }, { kind: "retry" }, now)).toEqual({ state: "retry", attempts: 1, at: now });
  });

  test("a transient while refreshing an image keeps the plate that is on screen", () => {
    const ready: RepoIcon = { state: "ready", plate: "dark", at: 1, reading: 2 };
    expect(settled(ready, { kind: "retry" }, now)).toEqual({ state: "ready", plate: "dark", at: now });
  });
});

describe("what is forgotten", () => {
  const ready = (at: number): RepoIcon => ({ state: "ready", plate: "dark", at });
  test("nothing under the cap", () => {
    expect(evictions({ a: ready(1), b: ready(2) }, {}, 2)).toEqual([]);
  });
  test("the oldest answers go first, down to the cap", () => {
    expect(evictions({ a: ready(3), b: ready(1), c: { state: "absent", why: "none", at: 2 }, d: ready(4) }, {}, 2)).toEqual(["b", "c"]);
  });
  test("a read being made for the first time is never forgotten, even when it is the oldest", () => {
    expect(evictions({ a: { state: "probing", at: 1 }, b: ready(2), c: ready(3) }, {}, 2)).toEqual(["b"]);
  });
  test("a verdict a mark on screen holds is never forgotten, so no visible mark is blanked", () => {
    expect(evictions({ a: ready(1), b: ready(2), c: ready(3) }, { a: 1 }, 2)).toEqual(["b"]);
    expect(evictions({ a: ready(1), b: ready(2) }, { a: 1, b: 2 }, 1)).toEqual([]);
  });
  test("the default cap is a few dozen repos' worth", () => {
    const many = Object.fromEntries(Array.from({ length: ICON_CAP + 3 }, (_, i) => [`k${i}`, ready(i)]));
    expect(evictions(many)).toEqual(["k0", "k1", "k2"]);
  });
});
