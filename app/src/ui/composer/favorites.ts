/* favorite models: the star on a model row. the list is one per person, kept by the server (`PUT /api/prefs/models`) and
   read back with the rest of the prefs, so every device shows the same short menu. a press changes the list on screen at
   once and is put back, to what it was before the press, when the server does not keep it. every press sends the whole
   list, so the saves go one at a time in press order (the server ends on the newest list) and only the newest press's
   answer settles the screen. */

import { api } from "../../api/client";
import { type ModelPrefs, type Prefs, setModelPrefs, setPrefs, state } from "../../store";
import { type Outcome, said, UNREACHABLE } from "../machines/said";
import { flipFavorite, MAX_FAVORITES } from "./models";

/** the starred ids, in the order the person put them. a server older than favorites answers prefs with no `models` */
export function favorites(): readonly string[] {
  return state.prefs?.models?.favorites ?? [];
}

/** what the server answered to a list: the list it kept, or why it did not */
export type Saved = { ok: true; value: ModelPrefs } | { ok: false; error: string };

/** the two routes the stars use; a test passes its own */
type Route = {
  save: (list: string[]) => Promise<Saved>;
  read: () => Promise<Prefs | null>;
};

const serverRoute: Route = {
  async save(list) {
    try {
      const { data, error, response } = await api.PUT("/api/prefs/models", { body: { favorites: list } });
      return data ? { ok: true, value: data } : { ok: false, error: said(error, response.status) };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  },
  async read() {
    const { data } = await api.GET("/api/prefs");
    return data ?? null;
  },
};

/** a menu opening reads the prefs again so a star made on another device is there, but not more often than this */
const REFRESH_MS = 15_000;

/** one owner for the presses in flight: the counters belong to a star's route, not to anything a component reads */
export function createFavorites(route: Route) {
  /** presses whose answer has not come back: a read of the prefs that lands while one is out would put a stale list back */
  let pending = 0;
  /** the newest press: only its answer settles the list on screen */
  let newest = 0;
  let readAt = 0;
  /** the list the server last kept (or, with no press out, the list on screen): what a refused press goes back to, however many
      presses before it were refused too */
  let settled: readonly string[] = [];
  /** the saves in a line, so the server is written in the order the person pressed */
  let line: Promise<unknown> = Promise.resolve();

  /** reads the prefs again when the menu opens, for the stars another device made. never over a press, and never with an
      answer that left before a press and landed after it (that is the list as it was) */
  async function refresh(): Promise<void> {
    if (pending > 0 || Date.now() - readAt < REFRESH_MS) return;
    readAt = Date.now();
    const asked = newest;
    try {
      const prefs = await route.read();
      if (prefs && pending === 0 && newest === asked) setPrefs(prefs);
    } catch {
      // the list on screen stands; the next opening reads again
      readAt = 0;
    }
  }

  /** puts the star on a model or takes it off; the outcome says what the server did, for the line under the words */
  async function toggle(id: string): Promise<Outcome<boolean>> {
    if (!state.prefs) {
      // the prefs are read at launch; a star before they came waits for them rather than being lost
      try {
        const prefs = await route.read();
        if (prefs) setPrefs(prefs);
      } catch {
        return { ok: false, error: `not saved. ${UNREACHABLE}` };
      }
      if (!state.prefs) return { ok: false, error: "not saved. the prefs did not come. try again" };
    }
    const before = favorites();
    if (pending === 0) settled = before;
    const flipped = flipFavorite(before, id);
    if (!flipped) return { ok: false, error: `${MAX_FAVORITES} is the most favorites. take one off first` };
    setModelPrefs({ favorites: flipped.next });
    const mine = ++newest;
    pending++;
    try {
      const run = line.then(() => route.save(flipped.next));
      line = run.then(() => undefined, () => undefined);
      const saved = await run;
      if (saved.ok) {
        settled = saved.value.favorites;
        if (mine === newest) setModelPrefs(saved.value);
        return { ok: true, value: flipped.on };
      }
      if (mine === newest) setModelPrefs({ favorites: [...settled] });
      return { ok: false, error: `not saved. ${saved.error}` };
    } catch {
      if (mine === newest) setModelPrefs({ favorites: [...settled] });
      return { ok: false, error: `not saved. ${UNREACHABLE}` };
    } finally {
      pending--;
    }
  }

  return { refresh, toggle };
}

const app = createFavorites(serverRoute);
export const refreshFavorites = app.refresh;
export const toggleFavorite = app.toggle;
