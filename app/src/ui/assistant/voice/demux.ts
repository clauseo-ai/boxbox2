/* containers to encoded audio packets, for the peaks worker (peaks.worker.ts) to feed webcodecs' AudioDecoder.

   pure: bytes in, a decoder config and packets out, nothing decoded. packets are views into the input (no copies),
   so the note's encoded bytes are the only large thing held; pcm is never kept (docs/design.md, voice notes).
   four containers, the ones voice notes arrive in: ogg/opus, webm (matroska) opus as MediaRecorder writes it
   (unknown-size clusters included), mp4/m4a aac or opus (plain and fragmented), and bare mp3 frames. anything
   else is null and the caller draws the flat line. timestamps and durations are microseconds. */

export type AudioConfig = {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: Uint8Array;
};

export type Packet = {
  data: Uint8Array;
  /** µs from the start of the stream */
  timestamp: number;
  /** µs, where the container or the codec says */
  duration?: number;
};

export type Container = "ogg" | "webm" | "mp4" | "mp3";

export type Demuxed = {
  container: Container;
  config: AudioConfig;
  packets: Packet[];
  /** µs: the clip's own length where the container says (priming and padding excluded), else the packets' sum */
  duration?: number;
  /** µs of encoder priming at the head of the decoded audio (opus pre-skip, aac's edit list, lame's delay), to drop */
  skip?: number;
};

export function sniff(bytes: Uint8Array): Container | null {
  if (bytes.length < 12) return null;
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (u32be(bytes, 0) === 0x1a45dfa3) return "webm";
  const box = ascii(bytes, 4, 4);
  if (box === "ftyp" || box === "moov" || box === "moof" || box === "styp" || box === "free" || box === "mdat") return "mp4";
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (mp3Header(bytes, 0) && mp3Header(bytes, mp3Header(bytes, 0)?.length ?? 0)) return "mp3";
  return null;
}

export function demux(input: ArrayBuffer | Uint8Array): Demuxed | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    switch (sniff(bytes)) {
      case "ogg":
        return demuxOgg(bytes);
      case "webm":
        return demuxWebm(bytes);
      case "mp4":
        return demuxMp4(bytes);
      case "mp3":
        return demuxMp3(bytes);
      default:
        return null;
    }
  } catch {
    /* a truncated or malformed file reads past its end somewhere: that is "cannot", not a crash */
    return null;
  }
}

/* —— bytes —— */

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i] ?? 0);
  return s;
}
function byte(b: Uint8Array, at: number): number {
  const v = b[at];
  if (v === undefined) throw new RangeError("past end");
  return v;
}
function u16be(b: Uint8Array, at: number): number {
  return (byte(b, at) << 8) | byte(b, at + 1);
}
function u24be(b: Uint8Array, at: number): number {
  return (byte(b, at) << 16) | (byte(b, at + 1) << 8) | byte(b, at + 2);
}
function u32be(b: Uint8Array, at: number): number {
  return ((byte(b, at) << 24) >>> 0) + ((byte(b, at + 1) << 16) | (byte(b, at + 2) << 8) | byte(b, at + 3));
}
function u64be(b: Uint8Array, at: number): number {
  return u32be(b, at) * 2 ** 32 + u32be(b, at + 4);
}
function u16le(b: Uint8Array, at: number): number {
  return byte(b, at) | (byte(b, at + 1) << 8);
}
function u32le(b: Uint8Array, at: number): number {
  return (byte(b, at) | (byte(b, at + 1) << 8) | (byte(b, at + 2) << 16)) + byte(b, at + 3) * 2 ** 24;
}
function u64le(b: Uint8Array, at: number): number {
  return u32le(b, at) + u32le(b, at + 4) * 2 ** 32;
}

function totalDuration(packets: Packet[]): number | undefined {
  const last = packets[packets.length - 1];
  if (!last) return undefined;
  return last.timestamp + (last.duration ?? 0);
}

/* —— opus: a packet's length from its toc byte (rfc 6716 §3.1) —— */

/** µs of audio in one opus packet, or undefined when it is empty or malformed */
export function opusPacketDuration(packet: Uint8Array): number | undefined {
  const toc = packet[0];
  if (toc === undefined) return undefined;
  const config = toc >> 3;
  let frameUs: number;
  if (config < 12) frameUs = [10_000, 20_000, 40_000, 60_000][config % 4] ?? 20_000;
  else if (config < 16) frameUs = config % 2 === 0 ? 10_000 : 20_000;
  else frameUs = [2_500, 5_000, 10_000, 20_000][config % 4] ?? 20_000;
  const code = toc & 3;
  let frames = 1;
  if (code === 1 || code === 2) frames = 2;
  else if (code === 3) {
    const count = packet[1];
    if (count === undefined) return undefined;
    frames = count & 0x3f;
  }
  return frames * frameUs;
}

