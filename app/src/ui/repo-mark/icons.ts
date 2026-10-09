/* what the app knows of each repo's favicon: asked for, and what came of it. the verdict lives in the store
   (state.repoIcons), so every mark of a repo on screen (a window, its swatch, its history rows) shares one request and
   one reading of the image. this file is the state machine, pure: how a reply is classed, when each answer is asked
   again, what is forgotten. probe.ts does the asking.

   the server says why there is no icon (`x-repo-icon` on a 404, server/src/http/repo_icon.rs) and caches each answer
   for as long as it holds, and the app asks again on the same clock:

   | answer      | server's max-age | asked again after                                              |
   |-------------|------------------|----------------------------------------------------------------|
   | an image    | 6 h              | 6 h (on a later mount; the plate is kept while a mark is up)   |
   | none        | 30 min           | 30 min; any class this file does not know is read as none      |
   | unsupported | 5 min            | 5 min (the daemon has no file-read route yet, cmx2 a28)         |
   | unproven    | 60 s             | 60 s (the host has not shown that root to be real yet)          |
   | refused     | 1 h              | 1 h (the host user's home or a directory above it, never listed) |
   | retry       | none (no-store)  | 15 s, doubling to a cap of 20 min: a transient is never         |
   |             |                  | remembered as "no icon", and a host asleep overnight or an empty |
   |             |                  | project is not asked every two minutes for ever                  |

   a retry is anything that says nothing about the repo: a refused or dropped connection, a timeout, an abort, a 5xx,
   a closed gate. only a reply from the server that says there is no icon is remembered as that. */

import type { Plate } from "./plate";

/** why a repo has no icon, as the server says it */
export type Absence = "none" | "unsupported" | "unproven" | "refused";

/** one repo's icon. `at` is when this was learned, ms. `reading` is when a read to replace it began, so a mark never
    sees the verdict it has go blank while it is asked again, and a second mark never asks at the same time */
export type RepoIcon =
  | { state: "probing"; at: number }
  | { state: "ready"; plate: Plate; at: number; reading?: number }
  | { state: "absent"; why: Absence; at: number; reading?: number }
  | { state: "retry"; attempts: number; at: number; reading?: number };

/** a repo is its machine plus its project root: the same folder on two machines is two repos */
export const iconKey = (host: string, root: string): string => `${host}\u0000${root}`;

/** where the server serves a repo's favicon from: image bytes when it has one, anything else when it does not */
export function iconUrl(host: string, root: string): string {
  return `/api/hosts/${encodeURIComponent(host)}/repo-icon?root=${encodeURIComponent(root)}`;
}

/** how one reply from the server reads: an image, a reason there is none, or nothing that can be remembered */
export function classify(status: number, header: string | null): "image" | Absence | "retry" {
  if (status === 200) return "image";
  if (status === 404) {
    if (header === "retry") return "retry";
    return header === "unsupported" || header === "unproven" || header === "refused" ? header : "none";
  }
  // a refusal of this request (a bad root, a forbidden one) says there is no icon; a closed gate, a timeout, a flood of
  // requests, a server error or anything unexpected says nothing about the repo
  if (status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status)) return "none";
  return "retry";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** how long each answer holds before it is asked again: the server's own max-age for it */
export const READY_FOR_MS = 6 * HOUR;
export const ABSENT_FOR_MS: Readonly<Record<Absence, number>> = { none: 30 * MINUTE, unsupported: 5 * MINUTE, unproven: MINUTE, refused: HOUR };

/** a read that has not answered by now is given up on (and is a retry) */
export const READ_MS = 15_000;
/** a read still marked this long after it began is dead, its page frozen or suspended: another may start */
const DEAD_READ_MS = READ_MS * 2;

/** a retry waits 15 s, then doubles each time (30, 60, 120, 240, 480, 960 s) to a cap of 20 minutes: quick while a blip
    may still be passing, and quiet for a host that is asleep or a project the daemon cannot read */
export const RETRY_FIRST_MS = 15_000;
export const RETRY_CAP_MS = 20 * MINUTE;
export const retryDelay = (attempts: number): number => Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);

/** repos remembered before the oldest answers are let go; a person has a few dozen repos at most */
export const ICON_CAP = 96;

/** when this verdict is due to be asked again, ms since the epoch */
export function dueAt(icon: RepoIcon): number {
  if (icon.state === "probing") return icon.at + DEAD_READ_MS;
  if (icon.reading !== undefined) return icon.reading + DEAD_READ_MS;
  switch (icon.state) {
    case "ready":
      return icon.at + READY_FOR_MS;
    case "absent":
      return icon.at + ABSENT_FOR_MS[icon.why];
    case "retry":
      return icon.at + retryDelay(icon.attempts);
    default:
      return icon satisfies never;
  }
}

/** how long a mark that is up waits before it asks again, or null when it should not: an image is kept while the mark
    stays (a later mount asks after six hours), and a read in flight settles by itself and wakes the mark when it does */
export function askAgainIn(icon: RepoIcon, now: number): number | null {
  if (icon.state === "ready" || icon.state === "probing") return null;
  return Math.max(0, dueAt(icon) - now);
}

/** whether a mark that finds this verdict (or none) should read the icon */
export const needsProbe = (icon: RepoIcon | undefined, now: number): boolean => icon === undefined || now >= dueAt(icon);

/** the verdict as a read begins: what was known stays (so nothing blanks), marked as being asked again */
export function reading(icon: RepoIcon | undefined, now: number): RepoIcon {
  return icon === undefined || icon.state === "probing" ? { state: "probing", at: now } : { ...icon, reading: now };
}

/** what one finished read comes to */
export type Read = { kind: "plate"; plate: Plate } | { kind: "absent"; why: Absence } | { kind: "retry" };

/** the verdict after a read: a transient keeps what was known (a plate stays a plate, tried again in six hours) or
    counts up the retries; everything else is the server's answer, kept for as long as it holds */
export function settled(was: RepoIcon | undefined, read: Read, now: number): RepoIcon {
  switch (read.kind) {
    case "plate":
      return { state: "ready", plate: read.plate, at: now };
    case "absent":
      return { state: "absent", why: read.why, at: now };
    case "retry":
      if (was?.state === "ready") return { state: "ready", plate: was.plate, at: now };
      return { state: "retry", attempts: (was?.state === "retry" ? was.attempts : 0) + 1, at: now };
    default:
      return read satisfies never;
  }
}

/** the keys to forget so that at most `cap` remain: the oldest answers first, never one a mark on screen holds and never
    one still being read for the first time. a screen shows a few dozen repos at most, well under the cap, so holds only
    matter when a person has far more repos than that and an old window is still up */
export function evictions(icons: Readonly<Record<string, RepoIcon>>, held: Readonly<Record<string, number>> = {}, cap: number = ICON_CAP): string[] {
  const free = Object.entries(icons)
    .filter(([key, icon]) => icon.state !== "probing" && !held[key])
    .sort((a, b) => a[1].at - b[1].at);
  const over = Object.keys(icons).length - cap;
  return over > 0 ? free.slice(0, over).map(([key]) => key) : [];
}
