/* history: every thread the machines know, newest first, the cleared and the
   old included (docs/home.md, history; docs/design.md, history). home shows
   what is live or touched in the last 12 hours; this is where the rest
   lives. the fleet's snapshot is capped, so the list is read from the
   server a page at a time (GET /api/history); a row of a thread the fleet
   holds shows its live state, and opening one it does not hold has the
   server adopt it first, so it opens like any other. */

import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api } from "../../api/client";
import { leave, navigate } from "../../shell/navigation";
import { state } from "../../store";
import { said, UNREACHABLE } from "../machines/verb";
import { RepoMark } from "../repo-mark/repo-mark";
import { colourStyle } from "../window/repo";
import type { RowView } from "./rows";
import { appendRows, collisionSuffixes, emptyWords, type HistoryApiRow, rowView, unreachedWords } from "./rows";
import "./history.css";

/** threads a page asks for */
const PAGE = 30;
/** a search that matched nothing yet reads on by itself this many times before it asks the person to continue */
const KEEP_LOOKING = 5;
/** typing waits this long before the server is asked */
const TYPING_MS = 250;
/** rows the list holds. past it the next page replaces the list instead of growing it, so a long read costs what 300
    rows cost, not what 3000 do (AGENTS.md, memory and latency) */
const MAX_ROWS = 300;
/** how often "3 min ago" is worked out again */
const CLOCK_MS = 30_000;
/** how long an opened thread has to show up in the fleet's stream after the server adopted it */
const ADOPT_WAIT_MS = 5000;

type Page = {
  rows: HistoryApiRow[];
  /** the server's cursor for the page behind these rows */
  next: string | null;
  unreached: string[];
  /** threads newer than the first row that were let go to make room */
  dropped: number;
  loaded: boolean;
  busy: boolean;
  problem: string | null;
};

const FRESH: Page = { rows: [], next: null, unreached: [], dropped: 0, loaded: false, busy: false, problem: null };

