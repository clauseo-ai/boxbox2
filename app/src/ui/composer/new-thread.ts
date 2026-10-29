/* starting a thread, without its drawing (docs/composer.md, the first message does not close on a guess): where it will
   start (a machine, a repo or any folder on it, a checkout or a fresh worktree), the recents and the folder finder that
   pick it, and the send's life until the thread exists: being made, slow, refused with its words given back, or born and
   opened. home's field (ui/next/field.tsx) is the one surface that draws it; this was the new-thread sheet's own state,
   moved out whole when the sheet became the field, so none of its rules were written twice.

   the words follow the place: a draft is kept per target (`new:<host>:<directory>`), and a pick moves it to the new key
   (place.ts, `followDraft`). the composer is never keyed on the target, so a pick, a fleet beat or a refused send never
   rebuilds the words being typed.

   the place picked and the send in flight live in the store (`state.newThread`, this file its one writer), so a field
   mounted again, as an arrangement change mounts it, keeps both: the thread still opens, the making line is still said,
   and the words are still under the place they were typed for. the send's decisions are send-life.ts, pure and tested. */

import { createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { type NewPlace, type NewSent, setNewThread, state } from "../../store";
import { discardSend, loadDraftPhotos, retrySend, saveDraft } from "../../sync/client";
import { type OutboxView, type Target, targetKey } from "../../sync/outbox";
import { repoName } from "../window/repo";
import { canonicalDirectory, directoryOfTyped, draftedPlaces, followDraft, isDrafted, looksLikePath, matchRepos, recentChips, recentRepos, restoredDraft, splitPath } from "./place";
import { folders, projects } from "./place-reads";
import { blockedWords, bornKey, makingWords as makingSaid, orphanOf, refusedOf, slowIn } from "./send-life";

/** refused sends remembered as given back (`state.newThread.restored`): an entry is discarded within a beat, so a handful is plenty */
const RESTORED_CAP = 16;

/* the store's slice, as this file (its one writer) moves it */
const setNewPlace = (place: NewPlace) => setNewThread({ place });
const setNewSent = (sent: NewSent | null) => setNewThread({ sent });
const markRestored = (clientID: string) => {
  const list = state.newThread.restored;
  if (!list.includes(clientID)) setNewThread({ restored: [...list, clientID].slice(-RESTORED_CAP) });
};

/** a pause in typing a folder this long reads the folder */
const BROWSE_PAUSE_MS = 160;
/** the repos offered as rows while a word filters them */
const ROWS = 40;
/** the recent repos offered as chips above home's field (docs/design.md, home: what next): one row, at most this many */
const RECENT_CHIPS = 5;

export type Place = { host: string; directory: string | null };

/** what the send says to the worker and reads from the machine; a test hands in its own (new-thread.reactive.test.ts) */
export type NewThreadIo = {
  saveDraft: typeof saveDraft;
  discardSend: typeof discardSend;
  retrySend: typeof retrySend;
  loadDraftPhotos: typeof loadDraftPhotos;
  projects: typeof projects;
  folders: typeof folders;
};

const IO: NewThreadIo = { saveDraft, discardSend, retrySend, loadDraftPhotos, projects, folders };

export type NewThreadOptions = {
  /** where it starts until something is picked: the place you were looking at, taken by the first field to come up */
  start: () => Place | null;
  /** the thread this send made exists: open it */
  onBorn: (key: string) => void;
  io?: NewThreadIo;
};

const NOWHERE: NewPlace = { host: "", directory: null, place: "checkout" };

export function createNewThread(options: NewThreadOptions) {
  const io = options.io ?? IO;
  if (!state.newThread.place) {
    const first = untrack(options.start);
    setNewPlace({ host: first?.host ?? state.fleet.agentNames[0] ?? "", directory: first?.directory ?? null, place: "checkout" });
  }
  const at = (): NewPlace => state.newThread.place ?? NOWHERE;
  const host = () => at().host;
  const directory = () => at().directory;
  const place = () => at().place;
  const setPlace = (next: "checkout" | "fresh") => setNewPlace({ ...at(), place: next });
  const moveTo = (nextHost: string, nextDir: string | null) => setNewPlace({ ...at(), host: nextHost, directory: nextDir });
  const [listed] = createResource(() => host() || null, (h) => io.projects(h));
  const machines = () => state.fleet.agentNames;

  // the first machine to come, when there was none (a launch before the agents' list): nothing typed is moved by it
  createEffect(() => {
    const name = machines()[0];
    if (!untrack(host) && name) moveTo(name, untrack(directory));
  });

  /* your repos by their newest thread, then the machine's other projects by their own activity */
  const seen = createMemo(() => Object.values(state.fleet.threads).filter((entry) => !entry.parent).map((entry) => ({ host: entry.agent, root: entry.place?.root ?? "", at: entry.updated })));
  const repos = createMemo(() => {
    const read = listed();
    return recentRepos(seen(), host(), read?.ok ? read.value : []).filter(Boolean);
  });
  /* the repos you used last on any machine still connected, for the chips above the field: a pick of one is pickRepo, so a
     repo on another machine moves the field there as a menu row found elsewhere does */
  const recents = createMemo(() => {
    const live = new Set(machines());
    return recentChips(seen().filter((s) => live.has(s.host)), host(), repos(), repoName, RECENT_CHIPS);
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
          io.saveDraft(to, moved.arriving);
          io.saveDraft(from, null);
        }
      };
      // the draft moves with its photos, so ones still on the device are read first (they are, as its composer opens)
      if (state.composer.drafts[from]?.held) void io.loadDraftPhotos(from).then(move);
      else move();
    }
    moveTo(nextHost, nextDir);
  };
  /* while a thread is being made its place holds: the chips are disabled, and a typed token, the list's "start in" or a
     board key is refused the same way (false), so nothing moves the target under the send */
  const pickRepo = (dir: string, on = host()): boolean => {
    if (making()) return false;
    // choosing another place after a refusal is editing: the refused words come back first
    if (failed()) backToDraft();
    const canonical = canonicalDirectory(dir, aliases(), on);
    if (on !== host() || canonical !== chosen()) retarget(on, canonical);
    setQuery("");
    return true;
  };
  const pickMachine = (name: string): boolean => {
    if (making()) return false;
    if (name === host()) return true;
    if (failed()) backToDraft();
    // the recents of the other machine are read for it; until they come, no repo is chosen and the finder says so
    retarget(name, null);
    setQuery("");
    return true;
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
    ({ at, dir, prefix }) => io.folders(at, dir, prefix),
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
  const sent = () => state.newThread.sent;
  const [slow, setSlow] = createSignal(false);
  let landing = false;
  // slow is counted from when the send went, so a field mounted again mid-send says it at the same moment
  createEffect(() => {
    const s = sent();
    const left = s ? slowIn(s.at, Date.now()) : null;
    setSlow(left === 0);
    if (!left) return;
    const timer = setTimeout(() => setSlow(true), left);
    onCleanup(() => clearTimeout(timer));
  });
  const started = (clientID: string) => {
    landing = false;
    setNewSent({ clientID, at: Date.now(), host: host(), directory: chosen() ?? "" });
  };
  const entry = () => {
    const s = sent();
    return s ? state.composer.outbox.find((e) => e.clientID === s.clientID) : undefined;
  };
  /* the new thread is the one this send made (send-life.ts, `bornKey`) */
  createEffect(() => {
    const key = bornKey(sent(), state.composer.born, state.fleet.threads);
    if (key && !landing) {
      landing = true;
      untrack(() => {
        setNewSent(null);
        options.onBorn(key);
      });
    }
  });
  const failed = () => refusedOf(sent(), state.composer.outbox);
  const retry = () => {
    const s = sent();
    if (s && failed()) io.retrySend(s.clientID);
  };
  /* a first message that did not start goes back where it was written, and its outbox entry goes: left there it would be
     in indexeddb for good, counted against the outbox's cap, and shown nowhere */
  const restore = (refused: { clientID: string; text: string; model: string | null; effort: string | null; target: Target }) => {
    if (state.newThread.restored.includes(refused.clientID)) return;
    markRestored(refused.clientID);
    const key = targetKey(refused.target);
    io.saveDraft(key, restoredDraft(state.composer.drafts[key], refused, Date.now()));
    // the photos it held follow its words back into the draft
    io.discardSend(refused.clientID, true);
  };
  /* the words go back to the place they were written for, and the field goes there too when nothing is typed where it is */
  const takeBack = (refused: OutboxView) => {
    const target = refused.target;
    if (target.kind === "new" && !isDrafted(state.composer.drafts[draftKey()]) && (target.host !== host() || target.directory !== chosen())) moveTo(target.host, target.directory);
    restore(refused);
  };
  const backToDraft = () => {
    const e = failed();
    if (!e) return;
    takeBack(e);
    setNewSent(null);
  };
  /* a send that failed after its field had let go of it (a reload, another tab) is still in the outbox: the field that
     comes up next takes it back the same way */
  createEffect(() => {
    const orphan = orphanOf(state.composer.outbox, sent()?.clientID ?? null, state.newThread.restored);
    if (orphan) untrack(() => takeBack(orphan));
  });
  const waitingOnDevice = () => entry()?.state === "waiting";
  const makingWords = () => makingSaid({ sent: sent(), host: host(), directory: chosen(), waiting: waitingOnDevice(), slow: slow() });
  /** a send in flight that has not been refused: one thread is made at a time */
  const making = () => sent() !== null && !failed();

  /** why a send cannot go yet; the words are kept whatever it says */
  const blocked = () => blockedWords({ refused: failed() !== undefined, making: making(), drafted: isDrafted(state.composer.drafts[draftKey()]), host: host(), directory: chosen() });

  return {
    host,
    directory: chosen,
    place,
    setPlace,
    where,
    isPlain,
    machines,
    repos,
    recents,
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
