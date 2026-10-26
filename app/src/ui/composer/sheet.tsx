/* the new-thread sheet (design.md, starting a thread; docs/composer.md, the sheet): the composer with a target of a new
   thread in a folder on a machine. the machine is chosen when there is more than one; the repos come in recency order,
   the ones you have threads in first, then the machine's other projects, and can be filtered; any other folder on the
   machine can be typed or walked to, because cmx2 starts a session in any directory that exists. the sheet takes the
   colour of the place picked. the place is one line above the words (the repo's mark, its name, the machine); a press
   opens it in place into the pickers: the machines, the recent repos as their marks, and the finder (the native app's
   newthread). a pick closes it onto the words.

   sending does not close it on a guess, and does not keep the screen either: the sheet lets go at once (`away`) while it
   holds the send, home's dock says the thread is being made, and a tap on the dock brings the same sheet back. a refusal
   brings it back by itself with the words, retry and edit; retry lets go again. when the new thread exists in the fleet
   the stage opens on it, never before the daemon made it (the native app's decision 21). the composer is never keyed or remounted, so nothing typed is lost to a pick, a fleet beat or a
   failed send. */

import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { play } from "../../motion/animate";
import { FADE, SHEET } from "../../motion/springs";
import { state } from "../../store";
import { discardSend, loadDraftPhotos, retrySend, saveDraft } from "../../sync/client";
import { type Target, targetKey } from "../../sync/outbox";
import { createKeyboardInset } from "../term/keyboard";
import { RepoMark } from "../repo-mark/repo-mark";
import { repoColour } from "../window/colours";
import { colourStyle, repoName } from "../window/repo";
import { Close } from "../close";
import { Composer } from "./composer";
import { Icon } from "./icons";
import { canonicalDirectory, directoryOfTyped, draftedPlaces, followDraft, isDrafted, looksLikePath, matchRepos, recentRepos, restoredDraft, splitPath } from "./place";
import { folders, projects } from "./reads";
import { refusedStart } from "./menu-words";

/** how long the sheet waits for the new thread before it says it is taking long (it keeps waiting) */
const SLOW_MS = 8000;
/** a pause in typing in the folder field this long reads the folder */
const BROWSE_PAUSE_MS = 160;
/** the repos shown as rows while filtering */
const ROWS = 40;
/** the recent repos offered as marks; the rest are a few typed letters away in the finder */
const RECENTS = 12;

export type SheetProps = {
  host: string;
  /** the repo you were looking at, picked first */
  directory: string | null;
  onClose: () => void;
  /** the thread exists: open it on the stage, growing from the sheet's window */
  onOpened: (key: string, from: HTMLElement) => void;
  /** let go of the screen while the first message's thread is being made (home holds the flag: its dock brings it back) */
  away?: boolean;
  onAway?: (away: boolean) => void;
  /** what the dock says while the sheet is away: the thread being made, slow, or waiting on the connection; null when back */
  onMaking?: (words: string | null) => void;
};

type Sent = { clientID: string; at: number; host: string; from: HTMLElement; key: string };

