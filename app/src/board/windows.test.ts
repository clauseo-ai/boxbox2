/* the board's seats and the app's windows are one membership (docs/board.md, the view: digit n on an unpaired board is
   window n in the app). the server pins its board membership to a fixture (server/src/fleet/board/windows.json); this
   reads the same fixture through the app's own filter, so the two sides cannot drift.
   the fixture is still cmx2's shapes (a session with its info and status): it is turned into the neutral threads here,
   the way translate.rs makes them (a thread's parent, updated and cleared, a status as its activity). */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { thread } from "../sync/fixtures/neutral";
import type { Ask, Thread } from "../sync/protocol";
import { EMPTY_FLEET, type Fleet } from "../sync/reducer";
import { windowKeys } from "../ui/home/membership";

/** what membership reads of a cmx2 session in the fixture: its info's parent and update time, its clear mark and its status */
type CmxSession = {
  cleared?: number;
  info: { parentID?: string; time: { updated: number } };
  status: { type: "busy"; since: number } | null;
};

type Fixture = {
  now: number;
  fleet: { asks: Record<string, { key: string }>; order: string[]; sessions: Record<string, CmxSession> };
  windows: string[];
};

const FIXTURE = join(import.meta.dir, "../../../server/src/fleet/board/windows.json");

/** a cmx2 session as translate.rs makes it neutral, as far as membership needs it */
function threadOf(key: string, session: CmxSession): Thread {
  const activity: Thread["activity"] = session.status ? { state: "busy", since: session.status.since } : { state: "idle" };
  return thread(key, {
    updated: session.info.time.updated,
    ...(session.info.parentID !== undefined ? { parent: session.info.parentID } : {}),
    ...(session.cleared !== undefined ? { cleared: session.cleared } : {}),
    activity,
  });
}

describe("the board's windows are the app's windows", () => {
  test("windowKeys over the server's board fixture gives its windows, in order", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
    const threads = Object.fromEntries(Object.entries(fixture.fleet.sessions).map(([key, session]) => [key, threadOf(key, session)]));
    /* an ask is keyed `<agent>:<id>` and names its thread by key (the neutral ask); membership reads only its key */
    const asks: Record<string, Ask> = Object.fromEntries(
      Object.entries(fixture.fleet.asks).map(([record, ask]) => {
        const at = record.indexOf(":");
        return [record, { key: ask.key, agent: record.slice(0, at), id: record.slice(at + 1), thread: ask.key, kind: "question" } as Ask];
      }),
    );
    const fleet: Fleet = { ...EMPTY_FLEET, order: fixture.fleet.order, threads, asks };
    expect(fixture.windows.length).toBeGreaterThan(0);
    expect(windowKeys(fleet, fixture.now)).toEqual(fixture.windows);
  });
});
