/* the composer's recorder on the web (docs/composer.md, recording; web and native): `MediaRecorder` on a `getUserMedia`
   stream, an encoded chunk every second into a buffer capped at 15 minutes and 12 mb (or the agent's maxBytes), the live
   levels from an `AnalyserNode` read once per 100 ms. it holds encoded chunks only, never raw samples, and the note's
   loudness as 64 + 128 bytes (recorder-model.ts). the microphone is held only while the recorder is open.

   the states are the law's table: asking (the platform's own prompt, which records nothing), refused, holding, locked,
   and a locked recording whose capture stopped (the cap, or an interruption), which is never sent by itself. */

import { createSignal } from "solid-js";
import { BAR_MS, barOf, bitrateOf, byteCap, CHUNK_MS, leftMs, MAX_MS, PeakBins, pickKind } from "./recorder-model";

export type RecorderState = "idle" | "asking" | "starting" | "holding" | "locked";

/** why a locked recording stopped capturing on its own */
export type Stopped = "cap" | "interrupted" | null;

/** a finished note, as the upload takes it (agents.md, upload: content-type, x-boxbox-duration-ms, x-boxbox-waveform) */
export type Recording = { blob: Blob; mime: string; durationMs: number; waveform: number[] };

/** what the browser offers: a test or a story hands in its own */
export type Platform = {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  permission: () => Promise<PermissionState | "unknown">;
  supported: (mime: string) => boolean;
  /** this device asked before and was granted (where the permissions api cannot say) */
  remembered: () => boolean;
  remember: () => void;
};

const KEY = "boxbox.mic.granted";

export function webPlatform(): Platform | null {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    permission: async () => {
      try {
        return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
      } catch {
        return "unknown";
      }
    },
    supported: (mime) => MediaRecorder.isTypeSupported(mime),
    remembered: () => {
      try {
        return localStorage.getItem(KEY) === "1";
      } catch {
        return false;
      }
    },
    remember: () => {
      try {
        localStorage.setItem(KEY, "1");
      } catch {
        // a private window keeps no storage: the platform will ask again, which is honest
      }
    },
  };
}

export type RecorderDeps = {
  platform: Platform | null;
  /** the agent's attachments: kinds the recording must be one of, and its maxBytes */
  kinds: readonly string[];
  maxBytes?: number;
  /** starting a recording stops any note playing */
  onStart?: () => void;
  /** a document whose hiding interrupts the recording (the page's own by default) */
  doc?: Document;
  /** the time cap; fifteen minutes always, shortened only by a story or a test that shows the cap without waiting for it */
  maxMs?: number;
};

export type Recorder = ReturnType<typeof createRecorder>;

