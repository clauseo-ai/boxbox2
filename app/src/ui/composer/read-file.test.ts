import { describe, expect, test } from "bun:test";
import { MAX_TEXT_FILE } from "./files";
import { readFile } from "./read-file";

/* what is refused before a file's data url is made (bun has no FileReader, so the reading itself is the browser's: verified
   against a dev daemon, /tmp/fix-files/REPORT.md) */
describe("a file read into the draft is refused on the device when the server would refuse it", () => {
  const agent = "cmx on desk";
  test("a text file that is not utf-8, or is a binary with a text name", async () => {
    expect(await readFile(new File([new Uint8Array([0x63, 0xe9, 0x0a])], "latin.txt"), "text/plain", agent)).toEqual({ ok: false, reason: "latin.txt is not utf-8 text. save it as utf-8 and add it again." });
    expect(await readFile(new File([new Uint8Array([0x50, 0x4b, 0x00, 0x01])], "a.json"), "application/json", agent)).toEqual({ ok: false, reason: "a.json is not text. cmx on desk reads pdfs, text and json." });
  });

  test("a name the server would refuse, an empty file and one past its limit, before a byte is read", async () => {
    expect(await readFile(new File(["x"], 'a"b.md'), "text/markdown", agent)).toMatchObject({ ok: false, reason: expect.stringContaining("a quote") });
    expect(await readFile(new File([], "e.md"), "text/markdown", agent)).toEqual({ ok: false, reason: "e.md is empty. add a file with something in it." });
    expect(await readFile(new File(["a".repeat(MAX_TEXT_FILE + 1)], "big.csv"), "text/csv", agent)).toEqual({ ok: false, reason: "big.csv is 513 kb. cmx on desk takes text files up to 512 kb." });
  });
});
