/* the thinking box's pace (docs/thread.md, live). text arrives in 100 ms batches (the server merges streamed deltas), and a batch that
   entered the box as one run would fade in as one clump of words. so what carries on from the last text becomes the target, and the box
   reveals it over the frames that follow, in pieces that end at a word, catching up within PACE_MS, before the next batch is due. a batch
   that lands sooner carries on from the same reveal; a text that does not carry on is painted whole at once. only the thinking box is
   paced: the answer, said rows and reports paint as they arrive. pure but for the clock it is handed; no dom. */

/** a batch is revealed within this, before the next is due (100 ms) */
export const PACE_MS = 80;
/** how far past a frame's share a piece reaches to end at a word */
export const WORD_REACH = 24;

export type Clock = { now(): number; frame(run: (now: number) => void): number; cancel(id: number): void };
export type PaceOut = {
  /** these characters carry on from what is shown */
  append(piece: string): void;
  /** the text does not carry on: show this, whole */
  replace(text: string): void;
};
export type Pacer = { set(text: string): void; dispose(): void };

const browser: Clock = { now: () => performance.now(), frame: (run) => requestAnimationFrame(run), cancel: (id) => cancelAnimationFrame(id) };
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** a pacer showing `first` already */
export function pacer(first: string, out: PaceOut, clock: Clock = browser): Pacer {
  let shown = first;
  let target = first;
  let base = first.length;
  let since = 0;
  let frame = 0;
  const reveal = (now: number) => {
    frame = 0;
    const t = Math.min(1, (now - since) / PACE_MS);
    let end = t >= 1 ? target.length : base + Math.ceil((target.length - base) * t);
    if (end < target.length) {
      const space = target.indexOf(" ", end);
      if (space >= 0 && space - end <= WORD_REACH) end = space + 1;
      else if (isHighSurrogate(target.charCodeAt(end - 1))) end++;
    }
    if (end > shown.length) {
      const piece = target.slice(shown.length, end);
      shown = target.slice(0, end);
      out.append(piece);
    }
    if (shown.length < target.length) frame = clock.frame(reveal);
  };
  return {
    set(text) {
      if (text === target) return;
      if (text.startsWith(target)) {
        target = text;
        base = shown.length;
        since = clock.now();
        frame ||= clock.frame(reveal);
        return;
      }
      if (frame) clock.cancel(frame);
      frame = 0;
      shown = target = text;
      base = text.length;
      out.replace(text);
    },
    dispose() {
      if (frame) clock.cancel(frame);
      frame = 0;
    },
  };
}
