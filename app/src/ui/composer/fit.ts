/* the numbers a photo is clamped to on the device (docs/composer.md,
   attachments), and the fitting itself, apart from the canvas so it is
   tested without a browser */

import { MAX_MESSAGE_FILE, MAX_MESSAGE_URL, MAX_PHOTOS } from "../../sync/outbox";

/** the long side a photo is fitted to: the size the models read best */
export const LONG_SIDE = 1568;
/** the server refuses a resized photo's data url above this (server/src/http/compose.rs, MAX_PHOTO) */
export const MAX_URL = 1536 * 1024;
/** the most a heic or heif original may be, as the person sees it in their files (MAX_HEIC_FILE): a phone's is 2 to 5 mb and a
    48 mp one about 9. a limit in the file's own size, so a refusal can say it and a file over it always reads bigger than it */
export const MAX_HEIC_FILE = 9 * 1024 * 1024;
/** that file as a data url, which the server refuses a heic or heif above (MAX_HEIC): the head, then four characters for
    every three bytes. both kinds' heads are 23 characters */
export const MAX_HEIC_URL = 12 * 1024 * 1024 + 23;
/** the photos this device holds that have not gone: every draft's and every unsent message's. three messages
    at the limit; past it the person is asked to send or remove some first (rule 7) */
export const MAX_HELD_URL = 3 * MAX_MESSAGE_URL;
export { MAX_MESSAGE_URL, MAX_PHOTOS };

const MIB = 1024 * 1024;

/** the characters of a `data:` url for `bytes` of a kind: its head, then base64 (four for every three bytes) */
export function dataUrlLength(bytes: number, mime: string): number {
  return `data:${mime};base64,`.length + 4 * Math.ceil(bytes / 3);
}

/** the most bytes of a heic or heif a message takes; as a data url of its kind it is exactly `MAX_HEIC_URL` */
export function maxHeifBytes(): number {
  return MAX_HEIC_FILE;
}

/** the bytes a base64 data url carries */
export function bytesOfUrl(url: string): number {
  return Math.floor(((url.length - url.indexOf(",") - 1) * 3) / 4);
}

/** a size as the person reads it: mb, one decimal only when it is not whole, rounded up so a refusal never says a size that fits */
export function megabytes(bytes: number): string {
  const tenths = Math.ceil((bytes * 10) / MIB);
  return tenths % 10 === 0 ? String(tenths / 10) : `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** why one more photo of `added` characters cannot join a message already holding `inMessage`, or when the device already
    holds `onDevice` of photos that have not gone; null when it fits */
export function noRoomFor(name: string, added: number, inMessage: number, onDevice: number): string | null {
  if (inMessage + added > MAX_MESSAGE_URL) return `${name} would take the photos on this message past ${MAX_MESSAGE_FILE / MIB} mb. send it in a message of its own, or remove one first`;
  // the person has files, not data urls: the size is said as they would see it
  if (onDevice + added > MAX_HELD_URL) return `this device is holding ${megabytes((onDevice * 3) / 4)} mb of photos that have not gone yet. send or remove some, then add ${name} again`;
  return null;
}

/** a box fitted inside the long side, never enlarged */
export function fit(width: number, height: number, long = LONG_SIDE): { width: number; height: number } {
  const scale = Math.min(1, long / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