/** builds the 19-byte OpusHead (rfc 7845 §5.1) webcodecs takes as an opus description */
function opusHead(channels: number, preSkip: number, inputRate: number, gain = 0, family = 0, mapping?: Uint8Array): Uint8Array {
  const head = new Uint8Array(19 + (family !== 0 && mapping ? mapping.length : 0));
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  const view = new DataView(head.buffer);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, gain, true);
  head[18] = family;
  if (family !== 0 && mapping) head.set(mapping, 19);
  return head;
}

/* —— ogg (rfc 3533) carrying opus (rfc 7845) —— */

function demuxOgg(b: Uint8Array): Demuxed | null {
  let serial: number | null = null;
  let head: Uint8Array | null = null;
  let headersSeen = 0;
  const packets: Packet[] = [];
  let pending: Uint8Array[] = [];
  let clock = 0;
  let lastGranule = -1;

  const finish = (parts: Uint8Array[]): Uint8Array => {
    if (parts.length === 1) return parts[0] ?? new Uint8Array(0);
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  let at = 0;
  while (at + 27 <= b.length) {
    if (ascii(b, at, 4) !== "OggS") {
      /* resync on garbage between pages */
      at++;
      continue;
    }
    const pageSerial = u32le(b, at + 14);
    if (serial !== null && pageSerial === serial) {
      const granule = u64le(b, at + 6);
      if (granule < 2 ** 52) lastGranule = granule;
    }
    const segments = byte(b, at + 26);
    let body = at + 27 + segments;
    const lacing = b.subarray(at + 27, at + 27 + segments);
    const mine = serial === null || pageSerial === serial;
    for (let i = 0; i < segments; i++) {
      const len = lacing[i] ?? 0;
      if (mine) pending.push(b.subarray(body, Math.min(body + len, b.length)));
      body += len;
      if (len < 255 && mine) {
        const packet = finish(pending);
        pending = [];
        if (serial === null) {
          /* the first packet of a stream: opus or not ours */
          if (ascii(packet, 0, 8) !== "OpusHead") {
            continue;
          }
          serial = pageSerial;
          head = packet;
          headersSeen = 1;
        } else if (headersSeen === 1) {
          headersSeen = 2; /* OpusTags */
        } else if (packet.length > 0) {
          const duration = opusPacketDuration(packet);
          const p: Packet = { data: packet, timestamp: clock };
          if (duration !== undefined) {
            p.duration = duration;
            clock += duration;
          }
          packets.push(p);
        }
      }
    }
    if (serial === null) pending = [];
    at = body;
  }
  if (!head || head.length < 19) return null;
  const channels = byte(head, 9);
  const config: AudioConfig = { codec: "opus", sampleRate: 48_000, numberOfChannels: channels, description: head };
  const preSkip = u16le(head, 10);
  const out: Demuxed = { container: "ogg", config, packets };
  if (preSkip > 0) out.skip = Math.round((preSkip * 1_000_000) / 48_000);
  const duration = lastGranule > preSkip ? Math.round(((lastGranule - preSkip) * 1_000_000) / 48_000) : totalDuration(packets);
  if (duration !== undefined) out.duration = duration;
  return out;
}

/* —— webm / matroska —— */

const EBML = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  CodecDelay: 0x56aa,
} as const;

/* the segment's children: in an unknown-size cluster, meeting one of these means the cluster has ended */
const LEVEL1 = new Set<number>([
  0x114d9b74 /* SeekHead */,
  EBML.Info,
  EBML.Tracks,
  EBML.Cluster,
  0x1c53bb6b /* Cues */,
  0x1941a469 /* Attachments */,
  0x1043a770 /* Chapters */,
  0x1254c367 /* Tags */,
]);

type Vint = { value: number; length: number; unknown: boolean };

function vint(b: Uint8Array, at: number, keepMarker: boolean): Vint {
  const first = byte(b, at);
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > 8) throw new RangeError("bad vint");
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const v = byte(b, at + i);
    if (v !== 0xff) allOnes = false;
    value = value * 256 + v;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

