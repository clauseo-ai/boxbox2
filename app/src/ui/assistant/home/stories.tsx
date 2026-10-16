/* the solid side of the assistant-home stories (stories/home.stories.tsx): each story mounts one of these into ladle's
   react host through the shared Frame (assistant/stories/frame.tsx), which sets the palette and the ready mark. every
   agent is a placeholder: wren, an assistant on vm-b; cmx on vm-a and vm-c. */

import { createSignal, For, type JSX, Show } from "solid-js";
import { Frame, mount } from "../stories/frame";
import { assistantColour, colourStyle } from "../../window/repo";
import type { Agent } from "../wire";
import { agentName } from "../words";
import { AddAgentGhost, AgentCard, type AgentCardProps, NoAgents } from "./card";
import { APPROVAL, AT, assistant, at, cmx } from "./fixtures";
import { AgentPicker, AgentRow, StartLine } from "./picker";
import { AssistantWindow, type AssistantView, RunsWindow } from "./window";
import "./stories.css";

const WREN = assistant();

/* —— windows —— */

const base: AssistantView = { key: "wren:main", title: "dinner on friday", state: "done", chip: null, since: at(11, 40), tail: [], ask: null, channel: null, steps: 0 };

const VIEWS = {
  wants: {
    ...base,
    title: "dinner on friday",
    state: "wants",
    chip: { text: "wants you", tone: "lit" },
    since: at(11, 48),
    channel: "whatsapp",
    tail: [
      { kind: "prompt", text: "can you find somewhere for friday, four of us, near the river" },
      { kind: "steps", steps: [{ verb: "checked", thing: "calendar" }, { verb: "searched", thing: "2 sites" }, { verb: "read", thing: "3 menus" }, { verb: "compared", thing: "reviews" }] },
      { kind: "prose", text: "the corner place has a table at 19:30 and the terrace is open. the other two are full after 19:00." },
    ],
    ask: { kind: "question", header: "booking", text: "book the 19:30 table at the corner place for four?", waiting: "3 options" },
  },
  working: {
    ...base,
    title: "flights to lisbon in november",
    state: "working",
    chip: { text: "working", tone: "plain" },
    since: AT - 40_000,
    channel: "whatsapp",
    tail: [
      { kind: "voice", mine: true, durationMs: 14_000 },
      { kind: "prose", text: "looking now. the cheapest direct ones leave early, so i am checking the later departures too." },
      { kind: "steps", steps: [{ verb: "searched", thing: "flights lis 14-18 nov" }, { verb: "checked", thing: "calendar" }, { verb: "opened", thing: "3 fare pages" }, { verb: "read", thing: "baggage rules" }] },
    ],
  },
  done: {
    ...base,
    title: "the lease renewal",
    state: "done",
    chip: { text: "done", tone: "plain" },
    since: at(11, 40),
    channel: "whatsapp",
    tail: [
      { kind: "media", mine: true, glyph: "file", name: "lease-renewal-2027.pdf" },
      { kind: "prose", text: "read it. the rent goes up 4% and the notice period is now two months. clause 9 is new." },
      { kind: "voice", mine: false, durationMs: 22_000 },
      { kind: "media", mine: false, glyph: "file", name: "lease-notes.pdf" },
    ],
  },
  playing: {
    ...base,
    title: "the lease renewal",
    state: "done",
    chip: { text: "done", tone: "plain" },
    since: at(11, 40),
    channel: "whatsapp",
    tail: [
      { kind: "prose", text: "the summary is in the note, and the clause by clause is in the pdf." },
      { kind: "voice", mine: false, durationMs: 22_000, playing: true },
      { kind: "media", mine: false, glyph: "image", name: "image" },
    ],
  },
  failed: {
    ...base,
    title: "move the dentist",
    state: "failed",
    chip: { text: "stopped", tone: "fail" },
    since: at(11, 31),
    channel: null,
    steps: 2,
    tail: [
      { kind: "prompt", text: "move the dentist to next week, any morning" },
      { kind: "steps", steps: [{ verb: "checked", thing: "calendar" }] },
      { kind: "step-failed", step: { verb: "could not open", thing: "the booking site" } },
      { kind: "prose", text: "the booking site would not load, so nothing is moved yet." },
    ],
  },
  boxbox: {
    ...base,
    title: "a packing list for the trip",
    state: "done",
    chip: { text: "done", tone: "plain" },
    since: at(10, 12),
    channel: null,
    steps: 3,
    tail: [
      { kind: "prompt", text: "a packing list for four days, it might rain" },
      { kind: "steps", steps: [{ verb: "checked", thing: "forecast" }, { verb: "read", thing: "last trip's list" }, { verb: "wrote", thing: "list.md" }] },
      { kind: "prose", text: "here it is, with a rain jacket and one more layer than last time. the forecast says showers on the second day." },
    ],
  },
  scheduled: {
    ...base,
    title: "main",
    state: "done",
    chip: { text: "done", tone: "plain" },
    since: at(8, 0),
    channel: null,
    tail: [
      { kind: "scheduled", word: "scheduled", rest: "08:00: morning check" },
      { kind: "prose", text: "two meetings moved to the afternoon. nothing for you to do." },
    ],
  },
} satisfies Record<string, AssistantView>;

