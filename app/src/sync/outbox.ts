/* the composer's outbox (docs/composer.md, sending): every message a
   person sends, from the tap until the daemon's echo of its client id
   reaches this device. the worker owns it, keeps it in indexeddb, posts
   each entry and retries it with the same client id, so a flaky network
   acts once (cmx2 a4); "sent" is never inferred from the text coming back
   (design.md, the composer: send is honest).

   this module is the outbox's rules, pure: what each answer and each
   frame does to an entry. the worker does the io. */

import type { MessageInfo } from "./protocol";

/** what the composer asked for. `prompt` becomes a queued card when the daemon queues it */
export type Verb = "prompt" | "steer" | "shell" | "command" | "start";

/** photos on one message */
export const MAX_PHOTOS = 4;
/** all of one message's photos together, in data url characters (server/src/http/compose.rs, MAX_PHOTOS_TOTAL); it bounds the body the routes take */
export const MAX_MESSAGE_URL = 24 * 1024 * 1024 + 46;
/** the same, as the person's files: two heics at the limit */
export const MAX_MESSAGE_FILE = 18 * 1024 * 1024;

/** a photo on a message: a jpeg or other image clamped on the device (a data url of at most 1.5 mb), or the original
    of a heic or heif this browser could not decode (a file of at most 9 mb; the host converts it). `width` and `height` are what
    the clamp measured, and null for an original, whose size only the host finds out; nothing in the app reads them. */
export type Photo = { mime: string; filename: string; url: string; width: number | null; height: number | null };

/** what is said when photos handed back to a draft did not all fit it: they are not held anywhere now, so they are picked again */
export function photosNotFitted(lost: number): string {
  const [some, them] = lost === 1 ? ["1 photo", "it"] : [`${lost} photos`, "them"];
  return `${some} did not fit the draft (a message takes at most ${MAX_PHOTOS} photos and ${MAX_MESSAGE_FILE / (1024 * 1024)} mb together) and boxbox no longer holds ${them}. pick ${them} again from your library for another message`;
}

/** photos handed back to a draft that already holds some: what it held stays first, then the returned ones in order while
    they fit the most a message carries; `lost` counts the ones that did not */
export function mergePhotos(held: readonly Photo[], back: readonly Photo[]): { photos: Photo[]; lost: number } {
  const photos = [...held];
  let bytes = photoBytes(photos);
  let lost = 0;
  for (const photo of back) {
    if (photos.length >= MAX_PHOTOS || bytes + photo.url.length > MAX_MESSAGE_URL) lost += 1;
    else {
      photos.push(photo);
      bytes += photo.url.length;
    }
  }
  return { photos, lost };
}

/** what a message the person took back leaves in the draft it came from, in one step: its photos join the ones the draft
    holds, and its words come back when the draft held nothing before they came (the rule of an unsend: words are not put
    over words being written, and photos being added are a draft). `kept` is true when the draft's own photos were not
    changed, so the worker is not sent them again */
export function takeBackDraft(held: Draft | undefined, back: { photos: readonly Photo[]; text: string | null }, now: number): { draft: Draft; lost: number; kept: boolean } {
  const merged = mergePhotos(held?.photos ?? [], back.photos);
  const empty = !held || (held.text.trim() === "" && held.photos.length === 0);
  const text = back.text !== null && empty ? back.text : (held?.text ?? "");
  return {
    draft: { model: null, effort: null, ...held, text, photos: merged.photos, at: now },
    lost: merged.lost,
    kept: merged.photos.length === (held?.photos.length ?? 0),
  };
}

/** the characters of data url the photos hold, which is what they cost in memory and on the wire */
export function photoBytes(photos: readonly Photo[]): number {
  let total = 0;
  for (const photo of photos) total += photo.url.length;
  return total;
}

/** where a message goes: an open session, or a new thread in a repo */
export type Target =
  | { kind: "session"; host: string; session: string; directory: string }
  | { kind: "new"; host: string; directory: string; place: "checkout" | "fresh" };

/** the outbox's own key for a target, and the key a draft is kept under */
export function targetKey(target: Target): string {
  return target.kind === "session" ? `${target.host}:${target.session}` : `new:${target.host}:${target.directory}`;
}

export type OutboxState =
  /** not posted yet: the stream is down, so it waits on the device and goes in order when it is back */
  | "waiting"
  /** posted; no echo yet */
  | "sending"
  /** the daemon echoed it as a provisional message waiting behind the running turn (a steer waits for the next step) */
  | "queued"
  /** the daemon echoed it in the transcript: done; the entry leaves the outbox */
  | "landed"
  /** it did not go: `error` says why; retry posts it again with the same client id */
  | "failed";

