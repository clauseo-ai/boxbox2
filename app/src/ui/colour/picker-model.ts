/* the colour sheet's rules (docs/design.md, the colour sheet): what the person is trying against what the server holds,
   which swatch is ringed and ticked, which one automatic gives, who else on the machine wears each, and the words of the
   note, the automatic row and the two buttons. pure: the sheet draws what this says, picker-model.test.ts pins it.

   a pick is what the sheet's radio group holds: automatic, or one of the ten by name. the server's state is read as a
   pick too (`currentPick`), so "nothing changed" is one comparison and nothing is sent for it. */

import { placeName } from "../thread/place";
import { type ColourMap, colourAssignment, colourOf, REPO_COLOURS, type Repo, type RepoColour, repoColourNamed, repoKey } from "../window/repo";

export type Pick = { kind: "auto" } | { kind: "chosen"; name: string };

export const AUTOMATIC: Pick = { kind: "auto" };

/** another repo on the same machine, as the sheet names it and paints it */
export type Neighbour = { root: string; name: string; colour: RepoColour };

/** what the server holds for `repo`, as a pick: its chosen colour, else automatic */
export function currentPick(repo: Repo, colours: ColourMap): Pick {
  const { chosen } = colourAssignment(repo, colours);
  return chosen ? { kind: "chosen", name: chosen.name } : AUTOMATIC;
}

export function samePick(a: Pick, b: Pick): boolean {
  return a.kind === "auto" ? b.kind === "auto" : b.kind === "chosen" && a.name === b.name;
}

/** the colour a pick paints: automatic paints the colour boxbox gave, a chosen name one of the ten (automatic's for a name
    this build does not know, which the sheet never offers) */
export function shownBy(pick: Pick, auto: RepoColour): RepoColour {
  return pick.kind === "auto" ? auto : (repoColourNamed(pick.name) ?? auto);
}

/** the person's pick, held with the key of the repo it was made for (`repoKey`) */
export type HeldPick = { key: string; pick: Pick } | null;

/** the pick the sheet holds for the repo `key`: the person's while it was made for that repo, else what the server holds.
    the sheet's repo follows its props, so a pick made for one repo is never previewed for, or sent to, another */
export function pickFor(held: HeldPick, key: string, current: Pick): Pick {
  return held !== null && held.key === key ? held.pick : current;
}

/** what "use" sends: a name, or null for automatic (api/client.ts, chooseColour) */
export function sentFor(pick: Pick): string | null {
  return pick.kind === "auto" ? null : pick.name;
}

/** the server's map holds the pick: the `colour` frame for it has landed, so the preview can let go without the stage
    flashing back to the old colour */
export function holds(repo: Repo, colours: ColourMap, pick: Pick): boolean {
  const assigned = colours[repoKey(repo)];
  if (!assigned) return false;
  return pick.kind === "auto" ? assigned.chosen === null : assigned.chosen === pick.name;
}

/** the store's preview while the person tries a pick that is not what the server holds; null when they are back on it, so the
    surfaces read the server's colour again rather than a copy of it */
export function previewFor(repo: Repo, current: Pick, pick: Pick, auto: RepoColour): { host: string; root: string; name: string } | null {
  return samePick(current, pick) ? null : { host: repo.host, root: repo.root, name: shownBy(pick, auto).name };
}

/** the other repos on `repo`'s machine: the roots given (the fleet's sessions there, newest first), then every repo the
    server has a colour for on that host, by name. never `repo` itself, each root once */
export function neighboursOf(repo: Repo, colours: ColourMap, roots: Iterable<string>): Neighbour[] {
  const prefix = `${repo.host}:`;
  const seen = new Set<string>([repo.root]);
  const out: Neighbour[] = [];
  const add = (root: string) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    out.push({ root, name: placeName(root, repo.host), colour: colourOf({ host: repo.host, root }, colours) });
  };
  for (const root of roots) add(root);
  const known = Object.keys(colours).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  const rest = known.filter((root) => !seen.has(root)).map((root) => ({ root, name: placeName(root, repo.host) }));
  for (const { root } of rest.sort((a, b) => a.name.localeCompare(b.name))) add(root);
  return out;
}

/** "relay", "relay and docs", "relay, docs and ledger" */
export function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** the badge on a swatch someone else wears: the wearer's first letter, or how many wear it */
export function badgeOf(wearers: readonly string[]): string | null {
  if (wearers.length === 0) return null;
  if (wearers.length > 1) return String(wearers.length);
  return [...(wearers[0] ?? "")][0] ?? null;
}

export type Swatch = {
  colour: RepoColour;
  /** the pick names it: ringed, ticked, and the checked radio */
  picked: boolean;
  /** what the pick paints, ringed: the picked swatch, or automatic's while automatic is the pick */
  shown: boolean;
  /** the colour automatic gives: "auto" under its name */
  auto: boolean;
  /** the other repos on the machine that wear it */
  wearers: readonly string[];
  badge: string | null;
  /** its accessible name: "slate, worn by relay", "cobalt, automatic" */
  label: string;
};

