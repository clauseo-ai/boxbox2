/* the agent's markdown read as github reads it where marked does not (docs/thread.md, code and copying): a single tilde is a tilde,
   two strike, and footnotes are numbered superscripts with their notes in a block at the end */

import { describe, expect, test } from "bun:test";
import { ALLOWED_TAGS, ALLOWED_URI, footnotes, toHtml } from "./markdown-gfm";

describe("tildes", () => {
  test("a single tilde draws as written", () => {
    expect(toHtml("see ~/.agents/skills and ~3 files")).toBe("<p>see ~/.agents/skills and ~3 files</p>\n");
    expect(toHtml("a ~word~ here")).toBe("<p>a ~word~ here</p>\n");
  });

  test("two tildes each side strike, with markdown inside", () => {
    expect(toHtml("a ~~gone **now**~~ b")).toBe("<p>a <del>gone <strong>now</strong></del> b</p>\n");
  });
});

describe("footnotes", () => {
  test("definitions come out of the text and are numbered by where they are first referenced", () => {
    const f = footnotes("one[^b] two[^a] again[^b]\n\n[^a]: the a note\n[^b]: the b note\n    carried on");
    expect(f.body).toBe("one[^b] two[^a] again[^b]\n");
    expect(f.notes).toEqual([{ label: "b", text: "the b note carried on" }, { label: "a", text: "the a note" }]);
  });

  test("a definition in a fence is code; one nothing refers to is dropped; a reference with no note stays as written", () => {
    const f = footnotes("text[^x]\n\n```\n[^y]: not a note\n```\n[^z]: unused");
    expect(f.notes).toEqual([]);
    expect(f.body).toContain("[^y]: not a note");
    expect(toHtml("text[^x]")).toBe("<p>text[^x]</p>\n");
  });

  test("references are superscript numbers and the notes a list in a footer at the end", () => {
    expect(toHtml("claim[^1].\n\n[^1]: the *source*")).toBe("<p>claim<sup>1</sup>.</p>\n<footer><ol><li>the <em>source</em></li></ol></footer>");
  });
});

describe("the html an agent may write", () => {
  test("nothing that runs, embeds or takes input is on the list, and links go to the web or to mail only", () => {
    for (const tag of ["script", "style", "iframe", "object", "embed", "form", "input", "button", "img", "svg", "video"]) expect(ALLOWED_TAGS).not.toContain(tag);
    for (const tag of ["br", "ul", "li", "details", "summary", "kbd", "sub", "sup", "table", "blockquote", "h3", "del"]) expect(ALLOWED_TAGS).toContain(tag);
    expect(ALLOWED_URI.test("https://example.com")).toBe(true);
    expect(ALLOWED_URI.test("mailto:a@example.com")).toBe(true);
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,x", "vbscript:x", "/relative", "file:///etc"]) expect(ALLOWED_URI.test(url)).toBe(false);
  });
});
