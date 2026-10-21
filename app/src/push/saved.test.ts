import { describe, expect, test } from "bun:test";
import type { PushKind } from "../api/client";
import { CHECK_EVERY_MS, isFresh, listing, listingWith, readSaved, type Saved, sameCopy, sameKeys } from "./saved";

const copy: Saved = {
  device: "d1",
  publicKey: "key-1",
  endpoint: "https://push.example/a",
  p256dh: "p",
  auth: "a",
  devices: listing([{ device: "d1", kinds: ["ask", "done"] }]),
  kinds: ["ask", "done"],
  checkedAt: 1_000,
};

/** a store that holds what it is given, as localStorage does */
function store(initial?: string) {
  const held = new Map<string, string>();
  if (initial !== undefined) held.set("boxbox.push.saved", initial);
  return {
    held,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
}

describe("the saved copy of the server's subscription", () => {
  test("what is written is read back whole", () => {
    const kept = store();
    kept.setItem("boxbox.push.saved", JSON.stringify(copy));
    expect(readSaved(kept)).toEqual(copy);
  });

  test("nothing kept, storage refused, or a value that is not a copy reads as no copy", () => {
    expect(readSaved(store())).toBeNull();
    expect(readSaved(null)).toBeNull();
    expect(readSaved(store("not json"))).toBeNull();
    expect(readSaved(store("null"))).toBeNull();
    expect(readSaved(store(JSON.stringify({ ...copy, checkedAt: "soon" })))).toBeNull();
    expect(readSaved(store(JSON.stringify({ ...copy, kinds: ["ask", "bogus"] })))).toBeNull();
    expect(readSaved(store(JSON.stringify({ ...copy, endpoint: 7 })))).toBeNull();
  });

  test("a storage that throws on read is no copy, never an error", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined, removeItem: () => undefined };
    expect(readSaved(broken)).toBeNull();
  });
});

describe("the check's age", () => {
  test("a check within the day holds; at the day, or after a clock that ran backwards, it does not", () => {
    expect(isFresh(copy, copy.checkedAt)).toBe(true);
    expect(isFresh(copy, copy.checkedAt + CHECK_EVERY_MS - 1)).toBe(true);
    expect(isFresh(copy, copy.checkedAt + CHECK_EVERY_MS)).toBe(false);
    expect(isFresh(copy, copy.checkedAt - 1)).toBe(false);
  });
});

describe("the subscription and the server's copy", () => {
  test("the keys name the subscription the copy holds, all three", () => {
    expect(sameKeys(copy, { endpoint: copy.endpoint, p256dh: copy.p256dh, auth: copy.auth })).toBe(true);
    expect(sameKeys(copy, { endpoint: "https://push.example/b", p256dh: copy.p256dh, auth: copy.auth })).toBe(false);
    expect(sameKeys(copy, { endpoint: copy.endpoint, p256dh: "other", auth: copy.auth })).toBe(false);
    expect(sameKeys(copy, { endpoint: copy.endpoint, p256dh: copy.p256dh, auth: "other" })).toBe(false);
  });

  test("the same copy ignores when it was checked and differs on any part the server holds", () => {
    expect(sameCopy(copy, { ...copy, checkedAt: 99 })).toBe(true);
    expect(sameCopy(copy, { ...copy, publicKey: "key-2" })).toBe(false);
    expect(sameCopy(copy, { ...copy, endpoint: "https://push.example/b" })).toBe(false);
    expect(sameCopy(copy, { ...copy, device: "d2" })).toBe(false);
    expect(sameCopy(copy, { ...copy, devices: listing([{ device: "d1", kinds: ["ask"] }]) })).toBe(false);
  });

  test("the listing is the same whatever order the server gives its devices in, and changes with any device's kinds", () => {
    const a = [
      { device: "d1", kinds: ["ask", "done"] as PushKind[] },
      { device: "d2", kinds: ["fault"] as PushKind[] },
    ];
    expect(listing(a)).toBe(listing([...a].reverse()));
    expect(listing(a)).not.toBe(listing([{ device: "d1", kinds: ["ask", "done"] }, { device: "d2", kinds: ["fault", "ready"] }]));
    expect(listing(a)).not.toBe(listing(a.slice(0, 1)));
  });

  test("the listing once this device holds kinds replaces its own entry and keeps the others", () => {
    const before = [
      { device: "d1", kinds: ["ask"] as PushKind[] },
      { device: "d2", kinds: ["fault"] as PushKind[] },
    ];
    expect(listingWith(before, "d1", ["ask", "done"])).toBe(listing([{ device: "d1", kinds: ["ask", "done"] }, { device: "d2", kinds: ["fault"] }]));
    expect(listingWith([], "d3", ["ready"])).toBe(listing([{ device: "d3", kinds: ["ready"] }]));
  });
});