export type WindowStory = keyof typeof VIEWS | "stale";

function Deck(props: { children: JSX.Element }) {
  return (
    <div class="ahs-deck" data-arrangement="deck">
      {props.children}
    </div>
  );
}

export function mountWindow(el: HTMLElement, story: WindowStory): () => void {
  return mount(el, () => (
    <Frame ground="ground">
      <Deck>
        <Show
          when={story === "stale"}
          fallback={<AssistantWindow agent={WREN} view={VIEWS[story as keyof typeof VIEWS]} now={AT} />}
        >
          <AssistantWindow agent={assistant({ status: "down" })} view={{ ...VIEWS.working, since: at(11, 39) }} now={AT} staleAt={at(11, 40)} />
        </Show>
      </Deck>
    </Frame>
  ));
}

export function mountWantsStale(el: HTMLElement): () => void {
  return mount(el, () => (
    <Frame ground="ground">
      <Deck>
        <AssistantWindow agent={assistant({ status: "refused", connection: { refused: "auth" } })} view={VIEWS.wants} now={AT} staleAt={at(11, 40)} />
      </Deck>
    </Frame>
  ));
}

export function mountRuns(el: HTMLElement): () => void {
  const agent = assistant({
    runs: {
      unseen: 3,
      items: [
        { thread: "r1", name: "morning check", at: at(8, 0), preview: "two meetings moved, nothing to do" },
        { thread: "r2", name: "heartbeat", at: at(8, 30), preview: "the parcel is out for delivery today" },
        { thread: "r3", name: "bills", at: at(9, 0), preview: "the phone bill is 12% higher than last month" },
      ],
    },
  });
  return mount(el, () => (
    <Frame ground="ground">
      <Deck>
        <RunsWindow agent={agent} />
      </Deck>
    </Frame>
  ));
}

/** one window in each of the five palettes, coral first */
export function mountPalettes(el: HTMLElement): () => void {
  const slots = ["coral", "lime", "jade", "lagoon", "orchid"];
  const names = ["wren", "kite", "fern", "tide", "moss"];
  return mount(el, () => (
    <Frame ground="ground">
      <Deck>
        <For each={slots}>
          {(slot, i) => (
            <AssistantWindow
              agent={assistant({ key: names[i()] ?? slot, palette: slot, label: { name: names[i()] ?? slot, source: "openclaw", machine: "vm-b" } })}
              view={i() === 0 ? VIEWS.wants : i() === 1 ? VIEWS.working : i() === 2 ? VIEWS.done : i() === 3 ? VIEWS.playing : VIEWS.boxbox}
              now={AT}
            />
          )}
        </For>
      </Deck>
    </Frame>
  ));
}

/* —— the agents screen —— */

const COUNTS = { wants: 1, threads: 14 };

const CARDS = {
  pairing: { agent: assistant({ status: "pairing", connection: { lastError: APPROVAL, since: at(11, 50) } }), counts: null },
  syncing: { agent: assistant({ status: "syncing" }), counts: { wants: 0, threads: 9 } },
  ready: { agent: WREN, counts: COUNTS },
  admin: { agent: assistant({ capabilities: { admin: true }, connection: { memory: { rss: 412 * 1_048_576, liveSessions: 3, uptimeS: 11_000, sampledAt: AT } } }), counts: COUNTS },
  untested: { agent: assistant({ connection: { version: "2026.11.0", untested: true } }), counts: COUNTS },
  connecting: { agent: assistant({ status: "connecting", connection: { since: at(11, 51) } }), counts: COUNTS },
  down: { agent: assistant({ status: "down", connection: { since: at(11, 40), lastError: "connect ECONNREFUSED vm-b.local:18789" } }), counts: COUNTS },
  protocol: { agent: assistant({ status: "refused", connection: { refused: "protocol", version: "2026.12.0", protocol: 5 } }), counts: COUNTS },
  methods: { agent: assistant({ status: "refused", connection: { refused: "methods", lastError: "the gateway did not grant sessions.send, sessions.abort" } }), counts: COUNTS },
  auth: { agent: assistant({ status: "refused", connection: { refused: "auth", lastError: "device token revoked" } }), counts: COUNTS },
  key: { agent: assistant({ status: "refused", connection: { refused: "key" } }), counts: COUNTS },
  restart: { agent: assistant({ capabilities: { admin: true } }), counts: COUNTS, arming: "restart" },
  forget: { agent: WREN, counts: COUNTS, arming: "forget" },
  reloaded: { agent: assistant({ capabilities: { admin: true } }), counts: COUNTS, note: { text: "reloaded at 11:52: flushed skills, agents.", failed: false } },
} satisfies Record<string, Omit<AgentCardProps, "now">>;

