/* starting a thread, without its drawing (docs/composer.md, the first message does not close on a guess): where it will
   start (a machine, a repo or any folder on it, a checkout or a fresh worktree), the recents and the folder finder that
   pick it, and the send's life until the thread exists: being made, slow, refused with its words given back, or born and
   opened. home's field (ui/next/field.tsx) is the one surface that draws it; this was the new-thread sheet's own state,
   moved out whole when the sheet became the field, so none of its rules were written twice.

   the words follow the place: a draft is kept per target (`new:<host>:<directory>`), and a pick moves it to the new key
   (place.ts, `followDraft`). the composer is never keyed on the target, so a pick, a fleet beat or a refused send never
   rebuilds the words being typed. */

import { createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { state } from "../../store";
import { discardSend, loadDraftPhotos, retrySend, saveDraft } from "../../sync/client";
import { type Target, targetKey } from "../../sync/outbox";
import { repoName } from "../window/repo";
import { canonicalDirectory, directoryOfTyped, draftedPlaces, followDraft, isDrafted, looksLikePath, matchRepos, recentRepos, restoredDraft, splitPath } from "./place";
import { folders, projects } from "./reads";

/** how long a send waits for its thread before it says it is taking long (it keeps waiting) */
const SLOW_MS = 8000;
/** a pause in typing a folder this long reads the folder */
const BROWSE_PAUSE_MS = 160;
/** the repos offered as rows while a word filters them */
const ROWS = 40;

export type Place = { host: string; directory: string | null };

type Sent = { clientID: string; at: number; host: string; directory: string; from: HTMLElement };

export type NewThreadOptions = {
  /** where it starts until something is picked: the place you were looking at */
  start: () => Place | null;
  /** the thread this send made exists: open it, from the element the send left */
  onBorn: (key: string, from: HTMLElement) => void;
};

export function createNewThread(options: NewThreadOptions) {
  const first = untrack(options.start);
  const [host, setHost] = createSignal(first?.host ?? state.fleet.agentNames[0] ?? "");
  const [directory, setDirectory] = createSignal<string | null>(first?.directory ?? null);
  const [place, setPlace] = createSignal<"checkout" | "fresh">("checkout");
  const [listed] = createResource(() => host() || null, projects);
  const machines = () => state.fleet.agentNames;

  // the first machine to come, when there was none (a launch before the agents' list): nothing typed is moved by it
  createEffect(() => {
    const name = machines()[0];
    if (!untrack(host) && name) setHost(name);
  });

  /* your repos by their newest thread, then the machine's other projects by their own activity */
  const seen = createMemo(() => Object.values(state.fleet.threads).filter((entry) => !entry.parent).map((entry) => ({ host: entry.agent, root: entry.place?.root ?? "", at: entry.updated })));
  const repos = createMemo(() => {
    const read = listed();
    return recentRepos(seen(), host(), read?.ok ? read.value : []).filter(Boolean);
  });
  /** when you last had a thread in a repo, for the words beside it */
  const lastAt = (at: string, root: string): number | null => {
    let last: number | null = null;
    for (const s of seen()) if (s.host === at && s.root === root) last = Math.max(last ?? 0, s.at);
    return last;
  };
  /* the name each thread's folder has as a repo, so a folder walked to under the name it was typed is the repo's own */
  const aliases = createMemo(() => Object.values(state.fleet.threads).map((entry) => ({ host: entry.agent, directory: entry.place?.directory ?? "", root: entry.place?.root ?? "" })));
  // the first repo is taken once and kept: a fleet beat that reorders the recents must not move the target under the words.
  // it goes through retarget like every pick, because words typed while no folder was chosen are kept under that place
  createEffect(() => {
    const top = repos()[0];
    if (directory() === null && top) untrack(() => retarget(host(), top));
  });
  const chosen = () => directory();

  /* folders where words wait: they stay offered, so a refused message or a folder typed once is one tap away */
  const waiting = createMemo(() => draftedPlaces(Object.keys(state.composer.drafts), host(), (key) => isDrafted(state.composer.drafts[key])));
  /** the recents as offered: the chosen folder and the ones holding words first when they are not recent, then the recents */
  const offered = createMemo(() => {
    const listedNow = repos();
    const extra = [...(chosen() ? [chosen() as string] : []), ...waiting()].filter((dir, i, all) => !listedNow.includes(dir) && all.indexOf(dir) === i);
    return [...extra, ...listedNow];
  });
  /** why there are no recents: the read is out, it failed (its words), or the machine has none */
  const recentsNote = () => {
    if (!host()) return "no machine is connected yet. add one from agents.";
    if (listed.loading) return "looking.";
    const read = listed();
    if (read && !read.ok) return read.message;
    return `nothing has run on ${host()} yet. type a folder to start in, like ~/code.`;
  };

  /* folders known not to be a git repo, from reading their parent: a fresh worktree needs one */
  const [plain, setPlain] = createSignal<ReadonlySet<string>>(new Set());
  const isPlain = () => {
    const dir = chosen();
    return dir !== null && plain().has(dir);
  };
  const where = () => (isPlain() ? "checkout" : place());

  const keyFor = (at: string, dir: string | null) => targetKey({ kind: "new", host: at, directory: dir ?? "", place: "checkout" });
  const target = (): Target => ({ kind: "new", host: host(), directory: chosen() ?? "", place: where() });
  const draftKey = () => keyFor(host(), chosen());

  /* the words go with you to the place you pick: a draft is kept per target, so it moves to the new one's key */
  const retarget = (nextHost: string, nextDir: string | null) => {
    const from = keyFor(host(), chosen());
    const to = keyFor(nextHost, nextDir);
    if (from !== to) {
      const move = () => {
        // photos that could not be read from the device stay where they are, with their draft
        if (state.composer.drafts[from]?.held) return;
        const moved = followDraft(state.composer.drafts[from], state.composer.drafts[to], Date.now());
        if (moved.clearLeaving && moved.arriving) {
          saveDraft(to, moved.arriving);
          saveDraft(from, null);
        }
      };
      // the draft moves with its photos, so ones still on the device are read first (they are, as its composer opens)
      if (state.composer.drafts[from]?.held) void loadDraftPhotos(from).then(move);
      else move();
    }
    setHost(nextHost);
    setDirectory(nextDir);
  };
  const pickRepo = (dir: string, at = host()) => {
    // choosing another place after a refusal is editing: the refused words come back first
    if (failed()) backToDraft();
    const canonical = canonicalDirectory(dir, aliases(), at);
    if (at !== host() || canonical !== chosen()) retarget(at, canonical);
    setQuery("");
  };
  const pickMachine = (name: string) => {
    if (name === host()) return;
    if (failed()) backToDraft();
    // the recents of the other machine are read for it; until they come, no repo is chosen and the finder says so
    retarget(name, null);
    setQuery("");
  };

  /* the finder: a word filters the repos, a typed path reads the folders inside it */
  const [query, setQueryNow] = createSignal("");
  const [typed, setTyped] = createSignal("");
  let browseTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(browseTimer));
  const setQuery = (value: string) => {
    if (value === untrack(query)) return;
    setQueryNow(value);
    clearTimeout(browseTimer);
    if (!looksLikePath(value)) return setTyped("");
    browseTimer = setTimeout(() => setTyped(value), BROWSE_PAUSE_MS);
  };
  const [browsed] = createResource(
    () => (looksLikePath(typed()) && host() ? { at: host(), ...splitPath(typed()) } : null),
    ({ at, dir, prefix }) => folders(at, dir, prefix),
  );
  createEffect(() => {
    const read = browsed();
    if (!read?.ok) return;
    const next = new Set(untrack(plain));
    for (const folder of read.value.children) {
      if (folder.repo) next.delete(folder.directory);
      else next.add(folder.directory);
    }
    setPlain(next);
  });
  const pathMode = () => looksLikePath(query());
  const known = createMemo(() => (pathMode() ? [] : matchRepos(offered(), query()).slice(0, ROWS)));
  /* a word that names a repo you have threads in on another machine finds it there too: picking it moves both */
  const elsewhere = createMemo(() => {
    if (pathMode() || !query().trim()) return [];
    const out: Array<{ host: string; root: string }> = [];
    for (const name of machines()) {
      if (name === host()) continue;
      const roots = [...new Set(seen().filter((s) => s.host === name && s.root).map((s) => s.root))];
      for (const root of matchRepos(roots, query())) out.push({ host: name, root });
    }
    return out.slice(0, 8);
  });
  const children = createMemo(() => {
    const read = browsed();
    if (!pathMode() || !read?.ok) return [];
    const prefix = splitPath(query()).prefix.toLowerCase();
    return read.value.children.filter((folder) => folder.name.toLowerCase().startsWith(prefix)).slice(0, ROWS);
  });
  const homeDir = () => {
    const read = browsed();
    return read?.ok ? read.value.home : null;
  };
  /** the folder above the one being read, offered while nothing more is typed after its slash */
  const upFrom = () => {
    const read = browsed();
    return pathMode() && read?.ok && splitPath(query()).prefix === "" ? read.value.parent : null;
  };
  const typedDir = () => (pathMode() ? directoryOfTyped(query(), homeDir()) : null);
  const truncated = () => {
    const read = browsed();
    return read?.ok ? read.value.truncated : false;
  };
  const lookProblem = () => {
    const read = browsed();
    return pathMode() && read && !read.ok ? read.message : null;
  };
  const looking = () => pathMode() && !lookProblem() && (browsed.loading || typed() !== query());

  /* —— the send: the thread is being made, and when it exists it opens —— */
  const [sent, setSent] = createSignal<Sent | null>(null);
  const [slow, setSlow] = createSignal(false);
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let landing = false;
  onCleanup(() => clearTimeout(slowTimer));
  const started = (clientID: string, from: HTMLElement) => {
    landing = false;
    setSlow(false);
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    setSent({ clientID, at: Date.now(), host: host(), directory: chosen() ?? "", from });
  };
  const entry = () => {
    const s = sent();
    return s ? state.composer.outbox.find((e) => e.clientID === s.clientID) : undefined;
  };
  /* the new thread is the one this send made, named by the worker from the server's answer to this client id (or from its
     echo). never a thread that merely appeared on the machine meanwhile: another phone's, a subagent's */
  createEffect(() => {
    const s = sent();
    if (!s) return;
    const key = state.composer.born[s.clientID];
    if (key && state.fleet.threads[key] && !landing) {
      landing = true;
      clearTimeout(slowTimer);
      untrack(() => {
        setSent(null);
        options.onBorn(key, s.from);
      });
    }
  });
  const failed = () => (entry()?.state === "failed" ? entry() : undefined);
  const retry = () => {
    const s = sent();
    if (s) retrySend(s.clientID);
  };
  /* a first message that did not start goes back where it was written, and its outbox entry goes: left there it would be
     in indexeddb for good, counted against the outbox's cap, and shown nowhere */
  const handled = new Set<string>();
  const restore = (refused: { clientID: string; text: string; model: string | null; effort: string | null; target: Target }) => {
    if (handled.has(refused.clientID)) return;
    handled.add(refused.clientID);
    const at = targetKey(refused.target);
    saveDraft(at, restoredDraft(state.composer.drafts[at], refused, Date.now()));
    // the photos it held follow its words back into the draft
    discardSend(refused.clientID, true);
  };
  const backToDraft = () => {
    const e = failed();
    if (!e) return;
    restore(e);
    setSent(null);
    clearTimeout(slowTimer);
  };
  /* a send that failed after its field had let go of it (a reload, another tab) is still in the outbox: the field that
     comes up next puts its words back, and goes to its place if nothing is typed here */
  createEffect(() => {
    const orphan = state.composer.outbox.find((e) => e.verb === "start" && e.state === "failed" && e.clientID !== sent()?.clientID && !handled.has(e.clientID));
    if (!orphan) return;
    untrack(() => {
      if (orphan.target.kind !== "new") return;
      const here = state.composer.drafts[draftKey()];
      if (!isDrafted(here) && (orphan.target.host !== host() || orphan.target.directory !== chosen())) {
        setHost(orphan.target.host);
        setDirectory(orphan.target.directory);
      }
      restore(orphan);
    });
  });
  const waitingOnDevice = () => entry()?.state === "waiting";
  const makingWords = () => {
    const s = sent();
    const repo = repoName(s?.directory ?? chosen() ?? "");
    if (waitingOnDevice()) return "the connection is down. the thread starts on its own when it is back.";
    if (slow()) return `still making the thread in ${repo}. the machine is slow to answer; it opens when it is there.`;
    return `making the thread in ${repo} on ${s?.host ?? host()}.`;
  };
  /** a send in flight that has not been refused: one thread is made at a time */
  const making = () => sent() !== null && !failed();

  /** why a send cannot go yet; the words are kept whatever it says */
  const blocked = () => {
    if (failed()) return "retry or edit the message below first.";
    // one thread is made at a time: words typed meanwhile wait for the first to open
    if (making()) return isDrafted(state.composer.drafts[draftKey()]) ? "one thread at a time. this one can start once the first is open." : undefined;
    if (!host()) return "no machine is connected yet. add one from agents.";
    return chosen() ? undefined : `pick a repo or a folder on ${host()} to start in`;
  };

  return {
    host,
    directory: chosen,
    place,
    setPlace,
    where,
    isPlain,
    machines,
    repos,
    offered,
    waiting,
    lastAt,
    recentsNote,
    target,
    draftKey,
    pickRepo,
    pickMachine,
    query,
    setQuery,
    pathMode,
    known,
    elsewhere,
    children,
    upFrom,
    typedDir,
    truncated,
    lookProblem,
    looking,
    sent,
    started,
    failed,
    retry,
    backToDraft,
    making,
    makingWords,
    blocked,
  };
}

export type NewThread = ReturnType<typeof createNewThread>;
