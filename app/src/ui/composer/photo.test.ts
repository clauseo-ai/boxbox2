import { describe, expect, test } from "bun:test";
import { HOST_ACCEPT_BASE_MS, HOST_ACCEPT_BYTES_PER_SECOND, HOST_ACCEPT_PER_CONVERTED_MS, HOST_ACCEPT_PER_PDF_MS, hostAcceptMs, MAX_MESSAGE_FILE, OUTBOX_PHOTO_BYTES, PHOTO_WAIT_MS } from "../../sync/outbox";
import { bytesOfUrl, dataUrlLength, fit, LONG_SIDE, MAX_HEIC_URL, MAX_HELD_URL, MAX_MESSAGE_URL, MAX_URL, maxHeifBytes, megabytes, noRoomFor } from "./fit";

describe("a photo is fitted on the device", () => {
  test("a phone screenshot's long side comes down to 1568 px, keeping its shape", () => {
    expect(fit(1179, 2556)).toEqual({ width: 723, height: LONG_SIDE });
  });

  test("a landscape photo fits by its width", () => {
    expect(fit(4032, 3024)).toEqual({ width: LONG_SIDE, height: 1176 });
  });

  test("a small image is never enlarged", () => {
    expect(fit(640, 480)).toEqual({ width: 640, height: 480 });
  });
});

describe("a heic goes as its own bytes, under a limit of its own", () => {
  test("the limit is the file the person has, 9 mb, and as a data url it is exactly what the server takes", () => {
    for (const kind of ["image/heic", "image/heif"]) {
      expect(maxHeifBytes()).toBe(9 * 1024 * 1024);
      expect(dataUrlLength(maxHeifBytes(), kind)).toBe(MAX_HEIC_URL);
      expect(dataUrlLength(maxHeifBytes() + 1, kind)).toBeGreaterThan(MAX_HEIC_URL);
    }
  });

  test("a file just over the limit reads bigger than the limit, never the same number", () => {
    expect(megabytes(maxHeifBytes())).toBe("9");
    expect(megabytes(maxHeifBytes() + 1)).toBe("9.1");
  });

  test("a size reads in mb, rounded up so a refusal never names a size that fits", () => {
    expect(megabytes(5 * 1024 * 1024)).toBe("5");
    expect(megabytes(5 * 1024 * 1024 + 1)).toBe("5.1");
    expect(megabytes(11.2 * 1024 * 1024)).toBe("11.2");
  });

  test("the bytes of a data url are read back from its length", () => {
    expect(bytesOfUrl(`data:image/heic;base64,${"A".repeat(4000)}`)).toBe(3000);
    expect(dataUrlLength(3000, "image/heic")).toBe("data:image/heic;base64,".length + 4000);
  });
});

describe("a message and the device have room for photos only so far", () => {
  const mb = 1024 * 1024;

  test("two heics at the limit fit one message, a third does not and says what to do", () => {
    expect(noRoomFor("a.heic", MAX_HEIC_URL, MAX_HEIC_URL, MAX_HEIC_URL)).toBeNull();
    const why = noRoomFor("c.heic", 1, MAX_MESSAGE_URL, MAX_MESSAGE_URL);
    expect(why).toBe("c.heic would take the photos and files on this message past 18 mb. send it in a message of its own, or remove one first");
  });

  test("a device holding 72 mb of photos that have not gone refuses more, with the size it holds", () => {
    expect(noRoomFor("b.heic", 4 * mb, 0, MAX_HELD_URL - 4 * mb)).toBeNull();
    expect(noRoomFor("b.heic", 4 * mb, 0, MAX_HELD_URL - 3 * mb)).toMatch(/^this device is holding 51\.\d mb of photos and files that have not gone yet\. send or remove some, then add b\.heic again$/);
  });
});

