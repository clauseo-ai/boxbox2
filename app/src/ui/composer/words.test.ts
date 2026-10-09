import { describe, expect, test } from "bun:test";
import { type Agent, type Card, cardVerbs, cardWords, compactionWords, compactMeta, contextFill, DRAFTS_FULL, fateLine, matchModels, liveLine, menuOf, menuQuery, modelsNote, placeholder, proseOf, refusedStart, effortChoices, sendWord, tailPrint, tokensWords, typedAnswers, waitedWords, withFile } from "./words";

describe("send says what it will do", () => {
  test("an idle thread sends, a working one queues, a held send steers, a question is answered", () => {
    expect(sendWord("bar", "idle", false, false)).toBe("send");
    expect(sendWord("bar", "working", false, false)).toBe("queue");
    expect(sendWord("bar", "working", true, false)).toBe("steer");
    expect(sendWord("bar", "wants", false, false)).toBe("answer");
    expect(sendWord("bar", "offline", false, false)).toBe("queue");
    expect(sendWord("bar", "working", false, true)).toBe("run");
    expect(sendWord("sheet", "idle", false, false)).toBe("start");
  });

  test("the line above the words says the queue's logic before you press", () => {
    expect(fateLine("bar", "working", false, false, 0, "desk", "cmx")).toBe("after this turn, or hold to steer");
    expect(fateLine("bar", "working", false, false, 2, "desk", "cmx")).toBe("after this turn and the 2 waiting");
    expect(fateLine("bar", "working", true, false, 0, "desk", "cmx")).toBe("lands in the running turn, after this step");
    expect(fateLine("sheet", "idle", false, false, 0, "desk", "boxbox")).toBe("the new thread starts on");
  });

  test("an ask of several questions says the words answer them all", () => {
    expect(fateLine("bar", "wants", false, false, 0, "desk", "cmx")).toBe("answers the question above");
    expect(fateLine("bar", "wants", false, false, 0, "desk", "cmx", 1)).toBe("answers the question above");
    expect(fateLine("bar", "wants", false, false, 0, "desk", "cmx", 2)).toBe("answers the questions above");
  });

  test("typed words answer every question, one list each, as the daemon takes them", () => {
    expect(typedAnswers(1, "hello")).toEqual([["hello"]]);
    expect(typedAnswers(3, "skip both")).toEqual([["skip both"], ["skip both"], ["skip both"]]);
    // an ask the app could not read still gets an answer: one list, as before
    expect(typedAnswers(0, "hi")).toEqual([["hi"]]);
  });

  test("the placeholder fits the moment", () => {
    expect(placeholder("bar", "working", "cmx", false)).toBe("queue a message");
    expect(placeholder("bar", "wants", "cmx", false)).toBe("or answer in your own words");
    expect(placeholder("sheet", "idle", "cmx", false)).toBe("what should it do?");
  });
});

describe("a queued card is legible", () => {
  /* a queued message with no stated reason reads as a bug. every card says why it waits and what sends it, in words */
  const cards: Array<[Card, Agent]> = [
    [{ state: "queued", place: 0 }, "working"],
    [{ state: "queued", place: 1 }, "working"],
    [{ state: "queued", place: 3 }, "working"],
    [{ state: "queued", place: 0 }, "idle"],
    [{ state: "steer", place: 0 }, "working"],
    [{ state: "sending", place: 0 }, "working"],
    [{ state: "waiting", place: 0 }, "offline"],
    [{ state: "failed", place: 0, error: "the desk host did not answer" }, "idle"],
  ];
  const why = /waiting|reads it|on its way|connection is down|did not|not answer|it did not go/;
  const sends = /goes on its own|run now|steer it in|next step|settles|in order|retry/;

  for (const [card, agent] of cards) {
    test(`${card.state} at ${card.place} while ${agent} says why it waits and what sends it`, () => {
      const words = cardWords(card, agent);
      expect(words.label.length).toBeGreaterThan(0);
      expect(words.why).toMatch(why);
      expect(words.why).toMatch(sends);
      expect(words.why).not.toMatch(/[–—]/);
      expect(words.why).toBe(words.why.toLowerCase());
    });
  }

  test("the first waits for the turn, the rest wait behind it", () => {
    expect(cardWords({ state: "queued", place: 0 }, "working").why).toBe("waiting for this turn to end. it goes on its own then, or steer it in now");
    expect(cardWords({ state: "queued", place: 1 }, "working").why).toBe("waiting behind the one above. it goes on its own, in order");
  });
});

