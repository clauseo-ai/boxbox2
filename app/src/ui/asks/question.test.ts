/* a question's own words in its card (docs/thread.md, every state: asks): painted as markdown through the thread's sanitiser, named
   and teased as plain words, copied as the agent wrote them, and drawn whole however the ask settled. the painting itself is the
   thread's (markdown.ts) and is checked in the browser (the question-markdown stories); what is pure is checked here */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFrom, forget } from "../thread/copy";
import { questionCopyLabel } from "../thread/copy-names";
import { ALLOWED_URI, toHtml } from "../thread/markdown-gfm";
import { type Asked, NOT_ANSWERED, YOU_DISMISSED, recordShape, spokenRecord } from "./record";
import { copyOfQuestion, plainWords, shortWords } from "./words";

const MD = "Visit [the login page](https://login.example.com/a/1) and run `ssh deploy@build-1`, **not before**. ([this](javascript:alert(1)) is not a link.)";

describe("a question's markdown", () => {
  test("it is read as the thread reads markdown: a link to the web is a link", () => {
    expect(toHtml(MD)).toContain('<a href="https://login.example.com/a/1">the login page</a>');
    expect(toHtml(MD)).toContain("<code>ssh deploy@build-1</code>");
  });

  test("the sanitiser's list lets a link go only to the web or to mail: a javascript: link is not a link", () => {
    expect(ALLOWED_URI.test("https://login.example.com")).toBe(true);
    expect(ALLOWED_URI.test("mailto:ops@example.com")).toBe(true);
    expect(ALLOWED_URI.test("javascript:alert(1)")).toBe(false);
    expect(ALLOWED_URI.test("JavaScript:alert(1)")).toBe(false);
    expect(ALLOWED_URI.test("data:text/html,x")).toBe(false);
  });
});

describe("a question as plain words, for names and the closed row's head", () => {
  test("links are their words, code and emphasis lose their marks, lines run together", () => {
    expect(plainWords(MD)).toBe("Visit the login page and run ssh deploy@build-1, not before. (this is not a link.)");
    expect(plainWords("# heading\n\n- one *two*\n- <b>three</b> <https://x.example>\n\n> quoted ~~gone~~ \\*star\\*")).toBe("heading one two three https://x.example quoted gone *star*");
  });

  test("words with no marks are left as they are, snake_case and file.names included", () => {
    expect(plainWords("which greeting should the notes use?")).toBe("which greeting should the notes use?");
    expect(plainWords("rename user_id in a_b.ts? 2 * 3 is 6")).toBe("rename user_id in a_b.ts? 2 * 3 is 6");
  });

  test("the card's names quote the plain words, cut short", () => {
    expect(`question: ${shortWords(plainWords(MD), 60)}`).toBe("question: Visit the login page and run ssh deploy@build-1, not...");
    expect(questionCopyLabel(plainWords(MD))).toBe("copy the question, Visit the login page and run ssh...");
    expect(questionCopyLabel("which greeting?")).toBe("copy the question, which greeting?");
    expect(questionCopyLabel("")).toBe("copy the question");
  });
});

describe("the copy control copies the question as written", () => {
  const globals = globalThis as unknown as { navigator: { clipboard?: unknown }; requestAnimationFrame: (f: () => void) => number };
  const had = { clipboard: globals.navigator.clipboard, raf: globals.requestAnimationFrame };
  afterEach(() => { globals.navigator.clipboard = had.clipboard; globals.requestAnimationFrame = had.raf; });

  test("the raw markdown reaches the clipboard in the tap's own call, marks and links and all", async () => {
    const written: string[] = [];
    globals.navigator.clipboard = { writeText: async (t: string) => { written.push(t); } };
    globals.requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
    const word = { textContent: "copy" };
    const button = { dataset: {} as Record<string, string>, querySelector: (s: string) => (s === ".copy-w" ? word : null), getAttribute: () => "copy the question", closest: () => null, ownerDocument: { body: { querySelector: () => null, append: () => {} }, createElement: () => ({ setAttribute: () => {} }) } } as unknown as HTMLElement;
    copyFrom(button, copyOfQuestion({ question: MD }));
    expect(written).toEqual([MD]);
    await Bun.sleep(5);
    forget(button);
  });
});

describe("a settled ask always draws its questions whole", () => {
  const one: Asked = { header: "greeting", question: "which **greeting** should the notes use?", options: [{ label: "hi" }, { label: "hello" }], answer: ["hi"] };
  const four: Asked[] = [
    { header: "Newer-version entries", question: "decode what it can, or drop the entry?", options: [{ label: "Version-first decode (recommended)" }, { label: "Drop" }], answer: ["Version-first decode (recommended)"] },
    { header: "Unit variant growth rule", question: "keep `Other(String)` or add variants?", options: [{ label: "Drop it, add variants (recommended)" }], answer: ["Drop it, add variants (recommended)"] },
    { header: "Command validation", question: "validate once into a type, or at each use?", options: [{ label: "ValidatedCommand type (recommended)" }], answer: ["ValidatedCommand type (recommended)"] },
    { header: "Scope of the change request", question: "which go into this change?", options: [{ label: "All of them (recommended)" }], answer: ["typed words"] },
  ];

  test("answered: the question's words, then its answer under them", () => {
    expect(recordShape("answered", [one])).toEqual({ blocks: [{ header: "greeting", question: one.question, answer: "hi" }], lead: null });
  });

  test("dismissed and turn-ended: the question's words, then one line that says so", () => {
    expect(recordShape("dismissed", [one])).toEqual({ blocks: [{ header: "greeting", question: one.question, answer: null }], lead: YOU_DISMISSED });
    expect(recordShape("ended", [one])).toEqual({ blocks: [{ header: "greeting", question: one.question, answer: null }], lead: NOT_ANSWERED });
    expect(recordShape("dismissed", four).blocks.map((b) => b.question)).toEqual(four.map((q) => q.question));
  });

  test("four questions answered together: each question's label and words, each with its own answer (not only the labels and the answers)", () => {
    const shape = recordShape("answered", four);
    expect(shape.blocks.map((b) => [b.header, b.question, b.answer])).toEqual([
      ["Newer-version entries", "decode what it can, or drop the entry?", "Version-first decode (recommended)"],
      ["Unit variant growth rule", "keep `Other(String)` or add variants?", "Drop it, add variants (recommended)"],
      ["Command validation", "validate once into a type, or at each use?", "ValidatedCommand type (recommended)"],
      ["Scope of the change request", "which go into this change?", "\u201ctyped words\u201d"],
    ]);
    expect(shape.lead).toBeNull();
    expect(spokenRecord("answered", four, "")).toContain("Newer-version entries: Version-first decode (recommended)");
  });
});
