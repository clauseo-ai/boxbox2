/* the starred models as the store holds them (favorites.ts keeps them): the one read the composer needs at its first
   paint, alone so the stars' saving and refreshing load only when the model menu opens (ui/later.ts) */

import { state } from "../../store";

/** the starred ids, in the order the person put them. a server older than favorites answers prefs with no `models` */
export function favorites(): readonly string[] {
  return state.prefs?.models?.favorites ?? [];
}
