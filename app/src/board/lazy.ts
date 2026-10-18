/* the board's foothold in the first load (docs/board.md, the app): what a window, a swatch and the stage need to name a
   digit and to mount the board's pieces once a board has been here. everything else is the board's own chunk (board.tsx),
   fetched on the first `board.here` and never on a device without one: nothing here renders until `state.board.met` */

import { lazy } from "solid-js";
import { state } from "../store";

const load = () => import("./board");

/** a window's or a swatch's digit, set into its material */
export const BoardKey = lazy(() => load().then((m) => ({ default: m.BoardKey })));
/** the thread menu's "pair with a board key", and what the stage says while a pairing is armed and when it settles */
export const BoardPair = lazy(() => load().then((m) => ({ default: m.BoardPair })));
export const BoardReceipt = lazy(() => load().then((m) => ({ default: m.BoardReceipt })));

/** the words a window's name carries while the board seats it, so a screen reader hears the key that opens it */
export const boardWords = (key: string): string => {
  const digit = state.board.digits[key];
  return digit === undefined ? "" : `, board key ${digit}`;
};
