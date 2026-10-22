import { describe, expect, test } from "bun:test";
import { BTW_FATE, BTW_NO_PHOTOS, BTW_PLACEHOLDER, BTW_SEND, BTW_UNAVAILABLE, askedDraftGoes, backspaceLeaves, btwOffered, btwQuestion, btwSendBlock, typedIntoBtw } from "./mode";

describe("where the btw mode is offered", () => {
  test("on a thread whose agent answers btws, in the bar", () => {
    expect(btwOffered({ capable: true, target: "session", mount: "bar" })).toBe(true);
  });
  test("never on an agent without the capability", () => {
    expect(btwOffered({ capable: false, target: "session", mount: "bar" })).toBe(false);
  });
  test("never on a thread with no turn yet: nothing to ask about, no turn for the card", () => {
    expect(btwOffered({ capable: true, target: "session", mount: "bar", turns: 0 })).toBe(false);
    expect(btwOffered({ capable: true, target: "session", mount: "bar", turns: 1 })).toBe(true);
  });
  test("never for a new thread, nor in the sheet", () => {
    expect(btwOffered({ capable: true, target: "new", mount: "bar" })).toBe(false);
    expect(btwOffered({ capable: true, target: "session", mount: "sheet" })).toBe(false);
  });
});

describe("typing into the mode", () => {
  test("/btw and a space at the start enters it, and the prefix is eaten", () => {
    expect(typedIntoBtw("/btw ")).toBe("");
    expect(typedIntoBtw("/btw why is the deploy slow")).toBe("why is the deploy slow");
  });
  test("a tab ends the command as a space does; a new line after it is kept as the person's", () => {
    expect(typedIntoBtw("/btw\twhat")).toBe("what");
    expect(typedIntoBtw("/btw\nwhat")).toBe("\nwhat");
  });
  test("only one space is the command's: the rest is the question's", () => {
    expect(typedIntoBtw("/btw  two")).toBe(" two");
  });
  test("/btw still being typed, another command, a /btw later in the words, or a capital do not enter it", () => {
    expect(typedIntoBtw("/btw")).toBeNull();
    expect(typedIntoBtw("/bt")).toBeNull();
    expect(typedIntoBtw("/btwx ")).toBeNull();
    expect(typedIntoBtw("/compact ")).toBeNull();
    expect(typedIntoBtw("so /btw what")).toBeNull();
    expect(typedIntoBtw(" /btw what")).toBeNull();
    expect(typedIntoBtw("/BTW what")).toBeNull();
  });
});

describe("leaving the mode", () => {
  test("backspace with the caret before the first word and nothing selected leaves it", () => {
    expect(backspaceLeaves("Backspace", 0, 0)).toBe(true);
  });
  test("backspace inside the words, or over a selection from the start, deletes words and stays", () => {
    expect(backspaceLeaves("Backspace", 3, 3)).toBe(false);
    expect(backspaceLeaves("Backspace", 0, 4)).toBe(false);
  });
  test("other keys at the start do not leave it, nor does an unknown caret", () => {
    expect(backspaceLeaves("Delete", 0, 0)).toBe(false);
    expect(backspaceLeaves("ArrowLeft", 0, 0)).toBe(false);
    expect(backspaceLeaves("Backspace", null, null)).toBe(false);
  });
});

describe("what a btw sends", () => {
  test("the words trimmed, or nothing when there are none", () => {
    expect(btwQuestion("  why?  ")).toBe("why?");
    expect(btwQuestion(" \n ")).toBeNull();
  });
});

describe("what the composer says in the mode", () => {
  test("the placeholder, send's word and the line, in the voice of the rest", () => {
    expect(BTW_PLACEHOLDER).toBe("ask on the side. the agent won't see this");
    expect(BTW_SEND).toBe("ask");
    for (const s of [BTW_PLACEHOLDER, BTW_FATE]) {
      expect(s).toBe(s.toLowerCase());
      expect(s).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("what holds a btw draft's send", () => {
  test("a btw draft where btw is not offered (the read not landed, no turn, an agent without it) is held with the reason, never sent as a message", () => {
    expect(btwSendBlock({ offered: false, photos: 0, held: false })).toBe(BTW_UNAVAILABLE);
  });
  test("photos in the draft, read or still on the device, say a btw takes words only, not that the photos are unread", () => {
    expect(btwSendBlock({ offered: true, photos: 1, held: false })).toBe(BTW_NO_PHOTOS);
    expect(btwSendBlock({ offered: true, photos: 0, held: true })).toBe(BTW_NO_PHOTOS);
  });
  test("words alone where btw is offered go", () => {
    expect(btwSendBlock({ offered: true, photos: 0, held: false })).toBeNull();
  });
});

describe("the draft after an ask lands", () => {
  test("goes when it still holds the question asked, whichever thread is open", () => {
    expect(askedDraftGoes("  why is it slow? ", "why is it slow?")).toBe(true);
  });
  test("stays when words were typed into it while the ask was on its way", () => {
    expect(askedDraftGoes("why is it slow? and the logs", "why is it slow?")).toBe(false);
    expect(askedDraftGoes("", "why is it slow?")).toBe(false);
  });
});
