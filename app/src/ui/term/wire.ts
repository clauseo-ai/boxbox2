/* the terminal wire, the pane's side (docs/terminal.md): what each frame
   from the relay means for the screen. pure, so the rules are tested
   without a socket or an emulator.

   - text frames are output. while a replay is running they are held, not
     painted, so a replay can be judged whole when its meta frame lands.
   - `0x00 {cursor}` (cmx2's) ends a replay. if the stream stands further
     on than the cursor the replay started from plus what it carried, cmx2
     no longer held the difference: the screen is reset and the replay
     painted onto a clean one, never spliced across a hole.
   - `0x01 {cursor}` (the relay's) starts a replay over: whatever was held
     of an unfinished one is dropped.
   - `0x02` is a heartbeat.

   the cursor counts utf-16 units, a string's `.length`, as cmx2's does. */

export const META = 0x00;
export const REPLAY = 0x01;
export const HEARTBEAT = 0x02;

/** a held replay past this many units is painted as it comes. cmx2 retains 64 kb of head and 256 kb of tail, so a
    real replay never gets near it; the cap only keeps a misbehaving peer from growing the page. */
const HOLD_CAP = 4 * 1024 * 1024;

export type Effect =
  /** paint output. `replay` output was produced before this connection: while it is parsed, the emulator's answers
      to old queries (device attributes, cursor reports) must not reach the shell */
  | { type: "write"; text: string; replay: boolean }
  /** clear the screen and scrollback */
  | { type: "reset" }
  /** a line the pane shows in its own voice, never sent to the shell */
  | { type: "note"; text: string }
  /** the replay is over; the stream is live at `cursor` */
  | { type: "live"; cursor: number };

type Held = { from: number | null; parts: string[]; units: number };

export class Wire {
  /** the cursor after the last output painted; null until the first meta frame */
  private at: number | null;
  private held: Held | null = null;

  constructor(cursor: number | null = null) {
    this.at = cursor;
  }

  /** the cursor to dial with: where the painted output ends, or null for everything retained */
  get cursor(): number | null {
    return this.at;
  }

  /** whether a replay is being held */
  get replaying(): boolean {
    return this.held !== null;
  }

  /** a connection opened: its first output is a replay from the cursor it dialled with */
  opened(): void {
    this.held = { from: this.at, parts: [], units: 0 };
  }

  text(text: string): Effect[] {
    if (text.length === 0) return [];
    if (this.held) {
      this.held.parts.push(text);
      this.held.units += text.length;
      if (this.held.units <= HOLD_CAP) return [];
      const spill = this.held.parts.join("");
      this.held.parts = [];
      return [{ type: "write", text: spill, replay: true }];
    }
    if (this.at !== null) this.at += text.length;
    return [{ type: "write", text, replay: false }];
  }

  binary(frame: Uint8Array): Effect[] {
    const tag = frame[0];
    if (tag === HEARTBEAT) return [];
    const body = parse(frame.subarray(1));
    if (tag === REPLAY) {
      const from = body?.cursor;
      this.held = { from: typeof from === "number" ? from : null, parts: [], units: 0 };
      return [];
    }
    if (tag !== META || typeof body?.cursor !== "number") return [];
    const cursor = body.cursor;
    const held = this.held;
    this.held = null;
    this.at = cursor;
    if (!held) return [{ type: "live", cursor }];
    const effects: Effect[] = [];
    const missing = held.from !== null && held.from >= 0 ? cursor - held.from - held.units : 0;
    if (missing > 0) {
      effects.push({ type: "reset" }, { type: "note", text: "older output was not kept" });
    }
    if (held.parts.length > 0) effects.push({ type: "write", text: held.parts.join(""), replay: true });
    effects.push({ type: "live", cursor });
    return effects;
  }
}

function parse(bytes: Uint8Array): { cursor?: unknown } | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" ? (value as { cursor?: unknown }) : null;
  } catch {
    return null;
  }
}
