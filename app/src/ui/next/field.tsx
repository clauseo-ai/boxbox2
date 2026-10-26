/* home's field (docs/design.md, home: what next): the one place a thread starts. the composer itself, as every other
   composer is, with the place typed into the sentence: `@repo`, `on <machine>` and `/model` are read at the caret
   (tokens.ts) and open a menu as they are typed, and a pick turns the token into the field's own chip and takes its
   letters out of the words. every token is also one tap away without typing: the repo and the machine chips lead the
   composer's top row and open the same menus, with a finder for any other folder, and the model is the composer's own
   chip. the field is a quiet neutral surface on the neutral ground; a chosen repo shows its colour in its own chip and
   nowhere else.

   starting goes through the one new-thread path (composer/new-thread.ts): a send does not close on a guess, a refusal is
   said plainly with its words given back, and the stage opens on the thread the send made once it exists. */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { play } from "../../motion/animate";
import { SNAP } from "../../motion/springs";
import { state } from "../../store";
import { saveDraft } from "../../sync/client";
import type { Draft } from "../../sync/outbox";
import { Composer } from "../composer/composer";
import { Icon } from "../composer/icons";
import { refusedStart } from "../composer/menu-words";
import { createNewThread, type Place } from "../composer/new-thread";
import { ensureModels } from "../composer/reads";
import { modelName } from "../model-name";
import { RepoMark } from "../repo-mark/repo-mark";
import { repoColour } from "../window/colours";
import { colourStyle, type RepoColour, repoName } from "../window/repo";
import { matchMachines, matchModels, type TokenKind, type Typed, typedToken, withoutToken } from "./tokens";

/** the field's own material: a neutral pair on the plane's recipe, so the composer is a quiet surface of the ground and
    not any repo's (decision 105, design.md: home, what next) */
export const GROUND: RepoColour = { name: "ground", top: "#2a2c34", bottom: "#141519", light: "#d4d7e0" };

/** rows a menu shows at most; the rest are a few more letters away */
const MENU_ROWS = 24;

/** what home asks of the field: put the caret in it, start somewhere, or pick a repo from the list under it */
export type FieldApi = {
  focus: () => void;
  startOn: (machine: string) => void;
  pick: (host: string, root: string) => void;
  /** words in the field, so escape on an empty field may go back to the thread it came from */
  empty: () => boolean;
};

/** the field's machine and its repos, for the list under it */
export type FieldPlace = { host: () => string; repos: () => readonly string[]; lastAt: (host: string, root: string) => number | null };

export type FieldProps = {
  start: Place | null;
  onBorn: (key: string, from: HTMLElement) => void;
  /** escape on an empty field with nothing open in it: back to the thread you came from, when there is one */
  onEscape?: () => void;
  api?: (api: FieldApi) => void;
  onPlace?: (place: FieldPlace) => void;
};

/** a row of the open menu, flattened so the arrows and enter walk one list */
type Row =
  | { kind: "repo"; host: string; root: string; note: string }
  | { kind: "folder"; host: string; dir: string; name: string; repo: boolean }
  | { kind: "use"; host: string; dir: string }
  | { kind: "up"; dir: string }
  | { kind: "other" }
  | { kind: "machine"; name: string }
  | { kind: "model"; id: string; efforts: string[] };

type Menu = { kind: TokenKind; by: "typed" | "tap"; typed: Typed | null };

