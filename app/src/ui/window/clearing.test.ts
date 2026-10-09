import { afterEach, describe, expect, test } from "bun:test";
import { clearable, clearName, doneKeys, doneLabel, doneName, HAND_MS, handCleared, markHandCleared, nameSuffixes, releaseHandCleared } from "./clearing";
import type { WindowState } from "./view";

const view = (key: string, state: WindowState) => ({ key, state });

describe("which windows offer a clear", () => {
  test("a finished, stopped or parked window does; a working, queued or asking one does not", () => {
    const offered = (["done", "idle", "failed", "parked", "working", "queued", "wants"] as const).filter((state) => clearable({ state }));
    expect(offered).toEqual(["done", "idle", "failed", "parked"]);
  });
});

describe("clear done", () => {
  test("takes the threads whose turn finished, read or not, and leaves stopped and parked ones", () => {
    const views = [view("a", "done"), view("b", "working"), view("c", "idle"), view("d", "failed"), view("e", "parked"), view("f", "wants")];
    expect(doneKeys(views)).toEqual(["a", "c"]);
  });

  test("says how many, and has no name for none (the pill is not drawn)", () => {
    expect(doneLabel(1)).toBe("clear 1");
    expect(doneLabel(4)).toBe("clear 4");
    expect(doneName(1)).toBe("clear 1 thread that is done or idle");
    expect(doneName(4)).toBe("clear 4 threads that are done or idle");
    expect(doneKeys([])).toEqual([]);
  });
});

describe("the names", () => {
  test("each window's clear carries its repo and title, so no two share a name", () => {
    expect(clearName({ repo: "ledger", title: "fix the rate limiter", host: "desk" })).toBe("clear ledger: fix the rate limiter");
    expect(clearName({ repo: "ledger", title: "fix the rate limiter", host: "desk" }, true)).toBe("clear ledger: fix the rate limiter, desk");
  });
});

describe("windows that would share a clear name", () => {
  const win = (key: string, title = "ok, noted", host = "desk") => ({ key, repo: "boxbox2", title, host });

  test("get the shortest id ending that tells them apart; the others get none", () => {
    const windows = [win("desk:ses_aaaa1111"), win("desk:ses_bbbb2222"), win("desk:ses_cccc3333", "something else")];
    const suffixes = nameSuffixes(windows, false);
    expect(suffixes.get("desk:ses_aaaa1111")).toBe(", 1111");
    expect(suffixes.get("desk:ses_bbbb2222")).toBe(", 2222");
    expect(suffixes.has("desk:ses_cccc3333")).toBe(false);
  });

  test("thirty alike windows get thirty different names", () => {
    const windows = Array.from({ length: 30 }, (_, n) => win(`desk:ses_${String(n).padStart(2, "0")}00abcd`));
    const suffixes = nameSuffixes(windows, false);
    const names = windows.map((w) => clearName(w, false, suffixes.get(w.key)));
    expect(new Set(names).size).toBe(30);
  });

  test("the machine in the name already tells two apart when it is shown", () => {
    const windows = [win("a:ses_1111", "x", "a"), win("b:ses_1111", "x", "b")];
    expect(nameSuffixes(windows, true).size).toBe(0);
    expect(nameSuffixes(windows, false).size).toBe(2);
  });
});

describe("a hand mark that nothing releases", () => {
  test("lets itself go after HAND_MS and says which keys it let go", async () => {
    const letGo: string[][] = [];
    markHandCleared(["h:late"], (late) => letGo.push(late));
    expect(handCleared("h:late")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, HAND_MS + 50));
    expect(handCleared("h:late")).toBe(false);
    expect(letGo).toEqual([["h:late"]]);
  });

  test("a mark released first never calls back", async () => {
    const letGo: string[][] = [];
    markHandCleared(["h:early"], (late) => letGo.push(late));
    releaseHandCleared(["h:early"]);
    await new Promise((resolve) => setTimeout(resolve, HAND_MS + 50));
    expect(letGo).toEqual([]);
  });
});

describe("a window cleared by hand", () => {
  afterEach(() => releaseHandCleared(["h:a", "h:b"]));

  test("is known until it is released, and the others are not", () => {
    markHandCleared(["h:a"]);
    expect(handCleared("h:a")).toBe(true);
    expect(handCleared("h:b")).toBe(false);
    releaseHandCleared(["h:a"]);
    expect(handCleared("h:a")).toBe(false);
  });
});
