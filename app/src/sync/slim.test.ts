import { describe, expect, test } from "bun:test";
import type { Part } from "./protocol";
import { slimPart } from "./reducer";

const file = (mime: string, url: string, extra: Record<string, unknown> = {}): Part => ({ id: "p", sessionID: "s", messageID: "m", type: "file", mime, filename: "a", url, ...extra }) as Part;

describe("a file part held without its bytes (docs/composer.md, attachments: any file)", () => {
  test("a pdf a person sent keeps its name, kind and size and lets its data url go", () => {
    const pdf = file("application/pdf", `data:application/pdf;base64,${"A".repeat(4000)}`);
    expect(slimPart(pdf)).toEqual({ ...pdf, url: "", size: 3000 });
    // the daemon's own size wins over one read from the url
    expect(slimPart(file("text/plain", "data:text/plain;base64,AAAA", { size: 3 }))).toMatchObject({ url: "", size: 3 });
  });

  test("an image, a heic original the browser cannot draw, a file url and any other part stay as they came", () => {
    for (const part of [file("image/png", "data:image/png;base64,AAAA"), file("image/heic", "data:image/heic;base64,AAAA"), file("text/plain", "file:///repo/a.md")]) expect(slimPart(part)).toBe(part);
    const text = { id: "t", sessionID: "s", messageID: "m", type: "text", text: "hi" } as Part;
    expect(slimPart(text)).toBe(text);
  });
});