export function swatchesOf(pick: Pick, auto: RepoColour, neighbours: readonly Neighbour[]): Swatch[] {
  const shown = shownBy(pick, auto);
  return REPO_COLOURS.map((colour) => {
    const wearers = neighbours.filter((n) => n.colour.name === colour.name).map((n) => n.name);
    const isAuto = colour.name === auto.name;
    const label = [colour.name, isAuto ? "automatic" : null, wearers.length ? `worn by ${listOf(wearers)}` : null].filter(Boolean).join(", ");
    return { colour, picked: pick.kind === "chosen" && pick.name === colour.name, shown: colour.name === shown.name, auto: isAuto, wearers, badge: badgeOf(wearers), label };
  });
}

/** at most this many colours are named after the shown one; the rest are counted */
const NOTE_COLOURS = 3;

/** the line under the swatches: who wears the colour being shown, and what the machine's other repos wear. null when the
    machine has no other repo. sharing is allowed, and said so, since two repos alike is a real cost */
export function noteOf(host: string, shown: RepoColour, neighbours: readonly Neighbour[]): string | null {
  if (neighbours.length === 0) return null;
  const mine = neighbours.filter((n) => n.colour.name === shown.name).map((n) => n.name);
  const groups = REPO_COLOURS.filter((c) => c.name !== shown.name)
    .map((c) => ({ colour: c.name, names: neighbours.filter((n) => n.colour.name === c.name).map((n) => n.name) }))
    .filter((g) => g.names.length > 0);
  const named = groups.slice(0, NOTE_COLOURS).map((g) => `${listOf(g.names)} ${g.names.length > 1 ? "have" : "has"} ${g.colour}`);
  const left = groups.slice(NOTE_COLOURS).reduce((n, g) => n + g.names.length, 0);
  if (left > 0) named.push(`${left} more ${left === 1 ? "repo has" : "repos have"} other colours`);
  const others = named.length ? ` ${named.join(", ")}.` : "";
  if (mine.length === 0) return `${shown.name} is free on ${host}.${others}`;
  return `${shown.name} is ${listOf(mine.map((n) => `${n}'s`))} on ${host}.${others} you can still share one; their windows would look alike.`;
}

/** the automatic row's line, honest about where the colour comes from: boxbox gave it and every device shows it, or, for a
    repo the server has not spoken for, the colour it has until boxbox gives it one */
export function autoLine(name: string, auto: RepoColour, assigned: boolean): string {
  return assigned ? `${auto.name}, picked by boxbox. every device agrees.` : `${auto.name} for now. boxbox picks ${name}'s own when a thread runs there.`;
}

/** the two buttons: "keep" leaves what the server holds, "use" sends the pick and is there only once the pick differs, or
    while the pick is one every device shows that the server could not keep (`unkept`), which "use" sends again. the
    current choice is named by its colour, or as "automatic" when the pick is that same colour chosen by hand, so the two
    never read alike */
export function buttonsOf(current: Pick, pick: Pick, auto: RepoColour, unkept: Pick | null = null): { keep: string; use: string | null } {
  const now = current.kind === "chosen" ? current.name : pick.kind === "chosen" && pick.name === auto.name ? "automatic" : auto.name;
  const offered = !samePick(current, pick) || (unkept !== null && samePick(unkept, pick));
  const use = !offered ? null : pick.kind === "auto" ? "use automatic" : `use ${pick.name}`;
  return { keep: `keep ${now}`, use };
}

/** a refusal with the error code `store-down` comes after every stream has heard the choice: the colour shows everywhere,
    and only the keeping failed. any other refusal changed nothing, a 503 included (a server that is stopping, or a proxy's
    503 with no body): `code` is the server's `ErrorDetail.code`, null when there was none */
export function heardBeforeRefused(code: string | null | undefined): boolean {
  return code === "store-down";
}

/** the words when the server would not take the choice: what happened and what to do, and the sheet stays open to try
    again. `shows` is the colour every device shows already when the server heard the choice and could not keep it;
    otherwise nothing changed and the server's own words carry the reason */
export function refusedLine(name: string, error: string, shows: string | null = null): string {
  if (shows !== null) return `every device shows ${shows} now, but the server could not keep it, so it goes back when the server restarts. try again in a moment.`;
  const why = error.trim().replace(/\.?$/, ".");
  return `${name}'s colour did not change. ${why}`;
}

/** the thread menu's item and the repo line's name: the colour shown now and where it comes from */
export function colourLine(repo: Repo, colours: ColourMap): { colour: RepoColour; automatic: boolean; text: string } {
  const { shown, chosen } = colourAssignment(repo, colours);
  const automatic = chosen === null;
  return { colour: shown, automatic, text: `${shown.name} · ${automatic ? "automatic" : "chosen"}` };
}

/** the radio group's order: automatic first, then the ten in slot order */
export const PICK_ORDER: readonly Pick[] = [AUTOMATIC, ...REPO_COLOURS.map((c): Pick => ({ kind: "chosen", name: c.name }))];

/** the pick an arrow key moves to, wrapping at the ends as a radio group does */
export function stepPick(pick: Pick, by: 1 | -1): Pick {
  const at = PICK_ORDER.findIndex((p) => samePick(p, pick));
  const next = (Math.max(0, at) + by + PICK_ORDER.length) % PICK_ORDER.length;
  return PICK_ORDER[next] as Pick; // an index modulo the length
}
