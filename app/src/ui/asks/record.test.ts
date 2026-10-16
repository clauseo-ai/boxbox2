/* a settled question's record in words (docs/thread.md, every state: asks): the answer, typed words quoted, where and when, and
   the control that shows the options as they were offered */

import { describe, expect, test } from "bun:test";
import { type Asked, answerWords, deviceName, optionsControl, permitWords, questionLabel, recordFacts, spokenRecord, whoOf } from "./record";

const AT = Date.UTC(2026, 9, 14, 11, 48);
const local = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(AT);
const greeting: Asked = { header: "greeting", question: "which greeting?", options: [{ label: "hi" }, { label: "hello" }], answer: ["hi"] };

describe("the record's words", () => {
  test("an answer is its labels, typed words in quotes, nothing when there are none", () => {
    expect(answerWords(greeting)).toBe("hi");
    expect(answerWords({ ...greeting, answer: ["hello", "good morning"] })).toBe("hello, \u201cgood morning\u201d");
    expect(answerWords({ ...greeting, answer: [] })).toBe("nothing");
  });

  test("where and when: this device by its kind, the device the daemon named, or only the time", () => {
    expect(recordFacts({ here: true }, AT, "iphone")).toBe(`on this iphone at ${local}`);
    expect(recordFacts({ here: true }, AT, "mac")).toBe(`on this mac at ${local}`);
    expect(recordFacts({ by: "ipad" }, AT, "iphone")).toBe(`on ipad at ${local}`);
    expect(recordFacts({ by: null }, null, "iphone")).toBe("on another device");
    expect(recordFacts(undefined, AT, "iphone")).toBe(`at ${local}`);
    expect(recordFacts(undefined, undefined, "iphone")).toBe("");
    expect(deviceName("desktop")).toBe("this computer");
  });

  test("the options control counts what was offered", () => {
    expect(optionsControl(3, false)).toBe("show the 3 options");
    expect(optionsControl(1, false)).toBe("show the option");
    expect(optionsControl(3, true)).toBe("hide the options");
  });

  test("a question of several is called by its label, else its words cut short", () => {
    expect(questionLabel(greeting)).toBe("greeting");
    expect(questionLabel({ ...greeting, header: " ", question: "which of the three release branches should the hotfix land on first?" })).toBe("which of the three release branches should the...");
  });

  test("spoken whole: how it ended, the answers, where and when", () => {
    expect(spokenRecord("answered", [greeting], `on this iphone at ${local}`)).toBe(`you answered hi, on this iphone at ${local}`);
    expect(spokenRecord("answered", [greeting, { header: "", question: "when?", options: [], answer: ["now"] }], "")).toBe("you answered greeting: hi; when?: \u201cnow\u201d");
    expect(spokenRecord("dismissed", [greeting], "")).toBe("you dismissed it");
    expect(spokenRecord("ended", [greeting], `at ${local}`)).toBe(`not answered: its turn ended, at ${local}`);
  });
});

describe("a permission's record", () => {
  const here = { here: true } as const;
  test("this device's reply in the record's words, the reason quoted", () => {
    expect(permitWords({ who: here, reply: { k: "permit", reply: "once" } })).toBe("you allowed it once");
    expect(permitWords({ who: here, reply: { k: "permit", reply: "always" } })).toBe("you always allowed it");
    expect(permitWords({ who: here, reply: { k: "permit", reply: "reject", message: "  not now " } })).toBe("you denied it: \u201cnot now\u201d");
    expect(permitWords({ who: here, reply: { k: "permit", reply: "reject", message: "   " } })).toBe("you denied it");
    expect(permitWords({ who: here, reply: { k: "permit", reply: "reject" } })).toBe("you denied it");
  });

  test("another device's answer is only that it was answered, with where it was given", () => {
    const elsewhere = { who: { by: "ipad" }, reply: { k: "permit", reply: "once" } } as const;
    expect(permitWords(elsewhere)).toBe("answered");
    expect(recordFacts(whoOf(elsewhere), AT, "iphone")).toBe(`on ipad at ${local}`);
    expect(recordFacts(whoOf({ who: here }), AT, "ipad")).toBe(`on this ipad at ${local}`);
  });
});
