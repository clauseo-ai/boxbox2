/* the client id a fork carries (docs/thread.md, fork): one per cut while that fork is in flight or has failed, so a retry
   after an answer that never came, a reload of the same stage, or a second tap repeats it, and the agent (cmx2's once rule
   for forks) answers the first fork instead of making another. a fork that is answered lets its id go, so the next fork
   of the same cut is a new one; a new cut gets a new id. an answer that never came or left it unknown (a network error,
   a 5xx) keeps it; a refusal lets it go too (`settles`), since a repeat of a 4xx is that 4xx again, and one (a client id
   the agent saw for another action) is only cured by a new id. the ids live in the tab's sessionStorage, which a reload keeps and
   another tab does not share, as one small list with the oldest let go past its cap. */

/** the cuts whose ids are kept at once; past it the oldest goes (a fork that failed and was never tried again) */
export const FORK_IDS_KEPT = 16;
const KEY = "boxbox.forks";

/** what the ids are kept in: sessionStorage in the app, a map in the tests */
export type Shelf = Pick<Storage, "getItem" | "setItem">;

type Kept = [cut: string, id: string][];

/** the tab's sessionStorage as a shelf: a browser that will not give it (storage turned off) reads as empty, and a write it
    refuses is caught where it is made */
export const tabShelf: Shelf = {
  getItem: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => sessionStorage.setItem(k, v),
};

/** a cut as the list names it: the thread, and the message it is cut before, or the whole thread */
export const cutKey = (thread: string, before: string | undefined): string => `${thread}|${before ?? ""}`;

function read(shelf: Shelf): Kept {
  try {
    const raw = JSON.parse(shelf.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") : [];
  } catch {
    return [];
  }
}

function write(shelf: Shelf, kept: Kept): void {
  try {
    shelf.setItem(KEY, JSON.stringify(kept.slice(-FORK_IDS_KEPT)));
  } catch {
    /* storage refused: the id lasts for this call, and a retry after a reload makes a new one */
  }
}

/** the id for a fork of this cut: the one kept from an earlier try that was not answered, else a new one, kept until the
    fork is answered */
export function forkId(shelf: Shelf, cut: string, mint: () => string): string {
  const kept = read(shelf);
  const found = kept.find(([c]) => c === cut);
  if (found) return found[1];
  const id = mint();
  write(shelf, [...kept, [cut, id]]);
  return id;
}

/** the fork of this cut was answered for good (`settles`): its id is let go */
export function forkDone(shelf: Shelf, cut: string): void {
  const kept = read(shelf);
  if (kept.some(([c]) => c === cut)) write(shelf, kept.filter(([c]) => c !== cut));
}

/** whether an answer settles a fork, so its id may go: it was made (2xx), or refused in a way a repeat cannot change (4xx,
    save a timeout or a limit). null is no answer at all (the request failed on its way); a 5xx (the agent unreachable, or
    the fork taken and its answer lost) keeps the id for the retry */
export function settles(status: number | null): boolean {
  if (status === null) return false;
  if (status >= 200 && status < 300) return true;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
