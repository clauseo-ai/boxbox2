import { describe, expect, test } from "bun:test";
import { latestWins } from "./latest";

/** a sender whose calls end when the test says */
function held() {
  const sent: number[] = [];
  const ends: Array<() => void> = [];
  const send = latestWins((value: number) => {
    sent.push(value);
    return new Promise<void>((resolve) => ends.push(resolve));
  });
  return { sent, send, end: async () => { ends.shift()?.(); await Promise.resolve(); await Promise.resolve(); } };
}

describe("one call in flight, the latest wins", () => {
  test("a burst while one is pending goes out as the first and the last", async () => {
    const { sent, send, end } = held();
    for (let i = 1; i <= 3448; i++) send(i);
    expect(sent).toEqual([1]);
    await end();
    expect(sent).toEqual([1, 3448]);
    await end();
    expect(sent).toEqual([1, 3448]);
  });
  test("a call when nothing is pending goes at once", async () => {
    const { sent, send, end } = held();
    send(1);
    await end();
    send(2);
    expect(sent).toEqual([1, 2]);
  });
  test("a call that fails does not stop the ones after it", async () => {
    const sent: number[] = [];
    const send = latestWins((value: number) => {
      sent.push(value);
      return Promise.reject(new Error("down"));
    });
    send(1);
    send(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toEqual([1, 2]);
  });
});
