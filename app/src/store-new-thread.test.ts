import { afterEach, describe, expect, test } from "bun:test";
import { setNewThread, state, syncSignedOut } from "./store";

const NONE = { place: null, sent: null, restored: [] };
afterEach(() => setNewThread(NONE));

describe("home's field's new thread, in the store", () => {
  test("each part is set whole: a place with no folder clears the folder before, and the other parts stay", () => {
    setNewThread({ place: { host: "mini", directory: "/w/ledger", place: "fresh" }, restored: ["c1"] });
    setNewThread({ place: { host: "desk", directory: null, place: "fresh" } });
    expect({ ...state.newThread.place }).toEqual({ host: "desk", directory: null, place: "fresh" });
    expect([...state.newThread.restored]).toEqual(["c1"]);
  });

  test("the send in flight goes when it is set to none", () => {
    setNewThread({ sent: { clientID: "c1", at: 1, host: "mini", directory: "/w/ledger" } });
    expect(state.newThread.sent?.clientID).toBe("c1");
    setNewThread({ sent: null });
    expect(state.newThread.sent).toBeNull();
  });

  test("signing out lets the place and the send go", () => {
    setNewThread({ place: { host: "mini", directory: "/w/ledger", place: "checkout" }, sent: { clientID: "c1", at: 1, host: "mini", directory: "/w/ledger" } });
    syncSignedOut();
    expect(state.newThread.place).toBeNull();
    expect(state.newThread.sent).toBeNull();
  });
});
