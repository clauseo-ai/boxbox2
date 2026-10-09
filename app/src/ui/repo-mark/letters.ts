/* the letters a repo mark carries while it has no favicon (or none loads): the repo's initials, as many as read at
   this size. two letters need a tile about this wide to be set at 11 px or more; below it one letter is set larger,
   because two at 8 px are a smudge. */

import { initialsOf } from "../home/swatch";

/** the smallest tile that carries two letters, px */
export const TWO_LETTERS_FROM = 28;

/** the repo's name as the mark spells it at `size` px: one letter small, two from `TWO_LETTERS_FROM` */
export function lettersFor(name: string, size: number): string {
  const initials = initialsOf(name);
  return size >= TWO_LETTERS_FROM ? initials : [...initials].slice(0, 1).join("");
}

/** the letters' size as a fraction of the tile: one letter is set larger than each of two */
export const letterScale = (count: number): number => (count > 1 ? 0.4 : 0.52);
