/* the foot room (docs/thread.md, live; the native client's ThreadFootRoom, its decision 25): while a turn plays, whatever the
   transcript gives back above its end is kept as room under the end, so the rows below rise into the place and a reader at the
   end sees nothing above it move. a run folding whole when the agent writes again gives back its live row's open body; the
   words that follow rise into that room, and the next growth fills it before anything moves up. the room is the scroller's end
   padding (`--hold`), written by the stage; this decides how much. pure, so it is tested without a browser.

   it holds only while the end is on screen: a reader further up loses nothing to it (the rows a window fills above them shrink
   and grow, which is no room of the live turn's), and the room goes, unseen, once the end leaves the view. it is bounded by the
   view: room that would fill the view with padding is content that went (the list was made again), not room to keep (`endRoom`
   in pin.ts says why that bound matters). */

export class FootRoom {
  /** the room kept under the end, px */
  room = 0;
  /** the lowest the end has been while room is kept */
  private lowest = 0;
  /** the end is on the screen: what is above it is kept */
  private shown = true;
  /** the last reading was while the turn played: the change that ends the play (its settle) is still kept */
  private wasKeeping = false;

  /** the end of the content now (`at`, px from the top of the scroller's content, its padding left out), after a change of what is
      above it. `keeping` while a turn plays; `view` is the scroller's height. answers the room to keep */
  read(at: number, keeping: boolean, view: number): number {
    const holds = this.shown && (keeping || this.wasKeeping || this.room > 0.5);
    this.wasKeeping = keeping;
    this.lowest = holds ? Math.max(this.lowest, at) : at;
    const next = holds ? Math.max(0, Math.ceil(this.lowest - at)) : 0;
    /* the end was on screen, so what a change in sight gave back is at most the view: more is content that went out of sight (the
       list was made again), not room to keep */
    if (next > view) return this.drop(at);
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

  /** the end is on the screen again: from now on what the content above it gives back is kept */
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
