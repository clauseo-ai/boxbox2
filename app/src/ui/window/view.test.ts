import { describe, expect, test } from "bun:test";
import { thread } from "../../sync/fixtures/neutral";
import type { Ask, Thread } from "../../sync/protocol";
import { REPO_COLOURS, hashColour, repoName } from "./repo";
import { chipOf, elapsed, footClock, stateOf, windowName, windowView } from "./view";

type Activity = Thread["activity"];

/* the thread the server sends for cmx2's session: its repo's root, its name and where it works are the place */
const entry = (activity: Activity, over: Partial<Thread> = {}): Thread =>
  thread("bench:ses_1", {
    title: "move invoices to the new ledger",
    created: 1,
    updated: 1_000_000,
    place: { root: "/tmp/work/ledger", directory: "/tmp/work/ledger", name: "ledger" },
    activity,
    changes: { files: 2, additions: 212, deletions: 3 },
    ...over,
  });

const idle: Activity = { state: "idle" };

/* a question cmx2 sent without a header has an empty one, and cmx2 always takes a typed answer (translate.rs) */
const asked = (question: string, options: { label: string; description: string }[], header = "") => ({ header, question, options, multiple: false, custom: true });

const question: Ask = {
  agent: "bench",
  id: "que_1",
  key: "bench:ses_1",
  thread: "bench:ses_1",
  kind: "question",
  questions: [asked("how should i handle the three negative rows?", [{ label: "migrate them as refunds", description: "" }, { label: "skip them", description: "" }])],
};

