import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demux, opusPacketDuration, sniff, type Demuxed } from "./demux";

/* each fixture: 1.5 s of mono audio, a 440 hz tone for the first 0.75 s and silence after, made with
   ffmpeg -f lavfi -i "sine=f=440:d=0.75:sample_rate=48000,apad=whole_dur=1.5" -ac 1 and
   tone.ogg / tone.webm: -c:a libopus -b:a 24k; tone.m4a: -c:a aac -b:a 32k;
   tone-frag.m4a: the same plus -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 200000;
   tone.mp3: -ar 44100 -c:a libmp3lame -b:a 32k */
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

function shape(d: Demuxed | null, packetUs: number): Demuxed {
  expect(d).not.toBeNull();
  if (!d) throw new Error("null");
  /* 1.5 s of packets, give or take codec priming and padding */
  const expected = 1_500_000 / packetUs;
  expect(d.packets.length).toBeGreaterThanOrEqual(Math.floor(expected));
  expect(d.packets.length).toBeLessThanOrEqual(Math.ceil(expected) + 3);
  for (let i = 1; i < d.packets.length; i++) {
    expect(d.packets[i]?.timestamp ?? 0).toBeGreaterThan(d.packets[i - 1]?.timestamp ?? 0);
  }
  for (const p of d.packets) expect(p.data.length).toBeGreaterThan(0);
  expect(d.duration ?? 0).toBeGreaterThan(1_450_000);
  expect(d.duration ?? 0).toBeLessThan(1_600_000);
  return d;
}

/** rewrites every cluster's size (and the segment's) to "unknown", as MediaRecorder writes them */
function unknownSizes(webm: Uint8Array): Uint8Array {
  const out = webm.slice();
  const ids = [
    [0x1f, 0x43, 0xb6, 0x75],
    [0x18, 0x53, 0x80, 0x67],
  ];
  let patched = 0;
  for (let i = 0; i + 5 < out.length; i++) {
    if (!ids.some((id) => id.every((v, k) => out[i + k] === v))) continue;
    const first = out[i + 4] ?? 0;
    let len = 1;
    while (len <= 8 && (first & (0x80 >> (len - 1))) === 0) len++;
    out[i + 4] = (0xff >> (len - 1)) & 0xff;
    for (let k = 1; k < len; k++) out[i + 4 + k] = 0xff;
    patched++;
  }
  expect(patched).toBeGreaterThan(1);
  return out;
}

describe("demux", () => {
  test("sniffs the four containers and refuses the rest", () => {
    expect(sniff(fixture("tone.ogg"))).toBe("ogg");
    expect(sniff(fixture("tone.webm"))).toBe("webm");
    expect(sniff(fixture("tone.m4a"))).toBe("mp4");
    expect(sniff(fixture("tone.mp3"))).toBe("mp3");
    expect(demux(new TextEncoder().encode("this is not audio at all, just words"))).toBeNull();
    expect(demux(new Uint8Array(0))).toBeNull();
  });

  test("ogg opus: OpusHead as description, 20 ms packets at 48 kHz", () => {
    const d = shape(demux(fixture("tone.ogg").buffer as ArrayBuffer), 20_000);
    expect(d.container).toBe("ogg");
    expect(d.config.codec).toBe("opus");
    expect(d.config.sampleRate).toBe(48_000);
    expect(d.config.numberOfChannels).toBe(1);
    const head = d.config.description;
    expect(head && new TextDecoder().decode(head.subarray(0, 8))).toBe("OpusHead");
    /* pre-skip 312 samples; the length from the last granule, pre-skip taken off */
    expect(d.skip).toBe(6500);
    expect(d.duration).toBe(1_500_000);
    /* OpusTags is not a packet */
    expect(d.packets.some((p) => new TextDecoder().decode(p.data.subarray(0, 8)) === "OpusTags")).toBe(false);
  });

  test("webm opus: CodecPrivate as description, cluster timecodes", () => {
    const d = shape(demux(fixture("tone.webm")), 20_000);
    expect(d.container).toBe("webm");
    expect(d.config.codec).toBe("opus");
    expect(d.config.numberOfChannels).toBe(1);
    expect(d.config.description?.length).toBe(19);
  });

  test("webm with unknown-size segment and clusters reads the same packets", () => {
    const plain = demux(fixture("tone.webm"));
    const live = shape(demux(unknownSizes(fixture("tone.webm"))), 20_000);
    expect(live.packets.length).toBe(plain?.packets.length ?? -1);
    expect(live.packets.map((p) => p.timestamp)).toEqual(plain?.packets.map((p) => p.timestamp) ?? []);
  });

  test("m4a aac: AudioSpecificConfig, mp4a.40.2, 1024-sample packets", () => {
    const d = shape(demux(fixture("tone.m4a")), 21_333);
    expect(d.container).toBe("mp4");
    expect(d.config.codec).toBe("mp4a.40.2");
    expect(d.config.sampleRate).toBe(48_000);
    expect(d.config.numberOfChannels).toBe(1);
    expect(d.config.description?.length).toBeGreaterThanOrEqual(2);
    /* the edit list: 1024 samples of priming, then exactly 1.5 s */
    expect(d.skip).toBe(21_333);
    expect(d.duration).toBe(1_500_000);
  });

  test("fragmented m4a (moof/traf/trun) gives the same packets as the plain one", () => {
    const plain = demux(fixture("tone.m4a"));
    const frag = shape(demux(fixture("tone-frag.m4a")), 21_333);
    expect(frag.config.codec).toBe("mp4a.40.2");
    expect(frag.packets.length).toBe(plain?.packets.length ?? -1);
    expect(frag.packets.map((p) => p.data.length)).toEqual(plain?.packets.map((p) => p.data.length) ?? []);
  });

  test("mp3: frames from sync headers, the xing frame left out", () => {
    const d = shape(demux(fixture("tone.mp3")), (1152 / 44_100) * 1e6);
    expect(d.container).toBe("mp3");
    expect(d.config).toEqual({ codec: "mp3", sampleRate: 44_100, numberOfChannels: 1 });
    /* the lame tag's delay (+529 for the decoder) and padding */
    expect(d.skip).toBe(25_057);
    expect(d.duration).toBe(1_500_000);
  });

  test("a truncated file still demuxes what it has, or is null, and never throws", () => {
    for (const name of ["tone.ogg", "tone.webm", "tone.m4a", "tone-frag.m4a", "tone.mp3"]) {
      const bytes = fixture(name);
      for (const cut of [13, 100, Math.floor(bytes.length / 2), bytes.length - 7]) {
        expect(() => demux(bytes.subarray(0, cut))).not.toThrow();
      }
    }
    const half = demux(fixture("tone.ogg").subarray(0, 2200));
    expect(half?.packets.length ?? 0).toBeGreaterThan(10);
  });

  test("opus toc durations", () => {
    expect(opusPacketDuration(new Uint8Array([0x78]))).toBe(20_000); /* celt fb 20 ms, one frame */
    expect(opusPacketDuration(new Uint8Array([0x79]))).toBe(40_000); /* two frames */
    expect(opusPacketDuration(new Uint8Array([0x1b, 0x03]))).toBe(180_000); /* silk 60 ms × 3 */
    expect(opusPacketDuration(new Uint8Array([]))).toBeUndefined();
  });
});
