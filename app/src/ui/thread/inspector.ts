/* the inspector: the column beside the stage at the rail, 1400 wide and up
   (design.md, one layout law: "a details panel joins at 1400"). home owns
   where it is and whether it shows, and remembers that on this device; the
   stage owns what is in it (the thread's details, or its turns) and portals
   it into the element home keeps. below 1400 the stage shows the same views
   docked inside itself, or as a sheet on the phone. */

import type { Accessor } from "solid-js";

export type InspectorView = "details" | "turns";

export type InspectorLink = {
  /** the element home keeps for it in the grid beside the stage; undefined until it is mounted */
  el: Accessor<HTMLElement | undefined>;
  /** what it shows, or null while it is folded away */
  view: Accessor<InspectorView | null>;
  /** shows a view, or folds the inspector away (null); home remembers the choice on this device */
  show: (view: InspectorView | null) => void;
};

/** the docked panel's share of the stage: the 330 px panel and its 12 px margin (details.css) */
export const DOCK_SHARE = 342;
/** the least column the panel docks beside: the strip's 640 px measure in the wide stage's 32 px gutters (the native app's
    `ThreadMeasure.dockedColumnMin`) */
export const DOCKED_COLUMN_MIN = 704;

/** whether a stage this wide docks its panel: the column beside it keeps its least width */
export function docksBeside(stage: number): boolean {
  return stage - DOCK_SHARE >= DOCKED_COLUMN_MIN;
}

/** below the inspector's width, home's say in where the stage's own panel goes (home/windows.ts, detailsPlace): it knows the
    room the arrangement can make, which the stage's own width does not (the open rail gives way first) */
export type DetailsRoom = {
  /** the panel docks beside the column; otherwise it is a sheet over the stage */
  docks: Accessor<boolean>;
  /** the panel is about to open (true) or close: home makes the room first and then calls `go`, or lets it go first and
      then gives the room back */
  make: (open: boolean, go: () => void) => void;
  /** a count that goes up when home asks for the panel to close (the windows were asked back) */
  closes: Accessor<number>;
};