describe("the window states of docs/design.md", () => {
  test("an ask outranks a running turn: wants you, filled in the repo's light tone", () => {
    const view = windowView(entry({ state: "busy", since: 5 }), [question], {});
    expect(view.state).toBe("wants");
    expect(view.chip).toEqual({ text: "wants you", tone: "lit" });
    expect(view.ask).toMatchObject({ kind: "question", id: "que_1", header: null, text: "how should i handle the three negative rows?", waiting: "2 options" });
  });

  test("working counts its clock from the turn's start", () => {
    const view = windowView(entry({ state: "busy", since: 60_000 }), [], {});
    expect(view.state).toBe("working");
    expect(footClock(view, 60_000 + 372_000)).toBe("6:12");
  });

  test("a busy turn whose start the server did not have shows no clock, whether since comes absent or as 0", () => {
    // the wire may leave busy's since out (cmx2 makes it optional), and a server that fills it sends 0
    const absent = windowView(entry({ state: "busy" } as Activity), [], {});
    const zero = windowView(entry({ state: "busy", since: 0 }), [], {});
    const queued = windowView(entry({ state: "busy", since: 0 }, { queued: 1 }), [], {});
    for (const view of [absent, zero, queued]) {
      expect(view.since).toBeNull();
      expect(footClock(view, 1_800_000_000_000)).toBe("");
    }
    expect(absent.state).toBe("working");
    expect(queued.state).toBe("queued");
  });

  test("queued says how many are next beside the state", () => {
    const view = windowView(entry({ state: "busy", since: 1 }, { queued: 3 }), [], {});
    expect(view.state).toBe("queued");
    expect(view.chip?.text).toBe("working, 3 next");
  });

  test("a retry is still a working turn, and carries the daemon's words", () => {
    const view = windowView(entry({ state: "retry", attempt: 2, message: "overloaded, trying again", next: 9, since: 1 }), [], {});
    expect(view.state).toBe("working");
    expect(view.retry).toBe("overloaded, trying again");
  });

  test("parked on a job says so; parked on agents at work is working, not parked", () => {
    const view = windowView(entry({ state: "parked", since: 2, agents: 0, jobs: 1 }), [], {});
    expect(view.state).toBe("parked");
    expect(view.jobs).toBe(1);
    expect(windowName(view)).toContain("parked on a background job");
    const agents = windowView(entry({ state: "parked", since: 2, agents: 2, jobs: 0 }), [], {});
    expect(agents.state).toBe("working");
    expect(agents.chip).toEqual({ text: "working", tone: "plain" });
    expect(agents.since).toBe(2);
    expect(windowName(agents)).toContain("working, 2 agents");
  });

  test("a failure is the one red, with its reason", () => {
    const view = windowView(entry(idle), [], {}, { failure: "the provider refused the key" });
    expect(view.state).toBe("failed");
    expect(view.chip).toEqual({ text: "stopped", tone: "fail" });
    expect(windowName(view)).toContain("stopped: the provider refused the key");
  });

  test("a finished turn with a review waiting says it is ready to merge, not done", () => {
    const waiting = windowView(entry(idle), [], {}, { review: "the toggle is in" });
    expect(waiting.state).toBe("done");
    expect(waiting.chip).toEqual({ text: "ready to merge", tone: "plain" });
    expect(windowName(waiting)).toContain("ready to merge");
    expect(windowView(entry(idle), [], {}).chip).toEqual({ text: "done", tone: "plain" });
  });

  test("a review does not hide what outranks it: a failure is still the failure", () => {
    expect(windowView(entry(idle), [], {}, { failure: "x", review: "r" }).chip).toEqual({ text: "stopped", tone: "fail" });
    expect(chipOf("working", 0, true)).toEqual({ text: "working", tone: "plain" });
  });

  test("a review waiting carries its note, and no review carries none", () => {
    expect(windowView(entry(idle), [], {}, { review: "the toggle is in" }).review).toBe("the toggle is in");
    expect(windowView(entry(idle), [], {}).review).toBeNull();
  });

  test("an idle thread is done until it is seen, then it has no chip", () => {
    expect(windowView(entry(idle), [], {}).state).toBe("done");
    const seen = windowView(entry(idle), [], {}, { seen: true });
    expect(seen.state).toBe("idle");
    expect(seen.chip).toBeNull();
  });

  test("the footer's diff comes from the thread's changes, and is absent with no edits", () => {
    expect(windowView(entry(idle), [], {}).diff).toEqual({ additions: 212, deletions: 3 });
    const clean = entry(idle);
    clean.changes = { files: 0, additions: 0, deletions: 0 };
    expect(windowView(clean, [], {}).diff).toBeNull();
  });

  test("the tail reads your prompt on its own line and the agent's prose after it", () => {
    const tail: Thread["tail"] = [
      { partID: "prt_u", messageID: "msg_u", kind: "text", role: "user", text: "add a per-customer limit, 100 a minute" },
      { partID: "prt_r", messageID: "msg_a", kind: "tool", role: "assistant", tool: "read", state: "completed", text: "src/routes.rs" },
      { partID: "prt_a", messageID: "msg_a", kind: "text", role: "assistant", text: "the limiter is a token bucket per customer id" },
    ];
    const view = windowView(entry({ state: "busy", since: 1 }, { tail }), [], {});
    expect(view.tail.map((l) => l.kind)).toEqual(["prompt", "reads", "prose"]);
    expect(view.tail[0]).toMatchObject({ kind: "prompt", text: "add a per-customer limit, 100 a minute" });
  });

  test("the repo is named by its place's name, the last segment of its root", () => {
    expect(windowView(entry(idle), [], {}).repo).toBe("ledger");
  });

  test("the place's name is shown as the server sends it, which is cmx2's repoName of the project id, even for \"\" and \"/\"", () => {
    for (const projectID of ["", "/", "/srv/ledger/", "C:\\work\\ledger"]) {
      const named = entry(idle, { place: { root: "/srv/ledger", directory: "/srv/ledger", name: repoName(projectID) } });
      expect(windowView(named, [], {}).repo).toBe(repoName(projectID));
    }
    expect([repoName(""), repoName("/")]).toEqual(["", "/"]);
  });

  test("the colour is the server's for the repo's root, which a worktree shares, and the hash colour before it has spoken", () => {
    const worktree = entry(idle, { place: { root: "/tmp/work/ledger", directory: "/tmp/work/.worktrees/ledger-2", name: "ledger" } });
    expect(windowView(worktree, [], { "bench:/tmp/work/ledger": { auto: "plum", chosen: "slate" } }).colour.name).toBe("slate");
    expect(windowView(worktree, [], {}).colour).toEqual(hashColour({ host: "bench", root: "/tmp/work/ledger" }));
    // a project id that is not a path is not the root: the server sends the directory as the place's root (translate.rs)
    const unpathed = entry(idle, { place: { root: "/tmp/work/ledger", directory: "/tmp/work/ledger", name: "ledger" } });
    expect(windowView(unpathed, [], { "bench:/tmp/work/ledger": { auto: "plum", chosen: null } }).colour.name).toBe("plum");
  });

  test("a permission reads as the thing it wants to do", () => {
    const permission: Ask = { agent: "bench", id: "per_1", key: "bench:ses_1", thread: "bench:ses_1", kind: "permission", permission: { title: "shell", patterns: ["rm -rf dist"], always: [], options: [] } };
    const view = windowView(entry({ state: "busy", since: 1 }), [permission], {});
    expect(view.ask).toMatchObject({ kind: "permission", id: "per_1", header: "permission", text: "run rm -rf dist", waiting: "allow once, always allow or deny" });
  });
});