describe("what a card offers", () => {
  const none = { retry: false, edit: false, steerNow: false, runNow: false, unsend: false, apart: false };

  test("the first waiting message while the agent works can be steered in, or the turn stopped for it, and unsent", () => {
    expect(cardVerbs({ state: "queued", place: 0 }, "working")).toEqual({ ...none, steerNow: true, runNow: true, unsend: true, apart: true });
  });

  test("the ones behind it are only unsent", () => {
    expect(cardVerbs({ state: "queued", place: 1 }, "working")).toEqual({ ...none, unsend: true });
  });

  test("a steer can be run now while the turn runs: it may wait for good behind a long command, and its verbs take their own row", () => {
    expect(cardVerbs({ state: "steer", place: 0 }, "working")).toEqual({ ...none, runNow: true, unsend: true, apart: true });
  });

  test("with no turn running there is nothing to stop: a steer can only be unsent, a queued message only unsent", () => {
    for (const agent of ["idle", "wants", "offline"] as const) {
      expect(cardVerbs({ state: "steer", place: 0 }, agent)).toEqual({ ...none, unsend: true });
      expect(cardVerbs({ state: "queued", place: 0 }, agent)).toEqual({ ...none, unsend: true });
    }
  });

  test("a message with photos is never sent again from its card, since the card holds their count and not their bytes", () => {
    expect(cardVerbs({ state: "steer", place: 0, photos: 2 }, "working")).toEqual({ ...none, unsend: true });
    expect(cardVerbs({ state: "queued", place: 0, photos: 1 }, "working")).toEqual({ ...none, runNow: true, unsend: true, apart: true });
  });

  test("a device with no room for drafts says what that costs and what to do, in the voice", () => {
    expect(DRAFTS_FULL).toBe("this device has no room left to keep drafts, so what you write here stays only while this page is open. free some space and it saves again");
    expect(DRAFTS_FULL).not.toMatch(/[A-Z]|—|–/);
  });

  test("a message whose photos went back to the draft is taken back to it and never retried, which would send its words alone", () => {
    const lost = { state: "failed" as const, place: 0, error: "too many photos are waiting to go, so this message did not go. its photos are back in the draft. edit it back there too, and send it when the others have gone", photosReturned: 2 };
    expect(cardVerbs(lost, "idle")).toEqual({ ...none, edit: true });
    expect(cardWords(lost, "idle").why).toBe(lost.error);
    expect(refusedStart(lost.error, 2)).toBe(`the thread did not start: ${lost.error}.`);
  });

  test("one that did not go is retried or taken back to the draft, and one on its way offers nothing", () => {
    expect(cardVerbs({ state: "failed", place: 0, error: "no" }, "idle")).toEqual({ ...none, retry: true, edit: true });
    expect(cardVerbs({ state: "sending", place: 0 }, "working")).toEqual(none);
    expect(cardVerbs({ state: "waiting", place: 0 }, "offline")).toEqual(none);
  });

  test("a steer's card names run now only when it offers it", () => {
    expect(cardWords({ state: "steer", place: 0 }, "working").why).toBe("the agent reads it at its next step, without stopping. run\u00a0now stops the turn and runs it.");
    expect(cardWords({ state: "steer", place: 0, photos: 1 }, "working").why).toBe("the agent reads it at its next step, without stopping");
    expect(cardWords({ state: "steer", place: 0 }, "idle").why).toBe("the agent reads it at its next step, without stopping");
  });
});

