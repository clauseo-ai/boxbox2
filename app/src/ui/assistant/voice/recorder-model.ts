/* the recorder's rules, pure, so a test pins them (docs/composer.md, recording; docs/design.md, buttery: the buffers):
   which kind to record, the caps, where the cancel and lock lines are, what a release means, and the running reduction of
   a note's loudness to 64 peaks in a fixed 64 + 128 bytes, however long the note runs. */

/** a hold released before this is a tap: nothing is sent */
export const TOO_SHORT_MS = 600;
/** fifteen minutes, the longest a note can be */
export const MAX_MS = 15 * 60_000;
/** twelve mb, or the agent's own maxBytes when that is less */
export const MAX_BYTES = 12 * 1024 * 1024;
/** the timer says "1 min left" this long before the cap */
export const NEAR_MS = 60_000;
/** past this far up, a release locks */
export const LOCK_LINE = 72;
/** a live bar per this much input */
export const BAR_MS = 100;
/** the recorder's timeslice: an encoded chunk every second into the capped buffer */
export const CHUNK_MS = 1000;

/** the cancel line: 120 px, or a third of the composer's width, whichever is less */
export const cancelLine = (width: number): number => Math.min(120, width / 3);

/** the byte cap for an agent: 12 mb, or its maxBytes when less */
export const byteCap = (maxBytes: number | undefined): number => (maxBytes !== undefined && maxBytes > 0 ? Math.min(MAX_BYTES, maxBytes) : MAX_BYTES);

/* the kinds, in the order agents.md wants them: aac in mp4 where the recorder offers it (safari, and chromium builds that
   do), else opus in webm, else opus in ogg. a kind the agent's attachments do not take is skipped, so the composer can say
   so before recording rather than after */
export const KINDS = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"] as const;

/** the encoder's rate for a kind, inside the law's 24 to 64 kbps: opus speaks well at 32; chromium's aac encoder refuses
    anything under 48 with an EncodingError (seen in chrome 151), so aac records at 64 */
export const bitrateOf = (kind: string): number => (kind.startsWith("audio/mp4") ? 64_000 : 32_000);

/** does an attachments kind list ("audio/*", "audio/ogg", "image/png") take this recorded kind? */
export function takes(kinds: readonly string[], mime: string): boolean {
  const base = (mime.split(";")[0] ?? mime).trim().toLowerCase();
  return kinds.some((k) => {
    const kind = k.trim().toLowerCase();
    return kind === base || kind === "*/*" || (kind.endsWith("/*") && base.startsWith(kind.slice(0, -1)));
  });
}

/** the kind to record in, or null when the browser records none the agent takes (the mic is then not offered) */
export function pickKind(supported: (mime: string) => boolean, kinds: readonly string[]): string | null {
  for (const kind of KINDS) if (supported(kind) && takes(kinds, kind)) return kind;
  return null;
}

/** what a release of the held key means, from how far it travelled (dx left is negative, dy up is positive) and how long it was held */
export type Release = "cancel" | "lock" | "too-short" | "send";

export function releaseOf(dx: number, dy: number, heldMs: number, width: number): Release {
  if (-dx >= cancelLine(width)) return "cancel";
  if (dy >= LOCK_LINE) return "lock";
  if (heldMs < TOO_SHORT_MS) return "too-short";
  return "send";
}

/** while held: how far the words have slid toward the cancel line (0 to 1) and how full the lock's track is (0 to 1). the
    finger goes one way at a time: whichever axis leads takes it */
export function dragOf(dx: number, dy: number, width: number): { slide: number; lock: number } {
  const left = Math.max(0, -dx);
  const up = Math.max(0, dy);
  if (left >= up) return { slide: Math.min(1, left / cancelLine(width)), lock: 0 };
  return { slide: 0, lock: Math.min(1, up / LOCK_LINE) };
}

/** how long is left before a cap: the time cap, or the byte cap at the rate the note has been filling it */
export function leftMs(elapsedMs: number, bytes: number, cap: number, maxMs = MAX_MS): number {
  const byTime = maxMs - elapsedMs;
  if (bytes <= 0 || elapsedMs <= 0) return byTime;
  const byBytes = ((cap - bytes) / bytes) * elapsedMs;
  return Math.max(0, Math.min(byTime, byBytes));
}

/** a live bar's height (0 to 255) from a slice's peak amplitude (0 to 1): a square root, so a quiet voice still moves */
export const barOf = (peak: number): number => Math.max(0, Math.min(255, Math.round(Math.sqrt(Math.max(0, peak)) * 255)));

/** the whole note's loudness, reduced as it records: 128 bins of a width that doubles whenever they fill (two neighbours
    merge by their max), so the memory is fixed however long the note runs, and 64 equal slices come out at the end */
export class PeakBins {
  readonly #bins = new Float32Array(128);
  #count = 0;
  /** slices per bin */
  #width = 1;
  /** slices taken into the open bin */
  #fill = 0;

  push(peak: number): void {
    if (this.#count === 0) this.#count = 1;
    const i = this.#count - 1;
    this.#bins[i] = Math.max(this.#bins[i] ?? 0, peak);
    this.#fill += 1;
    if (this.#fill < this.#width) return;
    this.#fill = 0;
    if (this.#count < this.#bins.length) {
      this.#count += 1;
      this.#bins[this.#count - 1] = 0;
      return;
    }
    // full: merge pairs, so each bin holds twice the slices
    for (let j = 0; j < this.#bins.length / 2; j++) this.#bins[j] = Math.max(this.#bins[2 * j] ?? 0, this.#bins[2 * j + 1] ?? 0);
    this.#bins.fill(0, this.#bins.length / 2);
    this.#count = this.#bins.length / 2 + 1;
    this.#width *= 2;
  }

  /** 64 values from 0 to 255, the loudest slice at 255, as the upload's `waveform` carries them */
  peaks(n = 64): number[] {
    const used = this.#fill === 0 && this.#count > 1 ? this.#count - 1 : this.#count;
    if (used === 0) return Array.from({ length: n }, () => 0);
    const out = Array.from({ length: n }, (_, k) => {
      const from = Math.floor((k * used) / n);
      const to = Math.max(from + 1, Math.floor(((k + 1) * used) / n));
      let m = 0;
      for (let j = from; j < to; j++) m = Math.max(m, this.#bins[j] ?? 0);
      return m;
    });
    const top = Math.max(...out);
    return out.map((v) => (top > 0 ? barOf(v / top) : 0));
  }
}
