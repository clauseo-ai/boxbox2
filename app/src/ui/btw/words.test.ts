import { describe, expect, test } from "bun:test";
import type { Btw } from "./types";
import { BTW_CAPTION, btwView, errorWords, fromBtwName, promotedParts, shownPrompt } from "./words";
import { replyLabel } from "../thread/copy-names";

const btw = (over: Partial<Btw> = {}): Btw => ({ id: "b1", question: "why is the deploy slow?\nit used to be quick", answer: "", status: "running", created: 1, ...over });
const NAME = "why is the deploy slow? it used to be quick";

const card = (b: Btw, expanded = false) => {
  const v = btwView(b, expanded, NAME);
  if (v.kind !== "card") throw new Error(`expected a card, got ${v.kind}`);
  return v;
};
const words = (b: Btw, expanded = false) => card(b, expanded).verbs.map((v) => v.word);

describe("a btw card in each state", () => {
  test("running: the answer streams (the caret stands for it), dismiss is the only verb", () => {
    const v = card(btw());
    expect(v.state).toBe("running");
    expect(v.answer).toBe(true);
    expect(v.note).toBeNull();
    expect(words(btw())).toEqual(["dismiss"]);
  });

  test("done: add to thread and dismiss", () => {
    const b = btw({ status: "done", answer: "the health check waits 30 s per machine." });
    expect(card(b).note).toBeNull();
    expect(words(b)).toEqual(["add to thread", "dismiss"]);
  });

  test("done with nothing said says so", () => {
    expect(card(btw({ status: "done", answer: "  " })).note).toBe("the answer came back empty.");
  });

  test("added: the verb becomes the way to the message", () => {
    const b = btw({ status: "done", answer: "x", promotedMessageID: "m9" });
    expect(words(b)).toEqual(["added to thread", "dismiss"]);
    expect(card(b).verbs[0]?.verb).toBe("added");
  });

  test("error: what happened and what to do, retry and dismiss, no answer drawn when none came", () => {
    const v = card(btw({ status: "error", error: "the model is overloaded." }));
    expect(v.note).toBe("no answer: the model is overloaded. retry asks it again.");
    expect(v.answer).toBe(false);
    expect(v.verbs.map((x) => x.word)).toEqual(["retry", "dismiss"]);
  });

  test("an error with no words of its own still says what to do", () => {
    expect(errorWords(undefined)).toBe("no answer came. retry asks it again.");
    expect(errorWords("  ")).toBe("no answer came. retry asks it again.");
  });

  test("the region is named as a btw, with its question", () => {
    expect(card(btw()).region).toBe(`btw: ${NAME}`);
  });

  test("the caption says what a btw is not", () => {
    expect(BTW_CAPTION).toBe("not in the agent's context · no tools");
  });
});

describe("a dismissed btw", () => {
  test("is one line, btw and its question's first line, named to say a tap shows it", () => {
    const v = btwView(btw({ status: "done", answer: "x", dismissed: 5 }), false, NAME);
    expect(v).toEqual({ kind: "chip", word: "btw: why is the deploy slow?", name: `btw "${NAME}", dismissed. show it` });
  });

  test("expanded on this device it is the card again, hide in place of dismiss", () => {
    const b = btw({ status: "done", answer: "x", dismissed: 5 });
    expect(words(b, true)).toEqual(["add to thread", "hide"]);
  });

  test("one that never answered renders nothing, expanded or not", () => {
    expect(btwView(btw({ status: "error", dismissed: 5 }), false, NAME).kind).toBe("none");
    expect(btwView(btw({ status: "error", dismissed: 5 }), true, NAME).kind).toBe("none");
  });
});

describe("accessible names", () => {
  test("every verb names its btw, so two cards' verbs never share a name", () => {
    const a = btwView(btw({ status: "done", answer: "x" }), false, "why?");
    const b = btwView(btw({ status: "done", answer: "x" }), false, "why?, again");
    if (a.kind !== "card" || b.kind !== "card") throw new Error("cards");
    const names = [...a.verbs, ...b.verbs].map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of a.verbs) expect(v.name).toContain('"why?"');
  });

  test("every state's verbs are distinct within the card", () => {
    for (const b of [btw(), btw({ status: "done", answer: "x" }), btw({ status: "error" }), btw({ status: "done", answer: "x", promotedMessageID: "m" }), btw({ status: "done", answer: "x", dismissed: 1 })]) {
      const v = btwView(b, true, NAME);
      if (v.kind !== "card") continue;
      const names = v.verbs.map((x) => x.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("the marker on a promoted message says where it goes", () => {
    expect(fromBtwName("why?")).toBe('from a btw, with its answer: go to the btw "why?"');
    expect(fromBtwName(undefined)).toBe("from a btw, with its answer: go to the btw");
  });

  test("no copy carries an em or en dash", () => {
    const all = [btw(), btw({ status: "done", answer: "x" }), btw({ status: "error", error: "x" }), btw({ status: "done", answer: "x", promotedMessageID: "m" })].flatMap((b) => {
      const v = card(b);
      return [v.region, v.note ?? "", ...v.verbs.flatMap((x) => [x.word, x.name])];
    });
    for (const s of all) expect(s).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("a promoted message's words", () => {
  // cmx2's promotedText (packages/server/src/btw.ts at 3a9b3e3), byte for byte
  const framed = (q: string, a: string) => `btw, i asked this on the side while you worked, and it was answered from this conversation.\n\nmy question:\n${q}\n\nthe answer:\n${a}`;

  test("the question and the answer are read out of cmx2's framing", () => {
    expect(promotedParts(framed("why is it slow?", "the health check waits **30 s**.\n\n- per machine"))).toEqual({ question: "why is it slow?", answer: "the health check waits **30 s**.\n\n- per machine" });
  });

  test("a question of several lines keeps them", () => {
    expect(promotedParts(framed("why?\nit used to be quick", "x"))?.question).toBe("why?\nit used to be quick");
  });

  test("words not in the framing are not read", () => {
    expect(promotedParts("why is it slow?")).toBeNull();
    expect(promotedParts("my question:\nwhy\n\nthe answer:\nx")).toBeNull();
  });
});

describe("a promoted turn's prompt where it is shown or named", () => {
  const prompt = "btw, i asked this on the side while you worked, and it was answered from this conversation.\n\nmy question:\nwhy is it slow?\n\nthe answer:\nthe health check waits **30 s**.";
  test("reads as its question, never cmx2's framing", () => {
    expect(shownPrompt({ prompt, btw: "b1" })).toBe("why is it slow?");
  });
  test("a turn not from a btw, or framing words typed by hand, read whole", () => {
    expect(shownPrompt({ prompt })).toBe(prompt);
    expect(shownPrompt({ prompt: "plain words", btw: "b1" })).toBe("plain words");
  });
  test("the reply's copy name is built from the question", () => {
    const name = replyLabel("11:04", shownPrompt({ prompt, btw: "b1" }));
    expect(name).toContain("why is it slow?");
    expect(name).not.toContain("i asked this on the side");
  });
});
