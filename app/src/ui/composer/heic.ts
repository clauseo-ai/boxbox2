/* heic and heif, found without decoding them (docs/composer.md, attachments). chrome and firefox cannot draw
   either, and chrome often gives a .heic file an empty type, so a photo is one by what the browser says, by its
   extension, or by the brand in its first bytes, whichever speaks. pure, so it is tested without a browser */

export type HeifKind = "image/heic" | "image/heif";

/** a photo that went as the original bytes of a heic or heif, which nothing here can draw */
export function isOriginal(mime: string): boolean {
  return mime === "image/heic" || mime === "image/heif";
}

/** the word on its tile: `heic` or `heif` */
export function kindOf(mime: string): string {
  return mime === "image/heif" ? "heif" : "heic";
}

/** how much of a file's start holds its brands: the box's size, `ftyp`, the major brand, then the compatible ones */
export const HEAD_BYTES = 64;

/** brands of the hevc-coded kind (an iphone's is `heic`) */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
/** the generic container brands, which avif uses too */
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

const ascii = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

/** the kind a file's first bytes declare, or null when they are not a heic or heif (an avif is neither) */
export function heifKindOfBytes(head: Uint8Array): HeifKind | null {
  if (head.length < 16 || ascii(head, 4) !== "ftyp") return null;
  const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
  const end = Math.min(size === 0 ? head.length : size, head.length);
  const brands = [ascii(head, 8)];
  // bytes 12 to 16 are the minor version, not a brand
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(head, at));
  if (brands.some((b) => HEIC_BRANDS.has(b))) return "image/heic";
  if (brands.some((b) => HEIF_BRANDS.has(b)) && !brands.some((b) => AVIF_BRANDS.has(b))) return "image/heif";
  return null;
}

/** the kind a file's declared type or its extension names, or null */
export function heifKindOfName(name: string, type: string): HeifKind | null {
  const declared = type.toLowerCase();
  if (declared === "image/heic" || declared === "image/heic-sequence") return "image/heic";
  if (declared === "image/heif" || declared === "image/heif-sequence") return "image/heif";
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension === "heic" || extension === "heics") return "image/heic";
  if (extension === "heif" || extension === "heifs" || extension === "hif") return "image/heif";
  return null;
}

/** reads a file's start; bytes it cannot read (a revoked file) say nothing */
export async function heifKindOfFile(file: File): Promise<HeifKind | null> {
  const byName = heifKindOfName(file.name, file.type);
  try {
    const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    return heifKindOfBytes(head) ?? byName;
  } catch {
    return byName;
  }
}
