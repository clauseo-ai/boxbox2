/* the details panel in the three places it lives (docs/design.md, the thread
   menu and details): flat on the ground (home's inspector), a card docked in a
   wide stage, a sheet on the phone. the data is made up to show every state at
   once (several models, agents in every state, long paths, a context that
   compacts, a dirty branch); the real stage's own data is in the shell
   stories. this file is react (ladle's host) and mounts the solid panel. */

import { type ReactElement, createElement, useEffect, useRef } from "react";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import type { SessionInfo } from "../../../sync/protocol";
import { type AgentRow, type Kin, filesChanged, spendOf } from "../details-model";
import { Panel, type DetailsData, type TurnsData } from "../details";
import type { Item, Turn } from "../model";
import type { Child } from "../rows";
import { TONES } from "./fixtures";
import "../stage.css";
import "./details.css";

export default { title: "details" };

type Story = (() => ReactElement) & { storyName?: string };

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 9, 0, 0);
const steps = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ k: "step", id: `s${i}`, family: i === 0 ? "read" : "edit" }) as unknown as Item);
const turn = (i: number, extra: Partial<Turn> & { n?: number }): Turn => {
  const { n = 4, ...rest } = extra;
  return { id: `t${i}`, by: "you", prompt: `prompt ${i}`, at: T0 + i * 7 * MIN, end: T0 + i * 7 * MIN + (n + 2) * 20_000, items: steps(n), status: "done", cost: 0.2, files: new Map(), compacted: false, unknownParts: 0, ...rest } as Turn;
};

const turns: Turn[] = [
  turn(0, { prompt: "add an annual toggle to the pricing page", model: "claude-opus-5-5", effort: "high", cost: 0.52, n: 9, files: new Map([["src/ui/pricing/toggle.tsx", { add: 54, del: 0 }], ["src/ui/pricing/pricing.css", { add: 22, del: 3 }]]) }),
  turn(1, { prompt: "the table breaks on small phones, fix it", model: "claude-opus-5-5", effort: "high", cost: 0.61, n: 6, files: new Map([["src/ui/pricing/pricing.css", { add: 14, del: 6 }]]) }),
  turn(2, { prompt: "check the checkout at the same widths", model: "claude-sonnet-5-5", effort: "medium", cost: 0.18, n: 3 }),
  turn(3, { by: "mail", from: "reviewer", prompt: "", model: "claude-sonnet-5-5", effort: "medium", cost: 0.09, n: 2 }),
  turn(4, { prompt: "now the yearly price copy, make it say what a year saves", model: "claude-opus-5-5", effort: "high", cost: 0.44, n: 7, files: new Map([["src/ui/pricing/copy.ts", { add: 5, del: 5 }], ["docs/pricing.md", { add: 3, del: 1 }], ["~/Library/Developer/Xcode/DerivedData/Boxbox-bdjqhkgwmdkcxmchlrmqzzvhsldc/SourcePackages/checkouts/SampleBufferDisplayRendererCompositor.swift", { add: 4391, del: 12 }], ["~/Library/Developer/Xcode/DerivedData/Boxbox-bdjqhkgwmdkcxmchlrmqzzvhsldc/SourcePackages/checkouts/SampleBufferDisplayRendererCompositorTests.swift", { add: 88, del: 2 }]]) }),
];

const child = (state: Child["state"], steps_: number): Child => ({ steps: steps_, ms: 90_000, items: [], held: true, state, since: Date.now() - 134_000, created: Date.now() - 134_000, title: "" });
const agents: AgentRow[] = [
  { id: "ses_aaaa1111", child: child("working", 12), name: "reviewer", type: "review", at: Date.now() - 134_000, reported: false, label: "reviewer" },
  { id: "ses_bbbb2222", child: child("wants", 4), name: "tester", type: "tests", at: T0 + 21 * MIN, reported: false, label: "tester" },
  { id: "ses_cccc3333", child: child("idle", 8), name: "scout", at: T0 + 7 * MIN, reported: true, label: "scout" },
  // an agent the fleet does not hold (older than its host's newest 300): not held, its state unknown, and still a door, opened by its key
  { id: "ses_dddd4444", child: { ...child("idle", 0), held: false }, name: "scout", at: T0, reported: false, label: "scout dddd" },
];

