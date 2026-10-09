/* asks the server for a repo's favicon and says what plate it wants. it is a fetch, not an <img>, because only a fetch
   sees the status and `x-repo-icon`: what the server says about why there is no icon is what decides how long that is
   believed (icons.ts, the table). an image is drawn into a small canvas (same origin, so the pixels are readable) and
   plate.ts decides; the fetch also leaves the bytes in the browser's cache, so the mark's own <img> paints at once.
   the verdict goes into the store, where every mark of the repo reads it. */

import { setRepoIcon, state } from "../../store";
import { classify, iconKey, iconUrl, needsProbe, READ_MS, type Read, reading, settled } from "./icons";
import { plateOf, SAMPLE } from "./plate";

/** the pixels of an image and its shape, as the canvas hands them over */
export type Sampled = { pixels: Uint8ClampedArray; aspect: number };

/** reads an image's pixels (sample.ts in the app; a stand-in in the tests, which have no canvas) */
export type Sampler = (blob: Blob, abort: AbortSignal) => Promise<Sampled | null>;

/** how a read is carried out beyond the fetch: the sampler of pixels, and where its outcome is reported */
export type ReadWith = { sample: Sampler; onRead?: (outcome: IconOutcome, attempts: number, ms: number) => void };

/** one read of the server. never throws: whatever goes wrong is a retry, which is not a statement about the repo */
async function read(url: string, abort: AbortSignal, sample: Sampler): Promise<{ read: Read; outcome: IconOutcome }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", signal: abort });
  } catch {
    return { read: { kind: "retry" }, outcome: "retry" };
  }
  const said = classify(res.status, res.headers.get("x-repo-icon"));
  if (said === "retry") return { read: { kind: "retry" }, outcome: "retry" };
  if (said !== "image") return { read: { kind: "absent", why: said }, outcome: said };
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    return { read: { kind: "retry" }, outcome: "retry" };
  }
  const sampled = await sample(blob, abort);
  if (abort.aborted) return { read: { kind: "retry" }, outcome: "retry" };
  // bytes the server called an image that cannot be drawn, or draws nothing, are a file with no icon in it
  const plate = sampled ? plateOf(sampled.pixels, SAMPLE, sampled.aspect) : null;
  return plate ? { read: { kind: "plate", plate }, outcome: "image" } : { read: { kind: "absent", why: "none" }, outcome: "unreadable" };
}

/** what a read came to, for the telemetry row (telemetry/schema.ts, repo.icon) */
export type IconOutcome = "image" | "none" | "unsupported" | "unproven" | "refused" | "retry" | "unreadable";

/** makes sure the repo's icon has been asked for and is not due again (the promise settles when a read it started has): marks call this when they appear and when a
    verdict falls due. a repo that is answered for, or being read, costs nothing. an empty host or root is not asked
    about (a thread whose info has not arrived has none). nothing here throws; an icon that cannot be had is the tile */
export function ensureRepoIcon(host: string, root: string, how: ReadWith): Promise<void> {
  if (!host || !root) return Promise.resolve();
  const key = iconKey(host, root);
  const now = Date.now();
  if (!needsProbe(state.repoIcons[key], now)) return Promise.resolve();
  setRepoIcon(key, reading(state.repoIcons[key], now));
  const abort = new AbortController();
  const giveUp = setTimeout(() => abort.abort(), READ_MS);
  const began = performance.now();
  return read(iconUrl(host, root), abort.signal, how.sample)
    .then(({ read: answer, outcome }) => {
      const was = state.repoIcons[key];
      const next = settled(was, answer, Date.now());
      setRepoIcon(key, next);
      how.onRead?.(outcome, next.state === "retry" ? next.attempts : 0, Math.round(performance.now() - began));
    })
    .finally(() => clearTimeout(giveUp));
}