type Element = { id: number; start: number; data: number; end: number; unknown: boolean };

function element(b: Uint8Array, at: number, parentEnd: number): Element {
  const id = vint(b, at, true);
  const size = vint(b, at + id.length, false);
  const data = at + id.length + size.length;
  const end = size.unknown ? parentEnd : Math.min(data + size.value, parentEnd);
  return { id: id.value, start: at, data, end, unknown: size.unknown };
}

function uint(b: Uint8Array, from: number, to: number): number {
  let v = 0;
  for (let i = from; i < to; i++) v = v * 256 + byte(b, i);
  return v;
}
function float(b: Uint8Array, from: number, to: number): number {
  const view = new DataView(b.buffer, b.byteOffset + from, to - from);
  return to - from === 4 ? view.getFloat32(0) : to - from === 8 ? view.getFloat64(0) : 0;
}

type Track = { number: number; type: number; codec: string; priv?: Uint8Array; rate: number; channels: number; delayNs?: number };

function webmCodec(t: Track): AudioConfig | null {
  const base = { sampleRate: t.rate, numberOfChannels: t.channels };
  switch (t.codec) {
    case "A_OPUS":
      return { codec: "opus", sampleRate: 48_000, numberOfChannels: t.channels, ...(t.priv ? { description: t.priv } : {}) };
    case "A_VORBIS":
      return t.priv ? { codec: "vorbis", ...base, description: t.priv } : null;
    case "A_AAC":
      if (!t.priv) return null;
      return { codec: aacCodec(t.priv, 0x40), ...base, description: t.priv };
    case "A_MPEG/L3":
      return { codec: "mp3", ...base };
    case "A_FLAC":
      return t.priv ? { codec: "flac", ...base, description: t.priv } : null;
    default:
      return null;
  }
}

