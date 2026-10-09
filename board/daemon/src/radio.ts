/* the radio, both ways: tts readback out through `say`, mic level in
   through sox while the radio key is held. the meter is real rms off
   the real microphone or it is nothing — if sox cannot open the input
   (TCC not granted, device busy in an exclusive mode), the meter disables
   itself for the session and the board simply does not pretend
   (docs/scope-board.md: ship without the meter rather than with a fake).

   sox, not ffmpeg: ffmpeg 8.1's avfoundation input silently drops ~75%
   of audio frames on this machine (pts advance at 1x, sample count at
   0.25x — "speed=0.999x" while the file holds a quarter of the audio),
   so the meter answered ever-older audio the longer the key was held.
   sox's coreaudio input is honest realtime; --buffer 256 puts the first
   byte on stdout ~265ms after spawn (measured 2026-07-27). */

import type { Subprocess } from "bun";
import type { Logger } from "./log";

/** raw rms above this counts as voice for the hands-free silence clock.
    absolute on purpose — the auto-gain below normalizes room tone into
    visible bars, so the bars cannot be the ear. first light put
    desk-distance speech comfortably above quiet-room ambience on this
    scale; BENCH-tune if the clock ever cuts a quiet talker. */
const VOICE_RMS = 0.004;

export class Radio {
  private meterProc: Subprocess<"ignore", "pipe", "ignore"> | null = null;
  private meterDisabled = false;
  /** last four rms windows, newest last, 0..5 — a scrolling histogram */
  private bands: [number, number, number, number] = [0, 0, 0, 0];
  /** running peak for auto-gain: the meter self-calibrates to the mic
      distance instead of assuming a broadcast booth (first light: linear
      rms off the built-in mic at desk distance lit one bar, ever) */
  private peak = 0.02;
  /** per-hold meter stats, reported at stopMeter */
  private windows = 0;
  private silentWindows = 0;
  /** last window that crossed the voice floor, ms epoch. seeded at
      startMeter so an opened mic gets the full silence window before
      the hands-free clock can fire. */
  private voiceAt = 0;

  constructor(
    private voice: string,
    private enabled: boolean,
    private log: Logger,
  ) {}

  retune(voice: string, enabled: boolean) {
    this.voice = voice;
    this.enabled = enabled;
  }

  /** speak, fire and forget. used for the loudest-call readback. */
  say(text: string) {
    try {
      const args = this.voice ? ["say", "-v", this.voice, text] : ["say", text];
      Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    } catch (e) {
      this.log.warn("radio.say_failed", { message: String(e) });
    }
  }

  meterActive(): boolean {
    return this.meterProc !== null;
  }

  levels(): [number, number, number, number] {
    return this.bands;
  }

  /** ms since the meter last heard voice. Infinity before the first
      startMeter — the hands-free clock treats that as "no ear" and
      falls back to its hard cap. */
  msSinceVoice(now: number): number {
    return this.voiceAt === 0 ? Number.POSITIVE_INFINITY : now - this.voiceAt;
  }

  startMeter() {
    if (!this.enabled || this.meterDisabled || this.meterProc) return;
    this.windows = 0;
    this.silentWindows = 0;
    this.voiceAt = Date.now();
    try {
      const proc = Bun.spawn(
        [
          "sox", "-q", "--buffer", "256",
          "-t", "coreaudio", "default",
          "-t", "raw", "-b", "16", "-e", "signed-integer", "-L",
          "-c", "1", "-r", "8000", "-",
        ],
        { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
      );
      this.meterProc = proc;
      void this.readLoop(proc);
      /* an exit while still current means sox died on its own (no mic:
         TCC denied, device gone): stop pretending for the rest of this
         daemon's life. stopMeter nulls meterProc BEFORE killing, so our
         own teardown never lands here — ffmpeg exited 255 on SIGTERM
         and the old unconditional check read every release of the key
         as a mic failure, disabling the meter after its first use. */
      void proc.exited.then((code) => {
        if (this.meterProc !== proc) return;
        this.meterProc = null;
        if (code !== 0 && !this.meterDisabled) {
          this.meterDisabled = true;
          this.log.warn("radio.meter_disabled", { code });
        }
      });
    } catch (e) {
      this.meterDisabled = true;
      this.log.warn("radio.meter_spawn_failed", { message: String(e) });
    }
  }

  stopMeter() {
    const proc = this.meterProc;
    this.meterProc = null;
    this.bands = [0, 0, 0, 0];
    if (proc) {
      /* the honesty line: a TCC-denied mic looks EXACTLY like a healthy
         one (sox runs, exits 0 on kill) except every sample is zero —
         the 2026-07-27 hunt had no log line at all to go on. windows=0
         means no audio arrived; silent=windows means it was all zeros
         (denied mic delivers silence, not errors). */
      this.log.info("radio.meter_stats", {
        windows: this.windows,
        silent: this.silentWindows,
      });
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }

  private async readLoop(proc: Subprocess<"ignore", "pipe", "ignore">) {
    /* 8000hz s16le mono: 25ms = 200 samples = 400 bytes per window.
       40 windows/s — the head band tracks syllables, the scroll reads as
       motion instead of mush (first light: 100ms windows felt like the
       meter was answering yesterday's audio) */
    const WINDOW_BYTES = 400;
    let held = new Uint8Array(0);
    const reader = proc.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.meterProc !== proc) break;
        const merged = new Uint8Array(held.length + value.length);
        merged.set(held);
        merged.set(value, held.length);
        let offset = 0;
        while (merged.length - offset >= WINDOW_BYTES) {
          const view = new DataView(merged.buffer, merged.byteOffset + offset, WINDOW_BYTES);
          let sum = 0;
          for (let i = 0; i < WINDOW_BYTES; i += 2) {
            const s = view.getInt16(i, true) / 32768;
            sum += s * s;
          }
          const rms = Math.sqrt(sum / (WINDOW_BYTES / 2));
          this.windows += 1;
          if (rms === 0) this.silentWindows += 1;
          if (rms >= VOICE_RMS) this.voiceAt = Date.now();
          /* auto-gain + sqrt compression: track the peak (slow decay so a
             shout recalibrates instantly and silence lets it drift down),
             normalize against it, compress the top. lively at any mic
             distance, honest at all of them. decay tuned for 40 win/s. */
          this.peak = Math.max(this.peak * 0.9992, rms, 0.008);
          const norm = Math.sqrt(Math.min(1, rms / this.peak));
          const height = Math.round(norm * 5);
          this.bands = [this.bands[1], this.bands[2], this.bands[3], height];
          offset += WINDOW_BYTES;
        }
        held = merged.slice(offset);
      }
    } catch {
      /* stream ended with the process */
    } finally {
      reader.releaseLock();
    }
  }
}
