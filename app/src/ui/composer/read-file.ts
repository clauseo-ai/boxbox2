/* a file that is not a photo, read on the device into the draft (docs/composer.md, attachments: any file): its own bytes, as a
   data url of the kind it goes as, under the limit for that kind. nothing is changed in it; the host reads it to the model.
   a chunk of its own, loaded at the first file, as clamping a photo is. */

import type { Photo } from "../../sync/outbox";
import { fileName, tooLarge } from "./files";

export type Read = { ok: true; photo: Photo } | { ok: false; reason: string };

/** how much of a text file is looked at to tell it from a binary one wearing a text name */
const SNIFF = 8192;

/** reads one file the agent takes as `mime`; `agent` names who takes it, for the words when it cannot go */
export async function readFile(file: File, mime: string, agent: string): Promise<Read> {
  // the name and the size are known before a byte is read, so a file the server would refuse is never held in memory
  const named = fileName(file.name);
  if (!named.ok) return named;
  const name = named.name;
  const large = tooLarge(agent, name, mime, file.size);
  if (large) return { ok: false, reason: large };
  if (file.size === 0) return { ok: false, reason: `${name} is empty. add a file with something in it.` };
  if (mime !== "application/pdf") {
    // a text file is at most 512 kb, so all of it is looked at: cmx2 reads it as utf-8, and the server refuses one that is not
    const bytes = await bytesOf(file);
    if (bytes === null) return { ok: false, reason: `${name} could not be read here. add it again.` };
    // a zero byte never appears in text: this is a binary file with a text file's name
    if (bytes.subarray(0, SNIFF).includes(0)) return { ok: false, reason: `${name} is not text. ${agent} reads pdfs, text and json.` };
    if (!isUtf8(bytes)) return { ok: false, reason: `${name} is not utf-8 text. save it as utf-8 and add it again.` };
  }
  const url = await readAsDataUrl(file.slice(0, file.size, mime));
  if (url === null || !url.startsWith(`data:${mime};base64,`)) return { ok: false, reason: `${name} could not be read here. add it again.` };
  // a file has no dimensions: the host reads its words
  return { ok: true, photo: { mime, filename: name, url, width: null, height: null } };
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function bytesOf(blob: Blob): Promise<Uint8Array | null> {
  return blob.arrayBuffer().then(
    (buffer) => new Uint8Array(buffer),
    () => null,
  );
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