function demuxWebm(b: Uint8Array): Demuxed | null {
  let scale = 1_000_000; /* ns per timecode tick */
  let infoDuration: number | undefined;
  let track: Track | null = null;
  const packets: Packet[] = [];
  let durationsFromBlocks = false;

  const readTrack = (e: Element): Track => {
    const t: Track = { number: 0, type: 0, codec: "", rate: 8000, channels: 1 };
    for (let at = e.data; at < e.end; ) {
      const c = element(b, at, e.end);
      if (c.id === EBML.TrackNumber) t.number = uint(b, c.data, c.end);
      else if (c.id === EBML.TrackType) t.type = uint(b, c.data, c.end);
      else if (c.id === EBML.CodecID) t.codec = ascii(b, c.data, c.end - c.data).replace(/\0+$/, "");
      else if (c.id === EBML.CodecPrivate) t.priv = b.subarray(c.data, c.end);
      else if (c.id === EBML.CodecDelay) t.delayNs = uint(b, c.data, c.end);
      else if (c.id === EBML.Audio) {
        for (let a = c.data; a < c.end; ) {
          const d = element(b, a, c.end);
          if (d.id === EBML.SamplingFrequency) t.rate = Math.round(float(b, d.data, d.end));
          else if (d.id === EBML.Channels) t.channels = uint(b, d.data, d.end);
          a = d.end;
        }
      }
      at = c.end;
    }
    return t;
  };

  const block = (from: number, to: number, cluster: number, blockDuration?: number): void => {
    if (!track) return;
    const num = vint(b, from, false);
    if (num.value !== track.number) return;
    let at = from + num.length;
    const rel = (u16be(b, at) << 16) >> 16;
    const flags = byte(b, at + 2);
    at += 3;
    const frames = unlace(b, at, to, (flags >> 1) & 3);
    let ts = ((cluster + rel) * scale) / 1000;
    for (const data of frames) {
      const p: Packet = { data, timestamp: Math.round(ts) };
      const d =
        track.codec === "A_OPUS"
          ? opusPacketDuration(data)
          : blockDuration !== undefined && frames.length === 1
            ? (blockDuration * scale) / 1000
            : undefined;
      if (d !== undefined) {
        p.duration = Math.round(d);
        ts += d;
        durationsFromBlocks = true;
      }
      packets.push(p);
    }
  };

  const cluster = (e: Element): number => {
    let timecode = 0;
    let at = e.data;
    while (at < e.end) {
      const c = element(b, at, e.end);
      if (e.unknown && LEVEL1.has(c.id)) return at;
      if (c.id === EBML.Timecode) timecode = uint(b, c.data, c.end);
      else if (c.id === EBML.SimpleBlock) block(c.data, c.end, timecode);
      else if (c.id === EBML.BlockGroup) {
        let blockAt: Element | null = null;
        let dur: number | undefined;
        for (let g = c.data; g < c.end; ) {
          const d = element(b, g, c.end);
          if (d.id === EBML.Block) blockAt = d;
          else if (d.id === EBML.BlockDuration) dur = uint(b, d.data, d.end);
          g = d.end;
        }
        if (blockAt) block(blockAt.data, blockAt.end, timecode, dur);
      }
      at = c.end;
    }
    return e.end;
  };

  /* top level: the EBML header, then the segment (whose size MediaRecorder leaves unknown) */
  let at = 0;
  while (at < b.length) {
    const top = element(b, at, b.length);
    if (top.id !== EBML.Segment) {
      at = top.end;
      continue;
    }
    let s = top.data;
    while (s < top.end) {
      const e = element(b, s, top.end);
      if (e.id === EBML.Info) {
        let rawDuration: number | undefined;
        for (let i = e.data; i < e.end; ) {
          const c = element(b, i, e.end);
          if (c.id === EBML.TimecodeScale) scale = uint(b, c.data, c.end);
          else if (c.id === EBML.Duration) rawDuration = float(b, c.data, c.end);
          i = c.end;
        }
        if (rawDuration !== undefined && rawDuration > 0) infoDuration = Math.round((rawDuration * scale) / 1000);
        s = e.end;
      } else if (e.id === EBML.Tracks) {
        for (let i = e.data; i < e.end; ) {
          const c = element(b, i, e.end);
          if (c.id === EBML.TrackEntry && !track) {
            const t = readTrack(c);
            if (t.type === 2) track = t;
          }
          i = c.end;
        }
        s = e.end;
      } else if (e.id === EBML.Cluster) {
        s = cluster(e);
      } else {
        s = e.end;
      }
    }
    at = top.end;
  }
  if (!track) return null;
  const config = webmCodec(track);
  if (!config) return null;
  /* without per-frame durations, a frame lasts until the next one starts */
  if (!durationsFromBlocks) {
    for (let i = 0; i + 1 < packets.length; i++) {
      const p = packets[i];
      const next = packets[i + 1];
      if (p && next && next.timestamp > p.timestamp) p.duration = next.timestamp - p.timestamp;
    }
  }
  const out: Demuxed = { container: "webm", config, packets };
  if (track.delayNs) out.skip = Math.round(track.delayNs / 1000);
  else if (track.codec === "A_OPUS" && track.priv && track.priv.length >= 12) {
    const preSkip = u16le(track.priv, 10);
    if (preSkip > 0) out.skip = Math.round((preSkip * 1_000_000) / 48_000);
  }
  const duration = infoDuration ?? totalDuration(packets);
  if (duration !== undefined) out.duration = duration;
  return out;
}

function unlace(b: Uint8Array, at: number, end: number, lacing: number): Uint8Array[] {
  if (lacing === 0) return [b.subarray(at, end)];
  const count = byte(b, at) + 1;
  at++;
  const sizes: number[] = [];
  if (lacing === 1) {
    /* xiph */
    for (let i = 0; i < count - 1; i++) {
      let size = 0;
      let v: number;
      do {
        v = byte(b, at++);
        size += v;
      } while (v === 255);
      sizes.push(size);
    }
  } else if (lacing === 3) {
    /* ebml: the first size whole, the rest signed differences */
    const first = vint(b, at, false);
    at += first.length;
    sizes.push(first.value);
    let prev = first.value;
    for (let i = 1; i < count - 1; i++) {
      const d = vint(b, at, false);
      at += d.length;
      const bias = 2 ** (7 * d.length - 1) - 1;
      prev = prev + (d.value - bias);
      sizes.push(prev);
    }
  } else {
    /* fixed */
    const each = Math.floor((end - at) / count);
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    frames.push(b.subarray(at, at + size));
    at += size;
  }
  frames.push(b.subarray(at, end));
  return frames;
}

/* —— mp4 / m4a (iso bmff) —— */

