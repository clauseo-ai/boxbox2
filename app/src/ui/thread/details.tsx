/* the thread's details and its turns, drawn once and shown where the layout has
   room (docs/design.md, the thread menu and details): flat on the ground in
   home's inspector, docked as a card in the stage at a wide stage, as a sheet
   on the phone. the stage decides where; this decides what. what they say is
   ./details-model.ts, how they look is ./details.css. */

import { For, type JSX, Show, createMemo, createUniqueId } from "solid-js";
import type { Thread } from "../../sync/protocol";
import { type AgentRow, type FactLine, type Spend, agentState, cachedShare, contextOf, figure, type FileChange, type filesChanged, kept, type ModelUse, modelsOf, percentWords, ranOf, spend, switches, tokensIn } from "./details-model";
import type { Turn } from "./model";
import { clock, clockDur, dur, isBad, n, plural } from "./rows";
import { Close } from "../close";
import { SpendDialog, warmEdgeOn, warmOn, whenLoaded } from "../later";
import "./details.css";

/** the repo's palette, set inline on what sits outside the stage (the inspector) so its accents are the thread's */
export type Palette = { tone: string; top: string; bottom: string };

const paletteStyle = (p: Palette) => ({ "--tone": p.tone, "--window-top": p.top, "--window-bottom": p.bottom });

export type DetailsData = {
  /** every turn of the thread: the steps, the files and the models are read from them */
  turns: readonly Turn[];
  agents: readonly AgentRow[];
  files: ReturnType<typeof filesChanged>;
  /** the daemon's account of the session: its spend, tokens, context and branch */
  info: Thread | undefined;
  /** what the thread and every agent under it have cost (details-model.ts, spendOf) */
  spend: Spend;
  now: number;
  /** a subagent's id: opens its thread */
  openAgent: (id: string, name?: string) => void;
};

export type TurnsData = {
  /** the turns the list shows, in order */
  listed: readonly Turn[];
  /** the turn the log is on */
  here: string | null;
  label: (t: Turn) => string;
  goTo: (t: Turn) => void;
};

export type PanelProps = {
  which: "turns" | "details";
  /** on the ground with no surface of its own (the inspector), a well pressed into the stage's flood (docked beside the
      log), or a sheet raised over the phone's stage */
  place: "flat" | "docked" | "sheet";
  /** the sheet's heading for the details: the thread's title, and where it runs ("repo, on machine") */
  heading?: { title: string; sub: string };
  /** what the close button says and does; none, no button */
  close?: { label: string; run: () => void } | undefined;
  palette: Palette;
  details: DetailsData;
  turns: TurnsData;
  /** the thread is still coming in, older turns a few a frame (turns.ts): what the panel counts is partial, and sections that grow by the
      block move the ones under them, which the browser counts as layout shift (budget 0). the body is not drawn until it is whole */
  filling?: boolean;
};

const isPrompt = (t: Turn): boolean => t.by === "you" || t.by === "queued" || t.by === "steer" || t.by === "brief";
const isReport = (t: Turn): boolean => t.by === "mail" && !t.note;
const counted = (k: number, one: string): string => (k ? plural(k, one) : "");