describe("what a window says of its ask", () => {
  test("a question's own label and its first question's words, with the number of questions it holds", () => {
    const two: Ask = {
      ...question,
      questions: [asked("what can't we access?", [{ label: "a", description: "" }], "message got cut off"), asked("which models stay?", [], "models")],
    };
    expect(windowView(entry({ state: "busy", since: 1 }), [two], {}).ask).toMatchObject({ header: "message got cut off", text: "what can't we access?", waiting: "2 questions" });
  });

  test("a question the daemon wrote without words still reads", () => {
    const bare: Ask = { ...question, questions: [asked("", [])] };
    expect(windowView(entry({ state: "busy", since: 1 }), [bare], {}).ask).toMatchObject({ text: "the agent has a question", waiting: "type an answer" });
  });
});

describe("the inbox rank inside a window", () => {
  test("ask, then fault, then running, then parked, then done", () => {
    const base = { ask: false, failure: null, busy: false, queued: 0, parked: false, agents: 0, seen: false };
    expect(stateOf({ ...base, ask: true, failure: "x", busy: true })).toBe("wants");
    expect(stateOf({ ...base, failure: "x", busy: true })).toBe("failed");
    expect(stateOf({ ...base, busy: true, parked: true })).toBe("working");
    expect(stateOf({ ...base, parked: true })).toBe("parked");
    expect(stateOf({ ...base, parked: true, agents: 1 })).toBe("working");
    expect(stateOf(base)).toBe("done");
  });

  test("every state but idle carries a chip", () => {
    for (const state of ["wants", "failed", "done", "working", "queued", "parked"] as const) expect(chipOf(state, 2)).not.toBeNull();
    expect(chipOf("idle", 0)).toBeNull();
  });
});

describe("clocks", () => {
  test("m:ss under an hour, h:mm:ss past it", () => {
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(372_000)).toBe("6:12");
    expect(elapsed(3_723_000)).toBe("1:02:03");
    expect(elapsed(-5)).toBe("0:00");
  });
});

describe("the view's colour", () => {
  /* home and history reconcile the next view into a store that holds the last one: a colour that is the table's own
     entry would have the next colour's fields written into it (the picker's preview changes a window's colour while
     it is up) */
  test("is a copy, never the table's own entry", () => {
    const view = windowView(entry(idle), [], { "bench:/tmp/work/ledger": { auto: "teal", chosen: null } });
    expect(view.colour.name).toBe("teal");
    expect(REPO_COLOURS.includes(view.colour)).toBe(false);
  });
});