export function Field(props: FieldProps) {
  const nt = createNewThread({ start: () => props.start, onBorn: (key, from) => props.onBorn(key, from) });
  let root: HTMLElement | undefined;
  let findEl: HTMLInputElement | undefined;
  const words = () => root?.querySelector<HTMLTextAreaElement>(".cz-body textarea") ?? null;
  const draft = (): Draft | undefined => state.composer.drafts[nt.draftKey()];

  /* —— the menu: opened by a typed token or by a tap on a chip —— */
  const [menu, setMenu] = createSignal<Menu | null>(null);
  const [active, setActive] = createSignal(0);
  /* the tap path's own filter: a finger opens the repo menu and may type a word or a path into it, never into the words */
  const [find, setFind] = createSignal("");
  const query = () => {
    const m = menu();
    if (!m) return "";
    return m.by === "typed" ? (m.typed?.query ?? "") : find();
  };
  createEffect(() => {
    const m = menu();
    nt.setQuery(m?.kind === "repo" ? query() : "");
  });
  createEffect(() => {
    if (menu()?.kind === "model") void ensureModels(nt.host());
  });

  const models = () => state.models[nt.host()]?.models ?? [];
  const rows = createMemo<Row[]>(() => {
    const m = menu();
    if (!m) return [];
    if (m.kind === "machine") return matchMachines(nt.machines(), query()).map((name) => ({ kind: "machine", name }));
    if (m.kind === "model") return matchModels(models(), query()).slice(0, MENU_ROWS).map((model) => ({ kind: "model", id: model.id, efforts: model.efforts }));
    const host = nt.host();
    const out: Row[] = [];
    const typedDir = nt.typedDir();
    if (typedDir) out.push({ kind: "use", host, dir: typedDir });
    const up = nt.upFrom();
    if (up) out.push({ kind: "up", dir: up });
    for (const dir of nt.known().slice(0, MENU_ROWS)) out.push({ kind: "repo", host, root: dir, note: repoNote(host, dir) });
    for (const at of nt.elsewhere()) out.push({ kind: "repo", host: at.host, root: at.root, note: repoNote(at.host, at.root) });
    for (const folder of nt.children()) out.push({ kind: "folder", host, dir: folder.directory, name: folder.name, repo: folder.repo });
    if (!nt.pathMode()) out.push({ kind: "other" });
    return out;
  });
  const repoNote = (host: string, root: string) => {
    const waits = host === nt.host() && root !== nt.directory() && nt.waiting().includes(root);
    return waits ? `${host} · words wait here` : `${host} · ${root}`;
  };
  createEffect(() => {
    // the active row stays inside the list as it narrows
    const count = rows().length;
    if (active() >= count) setActive(Math.max(0, count - 1));
  });

  const close = () => {
    setMenu(null);
    setFind("");
    setActive(0);
  };
  const caretTo = (at: number) => {
    const field = words();
    if (!field) return;
    queueMicrotask(() => {
      field.focus({ preventScroll: true });
      field.setSelectionRange(at, at);
    });
  };
  /* a picked token's letters leave the words before the pick moves them to the new place's draft */
  const takeToken = (): number | null => {
    const m = menu();
    if (m?.by !== "typed" || !m.typed) return null;
    const d = draft();
    if (!d) return null;
    const next = withoutToken(d.text, m.typed);
    const kept = next.text.trim() || d.photos.length || d.held || d.model || d.effort;
    saveDraft(nt.draftKey(), kept ? { ...d, text: next.text, at: Date.now() } : null, false, "kept");
    return next.caret;
  };

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "up") return setQueryText(`${row.dir === "/" ? "" : row.dir}/`);
    if (row.kind === "other") return setQueryText("~/");
    const caret = takeToken();
    if (row.kind === "repo") nt.pickRepo(row.root, row.host);
    else if (row.kind === "folder" || row.kind === "use") nt.pickRepo(row.dir, row.host);
    else if (row.kind === "machine") nt.pickMachine(row.name);
    else if (row.kind === "model") pickModel(row.id, row.efforts);
    close();
    caretTo(caret ?? words()?.value.length ?? 0);
  };
  /* "other folder" and "up" keep the menu open on the finder's text: typed, the token's words; tapped, the finder */
  const setQueryText = (text: string) => {
    const m = menu();
    if (!m) return;
    if (m.by === "tap") {
      setFind(text);
      queueMicrotask(() => findEl?.focus({ preventScroll: true }));
      return;
    }
    const d = draft();
    if (!d || !m.typed) return;
    const replaced = `${d.text.slice(0, m.typed.start)}@${text}${d.text.slice(m.typed.end)}`;
    const end = m.typed.start + 1 + text.length;
    saveDraft(nt.draftKey(), { ...d, text: replaced, at: Date.now() }, false, "kept");
    setMenu({ ...m, typed: { ...m.typed, query: text, end } });
    caretTo(end);
  };
  const pickModel = (id: string, efforts: readonly string[]) => {
    const d = draft() ?? { text: "", photos: [], model: null, effort: null, at: 0 };
    // an effort the new model does not take is let go, as the composer's own pick does
    const effort = d.effort && efforts.includes(d.effort) ? d.effort : null;
    saveDraft(nt.draftKey(), { ...d, model: id, effort, at: Date.now() }, false, "kept");
  };

  /* reading the words at the caret: a token being typed opens its menu, and its menu closes when it is no longer typed */
  const read = () => {
    const field = words();
    if (!field || document.activeElement !== field) return;
    const typed = typedToken(field.value, field.selectionStart ?? field.value.length, nt.machines());
    const m = untrack(menu);
    if (typed) {
      if (m?.by !== "typed" || m.kind !== typed.kind || m.typed?.start !== typed.start) setActive(0);
      setMenu({ kind: typed.kind, by: "typed", typed });
    } else if (m?.by === "typed") close();
  };
  const opener = (kind: TokenKind) => (event: MouseEvent) => {
    const m = menu();
    if (m?.by === "tap" && m.kind === kind) return close();
    setFind("");
    setActive(0);
    setMenu({ kind, by: "tap", typed: null });
    // a keyboard's press lands in the finder, so the arrows work at once; a finger's leaves the keyboard down
    if (kind === "repo" && event.detail === 0) queueMicrotask(() => findEl?.focus({ preventScroll: true }));
  };

  const onKey = (event: KeyboardEvent) => {
    const m = menu();
    const inWords = event.target === words();
    const inFind = event.target === findEl;
    if (m && (inWords || inFind)) {
      const count = rows().length;
      if (count && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        event.stopPropagation();
        setActive((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
        queueMicrotask(() => root?.querySelector(".nx-menu [data-active]")?.scrollIntoView({ block: "nearest" }));
        return;
      }
      if (count && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
        event.preventDefault();
        event.stopPropagation();
        choose(rows()[active()]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        if (inFind) words()?.focus({ preventScroll: true });
        return;
      }
    }
    // escape on an empty field, with nothing of the composer's open (its model menu, its dial), goes back to the thread
    if (!m && inWords && event.key === "Escape" && !event.defaultPrevented && !root?.querySelector(".cz-menu, .cz-dial")) {
      if ((words()?.value ?? "") === "" && props.onEscape) {
        event.preventDefault();
        event.stopPropagation();
        props.onEscape();
      }
    }
  };
  const onCaret = (event: Event) => {
    if (event.target === words()) read();
  };
  /* a pointer outside the field and its menu closes the menu; the words keep what was typed */
  const onOutside = (event: PointerEvent) => {
    if (menu() && root && !root.contains(event.target as Node)) close();
  };
  onMount(() => {
    if (!root) return;
    root.addEventListener("keydown", onKey, true);
    root.addEventListener("input", onCaret);
    root.addEventListener("click", onCaret);
    root.addEventListener("keyup", onCaret);
    addEventListener("pointerdown", onOutside, true);
    onCleanup(() => {
      root?.removeEventListener("keydown", onKey, true);
      root?.removeEventListener("input", onCaret);
      root?.removeEventListener("click", onCaret);
      root?.removeEventListener("keyup", onCaret);
      removeEventListener("pointerdown", onOutside, true);
    });
  });

  /* the menu arrives as the stage's menu does: a short drop and a fade on the snap spring (transform and opacity only) */
  let menuEl: HTMLDivElement | undefined;
  createEffect(() => {
    const m = menu();
    if (!m || !menuEl) return;
    untrack(() => menuEl && play(menuEl, [{ opacity: 0, transform: "translateY(-6px) scale(.985)" }, { opacity: 1, transform: "none" }], SNAP));
  });

  props.onPlace?.({ host: nt.host, repos: nt.repos, lastAt: nt.lastAt });
  props.api?.({
    focus: () => {
      const field = words();
      if (!field) return;
      field.focus({ preventScroll: true });
      const end = field.value.length;
      field.setSelectionRange(end, end);
    },
    startOn: (machine) => {
      if (nt.machines().includes(machine)) nt.pickMachine(machine);
    },
    pick: (host, dir) => {
      close();
      nt.pickRepo(dir, host);
      caretTo(words()?.value.length ?? 0);
    },
    empty: () => (words()?.value ?? "") === "",
  });

  const chosen = () => nt.directory();
  const repoChip = (
    <button
      type="button"
      class="cz-key me cz-chip nx-tok"
      data-empty={chosen() ? undefined : ""}
      style={chosen() ? colourStyle(repoColour({ host: nt.host(), root: chosen() as string })) : undefined}
      aria-label={chosen() ? `repo for the new thread: ${repoName(chosen() as string)}` : `pick a repo on ${nt.host() || "a machine"}`}
      aria-haspopup="listbox"
      aria-expanded={menu()?.kind === "repo" ? "true" : "false"}
      disabled={nt.making()}
      onPointerDown={(e) => e.preventDefault()}
      onClick={opener("repo")}
    >
      <Show when={chosen()} fallback={<Icon name="folder" />}>
        {(dir) => <RepoMark host={nt.host()} root={dir()} size={20} />}
      </Show>
      <span class="nx-tok-label">{chosen() ? repoName(chosen() as string) : "pick a repo"}</span>
    </button>
  );
  const machineChip = (
    <Show when={nt.machines().length > 1}>
      <button
        type="button"
        class="cz-key me cz-chip nx-tok"
        aria-label={`machine for the new thread: ${nt.host()}`}
        aria-haspopup="listbox"
        aria-expanded={menu()?.kind === "machine" ? "true" : "false"}
        disabled={nt.making()}
        onPointerDown={(e) => e.preventDefault()}
        onClick={opener("machine")}
      >
        <span class="nx-tok-on" aria-hidden="true">on</span>
        <span class="nx-tok-label">{nt.host()}</span>
      </button>
    </Show>
  );

  const menuLabel = () => (menu()?.kind === "machine" ? "machines" : menu()?.kind === "model" ? "models for the new thread" : `repos and folders on ${nt.host()}`);
  const menuNote = (): string | null => {
    const m = menu();
    if (!m) return null;
    if (m.kind === "model") {
      if (state.modelsRead[nt.host()] === "failed") return `the models on ${nt.host()} did not come. try the model chip again.`;
      if (!state.models[nt.host()]) return "reading the models.";
      return rows().length ? null : `no model on ${nt.host()} matches.`;
    }
    if (m.kind === "machine") return rows().length ? null : "no machine matches.";
    if (nt.lookProblem()) return nt.lookProblem();
    if (nt.looking()) return "looking.";
    if (nt.pathMode() && nt.truncated()) return "more folders match than are shown. type more of the name.";
    if (!nt.pathMode() && query().trim() && nt.known().length === 0 && nt.elsewhere().length === 0) return `no repo on ${nt.host()} matches. type a folder to look inside it, like ~/code.`;
    if (!query().trim() && nt.offered().length === 0) return nt.recentsNote();
    return null;
  };

  return (
    <section class="nx-field" ref={root} aria-label="start a thread" data-menu={menu() ? "" : undefined}>
      <Composer target={nt.target()} mount="sheet" hint="what next?" menus={false} colour={GROUND} blocked={nt.blocked()} onStarted={nt.started} lead={<>{repoChip}{machineChip}</>} />
      <Show when={menu()}>
        <div class="nx-menu" ref={menuEl} style={colourStyle(GROUND)}>
          <Show when={menu()?.by === "tap" && menu()?.kind === "repo"}>
            <label class="nx-find">
              <Icon name="search" />
              <input
                ref={findEl}
                type="text"
                value={find()}
                aria-label={`find a repo or a folder on ${nt.host()}`}
                placeholder="find a repo, or type a path"
                autocapitalize="off"
                autocomplete="off"
                autocorrect="off"
                spellcheck={false}
                enterkeyhint="go"
                onInput={(e) => {
                  setFind(e.currentTarget.value);
                  setActive(0);
                }}
              />
            </label>
          </Show>
          <div class="nx-rows" role="listbox" aria-label={menuLabel()} onPointerDown={(e) => e.preventDefault()}>
            <For each={rows()}>
              {(row, index) => {
                const on = () => index() === active();
                const pick = () => choose(row);
                if (row.kind === "repo")
                  return (
                    <button type="button" role="option" class="nx-row" data-active={on() ? "" : undefined} aria-selected={on() ? "true" : "false"} aria-label={`${repoName(row.root)} on ${row.host}, ${row.root}`} style={colourStyle(repoColour({ host: row.host, root: row.root }))} onClick={pick}>
                      <RepoMark host={row.host} root={row.root} size={28} />
                      <span class="nx-row-text">
                        <b>{repoName(row.root)}</b>
                        <small>{row.note}</small>
                      </span>
                    </button>
                  );
                if (row.kind === "folder" || row.kind === "use")
                  return (
                    <button type="button" role="option" class="nx-row" data-active={on() ? "" : undefined} aria-selected={on() ? "true" : "false"} aria-label={`start in ${row.dir}`} onClick={pick}>
                      <span class="nx-row-icon"><Icon name={row.kind === "use" ? "check" : row.repo ? "branch" : "folder"} /></span>
                      <span class="nx-row-text">
                        <b>{row.kind === "use" ? `use ${repoName(row.dir)}` : row.name}</b>
                        <small>{row.dir}</small>
                      </span>
                    </button>
                  );
                if (row.kind === "up")
                  return (
                    <button type="button" role="option" class="nx-row" data-active={on() ? "" : undefined} aria-selected={on() ? "true" : "false"} aria-label={`look in ${row.dir}`} onClick={pick}>
                      <span class="nx-row-icon"><Icon name="chevronUp" /></span>
                      <span class="nx-row-text">
                        <b>up</b>
                        <small>{row.dir}</small>
                      </span>
                    </button>
                  );
                if (row.kind === "other")
                  return (
                    <button type="button" role="option" class="nx-row nx-row-quiet" data-active={on() ? "" : undefined} aria-selected={on() ? "true" : "false"} aria-label={`other folder on ${nt.host()}`} onClick={pick}>
                      <span class="nx-row-icon"><Icon name="folder" /></span>
                      <span class="nx-row-text">
                        <b>other folder</b>
                        <small>{`any folder on ${nt.host()}, by its path`}</small>
                      </span>
                    </button>
                  );
                if (row.kind === "machine")
                  return (
                    <button type="button" role="option" class="nx-row" data-active={on() ? "" : undefined} aria-selected={on() ? "true" : "false"} aria-label={`start on ${row.name}`} aria-current={row.name === nt.host() ? "true" : undefined} onClick={pick}>
                      <span class="nx-row-icon"><Icon name="machine" /></span>
                      <span class="nx-row-text">
                        <b>{row.name}</b>
                        <small>{row.name === nt.host() ? "where it starts now" : "a machine"}</small>
                      </span>
                    </button>
                  );
                return (
                  <button type="button" role="option" class="nx-row" data-active={on() ? "" : undefined} aria-selected={on() ? "true" : "false"} aria-label={`model for the new thread: ${modelName(row.kind === "model" ? row.id : "")}`} onClick={pick}>
                    <span class="nx-row-text">
                      <b>{modelName(row.kind === "model" ? row.id : "")}</b>
                      <small>{row.kind === "model" ? row.id : ""}</small>
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
          <Show when={menuNote()}>{(note) => <p class="nx-note" role="status">{note()}</p>}</Show>
          {/* where it runs: the checkout as it stands, or a fresh worktree; said once, at the foot of the place it starts in */}
          <Show when={menu()?.kind === "repo" && chosen()}>
            <button type="button" class="nx-wt" role="switch" aria-checked={nt.where() === "fresh" ? "true" : "false"} aria-label="a fresh worktree" aria-description={nt.isPlain() ? "a fresh worktree needs a git repo, and this folder is not one" : "its own copy of the repo on a new branch"} disabled={nt.isPlain()} onPointerDown={(e) => e.preventDefault()} onClick={() => nt.setPlace(nt.place() === "fresh" ? "checkout" : "fresh")}>
              <Icon name="worktree" />
              <span class="nx-row-text">
                <b>a fresh worktree</b>
                <small>{nt.isPlain() ? "this folder is not a git repo" : nt.where() === "fresh" ? "a new branch, your checkout stays as it is" : "works in the folder as it stands"}</small>
              </span>
              <span class="nx-switch" aria-hidden="true" />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={nt.failed()}>
        {(bad) => (
          <div class="nx-refused" role="alert">
            <p>{refusedStart(bad().error, bad().photosReturned ?? 0)}</p>
            <div class="nx-refused-acts">
              <Show when={!bad().photosReturned}>
                <button type="button" class="nx-pill on" aria-label="retry starting the thread" onClick={nt.retry}>retry</button>
              </Show>
              <button type="button" class="nx-pill" aria-label="back to the draft" onClick={nt.backToDraft}>edit</button>
            </div>
          </div>
        )}
      </Show>
      <Show when={nt.making()}>
        <p class="nx-making" role="status">{nt.makingWords()}</p>
      </Show>
    </section>
  );
}
