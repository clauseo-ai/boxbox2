/* the converter's output is the committed protocol 3 recording, and what its frames build through the reducer is what the
   converter says the recording's last state is: the patches it wrote apply to exactly the threads, order, agents and asks
   the contract 1 recording ends with */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCursor } from "../../../sync/protocol";
import { parseJournal, replay } from "./replay";
import { type Contract1, serialize, toProtocol3 } from "./to-protocol3";

const dir = import.meta.dir;
const contract1 = readFileSync(join(dir, "journal.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Contract1);
const converted = toProtocol3(contract1);

describe("the protocol 3 recording", () => {
  test("is the converter's output over the contract 1 recording, line for line", () => {
    expect(readFileSync(join(dir, "journal-p3.ndjson"), "utf8")).toBe(serialize(converted.frames));
  });

  test("applies to the threads, order, agents and asks the recording ends with", () => {
    const { state } = replay(parseJournal(serialize(converted.frames)));
    expect(state.cursor).toEqual(parseCursor(converted.frames.at(-1)?.id ?? null));
    expect(state.fleet.threads).toEqual(converted.threads);
    expect(state.fleet.order).toEqual(converted.order);
    expect(state.fleet.agents).toEqual(converted.agents);
    expect(state.fleet.asks).toEqual(converted.asks);
  });

  test("sends a thread whole once and patches it after, and an unchanged session takes no frame", () => {
    const types = converted.frames.map((r) => r.frame.type);
    expect(types.filter((t) => t === "thread").length).toBe(Object.keys(converted.threads).length);
    expect(types.filter((t) => t === "thread.patch").length).toBeGreaterThan(0);
    const sessions = contract1.filter((r) => r.frame["type"] === "session").length;
    expect(types.filter((t) => t === "thread" || t === "thread.patch").length).toBeLessThan(sessions);
  });
});