type Box = { type: string; start: number; data: number; end: number };

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    let data = at + 8;
    if (size === 1) {
      size = u64be(b, at + 8);
      data = at + 16;
    } else if (size === 0) size = to - at;
    if (size < data - at) break;
    const end = Math.min(at + size, to);
    out.push({ type, start: at, data, end });
    at = at + size;
  }
  return out;
}
function child(b: Uint8Array, parent: Box | undefined, type: string): Box | undefined {
  if (!parent) return undefined;
  return boxes(b, parent.data, parent.end).find((x) => x.type === type);
}
function path(b: Uint8Array, parent: Box | undefined, ...types: string[]): Box | undefined {
  let at = parent;
  for (const t of types) at = child(b, at, t);
  return at;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** the codec string for an mp4 object type and its decoder-specific info (an AudioSpecificConfig for aac) */
function aacCodec(asc: Uint8Array | undefined, objectType: number): string {
  if (objectType === 0x6b || objectType === 0x69) return "mp3";
  let aot = 2;
  if (asc && asc.length > 0) {
    aot = byte(asc, 0) >> 3;
    if (aot === 31 && asc.length > 1) aot = 32 + (((byte(asc, 0) & 7) << 3) | (byte(asc, 1) >> 5));
  }
  return `mp4a.${objectType.toString(16)}.${aot}`;
}

/** sample rate and channels from an AudioSpecificConfig, where it states them plainly */
function ascShape(asc: Uint8Array): { rate?: number; channels?: number } {
  if (asc.length < 2) return {};
  const aot = byte(asc, 0) >> 3;
  if (aot === 31) return {};
  const index = ((byte(asc, 0) & 7) << 1) | (byte(asc, 1) >> 7);
  if (index === 15) return {};
  const channels = (byte(asc, 1) >> 3) & 0xf;
  const rate = AAC_RATES[index];
  return { ...(rate ? { rate } : {}), ...(channels > 0 ? { channels } : {}) };
}

/** the DecoderConfigDescriptor's object type and DecoderSpecificInfo inside an esds box */
function esds(b: Uint8Array, box: Box): { objectType: number; asc?: Uint8Array } | null {
  let at = box.data + 4; /* fullbox version + flags */
  const descriptor = (): { tag: number; data: number; end: number } => {
    const tag = byte(b, at++);
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const v = byte(b, at++);
      len = (len << 7) | (v & 0x7f);
      if ((v & 0x80) === 0) break;
    }
    return { tag, data: at, end: at + len };
  };
  const es = descriptor();
  if (es.tag !== 0x03) return null;
  at += 2;
  const flags = byte(b, at++);
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + byte(b, at);
  if (flags & 0x20) at += 2;
  while (at < es.end) {
    const d = descriptor();
    if (d.tag === 0x04) {
      const objectType = byte(b, d.data);
      at = d.data + 13;
      while (at < d.end) {
        const s = descriptor();
        if (s.tag === 0x05) return { objectType, asc: b.subarray(s.data, s.end) };
        at = s.end;
      }
      return { objectType };
    }
    at = d.end;
  }
  return null;
}

type Mp4Track = {
  id: number;
  timescale: number;
  config: AudioConfig;
  defaultDuration: number;
  defaultSize: number;
};

function sampleEntry(b: Uint8Array, stsd: Box): AudioConfig | null {
  const entry = boxes(b, stsd.data + 8, stsd.end)[0];
  if (!entry) return null;
  const version = u16be(b, entry.data + 8);
  const channels = u16be(b, entry.data + 16);
  const rate = u32be(b, entry.data + 24) >>> 16;
  const childrenAt = entry.data + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  const kids = boxes(b, childrenAt, entry.end);
  if (entry.type === "mp4a") {
    const e = kids.find((k) => k.type === "esds");
    const info = e ? esds(b, e) : null;
    if (!info) return { codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: channels };
    const codec = aacCodec(info.asc, info.objectType);
    if (codec === "mp3") return { codec, sampleRate: rate, numberOfChannels: channels };
    const shape = info.asc ? ascShape(info.asc) : {};
    return {
      codec,
      sampleRate: shape.rate ?? rate,
      numberOfChannels: shape.channels ?? channels,
      ...(info.asc ? { description: info.asc } : {}),
    };
  }
  if (entry.type === "Opus") {
    const d = kids.find((k) => k.type === "dOps");
    if (!d) return { codec: "opus", sampleRate: 48_000, numberOfChannels: channels };
    /* dOps is OpusHead's fields big-endian without the magic (iso/iec 23003-5 / opus-in-isobmff §4.3.2) */
    const n = byte(b, d.data + 1);
    const family = byte(b, d.data + 10);
    const head = opusHead(
      n,
      u16be(b, d.data + 2),
      u32be(b, d.data + 4),
      (u16be(b, d.data + 8) << 16) >> 16,
      family,
      family !== 0 ? b.subarray(d.data + 11, d.data + 13 + n) : undefined,
    );
    return { codec: "opus", sampleRate: 48_000, numberOfChannels: n, description: head };
  }
  if (entry.type === ".mp3") return { codec: "mp3", sampleRate: rate, numberOfChannels: channels };
  if (entry.type === "fLaC") return null;
  return null;
}

