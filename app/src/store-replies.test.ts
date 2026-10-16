/* the store's slot for this device's replies to asks (store.ts, setReply and bootSync; sync/replies.ts): a reply kept on the page
   is there at once, and the records the cache read back join what the page kept before the worker booted */

import { describe, expect, test } from "bun:test";
import { bootSync, setReply, state } from "./store";
import { EMPTY_FLEET } from "./sync/reducer";
import { type AskReply, replyKey } from "./sync/replies";

const record = (callID: string, at: number): AskReply => ({ thread: "desk:ses", callID, askID: `per_${callID}`, kind: "permission", reply: { k: "permit", reply: "once" }, who: { here: true }, at });
const boot = (replies: AskReply[]) => bootSync({ fleet: EMPTY_FLEET, threads: {}, stream: { state: "live", since: 0, lastEventAt: null }, drafts: {}, outbox: [], replies });

describe("this device's replies in the store", () => {
  test("a reply kept on the page is in the store at once, and a second for the same call replaces it at the end", () => {
    boot([]);
    setReply(record("a", 1));
    setReply(record("b", 2));
    setReply({ ...record("a", 3), reply: { k: "permit", reply: "reject", message: "not now" } });
    expect(Object.keys(state.replies)).toEqual([replyKey("desk:ses", "b"), replyKey("desk:ses", "a")]);
    expect(state.replies[replyKey("desk:ses", "a")]?.reply).toEqual({ k: "permit", reply: "reject", message: "not now" });
  });

  test("boot reads the cache's records back, and a record the page kept before the worker booted outlives them", () => {
    boot([]);
    setReply(record("early", 50));
    boot([record("cached", 10), { ...record("early", 5), reply: { k: "permit", reply: "always" } }]);
    // the page's own records (the first test's too) come after what the cache held
    const keys = Object.keys(state.replies);
    expect(keys[0]).toBe(replyKey("desk:ses", "cached"));
    expect(keys.at(-1)).toBe(replyKey("desk:ses", "early"));
    expect(state.replies[replyKey("desk:ses", "early")]?.at).toBe(50);
  });
});
