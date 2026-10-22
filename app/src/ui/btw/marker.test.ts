import { describe, expect, test } from "bun:test";
import { turnsOf } from "../thread/model";
import type { WireMessage } from "../thread/wire";

/* the "from a btw" marker's data: a promoted user message carries the btw's id (`AgentMessage.btw`), and its turn keeps it */

const T0 = 1_790_000_000_000;
const message = (info: Record<string, unknown>): WireMessage => ({ info: { created: T0, ...info }, parts: [{ id: `${String(info["id"])}_p`, type: "text", text: "why is it slow?\n\nthe health check waits 30 s per machine." }] }) as unknown as WireMessage;

describe("a message added to the thread from a btw", () => {
  test("its turn carries the btw's id", () => {
    const [turn] = turnsOf([message({ id: "u1", role: "user", btw: "btw_1" })], "/");
    expect(turn?.btw).toBe("btw_1");
    expect(turn?.by).toBe("you");
  });

  test("a message typed in the composer carries none", () => {
    const [turn] = turnsOf([message({ id: "u1", role: "user" })], "/");
    expect(turn !== undefined && "btw" in turn).toBe(false);
  });
});
