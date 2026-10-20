/* a server-sent-events parser over raw bytes, fed chunk by chunk as the
   fetch stream delivers them. the worker reads the stream with fetch
   rather than EventSource so it owns the cursor header, the stall timer
   and the backoff (docs/architecture.md, the sync worker).

   lines end in `\n` or `\r\n`; a blank line dispatches the frame; `data:`
   lines join with `\n`; comments (`:`) are counted and dropped, since the
   worker's stall timer watches bytes, not frames. a frame with no data is
   not dispatched; the server never sends one, and every cursor the worker
   keeps comes from an entry it applied, never from a bare id.

   what the parser holds (the line not yet ended and the data lines of the
   frame not yet dispatched) has a cap, FRAME_CAP. past it the parser drops
   what it holds and throws `SseOverflow`, and the worker drops the
   connection and resumes from its cursor. */

/** the most text one frame may hold, in utf-16 units (never more than its utf-8 bytes): four times the largest frame the server
    forwards, an upstream frame at its 8 mb cap (docs/architecture.md, the caps), so a well-formed stream never reaches it */
export const FRAME_CAP = 32 * 1024 * 1024;

/** a frame passed the parser's cap; `held` is what the parser held when it did */
export class SseOverflow extends Error {
  constructor(
    readonly held: number,
    cap: number,
  ) {
    super(`an sse frame passed ${cap} characters`);
  }
}

export type SseFrame = {
  /** the frame's `id:` field, when it had one */
  id: string | undefined;
  data: string;
};

export class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private data: string[] = [];
  private id: string | undefined;
  private hasData = false;
  /** the length of `data`'s lines, so the frame's size is known without joining them */
  private dataLength = 0;
  /** comment lines seen, heartbeats among them */
  comments = 0;

  constructor(private readonly cap = FRAME_CAP) {}

  /** feeds bytes as they arrived and returns the frames they completed; throws `SseOverflow` past the cap */
  push(chunk: Uint8Array): SseFrame[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const frames: SseFrame[] = [];
    let start = 0;
    for (let end = this.buffer.indexOf("\n", start); end >= 0; end = this.buffer.indexOf("\n", start)) {
      const raw = this.buffer.slice(start, end);
      start = end + 1;
      this.line(raw.endsWith("\r") ? raw.slice(0, -1) : raw, frames);
    }
    this.buffer = this.buffer.slice(start);
    const held = this.buffer.length + this.dataLength;
    if (held > this.cap) {
      this.buffer = "";
      this.data = [];
      this.dataLength = 0;
      this.hasData = false;
      throw new SseOverflow(held, this.cap);
    }
    return frames;
  }

  private line(line: string, frames: SseFrame[]) {
    if (line === "") {
      if (this.hasData) frames.push({ id: this.id, data: this.data.join("\n") });
      this.data = [];
      this.dataLength = 0;
      this.hasData = false;
      this.id = undefined;
      return;
    }
    if (line.startsWith(":")) {
      this.comments++;
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.data.push(value);
      this.dataLength += value.length;
      this.hasData = true;
    } else if (field === "id") {
      this.id = value;
    }
  }
}
