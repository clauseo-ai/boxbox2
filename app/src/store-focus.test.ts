/* the focus a push tap or a window's "answer" leaves for the stage (store.ts, openFocus and releaseFocus) */

import { afterEach, describe, expect, jest, test } from "bun:test";
import { FOCUS_FOR_MS, openFocus, releaseFocus, state } from "./store";

afterEach(() => openFocus(null));

describe("the focus that names an ask", () => {
  test("a second focus replaces the first, so whoever watches the store is told, and the first is not rewritten", () => {
    openFocus({ thread: "desk:a", ask: "que_a", push: null });
    const first = state.focus;
    openFocus({ thread: "desk:b", ask: "que_b", push: null });
    expect(state.focus).not.toBe(first);
    expect(state.focus?.ask).toBe("que_b");
    expect(first?.ask).toBe("que_a");
  });

  test("null lets go of it, and a focus after that is new again", () => {
    openFocus({ thread: "desk:a", ask: "que_a", push: null });
    openFocus(null);
    expect(state.focus).toBeNull();
    openFocus({ thread: "desk:c", ask: "que_c", push: "p1" });
    expect(state.focus).toMatchObject({ thread: "desk:c", ask: "que_c", push: "p1" });
  });

  test("it waits on the stage, not on the clock: a cold launch's gate and sign-in take as long as they take", () => {
    jest.useFakeTimers();
    try {
      openFocus({ thread: "desk:a", ask: "que_a", push: null });
      jest.advanceTimersByTime(FOCUS_FOR_MS * 10);
      expect(state.focus?.ask).toBe("que_a");
    } finally {
      jest.useRealTimers();
    }
  });

  test("the stage lets go of the focus it waited on", () => {
    openFocus({ thread: "desk:a", ask: "que_gone", push: null });
    releaseFocus(state.focus);
    expect(state.focus).toBeNull();
  });

  test("a newer focus is not let go of by the wait on the older one", () => {
    openFocus({ thread: "desk:a", ask: "que_a", push: null });
    const waited = state.focus;
    openFocus({ thread: "desk:b", ask: "que_b", push: null });
    releaseFocus(waited);
    expect(state.focus?.ask).toBe("que_b");
  });

  test("letting go of nothing changes nothing", () => {
    openFocus({ thread: "desk:a", ask: "que_a", push: null });
    releaseFocus(null);
    expect(state.focus?.ask).toBe("que_a");
  });
});