function demuxMp4(b: Uint8Array): Demuxed | null {
  const top = boxes(b, 0, b.length);
  const moov = top.find((x) => x.type === "moov");
  if (!moov) return null;
  let track: Mp4Track | null = null;
  let trak: Box | undefined;
  for (const t of boxes(b, moov.data, moov.end)) {
    if (t.type !== "trak") continue;
    const hdlr = path(b, t, "mdia", "hdlr");
    if (!hdlr || ascii(b, hdlr.data + 8, 4) !== "soun") continue;
    const tkhd = child(b, t, "tkhd");
    const mdhd = path(b, t, "mdia", "mdhd");
    const stsd = path(b, t, "mdia", "minf", "stbl", "stsd");
    if (!tkhd || !mdhd || !stsd) continue;
    const config = sampleEntry(b, stsd);
    if (!config) continue;
    const tv = byte(b, tkhd.data);
    const mv = byte(b, mdhd.data);
    track = {
      id: u32be(b, tkhd.data + (tv === 1 ? 20 : 12)),
      timescale: u32be(b, mdhd.data + (mv === 1 ? 20 : 12)),
      config,
      defaultDuration: 0,
      defaultSize: 0,
    };
    trak = t;
    break;
  }
  if (!track || !trak || track.timescale === 0) return null;
  const tr = track;
  const us = (ticks: number): number => Math.round((ticks * 1_000_000) / tr.timescale);
  const packets: Packet[] = [];

  /* the sample tables: whatever moov itself indexes (nothing, in a fragmented file) */
  const stbl = path(b, trak, "mdia", "minf", "stbl");
  if (stbl) {
    const kids = boxes(b, stbl.data, stbl.end);
    const get = (t: string): Box | undefined => kids.find((k) => k.type === t);
    const stsz = get("stsz");
    const stco = get("stco") ?? get("co64");
    const stsc = get("stsc");
    const stts = get("stts");
    if (stsz && stco && stsc && stts) {
      const fixed = u32be(b, stsz.data + 4);
      const count = u32be(b, stsz.data + 8);
      const size = (i: number): number => (fixed !== 0 ? fixed : u32be(b, stsz.data + 12 + i * 4));
      const wide = stco.type === "co64";
      const chunks = u32be(b, stco.data + 4);
      const chunkOffset = (i: number): number => (wide ? u64be(b, stco.data + 8 + i * 8) : u32be(b, stco.data + 8 + i * 4));
      const runs = u32be(b, stsc.data + 4);
      const durations: number[] = [];
      const sttsCount = u32be(b, stts.data + 4);
      for (let i = 0; i < sttsCount && durations.length < count; i++) {
        const n = u32be(b, stts.data + 8 + i * 8);
        const delta = u32be(b, stts.data + 12 + i * 8);
        for (let k = 0; k < n && durations.length < count; k++) durations.push(delta);
      }
      let sample = 0;
      let ticks = 0;
      for (let r = 0; r < runs && sample < count; r++) {
        const first = u32be(b, stsc.data + 8 + r * 12) - 1;
        const perChunk = u32be(b, stsc.data + 12 + r * 12);
        const nextFirst = r + 1 < runs ? u32be(b, stsc.data + 8 + (r + 1) * 12) - 1 : chunks;
        for (let c = first; c < nextFirst && c < chunks && sample < count; c++) {
          let offset = chunkOffset(c);
          for (let k = 0; k < perChunk && sample < count; k++) {
            const s = size(sample);
            const d = durations[sample] ?? durations[durations.length - 1] ?? 0;
            if (offset + s <= b.length) packets.push({ data: b.subarray(offset, offset + s), timestamp: us(ticks), duration: us(d) });
            offset += s;
            ticks += d;
            sample++;
          }
        }
      }
    }
  }

  /* fragments: mvex/trex defaults, then each moof's traf/tfhd/tfdt/trun */
  const trex = boxes(b, child(b, moov, "mvex")?.data ?? 0, child(b, moov, "mvex")?.end ?? 0).find(
    (x) => x.type === "trex" && u32be(b, x.data + 4) === tr.id,
  );
  if (trex) {
    tr.defaultDuration = u32be(b, trex.data + 12);
    tr.defaultSize = u32be(b, trex.data + 16);
  }
  let fragTicks = packets.length > 0 ? 0 : 0;
  {
    const last = packets[packets.length - 1];
    if (last) fragTicks = Math.round(((last.timestamp + (last.duration ?? 0)) * tr.timescale) / 1_000_000);
  }
  for (const moof of top) {
    if (moof.type !== "moof") continue;
    for (const traf of boxes(b, moof.data, moof.end)) {
      if (traf.type !== "traf") continue;
      const kids = boxes(b, traf.data, traf.end);
      const tfhd = kids.find((k) => k.type === "tfhd");
      if (!tfhd || u32be(b, tfhd.data + 4) !== tr.id) continue;
      const hf = u24be(b, tfhd.data + 1);
      let p = tfhd.data + 8;
      let base = moof.start;
      if (hf & 0x1) {
        base = u64be(b, p);
        p += 8;
      }
      if (hf & 0x2) p += 4;
      let defDur = tr.defaultDuration;
      let defSize = tr.defaultSize;
      if (hf & 0x8) {
        defDur = u32be(b, p);
        p += 4;
      }
      if (hf & 0x10) defSize = u32be(b, p);
      const tfdt = kids.find((k) => k.type === "tfdt");
      if (tfdt) fragTicks = byte(b, tfdt.data) === 1 ? u64be(b, tfdt.data + 4) : u32be(b, tfdt.data + 4);
      let cursor = base;
      for (const trun of kids) {
        if (trun.type !== "trun") continue;
        const rf = u24be(b, trun.data + 1);
        const count = u32be(b, trun.data + 4);
        let q = trun.data + 8;
        if (rf & 0x1) {
          cursor = base + (u32be(b, q) | 0);
          q += 4;
        }
        if (rf & 0x4) q += 4;
        for (let i = 0; i < count; i++) {
          let d = defDur;
          let s = defSize;
          if (rf & 0x100) {
            d = u32be(b, q);
            q += 4;
          }
          if (rf & 0x200) {
            s = u32be(b, q);
            q += 4;
          }
          if (rf & 0x400) q += 4;
          if (rf & 0x800) q += 4;
          if (cursor + s <= b.length && s > 0) packets.push({ data: b.subarray(cursor, cursor + s), timestamp: us(fragTicks), duration: us(d) });
          cursor += s;
          fragTicks += d;
        }
      }
    }
  }
  if (packets.length === 0) return null;
  const out: Demuxed = { container: "mp4", config: tr.config, packets };
  let duration = totalDuration(packets);
  /* the edit list: where the presentation starts in the media (aac priming) and how long it runs */
  const elst = path(b, trak, "edts", "elst");
  const mvhd = child(b, moov, "mvhd");
  if (elst && u32be(b, elst.data + 4) >= 1) {
    const v1 = byte(b, elst.data) === 1;
    const at = elst.data + 8;
    let segment = v1 ? u64be(b, at) : u32be(b, at);
    let mediaTime = v1 ? u64be(b, at + 8) : u32be(b, at + 4);
    if (!v1 && mediaTime === 0xffffffff) mediaTime = -1;
    if (mediaTime > 0) out.skip = us(mediaTime);
    const movieScale = mvhd ? u32be(b, mvhd.data + (byte(b, mvhd.data) === 1 ? 20 : 12)) : 0;
    if (segment > 0 && movieScale > 0 && segment < 2 ** 52) {
      segment = Math.round((segment * 1_000_000) / movieScale);
      if (duration === undefined || segment <= duration) duration = segment;
    }
  }
  if (duration !== undefined) out.duration = duration;
  return out;
}