describe("menus", () => {
  test("a slash first is a command, an at after a space is a file, a bang first is the shell", () => {
    expect(menuOf("/rev")).toBe("/");
    expect(menuOf("/review now")).toBeNull();
    expect(menuOf("look at @comp")).toBe("@");
    expect(menuOf("mail@example")).toBeNull();
    expect(menuOf("!git log")).toBe("!");
    expect(menuOf("plain words")).toBeNull();
    expect(menuQuery("look at @Comp", "@")).toBe("comp");
    expect(withFile("look at @comp", "src/compaction.ts")).toBe("look at @src/compaction.ts ");
  });
});

describe("the live line", () => {
  test("reads the newest tail item in the ledger's grammar", () => {
    expect(liveLine([{ kind: "tool", tool: "read", text: "compaction.rs", messageID: "m", partID: "p", role: "assistant" }])).toEqual({ kind: "read", text: "compaction.rs", prose: false, key: "m/p" });
    expect(liveLine([{ kind: "reasoning", text: "looking at the files", messageID: "m", partID: "p", role: "assistant" }])?.prose).toBe(true);
    expect(liveLine([])).toBeNull();
  });

  test("reads only the running turn: never the person's own prompt, the turn before it, or a part with no words yet", () => {
    const say = { kind: "text", text: "found it", messageID: "m", partID: "a", role: "assistant" } as const;
    const prompt = { kind: "text", text: "go and look", messageID: "u", partID: "p", role: "user" } as const;
    expect(liveLine([say, prompt]), "a turn that has said nothing yet shows no line, not the last turn's answer").toBeNull();
    expect(liveLine([say, prompt, { kind: "reasoning", text: "looking at the notes", messageID: "n", partID: "r", role: "assistant" }])?.key).toBe("n/r");
    expect(liveLine([say, prompt, { kind: "reasoning", text: "", messageID: "n", partID: "r", role: "assistant" }])).toBeNull();
    expect(liveLine([say, { kind: "text", text: "", messageID: "m", partID: "b", role: "assistant" }])?.key).toBe("m/a");
    expect(liveLine([{ kind: "text", text: "go", messageID: "u", partID: "p", role: "user" }])).toBeNull();
  });

  test("a row growing is the same line: its key is the part, not its words", () => {
    const at = (text: string) => liveLine([{ kind: "text", text, messageID: "m", partID: "p", role: "assistant" }]);
    expect(at("the notes now")?.key).toBe(at("the notes now greet in the voice")?.key);
    expect(liveLine([{ kind: "text", text: "a", messageID: "m", partID: "q", role: "assistant" }])?.key).not.toBe(at("a")?.key);
  });

  test("prose is the last two sentences, whole, and never begins inside a word", () => {
    expect(proseOf("first one. second one. the third is on its way")).toBe("second one. the third is on its way");
    expect(proseOf("  a short\n\nthought  ")).toBe("a short thought");
    const cut = "othing else changed " + "x".repeat(10) + " and then the change is small on purpose ".repeat(7);
    expect(cut.length).toBeGreaterThanOrEqual(280);
    expect(proseOf(cut).startsWith("othing")).toBe(false);
    expect(proseOf(cut).startsWith("else changed")).toBe(true);
    // a long part whose last sentences are inside what the server kept starts at a sentence
    const sentences = "the first is here. ".repeat(20) + "the newest begins and goes on";
    expect(proseOf(sentences)).toBe("the first is here. the newest begins and goes on");
  });

  test("a tail's print moves when a part is added or says more, and holds when nothing did", () => {
    const answer = { kind: "text" as const, text: "all done", messageID: "m", partID: "a", role: "assistant" as const };
    const same = tailPrint([answer]);
    expect(tailPrint([{ ...answer }])).toBe(same);
    expect(tailPrint([answer, { kind: "text", text: "go", messageID: "u", partID: "p", role: "user" }]), "the new prompt is a part").not.toBe(same);
    expect(tailPrint([{ ...answer, text: "all done, and" }]), "a part saying more").not.toBe(same);
    expect(tailPrint([])).toBe("");
  });

  test("names another agent's report, and stops at the person's own prompt", () => {
    const step = { kind: "tool" as const, tool: "shell", text: "bun test", messageID: "m", partID: "p1", role: "assistant" as const };
    const report = { kind: "text" as const, text: "all green", messageID: "m3", partID: "p3", role: "user" as const, from: "helper" };
    expect(liveLine([step, report])).toEqual({ kind: "agent", text: "helper reported", prose: false, key: "m3/p3" });
    expect(liveLine([step, report, { kind: "tool", tool: "read", text: "notes.md", messageID: "m5", partID: "p5", role: "assistant" }])?.key, "the agent's answer to the report is the line once it has words").toBe("m5/p5");
    expect(liveLine([step, { kind: "text", text: "and then fix the flake", messageID: "m2", partID: "p2", role: "user" }])).toBeNull();
    expect(liveLine([{ kind: "text", text: "a prompt alone", messageID: "m4", partID: "p4", role: "user" }])).toBeNull();
  });
});

