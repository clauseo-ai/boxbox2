/* a voice note's waveform: 64 loudnesses 0..255, "the loudness of equal slices of the clip" (docs/design.md, voice
   notes). your own notes carry theirs; an agent's arrive without, so they are drawn here: the note is decoded once in
   a worker (peaks.worker.ts, webcodecs' AudioDecoder), when its card first comes within 2.5 screens of the view
   (watchNear), and never on the main thread. until then, and where the platform cannot, the waveform is flat
   (flatPeaks). peaks are kept per note in an lru of 512 (64 bytes each, 32 kb). */

export const PEAK_COUNT = 64;
const LRU_SIZE = 512;

/** a flat line: nothing known, so nothing claimed. a renderer draws it at its quietest height. */
export function flatPeaks(n = PEAK_COUNT): Uint8Array {
  return new Uint8Array(n);
}

/** fine bins (any loudness measure, one per short window) to n equal slices, each the loudest bin it covers.
    fewer bins than slices are stretched, so a short clip still fills the width. */
export function reducePeaks(bins: ArrayLike<number>, n = PEAK_COUNT): Float32Array {
  const out = new Float32Array(n);
  const len = bins.length;
  if (len === 0 || n <= 0) return out;
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * len) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * len) / n));
    let max = 0;
    for (let k = from; k < to && k < len; k++) {
      const v = bins[k] ?? 0;
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

/** loudnesses to the wire's bytes: the loudest slice is 255, silence stays at 0. values under `floor` of the loudest
    (a hiss, a codec's noise) read as silence, so a quiet stretch is drawn as quiet. */
export function toBytes(values: ArrayLike<number>, floor = 0.02): Uint8Array {
  const out = new Uint8Array(values.length);
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    if (v > max) max = v;
  }
  if (!(max > 0)) return out;
  for (let i = 0; i < values.length; i++) {
    const r = (values[i] ?? 0) / max;
    out[i] = r < floor ? 0 : Math.max(1, Math.min(255, Math.round(r * 255)));
  }
  return out;
}

/* —— the worker and the cache —— */

export type PeaksRequest = { id: string; bytes: ArrayBuffer; durationMs?: number };
export type PeaksResponse = { id: string; peaks: Uint8Array } | { id: string; peaks: null; why: string };

/* a note whose decode came back null (an unknown container, a codec the platform lacks) is remembered as null too,
   so it is not fetched again; a failed fetch or a crashed worker is not remembered, and the next ask tries again. */
const cache = new Map<string, Uint8Array | null>();
const inflight = new Map<string, Promise<Uint8Array | null>>();
const waiting = new Map<string, (peaks: Uint8Array | null, keep: boolean) => void>();
let worker: Worker | null = null;

function remember(id: string, peaks: Uint8Array | null): void {
  cache.delete(id);
  cache.set(id, peaks);
  while (cache.size > LRU_SIZE) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function failAll(): void {
  const all = [...waiting.values()];
  waiting.clear();
  for (const done of all) done(null, false);
}

function theWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./peaks.worker.ts", import.meta.url), { type: "module", name: "peaks" });
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent<PeaksResponse>) => {
    const { id, peaks } = event.data;
    const done = waiting.get(id);
    waiting.delete(id);
    done?.(peaks, true);
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    failAll();
  };
  return worker;
}

/** the cached peaks for a note, without fetching: undefined when not yet known */
export function knownPeaks(id: string): Uint8Array | null | undefined {
  if (!cache.has(id)) return undefined;
  const peaks = cache.get(id) ?? null;
  remember(id, peaks);
  return peaks;
}

/** a note's 64 peaks, decoded off the main thread once and kept; null where the platform cannot (draw flatPeaks).
    concurrent asks for one note share one fetch and one decode. */
export function peaksFor(id: string, fetchBytes: () => Promise<ArrayBuffer>, durationMs?: number): Promise<Uint8Array | null> {
  const known = knownPeaks(id);
  if (known !== undefined) return Promise.resolve(known);
  const running = inflight.get(id);
  if (running) return running;
  const job = (async (): Promise<Uint8Array | null> => {
    const w = theWorker();
    if (!w) return null;
    let bytes: ArrayBuffer;
    try {
      bytes = await fetchBytes();
    } catch {
      return null;
    }
    return new Promise<Uint8Array | null>((resolve) => {
      waiting.set(id, (peaks, keep) => {
        if (keep) remember(id, peaks);
        resolve(peaks);
      });
      const request: PeaksRequest = durationMs === undefined ? { id, bytes } : { id, bytes, durationMs };
      w.postMessage(request, [bytes]);
    });
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

/* —— "within 2.5 screens of the view" —— */

const near = new Map<Element, Set<() => void>>();
let observer: IntersectionObserver | null = null;

/** calls cb once, when el first comes within 2.5 screens of the viewport; the returned function cancels.
    without IntersectionObserver it calls at once, since a late decode is better than none. */
export function watchNear(el: Element, cb: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) cb();
    });
    return () => {
      cancelled = true;
    };
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const cbs = near.get(entry.target);
        near.delete(entry.target);
        observer?.unobserve(entry.target);
        cbs?.forEach((f) => f());
      }
    },
    { rootMargin: "250%" },
  );
  let cbs = near.get(el);
  if (!cbs) {
    cbs = new Set();
    near.set(el, cbs);
    observer.observe(el);
  }
  const mine = (): void => cb();
  cbs.add(mine);
  return () => {
    const set = near.get(el);
    if (!set) return;
    set.delete(mine);
    if (set.size === 0) {
      near.delete(el);
      observer?.unobserve(el);
    }
  };
}

/** test seam: forget the cache (the worker stays) */
export function resetPeaksCache(): void {
  cache.clear();
}
