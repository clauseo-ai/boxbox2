/* what home lists under the field (docs/design.md, home: what next), assembled from what the server already gave: the
   threads that need you, in the inbox's order and never re-ranked here (decision 16: the order is the inbox), each with
   the one verb that answers it; then the repos to start in, in the recency the new-thread path has always used
   (composer/place.ts, `recentRepos`). the working fold is not a row here: its capsule is already on screen at every
   arrangement, and one thing is said in one place (decision 106). pure, so assemble.test.ts is the whole story. */

import { repoName } from "../window/repo";
import type { WindowView } from "../window/view";

/** a thread that needs you, and the verb that answers it: the answer sheet for an ask, the thread for the rest */
export type NeedRow = {
  key: string;
  state: "wants" | "failed" | "done";
  verb: "answer" | "open";
  host: string;
  repo: string;
  root: string;
  /** the line that says what it needs */
  head: string;
  /** the quiet line under it: the repo, and the thread when the head is not its title */
  detail: string;
  /** the verb's accessible name: what it does, to which thread */
  name: string;
};

export type RepoRow = { host: string; root: string; repo: string; detail: string; name: string };

export type NextUp = {
  needs: NeedRow[];
  repos: RepoRow[];
};

export type NextInput = {
  /** home's windows in the order the server gave, the folded ones not among them */
  order: readonly string[];
  viewOf: (key: string) => WindowView | null;
  /** the field's machine, and its repos in recency order (`recentRepos`) */
  host: string;
  repos: readonly string[];
  /** when you last had a thread in a repo, ms, if you have; `now` to say how long ago */
  lastAt: (host: string, root: string) => number | null;
  now: number;
  /** how many repos to offer: the room under the list */
  repoLimit: number;
};

const NEEDS = new Set<WindowView["state"]>(["wants", "failed", "done"]);

export function nextUp(input: NextInput): NextUp {
  const needs: NeedRow[] = [];
  for (const key of input.order) {
    const view = input.viewOf(key);
    if (!view || !NEEDS.has(view.state)) continue;
    needs.push(needRow(view));
  }
  const offered = input.repos.slice(0, Math.max(0, input.repoLimit));
  // two folders of one name on a machine (a clone and a fork) are told apart by their path, in the words and the name
  const names = new Map<string, number>();
  for (const root of offered) names.set(repoName(root), (names.get(repoName(root)) ?? 0) + 1);
  const repos = offered.map((root) => repoRow(input.host, root, input.lastAt(input.host, root), input.now, (names.get(repoName(root)) ?? 0) > 1));
  return { needs, repos };
}

function needRow(view: WindowView): NeedRow {
  const base = { key: view.key, host: view.host, repo: view.repo, root: view.root };
  const of = `${view.repo}: ${view.title}`;
  if (view.state === "wants") {
    const head = view.need?.line ?? view.ask?.text ?? "wants you";
    return { ...base, state: "wants", verb: "answer", head, detail: `${view.repo} · ${view.title}`, name: `answer ${of}` };
  }
  if (view.state === "failed") {
    const head = view.failure ? `stopped: ${view.failure}` : "stopped";
    return { ...base, state: "failed", verb: "open", head, detail: `${view.repo} · ${view.title}`, name: `open ${of}, stopped` };
  }
  return { ...base, state: "done", verb: "open", head: view.title, detail: `${view.repo} · done`, name: `open ${of}, done` };
}

function repoRow(host: string, root: string, last: number | null, now: number, twin: boolean): RepoRow {
  const repo = repoName(root);
  const when = last === null ? null : agoWords(now - last);
  const where = twin ? root : host;
  return { host, root, repo, detail: when ? `${where} · ${when}` : where, name: twin ? `start in ${repo} on ${host}, ${root}` : `start in ${repo} on ${host}` };
}

/** how long ago, in the fewest plain words: "just now", "4 minutes ago", "2 hours ago", "3 days ago" */
export function agoWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