export function Panel(props: PanelProps) {
  const turnsSaid = () => [counted(props.turns.listed.filter(isPrompt).length, "prompt"), counted(props.turns.listed.filter(isReport).length, "report")].filter(Boolean).join(", ");
  const sheetTitle = () => (props.which === "details" && props.place === "sheet" ? props.heading : undefined);
  /* the line under the title: the sheet says where the thread runs, the turns say how many they are; docked, the title
     stands alone */
  const sub = () => (sheetTitle() ? sheetTitle()?.sub : props.which === "turns" && props.place !== "docked" ? turnsSaid() : "");
  return (
    <div class="details" classList={{ flat: props.place === "flat", docked: props.place === "docked", sheet: props.place === "sheet" }} data-panel={props.which} data-filling={props.filling ? "" : undefined} style={paletteStyle(props.palette)}>
      <header class="dt-hd">
        {/* the title is drawn where it is the only heading (the turns), and heard everywhere */}
        <h2 tabindex="-1" classList={{ sr: props.place === "flat" && props.which === "details" }}>
          {sheetTitle()?.title ?? props.which}
          <Show when={sub()}><small>{sub()}</small></Show>
        </h2>
        <Show when={props.close}>{(close) => <Close label={close().label} onClick={() => close().run()} />}</Show>
      </header>
      <div class="dt-body">
        <Show when={props.which === "details"} fallback={<TurnsList {...props.turns} />}>
          <Details data={props.details} />
        </Show>
      </div>
    </div>
  );
}

/* ---------- the details ---------- */

function Section(props: { title: string; sum?: JSX.Element; children: JSX.Element }) {
  const id = createUniqueId();
  return (
    <section class="dt-sec" aria-labelledby={id}>
      <div class="dt-sh"><h3 id={id}>{props.title}</h3><Show when={props.sum}><span class="dt-sum">{props.sum}</span></Show></div>
      {props.children}
    </section>
  );
}

/** every tile reads the same way: the figure, what it counts, and under that what qualifies it, so the four align */
function Tile(props: { figure: string; label: string; aside?: string | undefined; children?: JSX.Element }) {
  return <div class="dt-tile"><b>{props.figure}</b><span>{props.label}</span>{props.children}<Show when={props.aside}><span class="dt-aside">{props.aside}</span></Show></div>;
}

/** the spend tile of a thread with agents: what the thread and every agent under it have cost, and the door to what
    each part cost. the breakdown is a modal dialog in the top layer, so it stands over the panel wherever the panel is
    (flat, docked or a sheet); escape, its close button and a press outside it close it, and focus goes back to the tile */
function SpendTile(props: { spend: Spend; open: () => void }) {
  const agentsSaid = () => plural(props.spend.rows.length, "agent");
  return (
    <button class="dt-tile dt-door" aria-haspopup="dialog" aria-label={`spent ${spend(props.spend.total)} with ${agentsSaid()}, open what each cost`} onPointerDown={warmOn("SpendDialog")} onClick={() => props.open()}>
      <b>{spend(props.spend.total)}</b>
      <span>spent</span>
      <span class="dt-aside">{spend(props.spend.agents)} by {agentsSaid()}</span>
    </button>
  );
}