const info = {
  id: "ses_x", cost: 1.84,
  tokens: { input: 130_000, output: 41_000, cache: { read: 1_180_000, write: 62_000 } },
  context: { used: 82_000, limit: 200_000, compactAt: 160_000 },
  vcs: { branch: "feature/inspector-column", dirty: true },
} as unknown as SessionInfo;

/* the agents' spend: the reviewer started a scout of its own, and the archived scout's spend is not known any more */
const kin: Kin[] = [
  { id: "ses_aaaa1111", parent: "ses_x", title: "reviewer (review)", at: Date.now() - 134_000, cost: 0.62, gone: false },
  { id: "ses_eeee5555", parent: "ses_aaaa1111", title: "scout (scout)", at: Date.now() - 90_000, cost: 0.08, gone: false },
  { id: "ses_bbbb2222", parent: "ses_x", title: "tester (tests)", at: T0 + 21 * MIN, cost: 0.31, gone: false },
  { id: "ses_cccc3333", parent: "ses_x", title: "scout (scout)", at: T0 + 7 * MIN, cost: 0.004, gone: false },
  { id: "ses_dddd4444", parent: "ses_x", title: "scout (scout)", at: T0, cost: null, gone: true },
];
const detailsOf = (extra: Partial<DetailsData> = {}): DetailsData => ({ turns, agents, files: filesChanged(turns), info, spend: spendOf(turns, info, kin, agents), now: Date.now(), openAgent: (id) => console.info("the story would open", id), ...extra });
const turnsOfList: TurnsData = { listed: turns, here: "t2", label: (t) => t.prompt || `${t.from ?? "an agent"} reported`, goTo: (t) => console.info("the story would go to", t.id) };
const quietInfo = { id: "ses_y", cost: 0, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } } as unknown as SessionInfo;
const quiet = { turns: [] as Turn[], agents: [] as AgentRow[], files: filesChanged([]), info: quietInfo, spend: spendOf([], quietInfo, [], []) };

type Where = "inspector" | "docked" | "sheet";
function story(name: string, where: Where, which: "details" | "turns", data: DetailsData): Story {
  const S: Story = () => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      const dispose = render(() => createComponent(Panel, { which, place: where === "inspector" ? "flat" : where, heading: { title: "add an annual toggle to the pricing page", sub: "ledger, on studio" }, palette: TONES.green, details: data, turns: turnsOfList, close: where === "inspector" && which === "details" ? undefined : { label: `close ${which}`, run: () => console.info("the story would close") } }), el);
      el.dataset["ready"] = "1";
      return dispose;
    }, []);
    // the inspector's column is 330 wide with 26 and 22 of padding (home.css); the stage's own classes dress the others
    if (where === "inspector") return createElement("div", { className: "dt-ground" }, createElement("div", { className: "dt-column", ref }));
    return createElement("section", { className: `thread-stage dt-stage ${where === "docked" ? "wide" : ""}`, style: { "--tone": TONES.green.tone, "--window-top": TONES.green.top, "--window-bottom": TONES.green.bottom } as never },
      createElement("div", { className: "stage-bg", "aria-hidden": "true" }),
      createElement("nav", { className: "turns on", "aria-label": which }, createElement("div", { ref, className: "dt-host" })));
  };
  S.storyName = name;
  return S;
}

export const InspectorDetails = story("inspector, details", "inspector", "details", detailsOf());
export const InspectorTurns = story("inspector, turns", "inspector", "turns", detailsOf());
export const InspectorEmpty = story("inspector, nothing yet", "inspector", "details", detailsOf(quiet));
export const DockedDetails = story("docked, details", "docked", "details", detailsOf());
export const DockedTurns = story("docked, turns", "docked", "turns", detailsOf());
export const SheetDetails = story("sheet, details", "sheet", "details", detailsOf());
export const SheetTurns = story("sheet, turns", "sheet", "turns", detailsOf());
