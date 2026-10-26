/* home's field's send (composer/new-thread.ts) as the field drives it, with no dom: the thread opens only when the one this
   send made is in the fleet, a refusal gives its words back and offers retry and edit, a refused send nobody holds is taken
   back by the next field, nothing moves the place while a thread is being made, and a field mounted again (an arrangement
   change) keeps the send and the place, since both live in the store. the worker and the machine are stood in for
   (`NewThreadIo`). solid's browser build only (`bun test --conditions browser`, the justfile's check). */

import { afterEach, describe, expect, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { bootSync, setBorn, setDraft, setNewThread, setOutbox, state } from "../../store";
import type { Fleet } from "../../sync/reducer";
import { EMPTY_FLEET } from "../../sync/reducer";
import { type OutboxView, targetKey } from "../../sync/outbox";
import type { NewThread, NewThreadIo } from "./new-thread";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();
// the sync client the send's own io comes from names itself on `window` as it loads
if (reactive) (globalThis as { window?: unknown }).window ??= globalThis;
type Module = typeof import("./new-thread");
const at = (path: string): string => path;
const { createNewThread } = reactive ? ((await import(at("./new-thread"))) as Module) : ({} as Module);

const LEDGER = { host: "mini", directory: "/w/ledger" };
const LEDGER_KEY = targetKey({ kind: "new", host: "mini", directory: "/w/ledger", place: "checkout" });
const STREAM = { state: "live", since: 0, lastEventAt: null } as const;

const threadAt = (key: string) => ({ key, agent: key.split(":")[0] ?? "", parent: null, updated: 1, place: { root: "/w/ledger", directory: "/w/ledger" } }) as unknown as Fleet["threads"][string];
function fleet(keys: readonly string[]): void {
  bootSync({ fleet: { ...EMPTY_FLEET, agentNames: ["mini", "desk"], threads: Object.fromEntries(keys.map((key) => [key, threadAt(key)])) }, threads: {}, stream: STREAM, drafts: { ...state.composer.drafts }, outbox: [...state.composer.outbox] });
}

function refused(clientID: string, target = LEDGER): OutboxView {
  return {
    clientID,
    verb: "start",
    target: { kind: "new", ...target, place: "checkout" },
    key: targetKey({ kind: "new", ...target, place: "checkout" }),
    text: "fix the invoice tests",
    photos: 0,
    files: 0,
    photoBytes: 0,
    model: null,
    effort: null,
    state: "failed",
    provisional: null,
    session: null,
    error: `nothing at ${target.directory} on ${target.host}`,
    attempts: 1,
    at: 1,
    ackAt: null,
    unsending: false,
  };
}

/** the worker and the machine, stood in for: what the send asked of them is kept */
function io() {
  const asked = { retried: [] as string[], discarded: [] as string[] };
  const fake: NewThreadIo = {
    saveDraft: (key, draft) => setDraft(key, draft),
    discardSend: (clientID) => {
      asked.discarded.push(clientID);
      setOutbox(state.composer.outbox.filter((e) => e.clientID !== clientID));
    },
    retrySend: (clientID) => void asked.retried.push(clientID),
    loadDraftPhotos: async () => undefined,
    projects: async () => ({ ok: true, value: [] }),
    folders: async () => ({ ok: false, message: "not read in a test" }),
  };
  return { asked, fake };
}

let mounted: Array<() => void> = [];
/** a field's send, as the field mounts it */
function mount(start: { host: string; directory: string | null }, fake: NewThreadIo) {
  const born: string[] = [];
  let nt!: NewThread;
  createRoot((dispose) => {
    mounted.push(dispose);
    nt = createNewThread({ start: () => start, onBorn: (key) => born.push(key), io: fake });
  });
  return { nt, born, unmount: () => mounted.pop()?.() };
}

afterEach(() => {
  for (const dispose of mounted) dispose();
  mounted = [];
  setNewThread({ place: null, sent: null, restored: [] });
  setOutbox([]);
  for (const key of Object.keys(state.composer.drafts)) setDraft(key, null);
  fleet([]);
});

describe.skipIf(!reactive)("home's field's send", () => {
  test("the thread opens only once the one born of this send's client id is in the fleet", () => {
    fleet([]);
    const { nt, born } = mount(LEDGER, io().fake);
    nt.started("c1");
    expect(nt.making()).toBe(true);
    setBorn("c1", "mini:ses_new");
    expect(born).toEqual([]);
    // a thread that merely appeared on the machine meanwhile is not this send's
    fleet(["mini:ses_stray"]);
    expect(born).toEqual([]);
    fleet(["mini:ses_stray", "mini:ses_new"]);
    expect(born).toEqual(["mini:ses_new"]);
    expect(state.newThread.sent).toBeNull();
    expect(nt.making()).toBe(false);
  });

  test("a field mounted again keeps the send and the place, and still opens the thread", () => {
    fleet([]);
    const { fake } = io();
    const first = mount(LEDGER, fake);
    first.nt.started("c2");
    first.unmount();
    // the second field is offered another place; the one taken holds
    const second = mount({ host: "desk", directory: "/w/other" }, fake);
    expect(second.nt.host()).toBe("mini");
    expect(second.nt.directory()).toBe("/w/ledger");
    expect(second.nt.making()).toBe(true);
    expect(second.nt.makingWords()).toBe("making the thread in ledger on mini.");
    setBorn("c2", "mini:ses_two");
    fleet(["mini:ses_two"]);
    expect(second.born).toEqual(["mini:ses_two"]);
  });

  test("a refusal blocks the next send, offers retry with the same client id, and edit gives the words back", () => {
    fleet([]);
    const { asked, fake } = io();
    const { nt } = mount(LEDGER, fake);
    nt.started("c3");
    setOutbox([refused("c3")]);
    expect(nt.failed()?.clientID).toBe("c3");
    expect(nt.making()).toBe(false);
    expect(nt.blocked()).toBe("retry or edit the message below first.");
    nt.retry();
    expect(asked.retried).toEqual(["c3"]);
    nt.backToDraft();
    expect(state.composer.drafts[LEDGER_KEY]?.text).toBe("fix the invoice tests");
    expect(asked.discarded).toEqual(["c3"]);
    expect(state.newThread.sent).toBeNull();
    expect(nt.failed()).toBeUndefined();
  });

  test("edit takes the field to the place the refused words were written for, when nothing is typed where it is", () => {
    fleet([]);
    const { fake } = io();
    const { nt } = mount(LEDGER, fake);
    nt.started("c6");
    setOutbox([refused("c6", { host: "desk", directory: "/w/other" })]);
    nt.backToDraft();
    expect(nt.host()).toBe("desk");
    expect(nt.directory()).toBe("/w/other");
    expect(state.composer.drafts[nt.draftKey()]?.text).toBe("fix the invoice tests");
  });

  test("a refused send nobody holds is taken back by the next field, which goes to its place when nothing is typed here", () => {
    fleet([]);
    const { asked, fake } = io();
    setOutbox([refused("c9", { host: "desk", directory: "/w/other" })]);
    const { nt } = mount(LEDGER, fake);
    expect(nt.host()).toBe("desk");
    expect(nt.directory()).toBe("/w/other");
    expect(state.composer.drafts[targetKey({ kind: "new", host: "desk", directory: "/w/other", place: "checkout" })]?.text).toBe("fix the invoice tests");
    expect(asked.discarded).toEqual(["c9"]);
    expect([...state.newThread.restored]).toContain("c9");
  });

  test("while a thread is being made the place holds: a pick of a repo or a machine is refused, and words typed wait", () => {
    fleet([]);
    const { nt } = mount(LEDGER, io().fake);
    nt.started("c5");
    expect(nt.pickRepo("/w/other")).toBe(false);
    expect(nt.pickMachine("desk")).toBe(false);
    expect(nt.host()).toBe("mini");
    expect(nt.directory()).toBe("/w/ledger");
    expect(nt.blocked()).toBeUndefined();
    setDraft(LEDGER_KEY, { text: "and the readme", photos: [], model: null, effort: null, at: 2 });
    expect(nt.blocked()).toBe("one thread at a time. this one can start once the first is open.");
  });
});
