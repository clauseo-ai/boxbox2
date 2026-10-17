/* the memo boundaries of the thread's reactive layer (docs/thread.md, the stage as built): a delta to the running turn wakes the
   running turn and nothing else, a turn that arrives is the only one built, and the names are counted from where a change was.
   these need solid's browser build, which bun test does not pick (the server build has no reactivity), so they run in their
   own pass (`bun test --conditions browser`, the justfile's check) and skip themselves in the plain one. */

import { describe, expect, test } from "bun:test";
import { createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import type { Message } from "../../sync/protocol";
import { createTurns } from "./turns";
import { type Label, createNames } from "./names";
import { createThreadCaches, cacheKey } from "./memo-cache";
import { namesOf, tally } from "./ledger";
import { turnsOf } from "./model";

const reactive = (() => {
  try {
    let works = false;
    createRoot((dispose) => { const [a, set] = createSignal(0); const m = createMemo(() => a()); set(1); works = m() === 1; dispose(); });
    return works;
  } catch { return false; }
})();

const T0 = 1_790_000_000_000;
const user = (n: number, parts = true): Message => ({ info: { id: `msg_u${n}`, role: "user", time: { created: T0 + n * 60_000 } }, parts: parts ? [{ id: `prt_u${n}`, type: "text", text: `ask ${n}` }] : [] }) as unknown as Message;
const assistant = (n: number, text = `said ${n}`): Message => ({
  info: { id: `msg_a${n}`, role: "assistant", time: { created: T0 + n * 60_000 + 1000, completed: T0 + n * 60_000 + 5000 } },
  parts: [
    { id: `prt_t${n}`, type: "tool", callID: `call_${n}`, tool: "read", state: { status: "completed", input: { filePath: `/p/f${n}.ts` }, output: "x", time: { start: T0 + n * 60_000 + 2000, end: T0 + n * 60_000 + 3000 } } },
    { id: `prt_s${n}`, type: "text", text },
  ],
}) as unknown as Message;
const thread = (turns: number): Message[] => Array.from({ length: turns }, (_, i) => [user(i), assistant(i)]).flat();

const CACHES = createThreadCaches();
/** the digest of a built turn is read in idle time, which a test waits for */
const idle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

/** a turns reader over a store, counting how often a turn is read from its messages: the root is read once per run of a turn's memo */
function open(messages: Message[], key = "desk:ses_1", caches = CACHES, options: { first?: number; need?: () => ReadonlySet<string> } = {}) {
  const [store, setStore] = createStore<{ messages: Message[] }>({ messages });
  let reads = 0;
  const made = createRoot((dispose) => {
    const turns = createTurns(() => store.messages, () => { reads++; return "/p"; }, () => key, caches, options);
    return { ...turns, dispose };
  });
  return { ...made, store, setStore, reads: () => reads };
}

describe.skipIf(!reactive)("turns", () => {
  test("a delta to the newest turn rebuilds that turn alone and leaves every other turn's object", () => {
    const t = open(thread(40), "desk:delta");
    const before = t.turns();
    expect(before).toHaveLength(40);
    const ran = t.reads();
    t.setStore("messages", 79, "parts", 1, "text", "said 39, and more");
    const after = t.turns();
    expect(t.reads() - ran).toBe(1);
    expect(after.slice(0, 39).every((x, i) => x === before[i])).toBe(true);
    expect(after[39]).not.toBe(before[39]);
    expect(after[39]?.answer?.text).toBe("said 39, and more");
    t.dispose();
  });

  test("a delta to a reply keeps the photos and files its turn's person sent: the same arrays, so the strip and the files row are not made again", () => {
    const messages = thread(3);
    const url = `data:image/jpeg;base64,${"A".repeat(4096)}`;
    const u2 = messages[4] as Message;
    messages[4] = { ...u2, parts: [...u2.parts, { id: "prt_f2", type: "file", mime: "image/jpeg", filename: "board.jpg", url }, { id: "prt_d2", type: "file", mime: "application/pdf", filename: "brief.pdf", url: "" }] } as unknown as Message;
    const t = open(messages, "desk:photos");
    const before = t.turns()[2]?.photos;
    const files = t.turns()[2]?.sentFiles;
    expect(before?.map((p) => p.filename)).toEqual(["board.jpg"]);
    expect(files?.map((f) => f.filename)).toEqual(["brief.pdf"]);
    for (const n of [1, 2, 3]) {
      t.setStore("messages", 5, "parts", 1, "text", `said 2${", and more".repeat(n)}`);
      const after = t.turns()[2];
      expect(after?.answer?.text.endsWith(", and more")).toBe(true);
      expect(after?.photos).toBe(before);
      expect(after?.sentFiles).toBe(files);
    }
    t.dispose();
  });

  test("a turn that arrives is the only one built: the turn before it is not read again", () => {
    const t = open(thread(40), "desk:arrive");
    const before = t.turns();
    const ran = t.reads();
    /* as the worker patches a message that arrives: at the next index of the array it holds */
    t.setStore("messages", 80, user(40));
    t.setStore("messages", 81, assistant(40));
    const after = t.turns();
    expect(after).toHaveLength(41);
    expect(after.slice(0, 40).every((x, i) => x === before[i])).toBe(true);
    expect(t.reads() - ran).toBeLessThanOrEqual(2);
    t.dispose();
  });

  test("a user message with no part yet is not shown, and neither is it counted", () => {
    const t = open([...thread(3), user(3, false)], "desk:hidden");
    expect(t.turns()).toHaveLength(3);
    expect(t.count()).toBe(6);
    t.setStore("messages", 6, "parts", [{ id: "prt_u3", type: "text", text: "ask 3" }] as never);
    expect(t.turns()).toHaveLength(4);
    expect(t.count()).toBe(7);
    t.dispose();
  });

  test("a thread opened again takes its finished turns from the cache, and builds none", async () => {
    const messages = thread(12);
    const first = open(messages, "desk:again");
    const built = first.turns();
    await idle();
    first.dispose();
    expect(CACHES.turns.get(cacheKey("desk:again", "msg_u5"))?.turn).toBe(built[5]);
    const second = open(messages, "desk:again");
    expect(second.turns().every((x, i) => x === built[i])).toBe(true);
    second.dispose();
  });

  test("a thread fetched again with the same words keeps its turns, though the store holds new objects", async () => {
    const first = open(thread(12), "desk:fetched");
    const built = first.turns();
    await idle();
    first.dispose();
    const second = open(thread(12), "desk:fetched");
    expect(second.turns().every((x, i) => x === built[i])).toBe(true);
    second.dispose();
  });

  test("a turn whose messages are gone leaves the page", () => {
    const t = open(thread(5), "desk:gone");
    t.setStore("messages", (m) => m.filter((x) => x.info.id !== "msg_u2" && x.info.id !== "msg_a2"));
    expect(t.turns().map((x) => x.id)).toEqual(["msg_u0", "msg_u1", "msg_u3", "msg_u4"]);
    t.dispose();
  });
});

describe.skipIf(!reactive)("the turns kept for later", () => {
  test("a sign-out between the build and the idle digest keeps nothing", async () => {
    const caches = createThreadCaches();
    const t = open(thread(6), "desk:signout", caches);
    t.turns();
    caches.clear();
    await idle();
    expect(caches.turns.size).toBe(0);
    t.dispose();
  });
  test("a thread the worker let go between them is not written back, and another's is", async () => {
    const caches = createThreadCaches();
    const gone = open(thread(4), "desk:gone", caches);
    const stays = open(thread(4), "desk:stays", caches);
    gone.turns();
    stays.turns();
    caches.dropThread("desk:gone");
    await idle();
    expect(caches.turns.get(cacheKey("desk:gone", "msg_u0"))).toBeUndefined();
    expect(caches.turns.get(cacheKey("desk:stays", "msg_u0"))).toBeDefined();
    gone.dispose();
    stays.dispose();
  });
});

describe.skipIf(!reactive)("a thread whose key is read through an object that is made again", () => {
  /* home makes a window's view again at every update of its session (a reply streaming updates it a few times a second), and the stage reads
     its thread's key through it: the key notifies at each, though it is the same string */
  function openThrough(first: number) {
    const [view, setView] = createSignal({ key: "desk:same" });
    const [store, setStore] = createStore<{ messages: Message[] }>({ messages: thread(60) });
    const t = createRoot((dispose) => ({ ...createTurns(() => store.messages, () => "/p", () => view().key, createThreadCaches(), { first }), dispose }));
    return { ...t, setView, store, setStore };
  }
  test("keeps the turns it has shown: they are not taken back to the newest few at each update of the view", () => {
    const t = openThrough(8);
    expect(t.ids()).toHaveLength(8);
    t.grow(100);
    expect(t.ids()).toHaveLength(60);
    for (let i = 0; i < 5; i++) t.setView({ key: "desk:same" });
    expect(t.ids()).toHaveLength(60);
    expect(t.more()).toBe(false);
    t.dispose();
  });
  test("keeps them through a message arriving between the updates, and builds nothing again", () => {
    const t = openThrough(8);
    t.grow(100);
    const before = t.turns();
    t.setView({ key: "desk:same" });
    t.setStore("messages", 120, user(60));
    t.setStore("messages", 121, assistant(60));
    t.setView({ key: "desk:same" });
    const after = t.turns();
    expect(after).toHaveLength(61);
    expect(after.slice(0, 60).every((x, i) => x === before[i])).toBe(true);
    t.dispose();
  });
  test("another thread is another start: its newest few", () => {
    const t = openThrough(8);
    t.grow(100);
    t.setView({ key: "desk:other" });
    expect(t.ids()).toHaveLength(8);
    expect(t.more()).toBe(true);
    t.dispose();
  });
});

describe.skipIf(!reactive)("a queued message whose provisional id is replaced by the real one", () => {
  test("is a turn under its new id: found by it, and the old id is gone from the list", () => {
    const t = open([...thread(12), user(900), assistant(900)], "desk:queued", createThreadCaches());
    const before = t.ids();
    expect(before.at(-1)).toBe("msg_u900");
    t.setStore("messages", (m) => m.map((x) => (x.info.id === "msg_u900" ? { ...x, info: { ...x.info, id: "msg_real900" } } : x)) as Message[]);
    const after = t.ids();
    expect(after).toHaveLength(before.length);
    expect(after.at(-1)).toBe("msg_real900");
    expect(after).not.toContain("msg_u900");
    expect(t.turnOf("msg_real900")?.prompt).toBe("ask 900");
    expect(t.turnOf("msg_u900")).toBeUndefined();
    expect(t.turns().at(-1)?.id).toBe("msg_real900");
  });
  test("with older turns still to come, the ones shown are the same ones", () => {
    const t = open([...thread(40), user(900), assistant(900)], "desk:queued2", createThreadCaches(), { first: 6 });
    t.setStore("messages", (m) => m.map((x) => (x.info.id === "msg_u900" ? { ...x, info: { ...x.info, id: "msg_real900" } } : x)) as Message[]);
    expect(t.ids()).toHaveLength(6);
    expect(t.ids().at(-1)).toBe("msg_real900");
    t.grow(100);
    expect(t.ids()).toHaveLength(41);
    expect(t.ids().filter((id) => id === "msg_real900")).toHaveLength(1);
  });
});

describe.skipIf(!reactive)("the turns an ask needs", () => {
  test("a turn holding a pending ask is shown, with the turns after it, though it is older than the newest few", () => {
    const [need] = createSignal<ReadonlySet<string>>(new Set(["call_30"]));
    const t = open(thread(100), "desk:need", createThreadCaches(), { first: 10, need });
    expect(t.ids()[0]).toBe("msg_u30");
    expect(t.ids()).toHaveLength(70);
    expect(t.more()).toBe(true);
    expect(t.turnOf("msg_u30")?.items.some((x) => x.k === "step" && x.callID === "call_30")).toBe(true);
  });
  test("an ask that arrives after the thread opened brings its turn in, and a second brings the older of the two", () => {
    const [need, setNeed] = createSignal<ReadonlySet<string>>(new Set());
    const t = open(thread(100), "desk:need2", createThreadCaches(), { first: 10, need });
    expect(t.ids()).toHaveLength(10);
    setNeed(new Set(["call_80"]));
    expect(t.ids()[0]).toBe("msg_u80");
    setNeed(new Set(["call_80", "call_55"]));
    expect(t.ids()[0]).toBe("msg_u55");
    setNeed(new Set(["call_80"]));
    expect(t.ids()[0]).toBe("msg_u55");
  });
  test("an ask whose call is not in the thread, or none, changes nothing", () => {
    const [need] = createSignal<ReadonlySet<string>>(new Set(["call_nowhere"]));
    const t = open(thread(100), "desk:need3", createThreadCaches(), { first: 10, need });
    expect(t.ids()).toHaveLength(10);
  });
  test("it is read from the messages without reading their parts reactively: a delta to a part elsewhere wakes nothing", () => {
    const [need] = createSignal<ReadonlySet<string>>(new Set(["call_90"]));
    const t = open(thread(100), "desk:need4", createThreadCaches(), { first: 10, need });
    const ids = t.ids();
    t.setStore("messages", 5, "parts", 1, "text", "changed far above");
    expect(t.ids()).toBe(ids);
  });
});

describe.skipIf(!reactive)("a long thread shown newest first", () => {
  test("opens with the newest turns, builds only those, and the rest come as grow is called", () => {
    const t = open(thread(100), "desk:long", createThreadCaches(), { first: 24 });
    expect(t.turns()).toHaveLength(24);
    expect(t.turns()[23]?.id).toBe("msg_u99");
    expect(t.turns()[0]?.id).toBe("msg_u76");
    expect(t.reads()).toBe(24);
    expect(t.more()).toBe(true);
    t.grow(32);
    expect(t.turns()).toHaveLength(56);
    expect(t.reads()).toBe(56);
    t.grow(32);
    t.grow(32);
    expect(t.turns()).toHaveLength(100);
    expect(t.turns()[0]?.id).toBe("msg_u0");
    expect(t.more()).toBe(false);
  });
  test("a turn that grows in is built once, and the ones already shown keep their objects", () => {
    const t = open(thread(60), "desk:keep", createThreadCaches(), { first: 10 });
    const before = t.turns();
    t.grow(10);
    const after = t.turns();
    expect(after).toHaveLength(20);
    expect(after.slice(10).every((x, i) => x === before[i])).toBe(true);
  });
  test("all shows every turn at once", () => {
    const t = open(thread(50), "desk:all", createThreadCaches(), { first: 5 });
    expect(t.turns()).toHaveLength(5);
    t.all();
    expect(t.turns()).toHaveLength(50);
    expect(t.more()).toBe(false);
  });
  test("ids change only when a turn comes or goes, and a turn is found by its id", () => {
    const t = open(thread(30), "desk:ids", createThreadCaches(), { first: 10 });
    const ids = t.ids();
    t.setStore("messages", 59, "parts", 1, "text", "said 29, and more");
    expect(t.ids()).toBe(ids);
    expect(t.turnOf("msg_u29")?.answer?.text).toBe("said 29, and more");
    t.grow(5);
    expect(t.ids()).toHaveLength(15);
    expect(t.ids()[0]).toBe("msg_u15");
  });
  test("a message arriving while older turns are still to come makes its own turn and leaves the others", () => {
    const t = open(thread(40), "desk:arrive", createThreadCaches(), { first: 8 });
    const before = t.turns();
    t.setStore("messages", (m) => [...m, user(40), assistant(40)]);
    const after = t.turns();
    expect(after).toHaveLength(9);
    expect(after.slice(0, 8).every((x, i) => x === before[i])).toBe(true);
    expect(after[0]?.id).toBe("msg_u32");
    expect(t.more()).toBe(true);
  });
  test("a turn left of the cut that the messages lose is never built", () => {
    const t = open(thread(40), "desk:lost", createThreadCaches(), { first: 8 });
    t.setStore("messages", (m) => m.slice(10));
    expect(t.turns().at(-1)?.id).toBe("msg_u39");
    expect(t.turns()).toHaveLength(8);
    expect(t.more()).toBe(true);
  });
});

describe.skipIf(!reactive)("names", () => {
  const page = (ids: string[]) => {
    const [order, setOrder] = createSignal(ids);
    return createRoot((dispose) => ({ dispose, setOrder, names: createNames(order) }));
  };

  test("a label the turns above already carried is told apart, counted down the page", () => {
    const p = page(["a", "b", "c"]);
    p.names.say("a", ["read x", undefined, "run y"]);
    p.names.say("b", ["read x", "run y"]);
    p.names.say("c", ["read x"]);
    expect(p.names.names("a")).toEqual(["read x", undefined, "run y"]);
    expect(p.names.names("b")).toEqual(["read x, again", "run y, again"]);
    expect(p.names.names("c")).toEqual(["read x, third time"]);
    p.dispose();
  });

  test("a change in the newest turn counts that turn alone and leaves the names above it as they were", () => {
    const p = page(["a", "b"]);
    p.names.say("a", ["read x"]);
    p.names.say("b", ["read x"]);
    const above = p.names.names("a");
    p.names.say("b", ["read x", "read x"]);
    expect(p.names.names("a")).toBe(above);
    expect(p.names.names("b")).toEqual(["read x, again", "read x, third time"]);
    p.names.say("b", ["run z"]);
    expect(p.names.names("b")).toEqual(["run z"]);
    p.dispose();
  });

  test("a change higher up shifts the namesakes below it by one, and only those", () => {
    const p = page(["a", "b", "c"]);
    p.names.say("a", ["read x"]);
    p.names.say("b", ["read x"]);
    p.names.say("c", ["read y"]);
    expect(p.names.names("b")).toEqual(["read x, again"]);
    p.names.say("a", ["run q"]);
    expect(p.names.names("b")).toEqual(["read x"]);
    expect(p.names.names("c")).toEqual(["read y"]);
    p.dispose();
  });

  test("a turn that has said nothing yet is not counted", () => {
    const p = page(["a", "b", "c"]);
    p.names.say("c", ["read x"]);
    expect(p.names.names("c")).toEqual(["read x"]);
    p.names.say("a", ["read x"]);
    expect(p.names.names("c")).toEqual(["read x, again"]);
    p.dispose();
  });

  test("a turn that arrives is counted below the ones before it", () => {
    const p = page(["a"]);
    p.names.say("a", ["read x"]);
    p.setOrder(["a", "b"]);
    p.names.say("b", ["read x"]);
    expect(p.names.names("b")).toEqual(["read x, again"]);
    p.dispose();
  });
});

/* a turn shows what turnsOf reads of its messages: every field of a finished part's state and of a message's info is told by the
   digest, so a part sent again or an info replaced with other words is seen, and with the same words is not */
const shape = (t: unknown) => { const x = t as Record<string, unknown>; return JSON.stringify({ items: x["items"], answer: x["answer"], cost: x["cost"], status: x["status"], error: x["error"], model: x["model"], effort: x["effort"], end: x["end"] }); };

describe.skipIf(!reactive)("a turn reads what turnsOf reads", () => {
  const tool = (state: Record<string, unknown>, name = "shell"): Message => ({
    info: { id: "msg_a1", role: "assistant", cost: 0.01, modelID: "m-1", variant: "high", time: { created: T0 + 1000, completed: T0 + 5000 } },
    parts: [
      { id: "prt_t1", type: "tool", callID: "call_1", tool: name, state: { status: "completed", input: { command: "ls" }, output: "x", title: "ls", metadata: { exit_code: 0 }, time: { start: T0 + 2000, end: T0 + 3000 }, ...state } },
      { id: "prt_s1", type: "text", text: "said" },
    ],
  }) as unknown as Message;
  const withInfo = (info: Record<string, unknown>): Message => ({ ...tool({}), info: { ...(tool({}).info as object), ...info } }) as unknown as Message;
  const first = (): Message => user(1);

  /** the turn after `next` replaced the part (or the message), against what turnsOf says of the same messages read from nothing */
  function after(next: Message, at: "part" | "message", before: Message = tool({}), key = "desk:digest") {
    /* read first: the store takes the objects it is given, and a replacement is written into them */
    const was = shape(turnsOf([first(), before], "/p")[0]);
    const [store, setStore] = createStore<{ messages: Message[] }>({ messages: [first(), before] });
    return createRoot((dispose) => {
      const { turns } = createTurns(() => store.messages, () => "/p", () => key, createThreadCaches());
      turns();
      /* as the worker's patch sets it: the value replaces what was at the path (setStore's own would merge into it) */
      setStore(produce((d) => { if (at === "part") (d.messages[1] as Message).parts[0] = next.parts[0] as never; else d.messages[1] = next; }));
      const shown = shape(turns()[0]);
      const truth = shape(turnsOf(structuredClone(unwrap(store.messages)), "/p")[0]);
      dispose();
      return { shown, truth, before: was };
    });
  }

  const parts: Array<[string, Record<string, unknown>, string?, Record<string, unknown>?]> = [
    ["the exit code of a command", { metadata: { exit_code: 1 } }],
    ["the command it ran", { input: { command: "ls -la" } }],
    ["the output it printed", { output: "y".repeat(2000) }],
    ["its error", { status: "error", error: "boom", output: undefined }],
    ["the diff an edit made", { input: { filePath: "/p/a.ts" }, metadata: { filediff: { additions: 3, deletions: 1, patch: "+a\n-b" } } }, "edit"],
    ["the agent a spawn started", { metadata: { child_session_id: "ses_child", agents: [{ name: "helper", id: "ses_child" }] }, input: { brief: "do it" } }, "spawn"],
    ["the answers to a question", { input: { questions: [{ question: "which?", options: [] }] }, metadata: { answers: [["a"]] } }, "question"],
    ["the agents a script started", { input: { code: "x" }, metadata: { nested: [{ tool: "spawn" }, { tool: "spawn" }] } }, "run"],
    ["the hits of a search", { input: { pattern: "foo" }, metadata: { hits: [{ path: "/p/a.ts", line: 3, text: "foo" }], matches: 1 } }, "grep"],
  ];
  for (const [what, state, name] of parts) {
    test(`${what} changing on a finished part that is sent again is shown`, () => {
      const { shown, truth, before } = after(tool(state, name), "part", tool({}, name));
      expect(truth).not.toBe(before);
      expect(shown).toBe(truth);
    });
  }

  const infos: Array<[string, Record<string, unknown>]> = [
    ["a settled turn's cost", { cost: 0.5 }],
    ["the model it ran on", { modelID: "m-2" }],
    ["the effort it ran at", { variant: "low" }],
    ["how it finished", { finish: "aborted" }],
    ["the name of its error", { error: { name: "ProviderError", data: { message: "rate limited" } } }],
    ["the words of its error", { error: { name: "MessageAbortedError", data: { message: "stopped by you" } } }],
  ];
  for (const [what, info] of infos) {
    test(`${what} changing on a message that is replaced is shown`, () => {
      const { shown, truth, before } = after(withInfo(info), "message");
      expect(truth).not.toBe(before);
      expect(shown).toBe(truth);
    });
  }

  test("a part sent again with the same words is the same turn, and its dom is kept", async () => {
    const [store, setStore] = createStore<{ messages: Message[] }>({ messages: [first(), tool({})] });
    await createRoot(async (dispose) => {
      const { turns } = createTurns(() => store.messages, () => "/p", () => "desk:same", createThreadCaches());
      const before = turns()[0];
      await idle();
      setStore(produce((d) => { (d.messages[1] as Message).parts[0] = tool({}).parts[0] as never; }));
      expect(turns()[0]).toBe(before);
      dispose();
    });
  });

  test("a part sent again before the digest was read is built again, not kept on a guess", () => {
    const [store, setStore] = createStore<{ messages: Message[] }>({ messages: [first(), tool({})] });
    createRoot((dispose) => {
      const { turns } = createTurns(() => store.messages, () => "/p", () => "desk:early", createThreadCaches());
      const before = turns()[0];
      setStore(produce((d) => { (d.messages[1] as Message).parts[0] = tool({ metadata: { exit_code: 1 } }).parts[0] as never; }));
      expect(turns()[0]).not.toBe(before);
      expect(JSON.stringify(turns()[0]?.items)).toContain("exit 1");
      dispose();
    });
  });
});

/* the rule: a turn's names are namesOf(its labels, tally of every turn above it) */
function naive(order: readonly string[], said: ReadonlyMap<string, readonly Label[]>): Map<string, readonly Label[]> {
  const counts = new Map<string, number>();
  const out = new Map<string, readonly Label[]>();
  for (const id of order) { const l = said.get(id) ?? []; out.set(id, namesOf(l, counts)); tally(l, counts); }
  return out;
}

describe.skipIf(!reactive)("names, the running count against the rule", () => {
  test("random edits, appends, removals and reorders give the rule's names", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const pool = ["read a", "read b", "edit c", undefined, "run d"];
    const labelsOf = (): Label[] => Array.from({ length: rand(4) }, () => pool[rand(pool.length)]);
    let failures = 0;
    for (let round = 0; round < 200; round++) {
      createRoot((dispose) => {
        let next = 0;
        const [order, setOrder] = createSignal<string[]>([]);
        const names = createNames(order);
        const said = new Map<string, readonly Label[]>();
        for (let step = 0; step < 30; step++) {
          const ids = order();
          const op = rand(6);
          if (op === 0 || ids.length === 0) { const id = `t${next++}`; setOrder([...ids, id]); }
          else if (op === 1) { const i = rand(ids.length); const id = ids[i] as string; const l = labelsOf(); said.set(id, l); names.say(id, l); }
          else if (op === 2) { const id = ids[ids.length - 1] as string; const l = labelsOf(); said.set(id, l); names.say(id, l); }
          else if (op === 3 && ids.length > 1) { const i = rand(ids.length); setOrder(ids.filter((_, j) => j !== i)); }
          else if (op === 4) { const id = `t${next++}`; const i = rand(ids.length + 1); setOrder([...ids.slice(0, i), id, ...ids.slice(i)]); }
          else { const id = `t${next++}`; const l = labelsOf(); said.set(id, l); setOrder([...ids, id]); names.say(id, l); }
          /* a turn that leaves the page forgets what it said (the register drops it) */
          for (const id of [...said.keys()]) if (!order().includes(id)) said.delete(id);
          const want = naive(order(), said);
          for (const id of order()) {
            const got = names.names(id);
            const exp = want.get(id) ?? [];
            if (got.length !== exp.length || got.some((x, i) => x !== exp[i])) failures++;
          }
        }
        dispose();
      });
    }
    expect(failures).toBe(0);
  });
});

/* a part of megabytes: told apart by its length and its ends, in a time that does not grow with the megabytes */
describe.skipIf(!reactive)("a part of 6 MB", () => {
  const huge = (text: string): Message => ({ info: { id: "msg_a1", role: "assistant", time: { created: T0 + 1000, completed: T0 + 5000 } }, parts: [{ id: "prt_s1", type: "text", text }] }) as unknown as Message;
  test("is built into a turn, and changed, in well under a second", () => {
    const text = "word ".repeat(1_200_000);
    const [store, setStore] = createStore<{ messages: Message[] }>({ messages: [user(1), huge(text)] });
    createRoot((dispose) => {
      const t0 = performance.now();
      const { turns } = createTurns(() => store.messages, () => "/p", () => "desk:big", createThreadCaches());
      const built = turns()[0];
      expect(built?.answer?.text.length).toBe(text.length);
      setStore(produce((d) => { (d.messages[1] as Message).parts[0] = huge(`${text}and more`).parts[0] as never; }));
      expect(turns()[0]?.answer?.text.length).toBe(text.length + 8);
      expect(performance.now() - t0).toBeLessThan(1500);
      dispose();
    });
  });
});
