import { describe, expect, test } from "bun:test";
import type { WindowView } from "../window/view";
import { coveredBy, type StageLayer, strayView } from "./layers";

const parent = "desk:ses_parent";
const agent = "desk:ses_agent";

describe("which layers on the stage are under another", () => {
  test("a parent under its agent's thread is covered, and the agent's, on top, is not", () => {
    const layers: StageLayer[] = [{ key: parent, id: 1 }, { key: agent, id: 2, over: parent }];
    expect(coveredBy(layers, layers[0] as StageLayer)).toBe(true);
    expect(coveredBy(layers, layers[1] as StageLayer)).toBe(false);
  });

  test("the parent poured again from under its agent's thread is not covered while the agent's layer leaves", () => {
    // the agent's layer keeps its `over` until the pour's timer takes it off, and the new layer is the same thread
    const layers: StageLayer[] = [{ key: parent, id: 1 }, { key: agent, id: 2, over: parent }, { key: parent, id: 3 }];
    expect(coveredBy(layers, layers[0] as StageLayer)).toBe(true);
    expect(coveredBy(layers, layers[1] as StageLayer)).toBe(false);
    expect(coveredBy(layers, layers[2] as StageLayer)).toBe(false);
  });

  test("an agent over an agent covers the first, and the parent beneath both", () => {
    const deeper = "desk:ses_deeper";
    const layers: StageLayer[] = [{ key: parent, id: 1 }, { key: agent, id: 2, over: parent }, { key: deeper, id: 3, over: agent }];
    expect(layers.map((layer) => coveredBy(layers, layer))).toEqual([true, true, false]);
  });

  test("a stage with nothing over it is not covered", () => {
    expect(coveredBy([{ key: parent, id: 1 }], { key: parent, id: 1 })).toBe(false);
    expect(coveredBy([], { key: parent, id: 1 })).toBe(false);
  });
});

describe("an agent the fleet does not hold, drawn over its parent", () => {
  const view = {
    key: parent, host: "desk", repo: "ledger", root: "/code/ledger", colour: { top: "#123", bottom: "#012", light: "#9cf", name: "teal" },
    title: "set the greeting", state: "wants", chip: { text: "wants you", tone: "lit" }, since: 5, tail: [{ kind: "say", id: "l1", text: "hi" }],
    ask: null, need: null, queued: 1, agents: 2, parkedAgents: 0, jobs: 0, diff: { additions: 1, deletions: 1 }, failure: null, review: null, retry: null, updated: 9,
  } as unknown as WindowView;

  test("takes the parent's repo and colour under its own key, named by the row that opened it", () => {
    const stray = strayView(view, agent, "explore the notes");
    expect(stray).toMatchObject({ key: agent, title: "explore the notes", repo: "ledger", root: "/code/ledger", colour: view.colour, host: "desk" });
  });

  test("carries none of the parent's state, since the agent's is not followed", () => {
    expect(strayView(view, agent, "x")).toMatchObject({ state: "idle", chip: null, since: null, tail: [], queued: 0, agents: 0, diff: null });
  });

  test("a row with no name: the agent's session id", () => {
    expect(strayView(view, agent, null).title).toBe("ses_agent");
    expect(strayView(view, agent, "  ").title).toBe("ses_agent");
  });
});
