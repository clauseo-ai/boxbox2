/* the peaks worker: a note's bytes in, its 64 peaks out (peaks.ts asks). demuxed here (demux.ts) and decoded with
   webcodecs' AudioDecoder as a stream: each AudioData is reduced into fine bins (the rms of a short window) as it
   arrives and closed at once, so the clip's pcm is never held whole (docs/design.md, voice notes). the decode
   queue is kept short, so decoded frames cannot pile up either. */

import { demux } from "./demux";
import { PEAK_COUNT, reducePeaks, toBytes, type PeaksRequest, type PeaksResponse } from "./peaks";

/* decode at most this many packets ahead of the output callback */
const QUEUE = 16;

class Bins {
  private sums: number[] = [];
  private sum = 0;
  private count = 0;
  private scratch = new Float32Array(0);
  private power = new Float32Array(0);
  private perBin = 0;
  /* frames still to drop (encoder priming), and frames still to keep (the clip's own length, padding excluded) */
  private toSkip = -1;
  private toKeep = Infinity;

  constructor(
    private readonly binMs: number,
    private readonly skipUs = 0,
    private readonly lengthUs?: number,
  ) {}

  add(data: AudioData): void {
    const frames = data.numberOfFrames;
    const channels = data.numberOfChannels;
    if (this.perBin === 0) {
      this.perBin = Math.max(1, Math.round((data.sampleRate * this.binMs) / 1000));
      this.toSkip = Math.round((data.sampleRate * this.skipUs) / 1e6);
      if (this.lengthUs !== undefined && this.lengthUs > 0) this.toKeep = Math.round((data.sampleRate * this.lengthUs) / 1e6);
    }
    if (this.toKeep <= 0) return;
    if (this.scratch.length < frames) {
      this.scratch = new Float32Array(frames);
      this.power = new Float32Array(frames);
    }
    const pcm = this.scratch.subarray(0, frames);
    /* the bins hold the mean square over channels; one plane at a time keeps one frame's worth of scratch */
    const energy = this.power.subarray(0, frames);
    energy.fill(0);
    for (let c = 0; c < channels; c++) {
      data.copyTo(pcm, { planeIndex: c, format: "f32-planar" });
      for (let i = 0; i < frames; i++) {
        const v = pcm[i] ?? 0;
        energy[i] = (energy[i] ?? 0) + (v * v) / channels;
      }
    }
    let i = 0;
    if (this.toSkip > 0) {
      i = Math.min(frames, this.toSkip);
      this.toSkip -= i;
    }
    for (; i < frames && this.toKeep > 0; i++) {
      this.toKeep--;
      this.sum += energy[i] ?? 0;
      this.count++;
      if (this.count === this.perBin) this.flushBin();
    }
  }

  private flushBin(): void {
    this.sums.push(Math.sqrt(this.sum / this.count));
    this.sum = 0;
    this.count = 0;
  }

  done(): number[] {
    if (this.count > 0) this.flushBin();
    return this.sums;
  }
}

async function peaksOf(request: PeaksRequest): Promise<PeaksResponse> {
  const { id, bytes, durationMs } = request;
  if (typeof AudioDecoder === "undefined") return { id, peaks: null, why: "no AudioDecoder" };
  const demuxed = demux(bytes);
  if (!demuxed) return { id, peaks: null, why: "unknown container" };
  if (demuxed.packets.length === 0) return { id, peaks: null, why: "no audio packets" };
  const config: AudioDecoderConfig = {
    codec: demuxed.config.codec,
    sampleRate: demuxed.config.sampleRate,
    numberOfChannels: demuxed.config.numberOfChannels,
  };
  if (demuxed.config.description) config.description = demuxed.config.description;
  const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) return { id, peaks: null, why: `unsupported ${demuxed.container} ${config.codec}` };

  /* ~10 ms bins; a long note gets wider ones, so the bins stay a few thousand */
  const ms = durationMs ?? (demuxed.duration ?? 0) / 1000;
  const bins = new Bins(Math.max(10, ms / 4096), demuxed.skip ?? 0, demuxed.duration);
  let failure: string | null = null;
  let wake: (() => void) | null = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        bins.add(data);
      } catch (e) {
        failure ??= `reduce: ${String(e)}`;
      } finally {
        data.close();
      }
    },
    error: (e) => {
      failure ??= `decode: ${e.message}`;
      wake?.();
    },
  });
  decoder.addEventListener("dequeue", () => wake?.());
  try {
    decoder.configure(config);
    for (const p of demuxed.packets) {
      if (failure) break;
      while (decoder.decodeQueueSize >= QUEUE && !failure) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      const init: EncodedAudioChunkInit = { type: "key", timestamp: p.timestamp, data: p.data };
      if (p.duration !== undefined) init.duration = p.duration;
      decoder.decode(new EncodedAudioChunk(init));
    }
    if (!failure) await decoder.flush();
  } catch (e) {
    failure ??= `decode: ${String(e)}`;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  if (failure) return { id, peaks: null, why: failure };
  const fine = bins.done();
  if (fine.length === 0) return { id, peaks: null, why: "nothing decoded" };
  return { id, peaks: toBytes(reducePeaks(fine, PEAK_COUNT)) };
}

self.addEventListener("message", (event: MessageEvent<PeaksRequest>) => {
  const request = event.data;
  peaksOf(request)
    .catch((e: unknown): PeaksResponse => ({ id: request.id, peaks: null, why: String(e) }))
    .then((response) => self.postMessage(response));
});
