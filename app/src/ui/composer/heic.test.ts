import { describe, expect, test } from "bun:test";
import { heifKindOfBytes, heifKindOfName, isOriginal, kindOf } from "./heic";

/** the start of an isobmff file: a box of `size` bytes, `ftyp`, a major brand, a minor version, compatible brands */
function head(major: string, compatible: string[]): Uint8Array {
  const bytes = new Uint8Array(16 + compatible.length * 4);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  const put = (at: number, word: string) => [...word].forEach((ch, i) => (bytes[at + i] = ch.charCodeAt(0)));
  put(4, "ftyp");
  put(8, major);
  compatible.forEach((brand, i) => put(16 + i * 4, brand));
  return bytes;
}

describe("a heic is found by its first bytes", () => {
  test("an iphone photo (major heic, compatible mif1 and heic) is a heic", () => {
    expect(heifKindOfBytes(head("heic", ["mif1", "heic"]))).toBe("image/heic");
  });

  test("a container that is only mif1 is a heif", () => {
    expect(heifKindOfBytes(head("mif1", ["miaf"]))).toBe("image/heif");
  });

  test("a mif1 container that names a heic brand among its compatible ones is a heic", () => {
    expect(heifKindOfBytes(head("mif1", ["miaf", "heix"]))).toBe("image/heic");
  });

  test("an avif, which also says mif1, is not one", () => {
    expect(heifKindOfBytes(head("avif", ["mif1", "miaf"]))).toBeNull();
    expect(heifKindOfBytes(head("mif1", ["avif"]))).toBeNull();
  });

  test("a jpeg, a png and a file too short to say are not", () => {
    expect(heifKindOfBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]))).toBeNull();
    expect(heifKindOfBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(heifKindOfBytes(new Uint8Array(0))).toBeNull();
  });

  test("a brand past the box's own size is not read", () => {
    const bytes = head("isom", ["mp41", "heic"]);
    new DataView(bytes.buffer).setUint32(0, 20);
    expect(heifKindOfBytes(bytes)).toBeNull();
  });

  test("the minor version is not a brand", () => {
    const bytes = head("isom", ["mp41"]);
    [..."heic"].forEach((ch, i) => (bytes[12 + i] = ch.charCodeAt(0)));
    expect(heifKindOfBytes(bytes)).toBeNull();
  });
});

describe("a heic is found by what the browser says, or by its extension when it says nothing", () => {
  test("chrome's empty type on a .heic is found by the extension, in any case", () => {
    expect(heifKindOfName("IMG_0001.HEIC", "")).toBe("image/heic");
    expect(heifKindOfName("IMG_0001.heif", "")).toBe("image/heif");
  });

  test("a declared type wins over a name", () => {
    expect(heifKindOfName("photo", "image/heic")).toBe("image/heic");
    expect(heifKindOfName("photo.jpg", "image/heif")).toBe("image/heif");
  });

  test("a jpeg, and a name with no extension and no type, are not", () => {
    expect(heifKindOfName("a.jpg", "image/jpeg")).toBeNull();
    expect(heifKindOfName("heic", "")).toBeNull();
  });
});

describe("the tile's words", () => {
  test("only the two originals are drawn as tiles, each with its own word", () => {
    expect(isOriginal("image/heic") && isOriginal("image/heif")).toBe(true);
    expect(isOriginal("image/jpeg")).toBe(false);
    expect([kindOf("image/heic"), kindOf("image/heif")]).toEqual(["heic", "heif"]);
  });
});
