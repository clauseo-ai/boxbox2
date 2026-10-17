import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cutMiddle, extensionOf, FILE_ACCEPT, fileKind, fileName, MAX_FILENAME, isPhotoKind, MAX_PDF_FILE, MAX_TEXT_FILE, notTaken, noRoomLeft, sizeOf, tooLarge, typeWord } from "./files";

/** a constant of the server's, read from its source (as photo.test.ts does) */
function rust(name: string): number {
  const source = readFileSync(new URL("../../../../server/src/http/compose.rs", import.meta.url), "utf8");
  const found = source.match(new RegExp(`const ${name}: usize = ([^;]+);`));
  if (!found?.[1]) throw new Error(`no ${name} in compose.rs`);
  return Function(`return ${found[1].replaceAll("_", "")}`)() as number;
}

describe("a file the composer takes", () => {
  test("a pdf, json and any text go as their kind; a name's extension wins over the browser's word for it", () => {
    expect(fileKind({ type: "application/pdf", name: "booking.pdf" })).toBe("application/pdf");
    expect(fileKind({ type: "", name: "notes.md" })).toBe("text/markdown");
    expect(fileKind({ type: "text/markdown", name: "NOTES.MD" })).toBe("text/markdown");
    expect(fileKind({ type: "", name: "plan.json" })).toBe("application/json");
    expect(fileKind({ type: "text/csv", name: "rows.csv" })).toBe("text/csv");
    // a browser calls typescript a video
    expect(fileKind({ type: "video/mp2t", name: "app.ts" })).toBe("text/plain");
    expect(fileKind({ type: "text/x-weird", name: "a.unknownext" })).toBe("text/x-weird");
    expect(fileKind({ type: "", name: "Makefile" })).toBe("text/plain");
  });

  test("an archive, a binary, an image or a text kind with parameters is not a file it takes", () => {
    expect(fileKind({ type: "application/zip", name: "logs.zip" })).toBeNull();
    expect(fileKind({ type: "", name: "a.bin" })).toBeNull();
    expect(fileKind({ type: "image/png", name: "a.png" })).toBeNull();
    expect(fileKind({ type: "text/plain; charset=utf-8", name: "a" })).toBeNull();
    // a .env holds secrets: it is never sent by a stray drop, whatever kind the browser gives it
    for (const name of [".env", ".env.local", ".ENV.production", "repo/.env"]) for (const type of ["", "text/plain"]) expect(fileKind({ type, name })).toBeNull();
    expect(fileKind({ type: "text/plain", name: "env.txt" })).toBe("text/plain");
    expect(isPhotoKind("image/heic")).toBe(true);
    expect(isPhotoKind("application/pdf")).toBe(false);
  });

  test("a file goes by the name after its last slash, and a name the server would refuse is refused before it is read", () => {
    expect(fileName("../../etc/plan.md")).toEqual({ ok: true, name: "plan.md" });
    expect(fileName("C:\\notes\\a.md")).toEqual({ ok: true, name: "a.md" });
    // the limit is characters, not bytes: a hundred cjk characters fit
    expect(fileName(`${"資".repeat(100)}.md`).ok).toBe(true);
    expect(fileName(`${"a".repeat(MAX_FILENAME - 3)}.md`).ok).toBe(true);
    expect(fileName(`${"a".repeat(MAX_FILENAME)}.md`)).toEqual({ ok: false, reason: `aaaaaaa…aa.md has a name of ${MAX_FILENAME + 3} characters. rename it to ${MAX_FILENAME} or fewer and add it again.` });
    expect(fileName('a"b.md')).toEqual({ ok: false, reason: 'a"b.md has a quote in its name. rename it and add it again.' });
    expect(fileName("<x>.md")).toMatchObject({ ok: false, reason: expect.stringContaining("an angle bracket") });
    expect(fileName("cv\u202Efdp.exe")).toEqual({ ok: false, reason: "cvfdp.exe has a hidden direction or control mark in its name. rename it and add it again." });
    expect(fileName("a\u200Bb.md").ok).toBe(false);
    for (const empty of ["", "dir/", "..", "  "]) expect(fileName(empty).ok).toBe(false);
    expect(MAX_FILENAME).toBe(rust("MAX_FILENAME"));
  });

  test("the picker offers what is taken", () => {
    for (const kind of ["application/pdf", "text/*", "application/json", ".md", ".csv", ".ts"]) expect(FILE_ACCEPT.split(",")).toContain(kind);
  });

  test("the limits are the server's", () => {
    expect(MAX_PDF_FILE).toBe(rust("MAX_PDF_FILE"));
    expect(MAX_TEXT_FILE).toBe(rust("MAX_TEXT_FILE"));
  });

  test("a file past its limit is refused in the agent's own numbers, and one at it is not", () => {
    expect(tooLarge("cmx on desk", "a.pdf", "application/pdf", MAX_PDF_FILE)).toBeNull();
    expect(tooLarge("cmx on desk", "deck.pdf", "application/pdf", 31 * 1024 * 1024)).toBe("deck.pdf is 31 mb. cmx on desk takes pdfs up to 9 mb.");
    expect(tooLarge("cmx on desk", "rows.csv", "text/csv", MAX_TEXT_FILE + 1)).toBe("rows.csv is 513 kb. cmx on desk takes text files up to 512 kb.");
  });

  test("the words for a file it does not take, and for one past the count", () => {
    expect(notTaken("cmx on desk", "logs.zip")).toBe("cmx on desk does not take .zip files, so logs.zip is mentioned by its name instead.");
    expect(notTaken("cmx on desk", "core")).toBe("cmx on desk does not take core, so it is mentioned by its name instead.");
    expect(noRoomLeft("cmx on desk", 4, "e.pdf")).toBe("cmx on desk takes 4 photos and files on a message. e.pdf did not fit.");
  });

  test("a tile names a file by its start and its end, and its kind in a short word", () => {
    expect(cutMiddle("booking-confirmation-final.pdf")).toBe("bookin…al.pdf");
    expect([...cutMiddle("booking-confirmation-final.pdf")].length).toBe(13);
    expect(cutMiddle("notes.md")).toBe("notes.md");
    expect(cutMiddle("deploy spec v2.md")).toBe("deploy…v2.md");
    expect(typeWord("notes.md", "text/markdown")).toBe("md");
    expect(typeWord("Report.PDF", "application/pdf")).toBe("pdf");
    expect(typeWord("schema.graphql", "text/plain")).toBe("text");
    expect(extensionOf("a.tar.gz")).toBe("gz");
    expect(sizeOf(300)).toBe("1 kb");
    expect(sizeOf(1536 * 1024)).toBe("1.5 mb");
  });
});
