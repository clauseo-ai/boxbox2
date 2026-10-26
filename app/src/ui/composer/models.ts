/* what the model menu shows, as pure rules (docs/composer.md, the model menu): favorites first and the rest a switch away,
   the model in use always there, a search that spans every model with the starred ones leading, and the whole list under
   provider headers when it is shown whole. the menu draws what `arrange` returns and walks `rows` with its arrows. */

import { providerKey, providerWords } from "./marks";
import { matchModels } from "./menu-words";

export type ModelLike = { id: string; name: string; provider: string; efforts: readonly string[] };

/** the two things the menu can open on when nothing is typed */
export type View = "favorites" | "all";

/** the most favorites the server keeps (server/src/prefs.rs) */
export const MAX_FAVORITES = 64;

type Group<M> = { key: string; words: string; models: M[] };

type Arranged<M> = {
  /** what the list is of: the starred models, every model, or what a search found */
  of: "favorites" | "all" | "search";
  /** "flat" is one list; "grouped" is every model under its provider's header (whole lists with more than one provider) */
  shape: "flat" | "grouped";
  /** the models in the order they show, which is the order the arrows walk */
  rows: M[];
  /** the provider headers, when grouped */
  groups: Group<M>[];
  /** how many of this host's models are starred */
  starred: number;
  total: number;
  /** the quiet switch between the short list and the whole one, when there is somewhere to go */
  toggle: { to: View; words: string } | null;
  /** nothing starred yet: the one line that says starring keeps the menu short */
  hint: boolean;
};

/** the starred models this host lists, in the order the person put them; an id this host does not list is not shown */
export function starredOf<M extends { id: string }>(models: readonly M[], favorites: readonly string[]): M[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const found: M[] = [];
  for (const id of favorites) {
    const model = byId.get(id);
    if (model && !seen.has(id)) {
      seen.add(id);
      found.push(model);
    }
  }
  return found;
}

/** the menu opens on the short list when there is one */
export function defaultView(models: readonly ModelLike[], favorites: readonly string[]): View {
  return starredOf(models, favorites).length > 0 ? "favorites" : "all";
}

function groupsOf<M extends ModelLike>(models: readonly M[]): Group<M>[] {
  const groups = new Map<string, Group<M>>();
  for (const model of models) {
    const key = providerKey(model);
    const group = groups.get(key) ?? { key, words: providerWords(model.provider), models: [] };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function arrange<M extends ModelLike>(input: { models: readonly M[]; favorites: readonly string[]; inUse: string | null; query: string; view: View }): Arranged<M> {
  const { models, favorites, inUse, query } = input;
  const starred = starredOf(models, favorites);
  const base = { starred: starred.length, total: models.length };

  // typing searches every model, the starred ones first, each part in the search's own order
  if (query.trim()) {
    const hits = matchModels(models, query);
    const stars = new Set(starred.map((model) => model.id));
    const rows = [...hits.filter((model) => stars.has(model.id)), ...hits.filter((model) => !stars.has(model.id))];
    return { ...base, of: "search", shape: "flat", rows, groups: [], toggle: null, hint: false };
  }

  if (input.view === "favorites" && starred.length > 0) {
    // the model in use is always on the short list, after the starred ones when it is not one of them
    const pinned = models.find((model) => model.id === inUse);
    const rows = pinned && !starred.some((model) => model.id === pinned.id) ? [...starred, pinned] : starred;
    const more = rows.length < models.length;
    return { ...base, of: "favorites", shape: "flat", rows, groups: [], toggle: more ? { to: "all", words: `all models · ${models.length}` } : null, hint: false };
  }

  const groups = groupsOf(models);
  const grouped = groups.length > 1;
  const toggle = starred.length > 0 ? { to: "favorites" as const, words: `favorites · ${starred.length}` } : null;
  return { ...base, of: "all", shape: grouped ? "grouped" : "flat", rows: grouped ? groups.flatMap((group) => group.models) : [...models], groups: grouped ? groups : [], toggle, hint: starred.length === 0 && models.length > 0 };
}

/** a star pressed: the list with the id added at the end or taken out. null when the list is full, which the caller says */
export function flipFavorite(favorites: readonly string[], id: string): { next: string[]; on: boolean } | null {
  if (favorites.includes(id)) return { next: favorites.filter((one) => one !== id), on: false };
  if (favorites.length >= MAX_FAVORITES) return null;
  return { next: [...favorites, id], on: true };
}
