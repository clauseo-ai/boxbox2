/* a draft's photos read back from the device when its composer opens (docs/composer.md, a draft's photos are read when its
   composer opens). a launch reads only the open thread's: every other draft says how many it keeps (`Draft.held`). this is
   loaded only when a draft has photos to read, so the first load carries none of it (client.ts, `loadDraftPhotos`). */

import { setDraft, state } from "../store";
import type { ToWorker } from "./messages";
import type { Draft, Photo } from "./outbox";

/** what is said when a draft's photos could not be read back to go with its message */
export const PHOTOS_UNREAD = "its photos could not be read, so it did not go. send it again";

/** reads waiting for the worker, by target key */
const reads = new Map<string, Array<() => void>>();

/** asks the worker for a draft's photos; resolves when they are in the store, or the read failed */
export function load(key: string, send: (message: ToWorker) => void): Promise<void> {
  if (!state.composer.drafts[key]?.held) return Promise.resolve();
  return new Promise((resolve) => {
    const waiting = reads.get(key);
    if (waiting) return void waiting.push(resolve);
    reads.set(key, [resolve]);
    send({ type: "photos", key });
  });
}

/** the worker's answer. read, the photos join the draft (the worker holds the set it read, so nothing goes back to it);
    failed, the draft keeps its count, marked, so emptying its words lets photos that cannot be read go */
export function read(key: string, photos: Photo[] | null): void {
  const draft = state.composer.drafts[key];
  if (draft?.held) {
    const { held, ...rest } = draft;
    setDraft(key, photos ? { ...rest, photos: [...photos, ...draft.photos] } : { ...draft, held: { ...held, failed: true } });
  }
  const waiting = reads.get(key) ?? [];
  reads.delete(key);
  for (const resolve of waiting) resolve();
}

/** a new set made before the draft's own photos were read would replace them: they are read first, and the set joins them,
    with what was typed meanwhile. a read that failed leaves the photos on the device as they are */
export function saveAfterRead(key: string, draft: Draft, abandoned: boolean, send: (message: ToWorker) => void, save: (key: string, draft: Draft, abandoned: boolean) => void): void {
  const { held: _unread, ...edit } = draft;
  void load(key, send).then(() => {
    const now = state.composer.drafts[key];
    if (now?.held) return;
    save(key, { ...edit, ...(now ? { text: now.text, model: now.model, effort: now.effort } : {}), photos: [...(now?.photos ?? []), ...edit.photos] }, abandoned);
  });
}

/** the worker stopped: nothing it was asked will come */
export function clear(): void {
  for (const waiting of reads.values()) for (const resolve of waiting) resolve();
  reads.clear();
}