describe("a first message that did not start", () => {
  test("the host's words that already say it stay as they are", () => {
    expect(refusedStart("nothing at /srv/nope on desk, so the thread did not start. pick another folder, or make it and retry.")).toBe("nothing at /srv/nope on desk, so the thread did not start. pick another folder, or make it and retry.");
  });
  test("any other reason is said after the thread did not start, and ends on the retry rule once", () => {
    expect(refusedStart("the daemon did not confirm it. retry sends it once, never twice")).toBe("the thread did not start: the daemon did not confirm it. retry sends it once, never twice.");
    expect(refusedStart("the host \"desk\" refused it: no model")).toBe("the thread did not start: the host \"desk\" refused it: no model. retry sends it once, never twice.");
    expect(refusedStart(null)).toBe("the thread did not start: the machine refused it. retry sends it once, never twice.");
  });
});

describe("a model the host's list has not named yet", () => {
  test("the menu says which of the two it is waiting on", () => {
    expect(modelsNote("loading")).toBe("reading the models.");
    expect(modelsNote("failed")).toBe("the models did not come.");
  });
});

describe("the effort chip without the model list", () => {
  test("with the list it is the model's own efforts, and a model that takes none has no chip", () => {
    expect(effortChoices({ accepted: ["low", "high"], current: "high", list: "ready" })).toEqual({ show: true, label: "high", known: ["low", "high"], note: null });
    expect(effortChoices({ accepted: [], current: null, list: "ready" }).show).toBe(false);
  });
  test("a list that did not come keeps the thread's own effort reachable, and says why the rest is missing", () => {
    expect(effortChoices({ accepted: [], current: "max", list: "failed" })).toEqual({ show: true, label: "max", known: ["max"], note: "the effort choices did not come." });
    expect(effortChoices({ accepted: [], current: "max", list: "loading" }).note).toBe("reading the effort choices.");
  });
  test("with nothing known the chip stays and says why, never hides", () => {
    expect(effortChoices({ accepted: [], current: null, list: "failed" })).toEqual({ show: true, label: "effort", known: [], note: "the effort choices did not come." });
  });
});
describe("the model menu filters as you type", () => {
  const models = [
    { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "Anthropic" },
    { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "Anthropic" },
    { id: "openai/gpt-6", name: "GPT-6", provider: "OpenAI" },
    { id: "openai/gpt-6-mini", name: "GPT-6 mini", provider: "OpenAI" },
  ];
  test("nothing typed keeps the host's order", () => {
    expect(matchModels(models, " ").map((m) => m.id)).toEqual(models.map((m) => m.id));
  });
  test("every word must match the name, provider or id; a name that starts with it leads", () => {
    expect(matchModels(models, "son").map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(matchModels(models, "openai mini").map((m) => m.id)).toEqual(["openai/gpt-6-mini"]);
    expect(matchModels(models, "gpt").map((m) => m.id)).toEqual(["openai/gpt-6", "openai/gpt-6-mini"]);
    expect(matchModels(models, "opus").map((m) => m.id)).toEqual(["anthropic/claude-opus-5-5"]);
    expect(matchModels(models, "zzz")).toEqual([]);
  });
});

describe("how full the context is", () => {
  test("tokens in few characters", () => {
    expect([842, 1200, 9_950, 38_400, 170_000, 1_250_000].map(tokensWords)).toEqual(["842", "1.2k", "10k", "38k", "170k", "1.3m"]);
  });

  test("the share of the window in use, where it compacts by itself, and the numbers in words", () => {
    expect(contextFill({ used: 128_000, limit: 200_000, compactAt: 170_000 })).toEqual({ percent: 64, mark: 0.85, words: "128k of 200k tokens, it compacts by itself at 170k" });
  });

  test("a thread that reports no window, or a window of nothing, has no fill to draw", () => {
    expect(contextFill(undefined)).toBeNull();
    expect(contextFill({ used: 10, limit: 0 })).toBeNull();
  });

  test("a context past its window reads as full, and with no compaction point there is no tick", () => {
    expect(contextFill({ used: 250_000, limit: 200_000 })).toEqual({ percent: 100, mark: null, words: "250k of 200k tokens" });
  });
});

describe("the compact row says what is true now", () => {
  const fill = contextFill({ used: 128_000, limit: 200_000 });
  test("an idle thread shows how full it is, or what compacting does when that is not known", () => {
    expect(compactMeta("idle", false, fill)).toBe("64% full");
    expect(compactMeta("idle", false, null)).toBe("frees the context");
  });
  test("a running turn cannot be compacted (the daemon refuses it), so the row says when it can", () => {
    expect(compactMeta("working", false, fill)).toBe("after this turn");
    expect(compactMeta("wants", false, fill)).toBe("after this turn");
    expect(compactMeta("offline", false, fill)).toBe("when you are back");
  });
  test("a compaction in flight says so before anything else", () => {
    expect(compactMeta("idle", true, fill)).toBe("running");
  });
});

describe("the compaction card", () => {
  test("a wait is a clock in seconds, then minutes", () => {
    expect([0, 8_400, 59_999, 65_000, 125_000].map(waitedWords)).toEqual(["0s", "8s", "59s", "1m 05s", "2m 05s"]);
  });

  test("running says what it is doing, why it takes a while, and keeps the clock apart from the words", () => {
    const said = compactionWords({ state: "running", since: 1000 }, 15_000);
    expect(said).toEqual({ label: "compacting", text: "summarising the thread so far to free the context", why: "this can take a minute.", clock: "14s" });
  });

  test("a refusal says what the host said and that the thread is unchanged, and has no clock", () => {
    const said = compactionWords({ state: "failed", message: "a turn is running. stop it or wait for it, then compact" }, 0);
    expect(said.label).toBe("not compacted");
    expect(said.text).toBe("a turn is running. stop it or wait for it, then compact");
    expect(said.why).toBe("the thread is as it was. retry compacts it again.");
    expect(said.clock).toBeNull();
  });

  test("a refusal that already says the thread is unchanged does not say it twice", () => {
    expect(compactionWords({ state: "failed", message: "the summary came back empty. the thread is unchanged." }, 0).why).toBe("retry compacts it again.");
  });

  test("done is a receipt", () => {
    expect(compactionWords({ state: "done", at: 0 }, 0)).toEqual({ label: "compacted", text: "the summary is in the thread", why: "the context has room again.", clock: null });
  });
});
