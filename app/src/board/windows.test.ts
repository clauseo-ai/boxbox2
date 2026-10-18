/* the board's seats and the app's windows are one membership (docs/board.md, the view: digit n on an unpaired board is
   window n in the app). the server pins its board membership to a fixture (server/src/fleet/board/windows.json); this
   reads the same fixture through the app's own filter, so the two sides cannot drift. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fleet } from "../sync/reducer";
import { windowKeys } from "../ui/home/membership";

/** the fixture carries only what membership reads; the rest of a fleet is not its business */
type Fixture = { now: number; fleet: Omit<Fleet, "hostNames" | "hosts">; windows: string[] };

const FIXTURE = join(import.meta.dir, "../../../server/src/fleet/board/windows.json");

describe("the board's windows are the app's windows", () => {
  test("windowKeys over the server's board fixture gives its windows, in order", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
    const fleet: Fleet = { hostNames: [], hosts: {}, ...fixture.fleet };
    expect(fixture.windows.length).toBeGreaterThan(0);
    expect(windowKeys(fleet, fixture.now)).toEqual(fixture.windows);
  });
});
