/* the windows beside the stage at the strip and the rail, and the one control that folds them (docs/home.md, the folds;
   the native app's stripux, `HomeWindowsToggle`). the toggle draws the layout it acts on (a band across the top on the
   strip, where the windows are above the thread; the sidebar on the rail, where they are beside it) and is named for what a
   tap does, so its name changes with the state and its glyph never does. one is on the screen at a time: the open bar's,
   or the fold's, at the same place. */

import { docksBeside } from "../thread/inspector";

export { docksBeside };

/** the two arrangements that keep the windows beside the stage */
export type Beside = "strip" | "rail";

/** where the windows are: their open row or column, folded to swatches, or put away (focus) */
export type WindowsState = "open" | "folded" | "hidden";

/** what a tap on the toggle does, in words: the open strip folds, the open rail puts its windows away (it folds only for the
    details' room), and folded or away they come back */
export function toggleName(form: Beside, state: WindowsState): string {
  if (state !== "open") return "show the windows";
  return form === "strip" ? "fold the windows" : "hide the windows";
}

/** the stage card's margin from the screen's edges and from the rail (home.css) */
const EDGE = 14;
/** the open rail's column, and the folded one's */
const RAIL_OPEN = 318;
const RAIL_FOLDED = 76;

/** the stage card's width at home for a window this wide, the windows open or folded */
export function stageWidth(form: "deck" | Beside, width: number, windows: WindowsState): number {
  if (form === "deck") return width;
  if (form === "strip" || windows === "hidden") return Math.max(0, width - 2 * EDGE);
  return Math.max(0, width - (windows === "open" ? RAIL_OPEN : RAIL_FOLDED) - EDGE);
}

/** where the details go below the inspector's width (the native app's ipadfit, `HomeArrangement`): docked beside the
    column where it keeps its least width, a sheet over the stage where it does not. at the rail the open rail is the first
    to give way: details that fit only beside the folded rail fold it while they are open. with the windows put away the
    card has the screen. the deck never docks */
export function detailsPlace(form: "deck" | Beside, width: number, hidden = false): { docks: boolean; foldsRail: boolean } {
  if (form === "deck") return { docks: false, foldsRail: false };
  if (form === "strip" || hidden) return { docks: docksBeside(stageWidth(form, width, hidden ? "hidden" : "open")), foldsRail: false };
  const open = docksBeside(stageWidth("rail", width, "open"));
  const folded = docksBeside(stageWidth("rail", width, "folded"));
  return { docks: folded, foldsRail: folded && !open };
}