export type OutboxEntry = {
  clientID: string;
  verb: Verb;
  target: Target;
  /** the outbox key of `target` */
  key: string;
  text: string;
  photos: Photo[];
  /** `provider/model` and effort picked for the thread, carried by this send */
  model: string | null;
  effort: string | null;
  state: OutboxState;
  /** the provisional message id while it is queued; unsend takes it back by this */
  provisional: string | null;
  /** a new thread's session, once the server made it */
  session: string | null;
  error: string | null;
  /** posts made so far */
  attempts: number;
  /** when the person tapped send, ms since the epoch */
  at: number;
  /** when the echo first arrived */
  ackAt: number | null;
  /** an unsend is in flight */
  unsending: boolean;
  /** photos the outbox would not keep with this message (it would hold too many): they went back to the draft they came
      from, and the entry is failed with its words alone. a retry would send the words without them, so it is not offered one */
  photosReturned?: number;
};

/** posts per send before it is shown as failed; each waits longer than the last */
export const MAX_ATTEMPTS = 3;
/** how long a posted send may wait for its echo while the stream is live before it says so */
export const ECHO_MS = 30_000;
/** entries kept at most; a person cannot have more in flight than this, and a stuck one is shown, never dropped */
export const OUTBOX_CAP = 64;
/** the photos the outbox holds at most, in data url characters: three messages at the server's limit for one. the
    composer asks for room before it takes a photo (`noRoomFor`), so this is the backstop for two tabs at once */
export const OUTBOX_PHOTO_BYTES = 3 * MAX_MESSAGE_URL;

/** what the server gives a daemon to take a message (server/src/http/compose.rs, `accept_timeout`): a base, then for each
    photo its bytes at a slow link's speed, and for a heic or heif the time to convert it, which the host does before it
    answers (cmx2 gives a conversion 60 s in all, and the rest is margin). a test holds each to the server's own */
export const HOST_ACCEPT_BASE_MS = 15_000;
export const HOST_ACCEPT_PER_CONVERTED_MS = 75_000;
export const HOST_ACCEPT_BYTES_PER_SECOND = 256 * 1024;
/** how long the server lets a message with photos wait for room in its photo budget before it turns it away
    (server/src/http/mod.rs, `PHOTO_WAIT`). nothing of the message is read while it waits */
export const PHOTO_WAIT_MS = 120_000;

export function hostAcceptMs(photos: readonly Photo[]): number {
  let ms = HOST_ACCEPT_BASE_MS;
  for (const photo of photos) {
    ms += Math.floor(photo.url.length / HOST_ACCEPT_BYTES_PER_SECOND) * 1000;
    if (photo.mime === "image/heic" || photo.mime === "image/heif") ms += HOST_ACCEPT_PER_CONVERTED_MS;
  }
  return ms;
}

/** one post's time, which outlasts everything it waits for, so what a slow or busy server produces is the server's own
    answer and never the device's timeout: the wait for room in the photo budget (a message with photos only), the upload
    to boxbox at the slowest link a phone is on (200 kB a second, about 1.6 mbit), the time the server gives the host
    (`hostAcceptMs`), then `marginMs` for the round trip */
export function postBudgetMs(photos: readonly Photo[], marginMs: number, bytesPerSecond = 200_000): number {
  const waits = photos.length > 0 ? PHOTO_WAIT_MS : 0;
  return Math.ceil(marginMs + waits + (photoBytes(photos) / bytesPerSecond) * 1000 + hostAcceptMs(photos));
}

/** the sound of a draft write that keeps failing, as the sender spaces its tries: 3 s, doubling, never past a minute. a
    full disk does not clear in a keystroke, and each try can be megabytes of photo */
export function draftRetryMs(failures: number): number {
  return Math.min(3_000 * 2 ** Math.max(0, failures - 1), 60_000);
}

/** failed rounds of draft writes in a row after which the person is told this device cannot keep drafts */
export const DRAFT_TROUBLE_AFTER = 3;

export type Draft = { text: string; photos: Photo[]; model: string | null; effort: string | null; at: number };

/** a draft as it crosses to the worker. a keystroke carries the words and `"kept"`: the photos are megabytes, and the worker
    already holds the set the last edit that changed it sent, so they travel (and are written to indexeddb) only when the set changes */
export type DraftMessage = Omit<Draft, "photos"> & { photos: Photo[] | "kept" };

/** the two records a draft is kept in: its words, small and written at every pause in typing, and its photos, written
    only when the set changes. the words record carries no photos */
