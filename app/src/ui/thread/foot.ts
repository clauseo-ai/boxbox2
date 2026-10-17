/* the foot room (docs/thread.md, live; the native client's ThreadFootRoom, its decision 25): while a turn plays, whatever the
   transcript gives back above its end is kept as room under the end, so the rows below rise into the place and a reader at the
   end sees nothing above it move. a run folding whole when the agent writes again gives back its live row's open body; the
   words that follow rise into that room, and the next growth fills it before anything moves up. the room is the spacer under
   the transcript (`--hold`, `.stage-room`), written by the stage; this decides how much. pure, so it is tested without a browser.

   it keeps what the reader sees still, and no more: the room is what keeps the box at the top of the view where it was (`Seen`,
   `seenAt`, `roseSince`). what is given back above the view (a box the window fills shorter than its guess, a fold that began
   above it) moves nothing the reader sees once the end is followed, and kept as room it would lift the words they were reading up
   the screen and leave the foot of the view empty. what the reader saw at the top that is gone (the live row's open body filled
   the view and folded away) leaves nothing to keep still: the room goes and the view follows the end, else it opened on a
   screen of room with the thread above it (docs/gotchas.md, the foot room).

   it holds only while the end is on screen: a reader further up loses nothing to it, and the room goes, unseen, once the end
   leaves the view. it is bounded by the view: room that would fill the view is content that went (the list was made again), not
   room to keep (`endRoom` in pin.ts says why that bound matters). */

/** the most of the view the room may take */
export const MOST_OF_VIEW = 0.5;

export class FootRoom {
  /** the room kept under the end, px */
  room = 0;
  /** the lowest the end has been while room is kept, moved up by what rose above the reader's eye */
  private lowest = 0;
  /** the end is on the screen: what is above it is kept. not until the stage has seen it there: a stage opening at the top of a
      long thread reads its end far below the view, and what the window gives back on the way is no room of the reader's */
  private shown = false;
  /** the last reading was while the turn played: the change that ends the play (its settle) is still kept */
  private wasKeeping = false;

  /** the end of the content now (`at`, px from the top of the scroller's content, its padding left out), after a change of what is
      above it. `keeping` while a turn plays; `view` is the scroller's height; `rose` how far the box at the top of the view rose
      since the last reading (`roseSince`), null when what was there is gone. answers the room to keep */
  read(at: number, keeping: boolean, view: number, rose: number | null = 0): number {
    const holds = this.shown && (keeping || this.wasKeeping || this.room > 0.5);
    this.wasKeeping = keeping;
    if (!holds) return this.drop(at);
    /* what the reader saw at the top of the view went: there is nothing to keep still, and room would be a screen of nothing */
    if (rose === null) return this.drop(at);
    this.lowest = Math.max(this.lowest - rose, at);
    const next = Math.max(0, Math.ceil(this.lowest - at));
    /* the end was on screen, so what a change in sight gave back is less than the view: more is content that went out of sight (the
       list was made again), not room to keep */
    if (next >= view) return this.drop(at);
    /* and more than half the view would leave the reader looking at nothing much: a fold that big moves what was above it down to
       where half the view still shows the thread (the end's own foot below), never a screen of room */
    if (next > view * MOST_OF_VIEW) {
      this.lowest = at + Math.floor(view * MOST_OF_VIEW);
      this.room = this.lowest - at;
      return this.room;
    }
    this.room = next;
    return next;
  }

  /** the settle measured the room it leaves under a shorter end itself (`endRoom`), from where the view was: it is kept as the foot's,
      so the next reading keeps it and growth fills it */
  keep(at: number, room: number): void {
    this.room = room;
    this.lowest = at + room;
  }

  /** the reader changed the layout by their own hand (a row opened or closed): what it gave back is theirs and is not kept; the
      room already kept stays, under the end where it is now */
  moved(at: number): void {
    this.lowest = at + this.room;
  }

  /** the end is on the screen: from now on what the content above it gives back is kept */
  came(): void {
    this.shown = true;
  }

  /** the end left the screen: its room goes, and nothing is kept until it is back. answers the room, 0 */
  letGo(at: number): number {
    this.shown = false;
    return this.drop(at);
  }

  private drop(at: number): number {
    this.lowest = at;
    this.room = 0;
    return 0;
  }
}

/* ---------- what the reader sees at the top of the view ---------- */

/** the boxes under the top of the view, outermost first (a turn, its row, the row's body), with where each began, and the line (the
    view's top) they were read at: px from the top of the scroller's content */
export type Seen<E> = { line: number; chain: Array<{ el: E; top: number; height: number }> };

/** how the stage reads a box: its children in order down the page, where it begins and how tall it is (layout px), and whether it is
    still on the page with a box of its own */
export type Boxes<E> = { kids: (el: E) => readonly E[]; top: (el: E) => number; height: (el: E) => number; here: (el: E) => boolean };

/** how deep the chain goes: a turn, a group or row, its body, a block of it */
const DEPTH = 4;

/** the boxes at the top of the view (`line`), from `root` down: at each level the first child still under the line, found by bisection
    (a transcript has hundreds of turns, and each read is a layout read). a box that begins at or below the line is the first the reader
    sees whole and ends the chain; none under the line (the view's top is past the transcript, in its room) is an empty chain */
export function seenAt<E>(root: E, line: number, boxes: Boxes<E>): Seen<E> {
  const chain: Seen<E>["chain"] = [];
  let at = root;
  for (let depth = 0; depth < DEPTH; depth++) {
    const kids = boxes.kids(at).filter(boxes.here);
    let lo = 0, hi = kids.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const k = kids[mid] as E;
      if (boxes.top(k) + boxes.height(k) > line + 0.5) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (found < 0) break;
    const el = kids[found] as E;
    const top = boxes.top(el);
    chain.push({ el, top, height: boxes.height(el) });
    if (top >= line - 0.5) break;
    at = el;
  }
  return { line, chain };
}

/** how far what the reader saw at the top of the view has risen since `seen` was read (down is negative): the deepest box of the chain
    still on the page says. null when there is nothing to say it: the chain was empty (the view's top was in the room), or the box is
    there but no longer reaches the line it was read at, kept where it was (the live row's open body that filled the view closed) */
export function roseSince<E>(seen: Seen<E> | null, boxes: Boxes<E>): number | null {
  if (!seen) return 0;
  for (let i = seen.chain.length - 1; i >= 0; i--) {
    const { el, top, height } = seen.chain[i] as Seen<E>["chain"][number];
    if (!boxes.here(el)) continue;
    /* a box that began above the line and is shorter now lost some of what the reader saw of it (the live row's open body folded, a
       long read clamped to its opening lines): there is no telling which part, so nothing of it is kept still. one that began in view
       keeps its top, and what is above it, where the reader saw them */
    if (top < seen.line - 0.5 && boxes.height(el) < height - 0.5) return null;
    return top - boxes.top(el);
  }
  return null;
}
