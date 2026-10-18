import { afterEach, describe, expect, test } from "bun:test";
import { boardCompose, boardFocus, boardGone, boardHere, setBoardPin, state, syncSignedOut } from "./store";

afterEach(() => {
  boardGone();
  setBoardPin(null);
});

describe("the board's slice", () => {
  test("a board.here puts the board here with its digits, and the next one replaces them whole", () => {
    expect(state.board.here).toBe(false);
    expect(state.board.met).toBe(false);
    boardHere([{ key: "desk:a", digit: 1 }, { key: "desk:b", digit: 2, bound: true }]);
    expect(state.board.here).toBe(true);
    expect(state.board.met).toBe(true);
    expect({ ...state.board.digits }).toEqual({ "desk:a": 1, "desk:b": 2 });
    expect({ ...state.board.bound }).toEqual({ "desk:b": true });
    boardHere([{ key: "desk:c", digit: 1 }]);
    expect({ ...state.board.digits }).toEqual({ "desk:c": 1 });
    expect({ ...state.board.bound }).toEqual({});
  });

  test("a seat the wire could not mean is left out rather than drawn wrong", () => {
    boardHere([
      { key: "desk:a", digit: 0 },
      { key: "desk:b", digit: 10 },
      { key: "desk:c", digit: 2.5 },
      { key: "desk:d", digit: 3 },
      { key: "desk:e", digit: 3 },
      { key: "desk:d", digit: 4 },
    ]);
    expect({ ...state.board.digits }).toEqual({ "desk:d": 3 });
  });

  test("board.gone drops every digit and any request, and keeps the chunk's pieces mounted", () => {
    boardHere([{ key: "desk:a", digit: 1 }]);
    boardFocus("desk:a");
    boardCompose("vm");
    boardGone();
    expect(state.board.here).toBe(false);
    expect({ ...state.board.digits }).toEqual({});
    expect(state.board.focus).toBeNull();
    expect(state.board.compose).toBeNull();
    expect(state.board.met).toBe(true);
  });

  test("a focus is a new request each time, even for the same thread", () => {
    boardFocus("desk:a");
    const first = state.board.focus?.serial;
    boardFocus("desk:a");
    expect(state.board.focus?.serial).not.toBe(first);
    expect(state.board.focus?.key).toBe("desk:a");
  });

  test("an armed pairing settles only on a here that shows its thread bound, not on the seat it already had", () => {
    boardHere([{ key: "desk:a", digit: 1 }]);
    setBoardPin({ key: "desk:a", phase: "armed", until: Date.now() + 30_000, was: null });
    boardHere([{ key: "desk:a", digit: 1 }, { key: "desk:b", digit: 2 }]);
    expect(state.board.pin?.phase).toBe("armed");
    boardHere([{ key: "desk:a", digit: 4, bound: true }]);
    expect(state.board.pin).toEqual({ key: "desk:a", phase: "paired", digit: 4 });
  });

  test("an armed pairing settles on its seat turning paired at the digit it already sat on", () => {
    boardHere([{ key: "desk:a", digit: 2 }]);
    setBoardPin({ key: "desk:a", phase: "armed", until: Date.now() + 30_000, was: null });
    boardHere([{ key: "desk:a", digit: 5 }]);
    expect(state.board.pin?.phase).toBe("armed");
    boardHere([{ key: "desk:a", digit: 5, bound: true }]);
    expect(state.board.pin).toEqual({ key: "desk:a", phase: "paired", digit: 5 });
  });

  test("a pairing for another thread settles nothing", () => {
    setBoardPin({ key: "desk:a", phase: "armed", until: Date.now() + 30_000, was: null });
    boardHere([{ key: "desk:b", digit: 1, bound: true }]);
    expect(state.board.pin?.phase).toBe("armed");
  });

  test("a thread already on a paired key settles only when a here shows it on another", () => {
    boardHere([{ key: "desk:a", digit: 3, bound: true }]);
    setBoardPin({ key: "desk:a", phase: "armed", until: Date.now() + 30_000, was: 3 });
    boardHere([{ key: "desk:a", digit: 3, bound: true }, { key: "desk:b", digit: 1 }]);
    expect(state.board.pin?.phase).toBe("armed");
    boardHere([{ key: "desk:a", digit: 7, bound: true }]);
    expect(state.board.pin).toEqual({ key: "desk:a", phase: "paired", digit: 7 });
  });

  test("an armed pairing goes with the board; a settled one stays to be read", () => {
    boardHere([{ key: "desk:a", digit: 1 }]);
    setBoardPin({ key: "desk:a", phase: "armed", until: Date.now() + 30_000, was: null });
    boardGone();
    expect(state.board.pin).toBeNull();
    setBoardPin({ key: "desk:a", phase: "missed" });
    boardGone();
    expect(state.board.pin?.phase).toBe("missed");
  });

  test("signing out takes the board's digits with everything else", () => {
    boardHere([{ key: "desk:a", digit: 1 }]);
    syncSignedOut();
    expect(state.board.here).toBe(false);
    expect({ ...state.board.digits }).toEqual({});
  });
});
