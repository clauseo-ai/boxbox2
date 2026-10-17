import { describe, expect, test } from "bun:test";
import { carriesDrop, sortDrop, withMention, withWords } from "./drop";

describe("a drop on the composer", () => {
  test("an image and a pdf, text or json file are taken, any other file is mentioned by its name, words join the draft", () => {
    const files = [
      { type: "image/png", name: "shot.png" },
      { type: "", name: "IMG_1.HEIC" },
      { type: "application/pdf", name: "spec.pdf" },
      { type: "application/zip", name: "logs.zip" },
      { type: "", name: "notes.md" },
      { type: "application/octet-stream", name: "a.bin" },
    ];
    expect(sortDrop(files, "/Users/dev/spec.pdf")).toEqual({ taken: [0, 1, 2, 4], others: ["logs.zip", "a.bin"], words: "" });
    expect(sortDrop([], "  look at this  ")).toEqual({ taken: [], others: [], words: "look at this" });
  });

  test("a mention is one word after an @, set apart from what the draft holds", () => {
    expect(withMention("", "notes.md")).toBe("@notes.md");
    expect(withMention("read", "notes.md")).toBe("read @notes.md");
    expect(withMention("read ", "my notes.md")).toBe("read @mynotes.md");
    expect(withMention("read", "   ")).toBe("read");
    expect(withWords("see", "the log")).toBe("see the log");
    expect(withWords("", "the log")).toBe("the log");
  });

  test("only a drag of files or words is offered to the composer", () => {
    expect(carriesDrop(["Files"])).toBe(true);
    expect(carriesDrop(["text/plain", "text/html"])).toBe(true);
    expect(carriesDrop(["text/uri-list"])).toBe(false);
  });
});
