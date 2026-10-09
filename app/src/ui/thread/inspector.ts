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
