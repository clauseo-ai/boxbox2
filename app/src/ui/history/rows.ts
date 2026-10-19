/* what a row of history shows, derived from the server's page and, for a
   thread the fleet holds, the fleet's live state (docs/home.md, history).
   the page carries only what the daemon lists (title, repo, times); whether
   a thread works, wants you or stopped is the fleet's, so a row overlays it
   where it can and reads "idle" where the fleet does not hold the thread.
   pure, so rows.test.ts pins it. */

import type { components } from "../../api/boxbox";
import type { Ask, SessionEntry, SessionInfo } from "../../sync/protocol";
import { repoRootOf } from "../composer/place";
import { extraOf } from "../inbox/extra";
import { type ColourMap, colourOf, type RepoColour, repoName } from "../window/repo";
import { type WindowState, windowView } from "../window/view";

export type HistoryApiRow = components["schemas"]["HistoryRow"];

export type RowView = {
  key: string;
  host: string;
  repo: string;
  /** the repo's project root, which its mark is read by */
  root: string;
  colour: RepoColour;
  title: string;
  state: WindowState;
  /** the state in words: `wants you`, `working`, `stopped`, `done`, `parked`, `idle` */
  words: string;
  /** off home now, by hand; it comes back on its own */
  cleared: boolean;
  /** ms, the daemon's clock */
  updated: number;
  /** "3 h ago", "yesterday", "12 sep" */
  when: string;
  /** the row's accessible name: unique per thread (the time is to the minute) */
  name: string;
};

const WORDS: Record<WindowState, string> = {
  wants: "wants you",
  failed: "stopped",
  working: "working",
  queued: "working",
  parked: "parked",
  done: "done",
  idle: "idle",
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const yearFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const stampFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** last activity, as a person says it; a future time (a clock a little ahead) reads as now */
export function whenOf(updated: number, now: number): string {
  const age = now - updated;
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 2 * DAY) return "yesterday";
  const year = new Date(now).getFullYear();
  return new Date(updated).getFullYear() === year ? dayFormat.format(updated) : yearFormat.format(updated);
}

/** what a row's name is made of before the fleet's live state: two rows sharing it need telling apart */
function staticName(row: HistoryApiRow): string {
  const info = row.info as unknown as SessionInfo;
  return `${repoName(info.projectID)}: ${info.title.trim() || "untitled"}, ${row.host}, ${stampFormat.format(info.time.updated)}`;
}

const idOf = (row: HistoryApiRow): string => row.key.slice(row.key.indexOf(":") + 1);

/** for rows whose names would be the same (the same repo, title and machine in one minute: a bulk import, a fan of
    retries), a suffix of the session id, as short as tells them apart, so every control has its own name (AGENTS.md,
    accessibility). rows with a name of their own get none */
export function collisionSuffixes(rows: readonly HistoryApiRow[]): Map<string, string> {
  const groups = new Map<string, HistoryApiRow[]>();
  for (const row of rows) {
    const name = staticName(row);
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  const suffixes = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ids = group.map(idOf);
    const longest = Math.max(...ids.map((id) => id.length));
    let length = 4;
    while (length < longest && new Set(ids.map((id) => id.slice(-length))).size < ids.length) length += 1;
    for (const row of group) suffixes.set(row.key, `, ${idOf(row).slice(-length)}`);
  }
  return suffixes;
}

/** `colours` is the fleet's (window/colours.ts, `colourMap`), from the reactive caller */
export function rowView(row: HistoryApiRow, held: SessionEntry | undefined, asks: readonly Ask[], colours: ColourMap, now: number, suffix = ""): RowView {
  const info = (held?.info ?? row.info) as unknown as SessionInfo;
  const view = held ? windowView(held, asks, colours, extraOf(held)) : null;
  const state: WindowState = view?.state ?? "idle";
  const title = info.title.trim() || "untitled";
  const repo = repoName(info.projectID);
  const updated = info.time.updated;
  // the fleet's mark is the live one: a thread that came back on its own is not cleared any more
  const cleared = held ? held.cleared != null : row.cleared;
  const words = WORDS[state];
  return {
    key: row.key,
    host: row.host,
    repo,
    root: repoRootOf(info),
    // a copy, for the reason windowView copies it: the page's store reconciles rows into what it holds
    colour: { ...colourOf({ host: row.host, root: repoRootOf(info) }, colours) },
    title,
    state,
    words,
    cleared,
    updated,
    when: whenOf(updated, now),
    name: `${repo}: ${title}, ${words}${cleared ? ", cleared" : ""}, ${row.host}, ${stampFormat.format(updated)}${suffix}`,
  };
}

/** a page's rows after the ones already shown: a thread moved between pages (it updated while the person scrolled)
    is not listed twice */
export function appendRows(shown: readonly HistoryApiRow[], page: readonly HistoryApiRow[]): HistoryApiRow[] {
  const seen = new Set(shown.map((row) => row.key));
  return [...shown, ...page.filter((row) => !seen.has(row.key))];
}

/** what an empty list says, for each way it can be empty */
export function emptyWords(facts: { searching: boolean; machine: string | null; unreached: number }): string {
  if (facts.searching) return facts.machine ? `nothing on ${facts.machine} matches that.` : "nothing matches that.";
  if (facts.machine) return `${facts.machine} has no threads yet.`;
  return facts.unreached > 0 ? "no machine answered. check they are running, then try again." : "no threads yet. start one from the plus.";
}

/** one line for machines the page could not read */
export function unreachedWords(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const [only] = names;
  if (names.length === 1 && only) return `${only} did not answer, so its threads are missing here.`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} did not answer, so their threads are missing here.`;
}
