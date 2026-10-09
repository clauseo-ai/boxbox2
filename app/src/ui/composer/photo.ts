/* photos are clamped on the device before they go (docs/composer.md,
   attachments): the long side fitted to 1568 px, the size the models read
   best, encoded as jpeg under the server's 1.5 mb limit. a heic or heif the
   browser can decode (safari) goes the same way. one it cannot (chrome and
   firefox) goes as it is, as a data url of its own kind under a limit of its
   own, for cmx2 to convert on the host (cmx2-asks a30): the browser path is
   free and smaller, so it is always tried first. */

import type { Photo } from "../../sync/outbox";
import { dataUrlLength, fit, MAX_URL, maxHeifBytes, megabytes } from "./fit";
import { type HeifKind, heifKindOfFile, kindOf } from "./heic";

export { MAX_PHOTOS } from "./fit";

/** jpeg qualities tried in turn until the photo fits */
const QUALITIES = [0.86, 0.76, 0.64, 0.5] as const;

export type Clamped = { ok: true; photo: Photo } | { ok: false; reason: string };

/** a photo's file name without its extension, and what to call it when it has none */
const stem = (name: string): string => name.replace(/\.[^.]+$/, "") || "photo";

/** decodes, fits and encodes one picked file; a heic or heif this browser cannot decode goes as its original bytes */
export async function clampPhoto(file: File): Promise<Clamped> {
  const heif = await heifKindOfFile(file);
  if (!heif && !file.type.startsWith("image/")) return { ok: false, reason: `${file.name} is not a photo` };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (heif) return original(file, heif);
    return { ok: false, reason: `${file.name} could not be read here. save it as a jpeg or png and add it again` };
  }
  const size = fit(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return { ok: false, reason: "this browser cannot resize photos" };
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  for (const quality of QUALITIES) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= MAX_URL) {
      return { ok: true, photo: { mime: "image/jpeg", filename: `${stem(file.name)}.jpg`, url, width: size.width, height: size.height } };
    }
  }
  return { ok: false, reason: `${file.name} is too detailed to send under 1.5 mb` };
}

/** a heic or heif the browser cannot draw: its bytes, untouched, under the limit for its kind. the size is known
    before a byte is read, so a file past the limit is refused without being held in memory */
async function original(file: File, kind: HeifKind): Promise<Clamped> {
  const most = maxHeifBytes();
  if (file.size > most) {
    return { ok: false, reason: `${file.name} is ${megabytes(file.size)} mb, over the ${megabytes(most)} mb a ${kindOf(kind)} goes at. export it as a jpeg, or shoot it at a lower resolution, and add it again` };
  }
  const url = await readAsDataUrl(file.slice(0, file.size, kind));
  if (url === null || url.length > dataUrlLength(most, kind)) return { ok: false, reason: `${file.name} could not be read here. save it as a jpeg and add it again` };
  // the dimensions are the host's to find: this browser could not draw the photo, so it never saw them
  return { ok: true, photo: { mime: kind, filename: file.name, url, width: null, height: null } };
}

/** a blob as a data url of the blob's own type; null when the file cannot be read (it was moved or revoked) */
function readAsDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
