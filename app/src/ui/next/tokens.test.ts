import { describe, expect, test } from "bun:test";
import { matchMachines, matchModels, typedToken, withoutToken } from "./tokens";

const machines = ["mini", "vm-a", "desk"];

describe("a token is read where it is typed", () => {
  test("@ at a word's start is a repo, with what follows it as the query", () => {
    const text = "fix the invoice tests @le";
    expect(typedToken(text, text.length, machines)).toEqual({ kind: "repo", query: "le", start: 22, end: 25 });
  });

  test("@ alone opens every repo, and at the very start of the words too", () => {
    expect(typedToken("@", 1, machines)).toEqual({ kind: "repo", query: "", start: 0, end: 1 });
  });

  test("an @ inside a word (an email, a handle in a sentence) is words", () => {
    const text = "mail dev@ex";
    expect(typedToken(text, text.length, machines)).toBeNull();
  });

  test("a typed folder after @ is a repo query too, slashes and all", () => {
    const text = "start @~/code/leg";
    expect(typedToken(text, text.length, machines)?.query).toBe("~/code/leg");
  });

  test("/ at a word's start is a model; a second slash makes it a path in the prose", () => {
    const text = "port it /op";
    expect(typedToken(text, text.length, machines)).toEqual({ kind: "model", query: "op", start: 8, end: 11 });
    const path = "look in /srv/app";
    expect(typedToken(path, path.length, machines)).toBeNull();
  });

  test("on followed by the start of a machine's name is a machine", () => {
    const text = "run the migration on vm";
    expect(typedToken(text, text.length, machines)).toEqual({ kind: "machine", query: "vm", start: 18, end: 23 });
  });

  test("on in plain prose is words: no machine starts with what follows, or there is only one machine", () => {
    const text = "fix the bug on the login page";
    expect(typedToken(text, text.length, machines)).toBeNull();
    const one = "run it on mi";
    expect(typedToken(one, one.length, ["mini"])).toBeNull();
    expect(typedToken(one, one.length, machines)?.kind).toBe("machine");
  });

  test("on matches only the start of a machine's name, never letters inside it", () => {
    const names = ["mini", "vm-a", "desk"];
    for (const text of ["focus on a", "hello on in", "tidy it on k"]) expect(typedToken(text, text.length, names)).toBeNull();
    const start = "fix it on de";
    expect(typedToken(start, start.length, names)).toEqual({ kind: "machine", query: "de", start: 7, end: 12 });
  });

  test("on with nothing typed after it yet offers nothing: every sentence with on in it would open a menu", () => {
    const text = "run it on ";
    expect(typedToken(text, text.length, machines)).toBeNull();
  });

  test("a token is read only where the caret is: editing inside a word, or with the caret elsewhere, reads none", () => {
    const text = "@led more words";
    expect(typedToken(text, 2, machines)).toBeNull();
    expect(typedToken(text, 4, machines)).toEqual({ kind: "repo", query: "led", start: 0, end: 4 });
    expect(typedToken(text, text.length, machines)).toBeNull();
  });

  test("a finished token followed by a space is no longer being typed", () => {
    const text = "@ledger ";
    expect(typedToken(text, text.length, machines)).toBeNull();
  });
});

describe("a picked token leaves the words", () => {
  test("its letters go and the gap closes to one space", () => {
    const text = "fix the tests @le please";
    expect(withoutToken(text, { start: 14, end: 17 })).toEqual({ text: "fix the tests please", caret: 14 });
  });

  test("at the end of the words, the caret lands after the last word", () => {
    const text = "fix the tests @le";
    expect(withoutToken(text, { start: 14, end: 17 })).toEqual({ text: "fix the tests", caret: 13 });
  });

  test("at the start, nothing is left in front", () => {
    expect(withoutToken("@le fix it", { start: 0, end: 3 })).toEqual({ text: "fix it", caret: 0 });
  });

  test("a line break beside it is kept as it was typed", () => {
    expect(withoutToken("first line\n@le", { start: 11, end: 14 })).toEqual({ text: "first line\n", caret: 11 });
  });
});

describe("matching", () => {
  test("machines that start with the query come before ones that contain it", () => {
    expect(matchMachines(["desk-a", "a-desk", "mini"], "desk")).toEqual(["desk-a", "a-desk"]);
    expect(matchMachines(machines, "")).toEqual(machines);
  });

  test("models match the name a person says, and the id", () => {
    const models = [{ id: "anthropic/claude-opus-5-5" }, { id: "anthropic/claude-sonnet-5-5" }, { id: "openai/gpt-5.2-codex" }];
    // a name that starts with the word first, then a provider that does: "op" is opus, then openai's, never "anthropic"
    expect(matchModels(models, "op").map((m) => m.id)).toEqual(["anthropic/claude-opus-5-5", "openai/gpt-5.2-codex"]);
    expect(matchModels(models, "5.5").map((m) => m.id)).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"]);
    expect(matchModels(models, "openai").map((m) => m.id)).toEqual(["openai/gpt-5.2-codex"]);
    expect(matchModels(models, "")).toHaveLength(3);
  });
});
