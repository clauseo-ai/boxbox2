/* the assistant stories' fixtures: one agent per state worth drawing, and parts built the way contract 2 sends them. the
   names are placeholders (an assistant called wren on vm-b), as a public repo needs. the sound is made here, in the page:
   a short tone with a spoken-word envelope written as a wav, so a story can really play it and the peaks are true. */

import type { Agent, AudioPart, Capabilities, FilePart, ImagePart } from "../wire";

export const AT = new Date(2026, 9, 15, 11, 34).getTime();
export const NAME = "wren";
export const MACHINE = "vm-b";

const CAPS: Capabilities = {
  places: false, worktree: false, terminal: false, review: false, compact: false, queue: true, steer: false, model: true,
  reasoning: { word: "thinking", levels: ["off", "minimal", "low", "medium", "high"] },
  approvals: true, questions: true,
  attachments: { kinds: ["image/*", "audio/*", "video/*", "application/pdf", "text/*"], maxBytes: 20 * 1024 * 1024, maxCount: 8 },
  voice: { notes: true, replies: true }, quotes: true, reactions: true, threads: true, archive: true, commands: false, files: false,
  shell: false, history: true, subagents: true, spend: false, origins: true, admin: false,
};

export const WREN: Agent = {
  key: "vm-b-main",
  label: { name: NAME, source: "openclaw", machine: MACHINE },
  kind: "assistant",
  source: "openclaw",
  mark: "round",
  palette: "coral",
  status: "ready",
  connection: { name: "vm-b", url: "wss://vm-b.example:18789", origin: "paired", since: AT - 3 * 3_600_000, lastError: null, connects: 1, version: "2026.10.1", pinned: "2026.10.1", untested: false, protocol: 4, refused: null, contract: null, contractMatches: null, memory: null },
  capabilities: CAPS,
  runs: null,
};

/** a waveform as a device would send it: 64 loudness values with a speaker's rhythm */
export function speech(seed: number, n = 64): number[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, (_, i) => {
    const phrase = Math.sin((i / n) * Math.PI * 3 + seed) * 0.5 + 0.5;
    const gap = i % 13 === 12 ? 0.15 : 1;
    return Math.round(Math.min(255, (40 + 215 * phrase * (0.55 + 0.45 * rnd())) * gap));
  });
}

let partSeq = 0;
const base = (messageID: string) => ({ id: `prt_${++partSeq}`, messageID, at: { step: 0, index: 0 } });

export function voice(messageID: string, ms: number, extra: Partial<AudioPart> = {}): AudioPart {
  return { ...base(messageID), type: "audio", mime: "audio/ogg", media: { id: `m${partSeq}`, state: "ready" }, durationMs: ms, flavour: "voice", ...extra };
}

export function image(messageID: string, extra: Partial<ImagePart> = {}): ImagePart {
  return { ...base(messageID), type: "image", mime: "image/png", media: { id: `m${partSeq}`, state: "ready" }, flavour: "generated", ...extra };
}

export function file(messageID: string, filename: string, mime: string, size: number, extra: Partial<FilePart> = {}): FilePart {
  return { ...base(messageID), type: "file", mime, filename, size, media: { id: `m${partSeq}`, state: "ready" }, flavour: "attached", ...extra };
}

/** every tone's url and its length, ms: the screenshot test's stand-in element reads its duration here (fake-audio.ts) */
export const TONES = new Map<string, number>();

/** a wav of `ms` with a voice's rise and fall, as an object url the player can stream */
export function toneUrl(ms: number, pitch = 220): string {
  const rate = 8000;
  const n = Math.round((ms / 1000) * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.max(0, Math.sin(t * Math.PI * 1.7)) * (0.6 + 0.4 * Math.sin(t * 9));
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * pitch * t) * env * 9000), true);
  }
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  TONES.set(url, ms);
  return url;
}

/** a picture drawn in the page: a gradient of the palette with a few shapes, at its own size, as a data url */
export function pictureUrl(w: number, h: number, hue = 8): string {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  if (!g) return "";
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue} 70% 62%)`);
  grad.addColorStop(1, `hsl(${hue + 40} 60% 28%)`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgb(255 255 255 / 0.5)";
  g.beginPath(); g.arc(w * 0.7, h * 0.35, Math.min(w, h) * 0.18, 0, Math.PI * 2); g.fill();
  g.fillStyle = "rgb(0 0 0 / 0.25)";
  g.beginPath(); g.moveTo(0, h); g.lineTo(w * 0.35, h * 0.55); g.lineTo(w * 0.6, h * 0.8); g.lineTo(w * 0.8, h * 0.6); g.lineTo(w, h); g.fill();
  return c.toDataURL("image/png");
}