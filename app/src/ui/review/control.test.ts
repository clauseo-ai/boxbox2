import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { Result, ReviewApi } from "./api";
import { createReviewControl } from "./control";
import type { Discarded, Merged, Review } from "./model";
import type { ReviewNeed } from "./open";

const review = (over: Partial<Review> = {}): Review => ({ checkout: "c", branch: "agent/c", base: "main", baseRef: "main", commits: 1, dirty: false, additions: 1, deletions: 0, files: [], diff: "", truncated: false, ...over });
const need = (id: string, body = "the note"): ReviewNeed => ({ id, key: "desk:ses_1", kind: "review", rank: 3, raisedAt: 1, title: "x is ready to merge", body, checkout: "c" });
const merged: Merged = { merged: true, commit: "x", base: "main", branch: "agent/c", commits: 1, stopped: [] };
const gone = { kind: "gone" as const, text: "this checkout is gone. it was merged or discarded already.", files: [] };

/** a server that answers at once, and counts what it was asked */
function server(answers: { read?: Result<Review>[]; merge?: Result<Merged>; discard?: Result<Discarded> } = {}) {
  const calls = { read: 0, merge: 0, discard: 0 };
  const reads = [...(answers.read ?? [])];
  const api: ReviewApi = {
    read: async () => { calls.read++; return reads.shift() ?? { ok: true, value: review() }; },
    merge: async () => { calls.merge++; return answers.merge ?? { ok: true, value: merged }; },
    discard: async () => { calls.discard++; return answers.discard ?? { ok: true, value: { discarded: true, stopped: [] } }; },
  };
  return { api, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function control(api: ReviewApi) {
  return createRoot((dispose) => ({ dispose, ...createReviewControl({ host: () => "desk", session: () => "ses_1", api }) }));
}

describe("a card reads its checkout once and answers a merge", () => {
  test("the need brings a card that reads, then offers the controls", async () => {
    const { api, calls } = server();
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    expect(card.phase()).toBe("reading");
    await settle();
    expect(card.phase()).toBe("ready");
    expect(calls.read).toBe(1);
    // the stream says the same thing again: no second read
    offer(need("a"));
    await settle();
    expect(calls.read).toBe(1);
    dispose();
  });

  test("the same request with a new note updates the note, and keeps the diff", async () => {
    const { api, calls } = server();
    const { control: card, offer, dispose } = control(api);
    offer(need("a", "first note"));
    await settle();
    offer(need("a", "second note"));
    expect(card.need()?.body).toBe("second note");
    expect(card.phase()).toBe("ready");
    expect(calls.read).toBe(1);
    dispose();
  });

  test("a merge folds the card, and it stays after the server serves the need", async () => {
    const { api, calls } = server();
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    await settle();
    card.merge();
    expect(card.phase()).toBe("merging");
    await settle();
    expect(card.fold()).toEqual({ kind: "merged", line: "merged into main" });
    expect(card.earned()).toBe(true);
    expect(card.pressed()).toBe(true);
    offer(undefined);
    expect(card.need()?.id).toBe("a");
    expect(card.fold()?.kind).toBe("merged");
    expect(calls.merge).toBe(1);
    dispose();
  });

  test("a discard asks once: the first press only asks", async () => {
    const { api, calls } = server();
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    await settle();
    card.discard();
    await settle();
    expect(calls.discard).toBe(0);
    card.askDiscard();
    card.discard();
    await settle();
    expect(calls.discard).toBe(1);
    expect(card.fold()).toEqual({ kind: "discarded", line: "discarded" });
    dispose();
  });
});

describe("a failed read can be asked again", () => {
  test("try again reads once more and, when it answers, the card is ready", async () => {
    const { api, calls } = server({ read: [{ ok: false, problem: { kind: "other", text: "the server answered 500. try again.", files: [] } }] });
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    await settle();
    expect(card.review()).toBeNull();
    expect(card.problem()?.text).toContain("500");
    card.retry();
    expect(card.problem()).toBeNull();
    await settle();
    expect(card.phase()).toBe("ready");
    expect(calls.read).toBe(2);
    dispose();
  });

  test("try again does nothing on a card that has read", async () => {
    const { api, calls } = server();
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    await settle();
    card.retry();
    await settle();
    expect(calls.read).toBe(1);
    dispose();
  });
});

describe("a checkout that is gone", () => {
  test("a merge that finds it gone folds the card to one line, which stays when the need is served", async () => {
    const { api, calls } = server({ merge: { ok: false, problem: gone } });
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    await settle();
    card.merge();
    await settle();
    expect(card.phase()).toBe("gone");
    expect(card.fold()).toEqual({ kind: "gone", line: "this checkout is gone" });
    expect(card.earned()).toBe(false);
    expect(card.pressed()).toBe(true);
    // the server serves the need in the same answer: the line is what says why the card is not there
    offer(undefined);
    expect(card.need()?.id).toBe("a");
    expect(card.fold()).toEqual({ kind: "gone", line: "this checkout is gone" });
    // it takes no more calls
    card.merge();
    expect(calls.merge).toBe(1);
    // a newer request still takes the card
    offer(need("b"));
    await settle();
    expect(card.need()?.id).toBe("b");
    expect(card.fold()).toBeNull();
    dispose();
  });

  test("a read that finds it gone folds the card the same way", async () => {
    const { api } = server({ read: [{ ok: false, problem: gone }] });
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    await settle();
    expect(card.fold()?.kind).toBe("gone");
    expect(card.pressed()).toBe(false);
    dispose();
  });
});

describe("a newer request replaces the card", () => {
  test("a new need id reads afresh: the new note and a new diff", async () => {
    const { api, calls } = server({ read: [{ ok: true, value: review({ commits: 1 }) }, { ok: true, value: review({ commits: 5 }) }] });
    const { control: card, offer, dispose } = control(api);
    offer(need("a", "first"));
    await settle();
    expect(card.review()?.commits).toBe(1);
    offer(need("b", "second"));
    expect(card.review()).toBeNull();
    expect(card.need()?.body).toBe("second");
    await settle();
    expect(card.review()?.commits).toBe(5);
    expect(calls.read).toBe(2);
    dispose();
  });

  test("from a folded card: the fold is gone, the earned moment is spent, and the new request is read", async () => {
    const { api, calls } = server();
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    await settle();
    card.merge();
    await settle();
    offer(undefined);
    expect(card.fold()?.kind).toBe("merged");
    offer(need("b", "the next request"));
    expect(card.fold()).toBeNull();
    expect(card.earned()).toBe(false);
    expect(card.pressed()).toBe(false);
    expect(card.phase()).toBe("reading");
    expect(card.need()?.body).toBe("the next request");
    await settle();
    expect(card.phase()).toBe("ready");
    expect(calls.read).toBe(2);
    dispose();
  });

  test("a request that arrives while a merge is out takes the card once the merge is answered", async () => {
    let release: (value: Result<Merged>) => void = () => undefined;
    const { api: base, calls } = server();
    const api: ReviewApi = { ...base, merge: () => new Promise((resolve) => { release = resolve; }) };
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    await settle();
    card.merge();
    offer(need("b", "the next request"));
    expect(card.need()?.id).toBe("a");
    release({ ok: true, value: merged });
    await settle();
    expect(card.need()?.id).toBe("b");
    expect(card.fold()).toBeNull();
    expect(calls.read).toBe(2);
    dispose();
  });

  test("an answer to the old request's read does not land on the new card", async () => {
    let first: (value: Result<Review>) => void = () => undefined;
    let n = 0;
    const api: ReviewApi = {
      read: () => (n++ === 0 ? new Promise((resolve) => { first = resolve; }) : Promise.resolve({ ok: true, value: review({ commits: 7 }) })),
      merge: async () => ({ ok: true, value: merged }),
      discard: async () => ({ ok: true, value: { discarded: true, stopped: [] } }),
    };
    const { control: card, offer, dispose } = control(api);
    offer(need("a"));
    offer(need("b"));
    await settle();
    first({ ok: true, value: review({ commits: 1 }) });
    await settle();
    expect(card.review()?.commits).toBe(7);
    dispose();
  });
});
