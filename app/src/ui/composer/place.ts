/* where a new thread can start, as pure rules: the repo a session belongs to, the repos in recency order, how a typed
   word narrows them, and how a typed path splits into the folder to read and the part still being typed. tested; home's
   field (ui/next/field.tsx, through new-thread.ts) only draws what these say. */

import type { Draft } from "../../sync/outbox";

/** the repo a session belongs to: its project root, the checkout a new thread starts in (not another thread's worktree).
    a project id that is not a path (cmx2 falls back to the directory) is not a root */
export function repoRootOf(info: { projectID: string; directory: string }): string {
  return info.projectID.startsWith("/") ? info.projectID : info.directory;
}

/** a repo as home's field lists it */
export type Seen = { host: string; root: string; at: number };

/** the repos of one machine: the ones you have threads in, newest thread first, then the machine's other projects by
    their own activity. a directory is listed once */
export function recentRepos(sessions: readonly Seen[], host: string, projects: readonly { directory: string; updated?: number | null }[]): string[] {
  const threads = new Map<string, number>();
  for (const seen of sessions) if (seen.host === host) threads.set(seen.root, Math.max(threads.get(seen.root) ?? 0, seen.at));
  const first = [...threads].sort((a, b) => b[1] - a[1]).map(([root]) => root);
  const rest = projects
    .filter((project) => !threads.has(project.directory))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .map((project) => project.directory);
  return [...first, ...new Set(rest)];
}

/** a recent repo as home's chips above the field offer it: where it is, and the words it is said in */
export type RecentChip = { host: string; root: string; repo: string; machine: string | null; name: string };

/** the repos you used last, on any machine, for the chips above home's field: the ones you have threads in, newest thread
    first, then the field's machine's own recents (`recentRepos`, its projects included) until there are `limit`. a repo on
    another machine than the field's says its machine; two of one name on one machine are told apart by their path in the
    name, so every chip's name is its own */
export function recentChips(sessions: readonly Seen[], host: string, hostRepos: readonly string[], repoName: (root: string) => string, limit: number): RecentChip[] {
  const newest = new Map<string, Seen>();
  for (const seen of sessions) {
    if (!seen.root || !seen.host) continue;
    const key = `${seen.host}\n${seen.root}`;
    const had = newest.get(key);
    if (!had || seen.at > had.at) newest.set(key, seen);
  }
  const places = [...newest.values()].sort((a, b) => b.at - a.at).map((seen) => ({ host: seen.host, root: seen.root }));
  for (const root of hostRepos) if (root && !newest.has(`${host}\n${root}`)) places.push({ host, root });
  const taken = places.slice(0, Math.max(0, limit));
  const count = new Map<string, number>();
  for (const at of taken) count.set(`${at.host}\n${repoName(at.root)}`, (count.get(`${at.host}\n${repoName(at.root)}`) ?? 0) + 1);
  return taken.map((at) => {
    const repo = repoName(at.root);
    const machine = at.host === host ? null : at.host;
    const twin = (count.get(`${at.host}\n${repo}`) ?? 0) > 1;
    return { host: at.host, root: at.root, repo, machine, name: `start in ${repo}${machine ? ` on ${machine}` : ""}${twin ? `, ${at.root}` : ""}` };
  });
}

/** the repos a typed word narrows to: every word must be in the name or the path, names first. no word is every repo */
export function matchRepos(repos: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...repos];
  const scored: Array<[string, number]> = [];
  for (const repo of repos) {
    const path = repo.toLowerCase();
    const name = path.slice(path.replace(/\/+$/, "").lastIndexOf("/") + 1);
    if (!words.every((word) => path.includes(word))) continue;
    scored.push([repo, words.every((word) => name.includes(word)) ? (name.startsWith(words[0] ?? "") ? 0 : 1) : 2]);
  }
  return scored.sort((a, b) => a[1] - b[1]).map(([repo]) => repo);
}

/** a typed folder rather than a word to filter by: absolute, or from the machine's home */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  return t.startsWith("/") || t === "~" || t.startsWith("~/");
}

/** a typed path as the folder to read and what is still being typed after its last slash: "/Users/dev/co" reads
    "/Users/dev" for names starting "co"; "/Users/dev/" reads it for all of them */
export function splitPath(text: string): { dir: string; prefix: string } {
  const t = text.trim();
  if (t === "~") return { dir: "~", prefix: "" };
  const slash = t.lastIndexOf("/");
  if (slash < 0) return { dir: "", prefix: t };
  return { dir: slash === 0 ? "/" : t.slice(0, slash), prefix: t.slice(slash + 1) };
}

/** a typed path as a directory to start in, given the machine's home when it starts with "~"; none when it is not a path */
export function directoryOfTyped(text: string, home: string | null): string | null {
  const t = text.trim().replace(/\/+$/, "") || (text.trim().startsWith("/") ? "/" : "");
  if (t.startsWith("/")) return t;
  if (t === "~") return home;
  if (t.startsWith("~/")) return home ? `${home.replace(/\/+$/, "")}/${t.slice(2)}` : null;
  return null;
}

/** a draft that holds something: words, a photo, or a model or effort picked */
export function isDrafted(draft: Draft | undefined): draft is Draft {
  return Boolean(draft && (draft.text.trim() || draft.photos.length || draft.held || draft.model || draft.effort));
}

/** what a pick of another place does to the words: they go with you. the draft at the place you leave moves to the place
    you pick (whatever it held there is replaced, since what you just typed is what you mean to send); a leaving draft
    with nothing in it moves nothing. returns the draft the new place holds, and whether the old place is cleared */
export function followDraft(leaving: Draft | undefined, arriving: Draft | undefined, now: number): { arriving: Draft | undefined; clearLeaving: boolean } {
  if (!isDrafted(leaving)) return { arriving, clearLeaving: false };
  return { arriving: { ...leaving, at: now }, clearLeaving: true };
}

/** the words of a first message that did not start, put back where they were written: before what the place holds now,
    so nothing there is lost and the refused message reads first. the photos are not here: an outbox view holds only their
    count, so the worker hands them back when the entry is discarded (`returned`), and they join the draft this makes */
export function restoredDraft(held: Draft | undefined, refused: { text: string; model: string | null; effort: string | null }, now: number): Draft {
  const text = isDrafted(held) && held.text.trim() ? `${refused.text}\n\n${held.text}` : refused.text;
  return { text, photos: held?.photos ?? [], model: refused.model ?? held?.model ?? null, effort: refused.effort ?? held?.effort ?? null, at: now, ...(held?.held ? { held: held.held } : {}) };
}

/** the folder a pick means: the project root the host's own sessions name for it, when it has one. cmx2 names a git
    project by its resolved path ("/private/tmp/x" for "/tmp/x"), so a folder walked to by the name it was typed under
    would sit beside the repo's own chip as a second one */
export function canonicalDirectory(directory: string, sessions: ReadonlyArray<{ host: string; directory: string; root: string }>, host: string): string {
  const same = sessions.find((s) => s.host === host && s.directory === directory);
  return same ? same.root : directory;
}

/** the places on a machine where words wait in a sheet draft (`new:<host>:<directory>` keys), so a folder typed once and
    left, or a first message that did not start, is still one tap away and not only reachable by typing its path again */
export function draftedPlaces(draftKeys: readonly string[], host: string, drafted: (key: string) => boolean): string[] {
  const prefix = `new:${host}:`;
  return draftKeys.filter((key) => key.startsWith(prefix) && key.length > prefix.length && drafted(key)).map((key) => key.slice(prefix.length));
}
