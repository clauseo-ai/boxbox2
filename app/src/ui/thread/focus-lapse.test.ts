import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createLapse } from "./focus-lapse";

const A = { thread: "desk:a" };
const B = { thread: "desk:b" };

// the clock is the test's: a wait is moved by saying how long has passed, so a loaded machine cannot make one early or late
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("the wait for the ask a focus names", () => {
  test("hands the focus back to be let go once the wait is over, and not before", () => {
    const released: object[] = [];
    createLapse(4000, (held) => released.push(held)).start(A);
    jest.advanceTimersByTime(3999);
    expect(released).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(released).toEqual([A]);
  });

  test("a frame that looks again for the same focus does not push the end away", () => {
    const released: object[] = [];
    const lapse = createLapse(4000, (held) => released.push(held));
    lapse.start(A);
    jest.advanceTimersByTime(2500);
    lapse.start(A);
    jest.advanceTimersByTime(1500);
    expect(released).toEqual([A]);
  });

  test("another focus starts the wait over, and the first is not released by the second's wait", () => {
    const released: object[] = [];
    const lapse = createLapse(4000, (held) => released.push(held));
    lapse.start(A);
    jest.advanceTimersByTime(2500);
    lapse.start(B);
    jest.advanceTimersByTime(2000);
    expect(released).toEqual([]);
    jest.advanceTimersByTime(2000);
    expect(released).toEqual([B]);
  });

  test("a stage that found the ask, or went away, releases nothing", () => {
    const released: object[] = [];
    const lapse = createLapse(4000, (held) => released.push(held));
    lapse.start(A);
    lapse.stop();
    jest.advanceTimersByTime(10_000);
    expect(released).toEqual([]);
  });

  test("after it has ended, the same focus can be waited on again", () => {
    const released: object[] = [];
    const lapse = createLapse(4000, (held) => released.push(held));
    lapse.start(A);
    jest.advanceTimersByTime(4000);
    lapse.start(A);
    jest.advanceTimersByTime(4000);
    expect(released).toEqual([A, A]);
  });
});
