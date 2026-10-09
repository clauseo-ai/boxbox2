import { describe, expect, test } from "bun:test";
import { type Event, none, type State, step } from "./machine";
import type { Review } from "./model";

const review: Review = { checkout: "c", branch: "b", base: "main", baseRef: "main", commits: 1, dirty: false, additions: 1, deletions: 0, files: [], diff: "", truncated: false };
const merged = { merged: true as const, commit: "x", base: "main", branch: "b", commits: 1, stopped: [] };
const run = (events: Event[], from: State = none): State => events.reduce(step, from);
const ready = (): State => run([{ type: "need", id: "review:k:c" }, { type: "read", review }]);

describe("the card follows its need", () => {
  test("a need opens a card that is reading; the read makes it ready", () => {
    const reading = run([{ type: "need", id: "n1" }]);
    expect(reading).toMatchObject({ id: "n1", phase: "reading", review: null });
    expect(ready()).toMatchObject({ phase: "ready", review });
  });

  test("the same need again changes nothing; a new one is a new card", () => {
    const now = ready();
    expect(step(now, { type: "need", id: "review:k:c" })).toBe(now);
    expect(step(now, { type: "need", id: "n2" })).toMatchObject({ id: "n2", phase: "reading", review: null });
  });

  test("the need going away takes a card that is only waiting", () => {
    expect(step(ready(), { type: "gone" })).toBe(none);
    expect(step(run([{ type: "need", id: "n" }]), { type: "gone" })).toBe(none);
  });

  test("a failed read keeps the card and its reason, and a retry clears it", () => {
    const problem = { kind: "other" as const, text: "the server answered 500. try again.", files: [] };
    const failed = run([{ type: "need", id: "n" }, { type: "unread", problem }]);
    expect(failed).toMatchObject({ phase: "reading", problem });
    expect(step(failed, { type: "retry" }).problem).toBeNull();
  });

  test("a read that lands after the card moved on is ignored", () => {
    expect(step(none, { type: "read", review })).toBe(none);
    const done = run([{ type: "merge" }, { type: "merged", result: merged }], ready());
    expect(step(done, { type: "read", review: { ...review, commits: 9 } })).toBe(done);
  });
});

describe("a new request replaces the card", () => {
  test("from a ready card: the new note's card is reading again, with nothing of the old diff", () => {
    const next = step(ready(), { type: "need", id: "review:k:c:2" });
    expect(next).toMatchObject({ id: "review:k:c:2", phase: "reading", review: null, fold: null, confirming: false });
  });

  test("from a folded card: the fold is dropped and the new request is read afresh", () => {
    const merged_ = run([{ type: "merge" }, { type: "merged", result: merged }], ready());
    expect(merged_.phase).toBe("merged");
    expect(step(merged_, { type: "need", id: "review:k:c:2" })).toMatchObject({ id: "review:k:c:2", phase: "reading", review: null, fold: null });
    const discarded = run([{ type: "ask-discard" }, { type: "discard" }, { type: "discarded", result: { discarded: true, stopped: [] } }], ready());
    expect(step(discarded, { type: "need", id: "review:k:c:2" }).fold).toBeNull();
  });

  test("from a card that has the question open: the question goes with the old request", () => {
    expect(step(step(ready(), { type: "ask-discard" }), { type: "need", id: "n2" }).confirming).toBe(false);
  });
});

describe("a checkout that is gone", () => {
  const vanished = { kind: "gone" as const, text: "this checkout is gone. it was merged or discarded already.", files: [] };

  test("a read that finds it gone folds the card to one line", () => {
    const now = run([{ type: "need", id: "n" }, { type: "unread", problem: vanished }]);
    expect(now).toMatchObject({ phase: "gone", review: null, problem: null, fold: { kind: "gone", line: "this checkout is gone" } });
  });

  test("a merge or a discard that finds it gone folds the card, rather than leaving it with no controls", () => {
    expect(run([{ type: "merge" }, { type: "failed", problem: vanished }], ready())).toMatchObject({ phase: "gone", fold: { kind: "gone" }, problem: null });
    expect(run([{ type: "ask-discard" }, { type: "discard" }, { type: "failed", problem: vanished }], ready())).toMatchObject({ phase: "gone", confirming: false });
  });

  test("the line stays when the server serves the need, which it does in the same answer", () => {
    const now = run([{ type: "merge" }, { type: "failed", problem: vanished }], ready());
    expect(step(now, { type: "gone" })).toBe(now);
  });

  test("a gone card takes no more calls", () => {
    const now = run([{ type: "merge" }, { type: "failed", problem: vanished }], ready());
    expect(step(now, { type: "merge" })).toBe(now);
    expect(step(now, { type: "ask-discard" })).toBe(now);
  });
});

describe("merging", () => {
  test("a merge in flight survives the need being served, and folds into its line", () => {
    const merging = step(ready(), { type: "merge" });
    expect(merging.phase).toBe("merging");
    expect(step(merging, { type: "gone" })).toBe(merging);
    const done = step(merging, { type: "merged", result: merged });
    expect(done).toMatchObject({ phase: "merged", fold: { kind: "merged", line: "merged into main" } });
    expect(step(done, { type: "gone" })).toBe(done);
  });

  test("a merge in flight is not replaced by another need", () => {
    const merging = step(ready(), { type: "merge" });
    expect(step(merging, { type: "need", id: "other" })).toBe(merging);
  });

  test("a refusal puts the card back as it was, with the reason beside it", () => {
    const problem = { kind: "busy" as const, text: "the agent is mid-turn.", files: [] };
    const back = run([{ type: "merge" }, { type: "failed", problem }], ready());
    expect(back).toMatchObject({ phase: "ready", problem, review, fold: null });
    // and it can be asked again, which clears the old reason
    expect(step(back, { type: "merge" })).toMatchObject({ phase: "merging", problem: null });
  });

  test("a merge cannot start before the checkout has been read, or twice", () => {
    const reading = run([{ type: "need", id: "n" }]);
    expect(step(reading, { type: "merge" })).toBe(reading);
    const merging = step(ready(), { type: "merge" });
    expect(step(merging, { type: "merge" })).toBe(merging);
  });
});

describe("discarding asks once in words", () => {
  test("the first tap asks, keeping it puts the question away", () => {
    const asked = step(ready(), { type: "ask-discard" });
    expect(asked.confirming).toBe(true);
    expect(step(asked, { type: "keep" }).confirming).toBe(false);
  });

  test("a discard without the question answered does nothing", () => {
    const now = ready();
    expect(step(now, { type: "discard" })).toBe(now);
  });

  test("the second tap discards, and the card folds to a line saying so", () => {
    const discarding = run([{ type: "ask-discard" }, { type: "discard" }], ready());
    expect(discarding).toMatchObject({ phase: "discarding", confirming: false });
    const done = step(discarding, { type: "discarded", result: { discarded: true, stopped: [] } });
    expect(done).toMatchObject({ phase: "discarded", fold: { kind: "discarded", line: "discarded" } });
  });

  test("a merge starting takes the question away", () => {
    expect(run([{ type: "ask-discard" }, { type: "merge" }], ready()).confirming).toBe(false);
  });
});
