/* `perf.thread cached` says whether the first paint came from the client's copy: a thread restored from indexeddb is one (the sync lane's
   lazy boot restores it after the stage mounts, in a few ms, with no request) */

import { describe, expect, test } from "bun:test";
import { paintSource } from "./paint-source";

const rows = { held: true, hydrating: false, turns: 12 };

describe("where the first paint came from", () => {
  test("a thread already in memory when the stage mounts is the client's copy", () => {
    const s = paintSource();
    s.see(rows);
    expect(s.cached()).toBe(true);
  });

  test("a thread restored from the cache after the stage mounted is the client's copy, though the stage first saw nothing", () => {
    const s = paintSource();
    s.see({ held: false, hydrating: false, turns: 0 });
    s.see(rows);
    expect(s.cached()).toBe(true);
  });

  test("a restored thread that is stale, shown while the wire is read again, is the client's copy", () => {
    const s = paintSource();
    s.see({ held: true, hydrating: true, turns: 12 });
    expect(s.cached()).toBe(true);
  });

  test("a thread the worker started empty and still reading, whose rows came when the fetch landed, is the wire's", () => {
    const s = paintSource();
    s.see({ held: false, hydrating: false, turns: 0 });
    s.see({ held: true, hydrating: true, turns: 0 });
    s.see(rows);
    expect(s.cached()).toBe(false);
  });

  test("an empty thread already reading when the stage mounts is the wire's too", () => {
    const s = paintSource();
    s.see({ held: true, hydrating: true, turns: 0 });
    s.see(rows);
    expect(s.cached()).toBe(false);
  });
});