function Details(props: { data: DetailsData }) {
  const files = () => props.data.files;
  const info = () => props.data.info;
  const ran = createMemo(() => ranOf(props.data.turns));
  const steps = createMemo(() => ran().reduce((n, t) => n + t.items.filter((x) => x.k === "step").length, 0));
  const context = createMemo(() => contextOf(info()));
  const cached = () => { const t = info()?.tokens; return t && cachedShare(t) !== null ? percentWords(t.cacheRead, t.input + t.cacheRead) : null; };
  /* the turns are new on every frame of a running thread: the rows that say the same keep their nodes (kept) */
  const models = createMemo<readonly ModelUse[]>((prev) => kept(modelsOf(props.data.turns), prev, (m) => `${m.model}\u0000${m.effort ?? ""}`));
  const fileRows = createMemo<readonly FileChange[]>((prev) => kept(files().files, prev, (f) => f.path));
  const total = createMemo(() => models().reduce((n, m) => n + m.cost, 0));
  const working = () => props.data.agents.filter((a) => a.child.state === "working").length;
  let spendDialog: HTMLDialogElement | undefined;
  return (
    <>
      <Section title="this thread">
        <div class="dt-tiles">
          {/* with agents under it the spend is the whole tree's, and the tile is the door to what each part cost */}
          <Show when={props.data.spend.rows.length} fallback={<Tile figure={spend(props.data.spend.total)} label="spent" />}>
            <SpendTile spend={props.data.spend} open={() => whenLoaded("SpendDialog", () => spendDialog?.showModal())} />
          </Show>
          <Show when={info()}>{(i) => (
            <Show when={tokensIn(i().tokens) > 0}><Tile figure={figure(tokensIn(i().tokens))} label="tokens" aside={cached() === null ? undefined : `${cached()} cached`} /></Show>
          )}</Show>
          <Show when={context()}>{(c) => (
            <Tile figure={percentWords(info()?.context?.used ?? 0, info()?.context?.limit ?? 0)} label="of context" aside={c().compactsAt === undefined ? undefined : `compacts at ${c().compactsAt}%`}>
              <span class="dt-meter" role="meter" aria-label="context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c().percent}>
                <i class="fill" style={{ transform: `scaleX(${c().percent / 100})` }} />
                <Show when={c().compactsAt !== undefined}><i class="tick" style={{ left: `${c().compactsAt}%` }} /></Show>
              </span>
            </Tile>
          )}</Show>
          <Tile figure={n(steps())} label={`steps in ${plural(ran().length, "turn")}`} />
        </div>
        <Show when={info()?.vcs}>{(vcs) => (
          <div class="dt-branch">
            <span>branch</span>
            <span class="dt-mono" title={vcs().branch}>{vcs().branch}</span>
            <Show when={vcs().dirty}><span class="dt-note">uncommitted changes</span></Show>
          </div>
        )}</Show>
        <Show when={props.data.spend.rows.length}>
          <SpendDialog spend={props.data.spend} openAgent={props.data.openAgent} ref={(el) => (spendDialog = el)} />
        </Show>
      </Section>

      <Section title="models">
        <Show when={models().length} fallback={<p class="dt-empty">no model has run yet</p>}>
          <ul class="dt-list">
            <For each={models()}>{(m) => (
              <li class="dt-row">
                <span class="dt-main">{m.name}<Show when={m.effort}><em>{m.effort}</em></Show></span>
                <Show when={total() > 0}><span class="dt-figure">{spend(m.cost)}</span></Show>
                <span class="dt-sub">{plural(m.turns, "turn")}{models().length > 1 && total() > 0 ? `, ${Math.round((m.cost / total()) * 100)}% of spend` : ""}</span>
              </li>
            )}</For>
          </ul>
        </Show>
      </Section>

      {/* the agents this thread started, the ones at work first; each opens as its own stage (design.md, the transcript) */}
      <Section title="agents" sum={working() ? `${working()} working` : undefined}>
        <Show when={props.data.agents.length} fallback={<p class="dt-empty">no agents on this thread</p>}>
          <ul class="dt-list">
            <For each={props.data.agents}>{(a) => {
              const live = () => a.child.state === "working" || a.child.state === "wants";
              const word = () => (a.child.state === "working" ? `working ${clockDur(Math.max(0, props.data.now - a.at))}${a.child.steps ? `, ${plural(a.child.steps, "step")}` : ""}` : agentState(a));
              // fresh nodes per use: the two branches below never share dom
              const inner = () => (
                <>
                  <span class="dt-main">{a.label}<Show when={a.type}><em>{a.type}</em></Show></span>
                  <span class="dt-figure">{clock(a.at)}</span>
                  <span class="dt-sub" classList={{ live: live() }}><Show when={live()}><i class="dot" /></Show>{word()}</span>
                </>
              );
              /* an archived agent's thread is gone: its row says so and is not a door */
              return (
                <li>
                  <Show when={a.child.state !== "gone"} fallback={<div class="dt-row gone">{inner()}</div>}>
                    <button class="dt-row door" aria-label={`open ${a.label}'s thread, ${agentState(a)}`} onClick={() => props.data.openAgent(a.id, a.label)}>{inner()}</button>
                  </Show>
                </li>
              );
            }}</For>
          </ul>
        </Show>
      </Section>

      <Section title="files changed" sum={files().files.length ? <>{plural(files().files.length, "file")}, <span class="add">+{n(files().add)}</span> <span class="del">-{n(files().del)}</span></> : undefined}>
        <Show when={files().files.length} fallback={<p class="dt-empty">no files changed yet</p>}>
          <ul class="dt-list">
            <For each={fileRows()}>{(f) => (
              <li class="dt-row dt-file">
                {/* the folder is one line cut from its start; the name is whole, wrapping when it must, because the
                    end of a name is what tells two files apart */}
                <Show when={f.dir}><span class="dt-dir" title={f.path}><bdi>{f.dir}</bdi></span></Show>
                <span class="dt-base">{f.base}</span>
                <span class="dt-counts"><span class="add">+{n(f.add)}</span> <span class="del">-{n(f.del)}</span></span>
              </li>
            )}</For>
          </ul>
        </Show>
      </Section>
    </>
  );
}

