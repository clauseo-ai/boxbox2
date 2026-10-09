import { afterEach, describe, expect, test } from "bun:test";
import { setModelsRead, state } from "../../store";
import { readModels } from "./reads";

const MODELS = { default: "anthropic/claude-opus-5-5", models: [{ id: "anthropic/claude-opus-5-5", name: "Opus 5.5", provider: "Anthropic", efforts: ["low", "high"] }] };

afterEach(() => {
  for (const host of ["desk", "desk2", "desk3", "desk4"]) setModelsRead(host, null);
});

describe("the host's model list", () => {
  test("a read that fails is recorded as failed, not swallowed, so the picker can say the models did not come", async () => {
    await readModels("desk", () => Promise.reject(new Error("down")));
    expect(state.modelsRead.desk).toBe("failed");
    expect(state.models.desk).toBeUndefined();
  });

  test("an answer with no list (a refusal) is a failure too", async () => {
    await readModels("desk3", () => Promise.resolve(null));
    expect(state.modelsRead.desk3).toBe("failed");
  });

  test("while it is being read it says loading", async () => {
    let finish: (list: typeof MODELS | null) => void = () => undefined;
    const read = readModels("desk4", () => new Promise((resolve) => (finish = resolve)));
    expect(state.modelsRead.desk4).toBe("loading");
    finish(MODELS);
    await read;
    expect(state.modelsRead.desk4).toBeUndefined();
  });

  test("asking again after a failure reads again, and a list that comes clears the failure", async () => {
    let calls = 0;
    const fetchList = () => (++calls === 1 ? Promise.reject(new Error("down")) : Promise.resolve(MODELS));
    await readModels("desk", fetchList);
    expect(state.modelsRead.desk).toBe("failed");
    await readModels("desk", fetchList);
    expect(calls).toBe(2);
    expect(state.modelsRead.desk).toBeUndefined();
    expect(state.models.desk?.models[0]?.name).toBe("Opus 5.5");
  });

  test("a menu, a chip and a retry asking at once make one read, and a list already here is not read again", async () => {
    let calls = 0;
    const fetchList = () => (calls++, Promise.resolve(MODELS));
    await Promise.all([readModels("desk2", fetchList), readModels("desk2", fetchList), readModels("desk2", fetchList)]);
    expect(calls).toBe(1);
    await readModels("desk2", fetchList);
    expect(calls).toBe(1);
  });
});