/* —— mp3: mpeg audio frames, after any id3v2 tag —— */

const MP3_BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

type Mp3Frame = { length: number; samples: number; rate: number; channels: number; layer: number; mpeg1: boolean };

function mp3Header(b: Uint8Array, at: number): Mp3Frame | null {
  if (at + 4 > b.length) return null;
  const h = u32be(b, at);
  if ((h & 0xffe00000) >>> 0 !== 0xffe00000) return null;
  const version = (h >>> 19) & 3; /* 3 mpeg1, 2 mpeg2, 0 mpeg2.5 */
  const layerBits = (h >>> 17) & 3;
  const bitrateIndex = (h >>> 12) & 0xf;
  const rateIndex = (h >>> 10) & 3;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const layer = 4 - layerBits;
  const mpeg1 = version === 3;
  const kbps = MP3_BITRATES[`${mpeg1 ? 1 : 2}-${layer}`]?.[bitrateIndex];
  const rate = MP3_RATES[version]?.[rateIndex];
  if (!kbps || !rate) return null;
  const padding = (h >>> 9) & 1;
  const channels = ((h >>> 6) & 3) === 3 ? 1 : 2;
  const bps = kbps * 1000;
  let length: number;
  let samples: number;
  if (layer === 1) {
    length = (Math.floor((12 * bps) / rate) + padding) * 4;
    samples = 384;
  } else if (layer === 2 || mpeg1) {
    length = Math.floor((144 * bps) / rate) + padding;
    samples = 1152;
  } else {
    length = Math.floor((72 * bps) / rate) + padding;
    samples = 576;
  }
  return { length, samples, rate, channels, layer, mpeg1 };
}