export function splitDraft(draft: Draft): { words: Draft; photos: Photo[] } {
  return { words: { ...draft, photos: [] }, photos: draft.photos };
}

/** a draft from its two records. a record written before they were split carried its photos itself, which stand when
    there is no photos record */
export function joinDraft(words: Draft, photos: Photo[] | undefined): Draft {
  return photos === undefined ? words : { ...words, photos };
}

export function entryOf(input: { clientID: string; verb: Verb; target: Target; text: string; photos: Photo[]; model: string | null; effort: string | null; at: number }, live: boolean): OutboxEntry {
  return {
    ...input,
    key: targetKey(input.target),
    state: live ? "sending" : "waiting",
    provisional: null,
    session: null,
    error: null,
    attempts: 0,
    ackAt: null,
    unsending: false,
  };
}

/** what an http answer to a post does to its entry */
export type Answer =
  | { kind: "taken"; session?: string; landed?: boolean }
  | { kind: "refused"; message: string; status?: number; name?: string }
  | { kind: "unreachable"; message: string };

export function answered(entry: OutboxEntry, answer: Answer, now: number): OutboxEntry {
  switch (answer.kind) {
    case "taken":
      // a shell line's answer is its echo (the daemon answers with the shell message); the rest wait for the stream
      if (answer.landed) return { ...entry, state: "landed", ackAt: entry.ackAt ?? now, error: null };
      return { ...entry, session: answer.session ?? entry.session, error: null };
    case "refused":
      return { ...entry, state: "failed", error: answer.message };
    case "unreachable":
      return entry.attempts >= MAX_ATTEMPTS ? { ...entry, state: "failed", error: answer.message } : { ...entry, error: answer.message };
    default:
      return answer satisfies never;
  }
}

/** the key a frame's session has in the outbox, for a new thread whose session the server named */
function sessionKeyOf(entry: OutboxEntry): string | null {
  if (entry.target.kind === "session") return entry.key;
  return entry.session ? `${entry.target.host}:${entry.session}` : null;
}

/** a message frame carrying an entry's client id: the echo */
export function echoed(entry: OutboxEntry, key: string, info: MessageInfo, now: number): OutboxEntry {
  if (info.clientID !== entry.clientID) return entry;
  const own = sessionKeyOf(entry);
  if (own !== null && own !== key) return entry;
  const session = entry.session ?? (entry.target.kind === "new" ? key.slice(key.indexOf(":") + 1) : null);
  if (info.queued === true) return { ...entry, state: "queued", provisional: info.id, session, ackAt: entry.ackAt ?? now, error: null };
  return { ...entry, state: "landed", provisional: null, session, ackAt: entry.ackAt ?? now, error: null };
}

/** a provisional message was taken back: by this device's unsend, or by another's */
export function removed(entry: OutboxEntry, key: string, messageID: string): OutboxEntry | null {
  if (entry.provisional !== messageID || sessionKeyOf(entry) !== key) return entry;
  // a queued prompt that lands is removed and then reissued under its transcript id with the same client id;
  // only an unsend means it is gone for good
  return entry.unsending ? null : entry;
}

/** a posted send whose echo has not come while the stream was live for `ECHO_MS` */
export function overdue(entry: OutboxEntry, liveSince: number | null, now: number): boolean {
  if (entry.state !== "sending" || entry.attempts === 0 || liveSince === null) return false;
  return now - Math.max(entry.at, liveSince) > ECHO_MS;
}

/** the verb a settled send is counted under in `perf.send` */
export function perfVerb(entry: OutboxEntry): "prompt" | "queue" | "steer" | "shell" | "command" | "start" {
  if (entry.verb === "prompt") return wasQueued(entry) ? "queue" : "prompt";
  return entry.verb;
}

/** the daemon held it behind a running turn under a provisional id */
export function wasQueued(entry: OutboxEntry): boolean {
  return entry.provisional !== null || entry.state === "queued";
}

/** the next entry to post: the oldest waiting one, so offline sends go out in the order they were written */
export function nextWaiting(entries: readonly OutboxEntry[]): OutboxEntry | null {
  let oldest: OutboxEntry | null = null;
  for (const entry of entries) if (entry.state === "waiting" && (!oldest || entry.at < oldest.at)) oldest = entry;
  return oldest;
}

/** what the ui renders of an entry: everything but the photos' bytes, which never cross to the ui again */
export type OutboxView = Omit<OutboxEntry, "photos"> & { photos: number; photoBytes: number };

export function viewOfEntry(entry: OutboxEntry): OutboxView {
  return { ...entry, photos: entry.photos.length, photoBytes: photoBytes(entry.photos) };
}
