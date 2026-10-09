import { describe, expect, test } from "bun:test";
import { coveredBy, type StageLayer } from "./layers";

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