export function NewThreadSheet(props: SheetProps) {
  const [host, setHost] = createSignal(props.host);
  const [directory, setDirectory] = createSignal(props.directory);
  const [place, setPlace] = createSignal<"checkout" | "fresh">("checkout");
  const [listed] = createResource(host, projects);
  const machines = () => state.fleet.agentNames;

  /* your repos by their newest thread, then the machine's other projects by their own activity */
  const repos = createMemo(() => {
    const sessions = Object.values(state.fleet.threads).map((entry) => ({ host: entry.agent, root: entry.place?.root ?? "", at: entry.updated }));
    const read = listed();
    return recentRepos(sessions, host(), read?.ok ? read.value : []);
  });
  /* the name each thread's folder has as a repo, so a folder walked to under the name it was typed is the repo's own chip */
  const aliases = createMemo(() => Object.values(state.fleet.threads).map((entry) => ({ host: entry.agent, directory: entry.place?.directory ?? "", root: entry.place?.root ?? "" })));
  // the first repo is taken once and kept: a fleet beat that reorders the recents must not move the target under the words.
  // it goes through retarget like every pick, because words typed while no folder was chosen are kept under that place
  createEffect(() => {
    const first = repos()[0];
    if (directory() === null && first) untrack(() => retarget(host(), first));
  });
  const chosen = () => directory();

  /* folders where words wait: they stay chips, so a refused message or a folder typed once is one tap away */
  const waiting = createMemo(() => draftedPlaces(Object.keys(state.composer.drafts), host(), (key) => isDrafted(state.composer.drafts[key])));
  const chips = createMemo(() => {
    const listed = repos();
    const extra = [...(chosen() ? [chosen() as string] : []), ...waiting()].filter((dir, i, all) => !listed.includes(dir) && all.indexOf(dir) === i);
    return [...extra, ...listed.slice(0, RECENTS)];
  });

  /* the place line open into its pickers. it opens by itself while there is nowhere chosen, since there is nothing else to do */
  const [picking, setPicking] = createSignal(props.directory === null);
  /* why there are no recent marks: the read is out, it failed (its words), or the machine has none */
  const recentsNote = () => {
    if (listed.loading) return "looking.";
    const read = listed();
    if (read && !read.ok) return read.message;
    return `nothing has run on ${host()} yet. find a folder to start in.`;
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
  const pickRepo = (dir: string) => {
    // choosing another place after a refusal is editing: the refused words come back first
    if (failed()) backToDraft();
    const at = canonicalDirectory(dir, aliases(), host());
    if (at !== chosen()) retarget(host(), at);
  };
  const pickMachine = (name: string) => {
    if (name === host()) return;
    if (failed()) backToDraft();
    // the recents of the other machine are read for it; until they come, no repo is chosen and the folder finder says so
    retarget(name, null);
    setQuery("");
    setTyped("");
    focusFinder();
  };

  /* the sheet stands on the keyboard itself: on home no stage sets the inset (decision 19) */
  const keyboard = createKeyboardInset();
  const colour = () => ({ ...colourStyle(repoColour({ host: host(), root: chosen() ?? host() })), "--keyboard": `${keyboard()}px` });

  /* the folder finder: always there, a field that filters the repos, or reads the folders inside a typed path */
  const [query, setQuery] = createSignal("");
  /* the row the arrows are on; enter picks it */
  const [active, setActive] = createSignal(0);
  const [typed, setTyped] = createSignal("");
  let browseTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(browseTimer));
  const onQuery = (value: string) => {
    setQuery(value);
    setActive(0);
    clearTimeout(browseTimer);
    browseTimer = setTimeout(() => setTyped(value), BROWSE_PAUSE_MS);
  };
  const [browsed] = createResource(
    () => (looksLikePath(typed()) ? { at: host(), ...splitPath(typed()) } : null),
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
  const known = createMemo(() => (pathMode() ? [] : matchRepos(repos(), query()).slice(0, ROWS)));
  const children = createMemo(() => {
    const read = browsed();
    if (!pathMode() || !read?.ok) return [];
    const prefix = splitPath(query()).prefix.toLowerCase();
    return read.value.children.filter((folder) => folder.name.toLowerCase().startsWith(prefix)).slice(0, ROWS);
  });
  const home = () => {
    const read = browsed();
    return read?.ok ? read.value.home : null;
  };
  /* the folder above the one being read, offered while nothing more is typed after its slash */
  const upFrom = () => {
    const read = browsed();
    return pathMode() && read?.ok && splitPath(query()).prefix === "" ? read.value.parent : null;
  };
  const typedDir = () => (pathMode() ? directoryOfTyped(query(), home()) : null);
  const truncated = () => {
    const read = browsed();
    return read?.ok ? read.value.truncated : false;
  };
  const lookProblem = () => {
    const read = browsed();
    return pathMode() && read && !read.ok ? read.message : null;
  };

  let sheetEl: HTMLDivElement | undefined;
  let scrimEl: HTMLDivElement | undefined;
  let findEl: HTMLInputElement | undefined;
  const words = () => sheetEl?.querySelector<HTMLTextAreaElement>(".cz-body textarea");
  const focusFinder = () => queueMicrotask(() => findEl?.focus({ preventScroll: true }));
  /* a repo or a folder picked: the pickers close onto the words, the caret in them */
  const pickFolder = (dir: string) => {
    pickRepo(dir);
    setQuery("");
    setTyped("");
    setPicking(false);
    words()?.focus({ preventScroll: true });
  };
  // with nowhere chosen yet the pickers are open and the finder has the focus from the start
  createEffect(() => {
    if (chosen() === null && !listed.loading && repos().length === 0) {
      setPicking(true);
      focusFinder();
    }
  });
  /* opening the pickers brings the chosen repo's mark into view, wherever it sits among the recent ones */
  const togglePicking = () => {
    const next = !picking();
    setPicking(next);
    if (next) queueMicrotask(() => sheetEl?.querySelector(".cz-recents [aria-checked='true']")?.scrollIntoView({ block: "nearest", inline: "center" }));
  };
  /* the rows in the order they show, for the arrows and enter: the typed folder, then the repos, then the folders inside */
  const rows = createMemo(() => [...(typedDir() ? [typedDir() as string] : []), ...known(), ...children().map((folder) => folder.directory)]);
  const isActive = (dir: string) => rows()[active()] === dir;
  const scrollActive = () => queueMicrotask(() => sheetEl?.querySelector(".cz-rows [data-active]")?.scrollIntoView({ block: "nearest" }));
  const onFinderKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      // the first escape clears what was typed, the next goes back to the words
      if (query()) onQuery("");
      else words()?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = rows().length;
      if (!count) return;
      setActive((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      scrollActive();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const dir = rows()[active()] ?? rows()[0];
    if (dir) pickFolder(dir);
  };
  const showRows = () => query().trim() !== "";

  onMount(() => {
    const phone = !matchMedia("(min-width: 700px)").matches;
    if (sheetEl) play(sheetEl, phone ? [{ transform: "translateY(110%)" }, { transform: "none" }] : [{ transform: "translateY(18px) scale(.96)", opacity: 0 }, { transform: "none", opacity: 1 }], SHEET);
    if (scrimEl) play(scrimEl, [{ opacity: 0 }, { opacity: 1 }], FADE);
  });

  const close = async () => {
    // closing on a refusal is leaving the words, not losing them
    backToDraft();
    const phone = !matchMedia("(min-width: 700px)").matches;
    const out = sheetEl && play(sheetEl, phone ? [{ transform: "none" }, { transform: "translateY(110%)" }] : [{ opacity: 1 }, { opacity: 0, transform: "translateY(18px) scale(.96)" }], SHEET, { fill: "forwards" });
    if (scrimEl) play(scrimEl, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
    await out?.finished.catch(() => undefined);
    props.onClose();
  };

  /* the first message went: the thread is being made, and when it exists the sheet's window becomes it */
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
    setSent({ clientID, at: Date.now(), host: host(), from, key: keyFor(host(), chosen()) });
    props.onAway?.(true);
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
    if (key && state.fleet.threads[key]) untrack(() => void land(s, key));
  });
  const land = async (s: Sent, key: string) => {
    if (landing) return;
    landing = true;
    clearTimeout(slowTimer);
    props.onOpened(key, s.from);
    // the stage grows from the sheet's window while the sheet lets go of the screen
    if (sheetEl) play(sheetEl, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
    const out = scrimEl && play(scrimEl, [{ opacity: 1 }, { opacity: 0 }], FADE, { fill: "forwards" });
    await out?.finished.catch(() => undefined);
    props.onClose();
  };
  const failed = () => (entry()?.state === "failed" ? entry() : undefined);
  const retry = () => {
    const s = sent();
    if (!s) return;
    retrySend(s.clientID);
    // sent again: the sheet lets go of the screen as it did at the first send
    props.onAway?.(true);
  };
  // a refusal while away brings the sheet back with its words, retry and edit
  createEffect(() => {
    if (failed() && props.away) untrack(() => props.onAway?.(false));
  });
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
  /* a send that failed after its sheet was gone (it was slow, the sheet closed, then the host refused) is still in the
     outbox: the sheet that opens next puts its words back, and goes to its place if nothing is typed here */
  createEffect(() => {
    const orphan = state.composer.outbox.find((e) => e.verb === "start" && e.state === "failed" && e.clientID !== sent()?.clientID && !handled.has(e.clientID));
    if (!orphan) return;
    untrack(() => {
      if (orphan.target.kind !== "new") return;
      const here = state.composer.drafts[keyFor(host(), chosen())];
      if (!isDrafted(here) && (orphan.target.host !== host() || orphan.target.directory !== chosen())) {
        setHost(orphan.target.host);
        setDirectory(orphan.target.directory);
      }
      restore(orphan);
    });
  });
  const waitingOnDevice = () => entry()?.state === "waiting";
  const makingWords = () =>
    waitingOnDevice()
      ? "the connection is down. it goes on its own when it is back."
      : slow()
        ? `still making the thread in ${repoName(chosen() ?? "")}. the machine is slow to answer; it will open when it is there.`
        : `making the thread in ${repoName(chosen() ?? "")} on ${host()}.`;
  createEffect(() => props.onMaking?.(props.away && sent() && !failed() ? makingWords() : null));

  /* away and back: the sheet slides off as a close does and is hidden (visibility, so it keeps its state and the send),
     and comes back as it opened. the hiding is the attribute's, so reduced motion (no slide) hides it too */
  const [hidden, setHidden] = createSignal(false);
  let wasAway = false;
  createEffect(() => {
    const now = props.away === true;
    if (now === wasAway) return;
    wasAway = now;
    const phone = !matchMedia("(min-width: 700px)").matches;
    if (now) {
      if (sheetEl?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      const out = sheetEl && play(sheetEl, phone ? [{ transform: "none" }, { transform: "translateY(110%)" }] : [{ opacity: 1 }, { opacity: 0, transform: "translateY(18px) scale(.96)" }], SHEET);
      if (scrimEl) play(scrimEl, [{ opacity: 1 }, { opacity: 0 }], FADE);
      if (out) void out.finished.then(() => wasAway && setHidden(true), () => undefined);
      else setHidden(true);
    } else {
      setHidden(false);
      if (sheetEl) play(sheetEl, phone ? [{ transform: "translateY(110%)" }, { transform: "none" }] : [{ transform: "translateY(18px) scale(.96)", opacity: 0 }, { transform: "none", opacity: 1 }], SHEET);
      if (scrimEl) play(scrimEl, [{ opacity: 0 }, { opacity: 1 }], FADE);
    }
  });

  const blocked = () => (failed() ? "retry or edit the message below first." : chosen() ? undefined : `pick a folder on ${host()} to start in`);

  return (
    <>
      <div class="cz-scrim" ref={scrimEl} style={colour()} data-away={hidden() ? "" : undefined} onClick={() => void close()} />
      <div
        class="cz-sheet"
        ref={sheetEl}
        role="dialog"
        aria-modal="true"
        aria-label="new thread"
        data-sent={sent() && !failed() ? "" : undefined}
        data-away={hidden() ? "" : undefined}
        inert={props.away === true}
        style={colour()}
        onKeyDown={(e) => e.key === "Escape" && void close()}
      >
        <div class="cz-sheet-head">
          <h2>start something</h2>
          {/* the one close (ui/close.tsx): the stage bar's own round of glass */}
          <Close class="cz-sheet-close" label="close new thread" onClick={() => void close()} />
        </div>
        <div class="cz-place-card" data-open={picking() ? "" : undefined}>
          <button
            type="button"
            class="cz-place"
            aria-label={chosen() ? `starts in ${repoName(chosen() as string)} on ${host()}` : `pick a folder on ${host()}`}
            aria-description="change the machine or the repo"
            aria-expanded={picking() ? "true" : "false"}
            onClick={togglePicking}
          >
            <Show when={chosen()} fallback={<span class="cz-place-none" aria-hidden="true"><Icon name="folder" /></span>}>
              {(dir) => <RepoMark host={host()} root={dir()} size={34} />}
            </Show>
            <span class="cz-place-text">
              <Show when={chosen()} fallback={<b>pick a folder on {host()}</b>}>
                {(dir) => (
                  <>
                    <b>{repoName(dir())}</b>
                    <small>on {host()}</small>
                  </>
                )}
              </Show>
            </span>
            <Icon name="chevronDown" />
          </button>
          <Show when={picking()}>
            <div class="cz-pickers">
              <Show when={machines().length > 1}>
                <div class="cz-repos cz-machines" role="radiogroup" aria-label="machine" onPointerDown={(e) => e.preventDefault()}>
                  <For each={machines()}>
                    {(name) => (
                      <button type="button" role="radio" aria-checked={name === host() ? "true" : "false"} onClick={() => pickMachine(name)}>
                        <Icon name="machine" />
                        {name}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={!query()}>
                <Show when={chips().length > 0} fallback={<p class="cz-note cz-recents-none">{recentsNote()}</p>}>
                  <div class="cz-recents" role="radiogroup" aria-label="recent repos" onPointerDown={(e) => e.preventDefault()}>
                    <For each={chips()}>
                      {(dir) => (
                        <button
                          type="button"
                          class="cz-recent"
                          role="radio"
                          aria-checked={dir === chosen() ? "true" : "false"}
                          aria-label={`${repoName(dir)}, ${dir}`}
                          data-waiting={waiting().includes(dir) ? "" : undefined}
                          style={colourStyle(repoColour({ host: host(), root: dir }))}
                          onClick={() => pickFolder(dir)}
                        >
                          <span class="cz-recent-mark">
                            <RepoMark host={host()} root={dir} size={52} />
                          </span>
                          <span class="cz-recent-name">{repoName(dir)}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
              <div class="cz-finder">
                <label class="cz-search">
                  <Icon name="search" />
                  <input
                    ref={findEl}
                    class="cz-find"
                    type="text"
                    value={query()}
                    aria-label={`find a repo or a folder on ${host()}`}
                    placeholder="find a repo, or type a path"
                    autocapitalize="off"
                    autocomplete="off"
                    autocorrect="off"
                    spellcheck={false}
                    enterkeyhint="go"
                    onInput={(e) => onQuery(e.currentTarget.value)}
                    onKeyDown={onFinderKey}
                  />
                  <Show when={query()}>
                    <button type="button" class="cz-clear" aria-label="clear the search" onPointerDown={(e) => e.preventDefault()} onClick={() => { onQuery(""); findEl?.focus({ preventScroll: true }); }}>
                      <Icon name="close" />
                    </button>
                  </Show>
                </label>
                <Show when={showRows()}>
                  <div class="cz-rows" role="list" aria-label="folders" onPointerDown={(e) => e.preventDefault()}>
                    <Show when={typedDir()}>
                      {(dir) => (
                        <div class="cz-row" role="listitem">
                          <button type="button" class="cz-row-main" data-active={isActive(dir()) ? "" : undefined} aria-label={`start in ${dir()}`} onClick={() => pickFolder(dir())}>
                            <b>
                              <Icon name="check" />
                              use {repoName(dir())}
                            </b>
                            <span>{dir()}</span>
                          </button>
                        </div>
                      )}
                    </Show>
                    <Show when={upFrom()}>
                      {(up) => (
                        <div class="cz-row" role="listitem">
                          <button type="button" class="cz-row-main" aria-label={`look in ${up()}`} onClick={() => onQuery(`${up() === "/" ? "" : up()}/`)}>
                            <b>
                              <Icon name="chevronUp" />
                              up
                            </b>
                            <span>{up()}</span>
                          </button>
                        </div>
                      )}
                    </Show>
                    <For each={known()}>
                      {(dir) => (
                        <div class="cz-row" role="listitem">
                          <button type="button" class="cz-row-main" data-lead="" data-active={isActive(dir) ? "" : undefined} aria-label={`${repoName(dir)}, ${dir}`} style={colourStyle(repoColour({ host: host(), root: dir }))} onClick={() => pickFolder(dir)}>
                            <RepoMark host={host()} root={dir} size={28} />
                            <b>{repoName(dir)}</b>
                            <span>{dir}</span>
                          </button>
                        </div>
                      )}
                    </For>
                    <For each={children()}>
                      {(folder) => (
                        <div class="cz-row" role="listitem">
                          <button type="button" class="cz-row-main" data-active={isActive(folder.directory) ? "" : undefined} aria-label={`start in ${folder.directory}`} onClick={() => pickFolder(folder.directory)}>
                            <b>
                              <Icon name={folder.repo ? "branch" : "folder"} />
                              {folder.name}
                              <Show when={folder.repo}>
                                <em>repo</em>
                              </Show>
                            </b>
                            <span>{folder.directory}</span>
                          </button>
                          <button type="button" class="cz-row-in" aria-label={`look inside ${folder.name}`} onClick={() => onQuery(`${folder.directory}/`)}>
                            <Icon name="chevronRight" />
                          </button>
                        </div>
                      )}
                    </For>
                    <Show when={pathMode() && truncated()}>
                      <p class="cz-note">more folders match than are shown. type more of the name.</p>
                    </Show>
                    <Show when={lookProblem()}>{(said) => <p class="cz-note">{said()}</p>}</Show>
                    <Show when={!pathMode() && known().length === 0}>
                      <p class="cz-note">{`no repo on ${host()} matches. type a folder to look inside it, like ~/code or /srv/app.`}</p>
                    </Show>
                    <Show when={pathMode() && !lookProblem() && browsed.loading}>
                      <p class="cz-note">looking.</p>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </div>
        {/* never keyed: the composer follows the target in place, so picking a repo, a machine or a fleet beat never rebuilds
            the words being typed (a remount drops the phone's keyboard) */}
        <Composer target={target()} mount="sheet" autofocus={chosen() !== null} blocked={blocked()} onStarted={started} />
        <Show when={sent()}>
          <div class="cz-making" role="status" data-bad={failed() ? "" : undefined}>
            <Show
              when={failed()}
              fallback={
                <p>{makingWords()}</p>
              }
            >
              {(bad) => (
                <>
                  <p>{refusedStart(bad().error, bad().photosReturned ?? 0)}</p>
                  <div class="cz-making-acts">
                    <Show when={!bad().photosReturned}>
                      <button type="button" class="cz-pill on" onClick={retry}>retry</button>
                    </Show>
                    <button type="button" class="cz-pill" aria-label="back to the draft" onClick={backToDraft}>edit</button>
                  </div>
                </>
              )}
            </Show>
          </div>
        </Show>
        {/* where it runs: one quiet switch, off works in the checkout as it stands, on makes a fresh worktree; one line under
            it says what the choice means, or why this folder cannot have one */}
        <div class="cz-where">
          <button
            type="button"
            class="cz-wt"
            role="switch"
            aria-checked={where() === "fresh" ? "true" : "false"}
            aria-label="a fresh worktree"
            aria-description="where it runs"
            disabled={isPlain()}
            onClick={() => setPlace(place() === "fresh" ? "checkout" : "fresh")}
          >
            <Icon name="worktree" />
            <b>a fresh worktree</b>
            <span class="cz-switch" aria-hidden="true" />
          </button>
          <p class="cz-note cz-where-note">
            {isPlain()
              ? "a fresh worktree needs a git repo, and this folder is not one."
              : where() === "fresh"
                ? "its own copy of the repo on a new branch, so your checkout stays as it is."
                : "works in the folder as it stands, on the branch it is on."}
          </p>
        </div>
      </div>
    </>
  );
}