export type CardStory = keyof typeof CARDS;

export function mountCard(el: HTMLElement, story: CardStory): () => void {
  const card: Omit<AgentCardProps, "now"> = CARDS[story];
  return mount(el, () => (
    <Frame ground="ground">
      <div class="ahs-agents">
        <ul class="host-list">
          <AgentCard {...card} now={AT} />
        </ul>
      </div>
    </Frame>
  ));
}

/** the screen: wren beside a second assistant, the ghost after them; then, with no agents, the line and the ghost alone */
export function mountScreen(el: HTMLElement, empty: boolean): () => void {
  const kite = assistant({ key: "kite", palette: "lagoon", label: { name: "kite", source: "openclaw", machine: "vm-c" }, status: "pairing", connection: { lastError: APPROVAL } });
  return mount(el, () => (
    <Frame ground="ground">
      <div class="ahs-agents ahs-screen">
        <h1>agents</h1>
        <Show when={empty}>
          <NoAgents />
        </Show>
        <ul class="host-list">
          <Show when={!empty}>
            <AgentCard agent={WREN} counts={COUNTS} now={AT} />
            <AgentCard agent={kite} counts={null} now={AT} />
          </Show>
          <AddAgentGhost />
        </ul>
      </div>
    </Frame>
  ));
}

/* —— start something —— */

const VM_A = cmx("vm-a");
const VM_C = cmx("vm-c", { status: "down" });
const KITE = assistant({ key: "kite", palette: "lagoon", label: { name: "kite", source: "openclaw", machine: "vm-c" }, status: "pairing" });
const MOTH = assistant({ key: "moth", palette: "orchid", label: { name: "moth", source: "openclaw", machine: "vm-b" } });
const AGENTS: Agent[] = [VM_A, VM_C, WREN, MOTH, KITE];

export type SheetStory = "sheet-assistant" | "sheet-cmx" | "picker" | "picker-cmx" | "picker-walked";

/** a sheet as start something draws it: the title, the agent row, the picker under it when open, and, with an assistant
    chosen, the composer's place with its placeholder and the line under it. the composer itself is the composer's */
function Sheet(props: { chosen: Agent; open: boolean }) {
  const [chosen, setChosen] = createSignal(props.chosen);
  const [open, setOpen] = createSignal(props.open);
  let row: HTMLButtonElement | undefined;
  const close = () => {
    setOpen(false);
    queueMicrotask(() => row?.focus({ preventScroll: true }));
  };
  const colour = () => (chosen().palette ? assistantColour(chosen().palette) : { name: "violet", top: "#34298a", bottom: "#171240", light: "#b7abff" });
  return (
    <div class="ahs-sheet plane-window" role="dialog" aria-label="new thread" style={colourStyle(colour())}>
      <h2>start something</h2>
      <div class="ahs-sheet-body">
        <AgentRow ref={(el) => (row = el)} agent={chosen()} expanded={open()} controls="ahs-picker" onToggle={() => (open() ? close() : setOpen(true))} />
        <Show when={open()}>
          <AgentPicker
            id="ahs-picker"
            agents={AGENTS}
            chosen={chosen().key}
            onPick={(agent) => {
              setChosen(agent);
              close();
            }}
            onClose={close}
          />
        </Show>
        <Show when={chosen().mark === "round" && !open()}>
          <div class="ahs-composer" aria-hidden="true">
            message {agentName(chosen())}
          </div>
          <StartLine agent={chosen()} />
        </Show>
      </div>
    </div>
  );
}

export function mountSheet(el: HTMLElement, story: SheetStory): () => void {
  const chosen = story === "sheet-cmx" || story === "picker-cmx" ? VM_A : WREN;
  const open = story.startsWith("picker");
  /* the walked picker is driven as a keyboard would: down twice from wren lands on kite, which waits for approval */
  const drive = story === "picker-walked" ? (frame: HTMLElement) => {
    const list = frame.querySelector<HTMLElement>(".ah-picker");
    for (const key of ["ArrowDown", "ArrowDown"]) list?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  } : undefined;
  return mount(el, () => (
    <Frame ground="ground" palette={chosen.palette ?? "coral"} {...(drive ? { drive } : {})}>
      <div class="ahs-sheet-frame">
        <Sheet chosen={chosen} open={open} />
      </div>
    </Frame>
  ));
}