describe("the device and the server hold the same limits", () => {
  /** a `const NAME: usize = 12 * 1024 * 1024;` in a rust file, evaluated */
  const rust = async (file: string, name: string): Promise<number> => {
    const source = await Bun.file(new URL(`../../../../server/src/http/${file}`, import.meta.url)).text();
    const found = new RegExp(`const ${name}: usize = ([0-9_ *+]+);`).exec(source);
    if (!found?.[1]) throw new Error(`${name} is not in ${file}`);
    // a sum of products of numbers, nothing else: the pattern lets nothing more through
    return Number(new Function(`return ${found[1].replaceAll("_", "")}`)());
  };

  test("the composer's three photo limits are the server's", async () => {
    expect(MAX_URL).toBe(await rust("compose.rs", "MAX_PHOTO"));
    expect(MAX_HEIC_URL).toBe(await rust("compose.rs", "MAX_HEIC"));
    expect(maxHeifBytes()).toBe(await rust("compose.rs", "MAX_HEIC_FILE"));
    expect(MAX_MESSAGE_URL).toBe(await rust("compose.rs", "MAX_ATTACHMENTS_TOTAL"));
  });

  /** a `const NAME: Duration = Duration::from_secs(120);` in a rust file, in ms */
  const rustSeconds = async (file: string, name: string): Promise<number> => {
    const source = await Bun.file(new URL(`../../../../server/src/http/${file}`, import.meta.url)).text();
    const found = new RegExp(String.raw`const ${name}: Duration = Duration::from_secs\((\d+)\);`).exec(source);
    if (!found?.[1]) throw new Error(`${name} is not in ${file}`);
    return Number(found[1]) * 1000;
  };

  test("what the device gives a post to wait for is what the server waits for", async () => {
    expect(HOST_ACCEPT_BASE_MS).toBe(await rustSeconds("compose.rs", "ACCEPT_BASE"));
    expect(HOST_ACCEPT_PER_CONVERTED_MS).toBe(await rustSeconds("compose.rs", "ACCEPT_PER_CONVERTED"));
    expect(HOST_ACCEPT_PER_PDF_MS).toBe(await rustSeconds("compose.rs", "ACCEPT_PER_PDF"));
    // a pdf is given its reading on top of its crossing; a text file only its crossing
    const pdf = { mime: "application/pdf", filename: "a.pdf", url: "data:application/pdf;base64,AAAA", width: null, height: null };
    expect(hostAcceptMs([pdf])).toBe(HOST_ACCEPT_BASE_MS + HOST_ACCEPT_PER_PDF_MS);
    expect(hostAcceptMs([{ ...pdf, mime: "text/plain" }])).toBe(HOST_ACCEPT_BASE_MS);
    expect(HOST_ACCEPT_BYTES_PER_SECOND).toBe(await rust("compose.rs", "ACCEPT_BYTES_PER_SECOND"));
    expect(PHOTO_WAIT_MS).toBe(await rustSeconds("mod.rs", "PHOTO_WAIT"));
  });

  test("the most a message carries is two heics or two pdfs at the limit, in files as in data urls", () => {
    expect(MAX_MESSAGE_FILE).toBe(2 * maxHeifBytes());
    // a pdf's head is five characters longer than a heic's, so two pdfs at the limit are the total
    expect(MAX_MESSAGE_URL).toBe(2 * dataUrlLength(maxHeifBytes(), "application/pdf"));
    expect(MAX_MESSAGE_URL).toBeGreaterThan(2 * MAX_HEIC_URL);
  });

  test("the routes take a body that holds a message at the total with its text, and the device holds three of them", async () => {
    expect(await rust("mod.rs", "PROMPT_BODY")).toBeGreaterThan(MAX_MESSAGE_URL + 600_000 + 4096);
    expect(MAX_HELD_URL).toBe(3 * MAX_MESSAGE_URL);
    expect(OUTBOX_PHOTO_BYTES).toBe(MAX_HELD_URL);
  });
});
