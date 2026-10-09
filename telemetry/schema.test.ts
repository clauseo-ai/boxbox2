/* the drift test (decision 17): telemetry/schema.json, which the rust
   server's ingest is generated from, is exactly what schema.ts says now. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dictionaryJson } from "./dictionary";
import { EVENTS } from "./schema";

test("telemetry/schema.json matches schema.ts (run `just dictionary` after editing schema.ts)", () => {
  const committed = readFileSync(join(import.meta.dir, "schema.json"), "utf8");
  expect(committed).toBe(dictionaryJson());
});

test("v1's kinds keep their names", () => {
  const v1 = [
    "app.open", "app.visible", "app.hidden", "app.stream", "surface.view", "surface.ready", "verb",
    "need.raised", "need.seen", "need.cleared", "push.sent", "push.tapped", "push.replied",
    "friction.rage", "friction.deadend", "friction.abandon", "friction.keyboard", "error.client",
    "agent.prompt", "agent.bill", "read.mark", "fleet.compaction", "board.connect", "board.key", "board.bind",
  ];
  for (const kind of v1) expect(Object.keys(EVENTS)).toContain(kind);
});
