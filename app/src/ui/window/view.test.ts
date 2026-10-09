import { describe, expect, test } from "bun:test";
import type { Ask, SessionEntry, SessionStatus } from "../../sync/protocol";
import { chipOf, elapsed, footClock, stateOf, windowName, windowView } from "./view";

const entry = (status: SessionStatus | null, over: Partial<SessionEntry> = {}): SessionEntry => ({
  key: "bench:ses_1",
  host: "bench",
  id: "ses_1",
  agents: 0,
  processes: 0,
  tail: [],
  needs: [],
  read: null,
  status,
  info: {
    id: "ses_1",
    slug: "s",
    projectID: "/tmp/work/ledger",
    directory: "/tmp/work/ledger",
    title: "move invoices to the new ledger",
    version: "0",
    source: "cmx2",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1_000_000 },
    summary: { files: 2, additions: 212, deletions: 3 },
  } as SessionEntry["info"],
  ...over,
});

const question: Ask = {
  host: "bench",
  id: "que_1",
  key: "bench:ses_1",
  kind: "question",
  request: { questions: [{ question: "how should i handle the three negative rows?", options: [{ label: "migrate them as refunds", description: "" }, { label: "skip them", description: "" }] }] },
};

describe("the window states of docs/design.md", () => {
  test("an ask outranks a running turn: wants you, filled in the repo's light tone", () => {
    const view = windowView(entry({ type: "busy", since: 5 }), [question]);
    expect(view.state).toBe("wants");
    expect(view.chip).toEqual({ text: "wants you", tone: "lit" });
    expect(view.ask).toMatchObject({ kind: "question", id: "que_1", header: null, text: "how should i handle the three negative rows?", waiting: "2 options" });
  });

  test("working counts its clock from the turn's start", () => {
    const view = windowView(entry({ type: "busy", since: 60_000 }), []);
    expect(view.state).toBe("working");
    expect(footClock(view, 60_000 + 372_000)).toBe("6:12");
  });

  test("queued says how many are next beside the state", () => {
    const view = windowView(entry({ type: "busy", since: 1, queued: 3 }), []);
    expect(view.state).toBe("queued");
    expect(view.chip?.text).toBe("working, 3 next");
  });

  test("a retry is still a working turn, and carries the daemon's words", () => {
    const view = windowView(entry({ type: "retry", attempt: 2, message: "overloaded, trying again", next: 9, since: 1 }), []);
    expect(view.state).toBe("working");
    expect(view.retry).toBe("overloaded, trying again");
  });

  test("parked on a job says so; parked on agents at work is working, not parked", () => {
    const view = windowView(entry({ type: "idle", since: 2, parked: { agents: 0, jobs: 1 } }), []);
    expect(view.state).toBe("parked");
    expect(view.jobs).toBe(1);
    expect(windowName(view)).toContain("parked on a background job");
    const agents = windowView(entry({ type: "idle", since: 2, parked: { agents: 2, jobs: 0 } }), []);
    expect(agents.state).toBe("working");
    expect(agents.chip).toEqual({ text: "working", tone: "plain" });
    expect(agents.since).toBe(2);
    expect(windowName(agents)).toContain("working, 2 agents");
  });

  test("a failure is the one red, with its reason", () => {
    const view = windowView(entry(null), [], { failure: "the provider refused the key" });
    expect(view.state).toBe("failed");
    expect(view.chip).toEqual({ text: "stopped", tone: "fail" });
    expect(windowName(view)).toContain("stopped: the provider refused the key");
  });

  test("a finished turn with a review waiting says it is ready to merge, not done", () => {
    const waiting = windowView(entry(null), [], { review: "the toggle is in" });
    expect(waiting.state).toBe("done");
    expect(waiting.chip).toEqual({ text: "ready to merge", tone: "plain" });
    expect(windowName(waiting)).toContain("ready to merge");
    expect(windowView(entry(null), []).chip).toEqual({ text: "done", tone: "plain" });
  });

  test("a review does not hide what outranks it: a failure is still the failure", () => {
    expect(windowView(entry(null), [], { failure: "x", review: "r" }).chip).toEqual({ text: "stopped", tone: "fail" });
    expect(chipOf("working", 0, true)).toEqual({ text: "working", tone: "plain" });
  });

  test("a review waiting carries its note, and no review carries none", () => {
    expect(windowView(entry(null), [], { review: "the toggle is in" }).review).toBe("the toggle is in");
    expect(windowView(entry(null), []).review).toBeNull();
  });

  test("an idle thread is done until it is seen, then it has no chip", () => {
    expect(windowView(entry(null), []).state).toBe("done");
    const seen = windowView(entry(null), [], { seen: true });
    expect(seen.state).toBe("idle");
    expect(seen.chip).toBeNull();
  });

  test("the footer's diff comes from the session's summary, and is absent with no edits", () => {
    expect(windowView(entry(null), []).diff).toEqual({ additions: 212, deletions: 3 });
    const clean = entry(null);
    (clean.info as { summary?: unknown }).summary = { files: 0, additions: 0, deletions: 0 };
    expect(windowView(clean, []).diff).toBeNull();
  });

  test("the tail reads your prompt on its own line and the agent's prose after it", () => {
    const tail: SessionEntry["tail"] = [
      { partID: "prt_u", messageID: "msg_u", kind: "text", role: "user", text: "add a per-customer limit, 100 a minute" },
      { partID: "prt_r", messageID: "msg_a", kind: "tool", role: "assistant", tool: "read", state: "completed", text: "src/routes.rs" },
      { partID: "prt_a", messageID: "msg_a", kind: "text", role: "assistant", text: "the limiter is a token bucket per customer id" },
    ];
    const view = windowView(entry({ type: "busy", since: 1 }, { tail }), []);
    expect(view.tail.map((l) => l.kind)).toEqual(["prompt", "reads", "prose"]);
    expect(view.tail[0]).toMatchObject({ kind: "prompt", text: "add a per-customer limit, 100 a minute" });
  });

  test("the repo is named by the last segment of its root", () => {
    expect(windowView(entry(null), []).repo).toBe("ledger");
  });

  test("a permission reads as the thing it wants to do", () => {
    const permission: Ask = { host: "bench", id: "per_1", key: "bench:ses_1", kind: "permission", request: { permission: "shell", patterns: ["rm -rf dist"] } };
    const view = windowView(entry({ type: "busy", since: 1 }), [permission]);
    expect(view.ask).toMatchObject({ kind: "permission", id: "per_1", header: "permission", text: "run rm -rf dist", waiting: "allow once, always allow or deny" });
  });
});

describe("what a window says of its ask", () => {
  test("a question's own label and its first question's words, with the number of questions it holds", () => {
    const two: Ask = {
      ...question,
      request: {
        questions: [
          { header: "message got cut off", question: "what can't we access?", options: [{ label: "a", description: "" }] },
          { header: "models", question: "which models stay?", options: [] },
        ],
      },
    };
    expect(windowView(entry({ type: "busy", since: 1 }), [two]).ask).toMatchObject({ header: "message got cut off", text: "what can't we access?", waiting: "2 questions" });
  });

  test("a question the daemon wrote without words still reads", () => {
    const bare: Ask = { ...question, request: { questions: [{ options: [] }] } };
    expect(windowView(entry({ type: "busy", since: 1 }), [bare]).ask).toMatchObject({ text: "the agent has a question", waiting: "type an answer" });
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