function demuxMp3(b: Uint8Array): Demuxed | null {
  let at = 0;
  while (ascii(b, at, 3) === "ID3") {
    const size = ((byte(b, at + 6) & 0x7f) << 21) | ((byte(b, at + 7) & 0x7f) << 14) | ((byte(b, at + 8) & 0x7f) << 7) | (byte(b, at + 9) & 0x7f);
    at += 10 + size + (byte(b, at + 5) & 0x10 ? 10 : 0);
  }
  /* find the first frame whose successor is also a frame, so a stray 0xff in a tag is not taken for one */
  let first: Mp3Frame | null = null;
  for (; at + 4 <= b.length; at++) {
    const f = mp3Header(b, at);
    if (!f) continue;
    const next = mp3Header(b, at + f.length);
    if (next && next.rate === f.rate && next.layer === f.layer) {
      first = f;
      break;
    }
    if (!next && at + f.length >= b.length) {
      first = f;
      break;
    }
  }
  if (!first || first.layer !== 3) return null;
  const packets: Packet[] = [];
  let clock = 0;
  let index = 0;
  let delay = 0;
  let padding = 0;
  while (at + 4 <= b.length) {
    const f = mp3Header(b, at);
    if (!f || f.rate !== first.rate || f.layer !== first.layer) break;
    const data = b.subarray(at, Math.min(at + f.length, b.length));
    const duration = (f.samples * 1_000_000) / f.rate;
    /* a xing/info frame at the head is metadata, silent: leave it out so it does not count as audio */
    const side = f.mpeg1 ? (f.channels === 1 ? 17 : 32) : f.channels === 1 ? 9 : 17;
    const tag = ascii(data, 4 + side, 4);
    const xing = index === 0 && (tag === "Xing" || tag === "Info");
    if (xing) {
      /* the lame tag after the xing fields carries the encoder's delay and padding, 12 bits each */
      let q = 4 + side + 8;
      const flags = u32be(data, 4 + side + 4);
      if (flags & 1) q += 4;
      if (flags & 2) q += 4;
      if (flags & 4) q += 100;
      if (flags & 8) q += 4;
      if (q + 24 <= data.length && /^(LAME|Lavc|Lavf|L3.9)/.test(ascii(data, q, 4))) {
        const v = u24be(data, q + 21);
        delay = v >> 12;
        padding = v & 0xfff;
      }
    }
    if (!(xing || (index === 0 && ascii(data, 36, 4) === "VBRI"))) {
      packets.push({ data, timestamp: Math.round(clock), duration: Math.round(duration) });
      clock += duration;
    }
    index++;
    at += f.length;
  }
  if (packets.length === 0) return null;
  const out: Demuxed = {
    container: "mp3",
    config: { codec: "mp3", sampleRate: first.rate, numberOfChannels: first.channels },
    packets,
    duration: Math.round(clock),
  };
  if (delay > 0 || padding > 0) {
    /* 529 samples: the mpeg decoder's own delay, which lame's figure leaves out */
    const head = delay + 529;
    out.skip = Math.round((head * 1_000_000) / first.rate);
    out.duration = Math.max(0, Math.round(clock - ((delay + padding) * 1_000_000) / first.rate));
  }
  return out;
}