export function createRecorder(deps: RecorderDeps) {
  const kind = deps.platform ? pickKind(deps.platform.supported, deps.kinds) : null;
  const cap = byteCap(deps.maxBytes);
  const maxMs = deps.maxMs ?? MAX_MS;
  const [state, setState] = createSignal<RecorderState>("idle");
  const [stopped, setStopped] = createSignal<Stopped>(null);
  const [elapsed, setElapsed] = createSignal(0);
  const [left, setLeft] = createSignal(MAX_MS);
  const [refused, setRefused] = createSignal(false);
  /** the live bars: a ring of the last 64 heights, and a count that moves once per bar so a canvas paints just the new one */
  const ring = new Uint8Array(64);
  const [bars, setBars] = createSignal(0);

  let stream: MediaStream | null = null;
  let rec: MediaRecorder | null = null;
  let ctx: AudioContext | null = null;
  let chunks: Blob[] = [];
  let bytes = 0;
  let bins = new PeakBins();
  let t0 = 0;
  let capturedMs = 0;
  let tick: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | null = null;
  /** a hold released while the microphone was still being opened */
  let abandoned = false;
  const doc = deps.doc ?? (typeof document === "undefined" ? undefined : document);

  /** a key press or a hold: true when it may record now; false when it asked the platform, or was refused */
  async function mayRecord(): Promise<boolean> {
    const p = deps.platform;
    if (!p) return false;
    const perm = await p.permission();
    if (perm === "denied") {
      setRefused(true);
      return false;
    }
    if (perm === "granted" || (perm === "unknown" && p.remembered())) return true;
    // the first press, ever: the platform's prompt, and nothing of ours. a grant leaves the composer as it was
    setState("asking");
    try {
      const s = await p.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      p.remember();
      setRefused(false);
    } catch {
      setRefused(true);
    }
    setState("idle");
    return false;
  }

  /** opens the microphone and starts capturing, held or locked */
  async function start(mode: "holding" | "locked"): Promise<boolean> {
    if (!kind || state() !== "idle") return false;
    abandoned = false;
    setState("starting");
    if (!(await mayRecord())) {
      if (state() === "starting") setState("idle");
      return false;
    }
    try {
      stream = await deps.platform?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) ?? null;
    } catch {
      setRefused(true);
      setState("idle");
      return false;
    }
    if (!stream) return false;
    if (abandoned) {
      release();
      setState("idle");
      return false;
    }
    setRefused(false);
    deps.onStart?.();
    chunks = [];
    bytes = 0;
    bins = new PeakBins();
    ring.fill(0);
    setBars(0);
    setStopped(null);
    rec = new MediaRecorder(stream, { mimeType: kind, audioBitsPerSecond: bitrateOf(kind) });
    rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      chunks.push(e.data);
      bytes += e.data.size;
      // the next second would not fit: stop now, with what fits
      if (bytes + e.data.size > cap) void stopCapture("cap");
    };
    rec.onerror = () => void stopCapture("interrupted");
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => void stopCapture("interrupted"));
    doc?.addEventListener("visibilitychange", onHidden);
    rec.start(CHUNK_MS);
    t0 = performance.now();
    capturedMs = 0;
    setElapsed(0);
    levels(stream);
    setState(mode);
    return true;
  }

  function levels(s: MediaStream) {
    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(s).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      tick = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        bins.push(peak);
        const n = bars();
        ring[n % ring.length] = barOf(peak);
        setBars(n + 1);
        const ms = performance.now() - t0;
        // the timer ticks once a second: the signal moves only when the shown second changes
        if (Math.floor(ms / 1000) !== Math.floor(elapsed() / 1000)) setElapsed(ms);
        setLeft(leftMs(ms, bytes, cap, maxMs));
        if (ms >= maxMs) void stopCapture("cap");
      }, BAR_MS);
    } catch {
      // no levels (an audio context refused): the note records with a flat live strip, and its peaks are flat
    }
  }

  const onHidden = () => {
    if (doc?.visibilityState === "hidden") void stopCapture("interrupted");
  };

  /** stops capturing and keeps what was captured; a cap or an interruption leaves the recorder locked, never sent */
  function stopCapture(why: Stopped): Promise<void> {
    if (stopping) return stopping;
    const r = rec;
    if (!r || r.state === "inactive") return Promise.resolve();
    capturedMs = performance.now() - t0;
    setElapsed(capturedMs);
    stopping = new Promise<void>((done) => {
      r.addEventListener("stop", () => done(), { once: true });
      r.stop();
    }).then(() => {
      release();
      stopping = null;
      if (why) {
        setStopped(why);
        setState("locked");
      }
    });
    return stopping;
  }

  function release() {
    clearInterval(tick);
    tick = undefined;
    doc?.removeEventListener("visibilitychange", onHidden);
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
    void ctx?.close().catch(() => undefined);
    ctx = null;
  }

  /** the hold or the lock became a lock */
  function lock() {
    if (state() === "holding") setState("locked");
  }

  /** dropped from memory at once: nothing is sent and nothing is kept */
  async function cancel() {
    if (state() === "starting") abandoned = true;
    await stopCapture(null);
    chunks = [];
    bytes = 0;
    rec = null;
    setStopped(null);
    setState("idle");
  }

  /** the note, finished: the recorder closes and hands over the bytes, their kind, the length and the 64 peaks */
  async function finish(): Promise<Recording | null> {
    if (state() === "starting") {
      abandoned = true;
      return null;
    }
    await stopCapture(null);
    const mime = rec?.mimeType || kind || "audio/webm";
    const out = chunks.length > 0 ? { blob: new Blob(chunks, { type: mime }), mime, durationMs: Math.round(capturedMs), waveform: bins.peaks() } : null;
    chunks = [];
    bytes = 0;
    rec = null;
    setStopped(null);
    setState("idle");
    return out;
  }

  /** how long the hold has lasted, for the too-short rule */
  const heldMs = () => (state() === "holding" ? performance.now() - t0 : 0);

  return { kind, state, stopped, elapsed, left, refused, setRefused, ring, bars, start, lock, cancel, finish, heldMs };
}