/* ---------- the turns ---------- */

function TurnsList(props: TurnsData) {
  const longest = createMemo(() => Math.max(1, ...props.listed.map((t) => t.end - t.at)));
  const changed = createMemo(() => switches(props.listed));
  return (
    <div class="turns-list">
      <For each={props.listed}>{(t) => {
        const steps = () => t.items.filter((x) => x.k === "step").length;
        const w = () => Math.max(2, Math.sqrt((t.end - t.at) / longest()) * 100);
        const model = () => changed().get(t.id);
        return (
          <button class="ti" classList={{ quiet: t.by !== "you", here: props.here === t.id }} aria-label={`turn at ${clock(t.at)}, ${props.label(t)}${model() ? `, switched to ${model()}` : ""}`} onClick={() => props.goTo(t)}>
            <span class="ti-time">{clock(t.at)}</span>
            <span class="ti-text"><Show when={t.items.some((x) => x.k === "step" && x.family === "ask")}><i class="dot" /></Show>{props.label(t)}</span>
            <Show when={model()}>{(words) => <span class="ti-model">switched to {words()}</span>}</Show>
            <span class="ti-sub">
              <span class="ti-bar"><i style={{ width: `${w().toFixed(1)}%` }} /><Show when={t.items.some((x) => x.k === "step" && isBad(x))}><i class="bad" /></Show></span>
              <span>{steps() ? `${plural(steps(), "step")}, ` : ""}{dur(t.end - t.at)}{t.status === "aborted" ? ", stopped" : ""}</span>
            </span>
          </button>
        );
      }}</For>
    </div>
  );
}

/* ---------- the doors in ---------- */

/** the line under the title that says the model, the context and the spend, and opens the details */
export function FactsButton(props: { facts: FactLine; open: () => void }) {
  /* the facts are a new object on every frame of a streaming thread; the name is set when it changes */
  const name = createMemo(() => props.facts.name);
  return (
    <button class="tb-facts" aria-label={name()} onClick={() => props.open()}>
      <span>{props.facts.text}</span>
      <svg viewBox="0 0 8 12" aria-hidden="true"><path d="M1.5 1.5 6 6l-4.5 4.5" /></svg>
    </button>
  );
}

/** the bar's toggle for the details: a sidebar glyph, the mirror of home's fold toggle for the rail, whose rule sits
    on the left (docs/design.md, the thread menu and details) */
export function DetailsToggle(props: { expanded: boolean; controls: string; shortcut: boolean; onClick: () => void }) {
  return (
    <button class="round details-toggle" aria-label="details" aria-expanded={props.expanded ? "true" : "false"} aria-controls={props.controls} aria-keyshortcuts={props.shortcut ? "]" : undefined} onPointerDown={warmEdgeOn} onClick={() => props.onClick()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path class="pane" d="M14.5 4.5H17a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-2.5z" /><rect x="4" y="4.5" width="16" height="15" rx="3" /><path d="M14.5 4.5v15" /></svg>
    </button>
  );
}