export function History() {
  const [page, setPage] = createStore<Page>({ ...FRESH });
  const [typed, setTyped] = createSignal("");
  const [term, setTerm] = createSignal("");
  const [machine, setMachine] = createSignal<string | null>(null);
  const [opening, setOpening] = createSignal<string | null>(null);
  const [stuck, setStuck] = createSignal<{ key: string; why: string } | null>(null);
  let generation = 0;

  const machines = createMemo(() => state.fleet.hostNames);
  const searching = () => term() !== "";

  /** reads one page and the pages behind it while a search finds nothing; a newer question abandons this one */
  const read = async (before: string | null, replace = false) => {
    const mine = generation;
    setPage("busy", true);
    setPage("problem", null);
    let cursor = before;
    let gathered: HistoryApiRow[] = before === null || replace ? [] : [...page.rows];
    const dropped = replace ? page.dropped + page.rows.length : page.dropped;
    for (let round = 0; ; round++) {
      let data: Awaited<ReturnType<typeof ask>>;
      try {
        data = await ask(cursor);
      } catch {
        if (mine === generation) batch(() => (setPage("busy", false), setPage("loaded", true), setPage("problem", UNREACHABLE)));
        return;
      }
      if (mine !== generation) return;
      if ("problem" in data) {
        const problem = data.problem;
        return void batch(() => (setPage("busy", false), setPage("loaded", true), setPage("problem", problem)));
      }
      const had = gathered.length;
      gathered = appendRows(gathered, data.rows);
      const more = data.next ?? null;
      const empty = gathered.length === had;
      if (!(searching() && empty && more !== null && round < KEEP_LOOKING)) {
        return void batch(() => {
          setPage("rows", reconcile(gathered, { key: "key" }));
          setPage({ next: more, unreached: data.unreached, dropped, loaded: true, busy: false });
          if (replace) titleEl?.scrollIntoView({ block: "start" });
        });
      }
      cursor = more;
    }
  };

  const ask = async (before: string | null) => {
    const query = { limit: PAGE, ...(term() ? { q: term() } : {}), ...(machine() ? { host: machine() as string } : {}), ...(before !== null ? { before } : {}) };
    const { data, error, response } = await api.GET("/api/history", { params: { query } });
    if (!data) return { problem: said(error, response.status) };
    return { rows: data.rows, next: data.next ?? null, unreached: data.unreached.map((u) => u.host) };
  };

  // a new search or machine starts over; the first read is at once, typing waits for a pause
  createEffect(
    on([term, machine], () => {
      generation += 1;
      setPage({ ...FRESH, rows: [] });
      void read(null);
    }),
  );
  let typing: ReturnType<typeof setTimeout> | undefined;
  const onInput = (value: string) => {
    setTyped(value);
    clearTimeout(typing);
    typing = setTimeout(() => setTerm(value.trim()), TYPING_MS);
  };
  onCleanup(() => {
    clearTimeout(typing);
    generation += 1;
  });

  // "just now" ages while the screen stays open
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
  onCleanup(() => clearInterval(clock));
  let titleEl: HTMLHeadingElement | undefined;
  const suffixes = createMemo(() => collisionSuffixes(page.rows));
  const full = () => page.rows.length >= MAX_ROWS;

  /** opens a thread. one the fleet holds opens at once; another is adopted by the server first, and opens when the
      stream has brought it */
  const open = async (view: RowView) => {
    if (opening()) return;
    setStuck(null);
    if (!state.fleet.sessions[view.key]) {
      setOpening(view.key);
      const id = view.key.slice(view.key.indexOf(":") + 1);
      try {
        const { error, response } = await api.POST("/api/hosts/{host}/sessions/{session}/adopt", { params: { path: { host: view.host, session: id } } });
        if (!response.ok) throw new Error(said(error, response.status));
        const until = performance.now() + ADOPT_WAIT_MS;
        while (!state.fleet.sessions[view.key]) {
          if (performance.now() > until) throw new Error("it was found, but has not reached this device yet. tap it again in a moment.");
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      } catch (reason) {
        setOpening(null);
        setStuck({ key: view.key, why: reason instanceof Error && reason.message ? reason.message : UNREACHABLE });
        return;
      }
      setOpening(null);
    }
    navigate({ name: "thread", thread: view.key, at: null, part: null });
  };

  const note = createMemo(() => unreachedWords(page.unreached));

  return (
    <section class="machines history" aria-labelledby="history-title">
      <header class="machines-head">
        <div class="head-row">
          <button class="quiet screen-back" type="button" aria-label="back to the windows" onClick={() => leave({ name: "history" })}>
            <span class="chevron" aria-hidden="true" />
            windows
          </button>
        </div>
        <h1 id="history-title" tabindex="-1" data-screen-title ref={titleEl}>
          history
        </h1>
      </header>
      <form class="history-find" role="search" aria-label="find a thread" onSubmit={(event) => (event.preventDefault(), clearTimeout(typing), setTerm(typed().trim()))}>
        <label class="field">
          <input
            type="search"
            aria-label="search titles and repos"
            enterkeyhint="search"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="search titles and repos"
            value={typed()}
            onInput={(event) => onInput(event.currentTarget.value)}
          />
        </label>
        <Show when={machines().length > 1}>
          <div class="history-machines" role="group" aria-label="machine">
            <button type="button" class="chipbtn" aria-pressed={machine() === null} onClick={() => setMachine(null)}>
              all machines
            </button>
            <For each={machines()}>
              {(name) => (
                <button type="button" class="chipbtn" aria-pressed={machine() === name} aria-label={`only ${name}`} onClick={() => setMachine(machine() === name ? null : name)}>
                  {name}
                </button>
              )}
            </For>
          </div>
        </Show>
      </form>
      <Show when={note()}>
        {(words) => (
          <p class="history-note" role="status">
            {words()}
          </p>
        )}
      </Show>
      <Show when={page.problem}>
        {(problem) => (
          <p class="problem" role="alert">
            {problem()}{" "}
            <button class="quiet" type="button" onClick={() => void read(null)}>
              try again
            </button>
          </p>
        )}
      </Show>
      <Show
        when={page.rows.length > 0}
        fallback={
          <p class="empty" role="status">
            <Show when={page.loaded && !page.problem} fallback={page.problem ? "" : "reading your machines"}>
              {emptyWords({ searching: searching(), machine: machine(), unreached: page.unreached.length })}
            </Show>
          </p>
        }
      >
        <ul class="history-list" aria-label="threads, newest first">
          <For each={page.rows}>
            {(row) => (
              <HistoryRow
                row={row}
                suffix={suffixes().get(row.key) ?? ""}
                showHost={machines().length > 1}
                now={now}
                opening={opening() === row.key}
                stuck={stuck()?.key === row.key ? (stuck()?.why ?? null) : null}
                onOpen={(view) => void open(view)}
              />
            )}
          </For>
        </ul>
        <Show when={page.next !== null}>
          <Show when={full()}>
            <p class="history-end">{page.rows.length} threads are on screen. the next ones replace them.</p>
          </Show>
          <button class="quiet history-more" type="button" disabled={page.busy} onClick={() => void read(page.next, full())}>
            {page.busy ? "reading" : full() ? "next older threads" : searching() ? "search older threads" : "older threads"}
          </button>
        </Show>
        <Show when={page.dropped > 0 && !page.busy}>
          <button class="quiet history-more" type="button" onClick={() => (generation += 1, setPage({ ...FRESH, rows: [] }), void read(null))}>
            back to the newest
          </button>
        </Show>
        <Show when={page.next === null && page.loaded && !page.busy}>
          <p class="history-end">{searching() ? "that is every match." : "that is every thread the machines know."}</p>
        </Show>
      </Show>
    </section>
  );
}

type RowProps = {
  row: HistoryApiRow;
  suffix: string;
  showHost: boolean;
  now: () => number;
  opening: boolean;
  stuck: string | null;
  onOpen: (view: RowView) => void;
};

/** one thread. its view is its own memo: a page arriving, or the clock ticking, works out the rows it touches and no
    others */
function HistoryRow(props: RowProps) {
  const view = createMemo(() =>
    rowView(
      props.row,
      state.fleet.sessions[props.row.key],
      Object.values(state.fleet.asks).filter((ask) => ask.key === props.row.key),
      props.now(),
      props.suffix,
    ),
  );
  return (
    <li>
      <button
        class="history-row"
        type="button"
        data-state={view().state}
        data-cleared={view().cleared ? "" : undefined}
        style={colourStyle(view().colour)}
        aria-label={view().name}
        aria-busy={props.opening ? "true" : undefined}
        onClick={() => props.onOpen(view())}
      >
        <RepoMark host={view().host} root={view().root} name={view().repo} colour={view().colour} size={36} />
        <span class="history-text">
          <span class="history-title">{view().title}</span>
          <span class="history-meta" aria-hidden="true">
            {view().repo}
            <Show when={props.showHost}>, {view().host}</Show>
          </span>
        </span>
        <span class="history-side" aria-hidden="true">
          <span class="history-state" data-state={view().state}>
            {props.opening ? "opening" : view().words}
          </span>
          <span class="history-when">
            {view().when}
            {view().cleared ? ", cleared" : ""}
          </span>
        </span>
      </button>
      <Show when={props.stuck}>
        {(why) => (
          <p class="problem history-stuck" role="alert">
            {why()}
          </p>
        )}
      </Show>
    </li>
  );
}
