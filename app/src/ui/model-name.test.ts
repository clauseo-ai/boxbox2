import { describe, expect, test } from "bun:test";
import { modelName } from "./model-name";

describe("modelName", () => {
  test("says a model the way a person does, whatever carries it", () => {
    expect(modelName("claude-sonnet-5-5")).toBe("sonnet 5.5");
    expect(modelName("anthropic/claude-opus-5-5")).toBe("opus 5.5");
    expect(modelName("anthropic/claude-fable-5-1")).toBe("fable 5.1");
    expect(modelName("gpt-5.2-codex")).toBe("gpt 5.2 codex");
    expect(modelName("gpt-5")).toBe("gpt 5");
  });
  test("drops a date and marks a latest alias", () => {
    expect(modelName("anthropic/claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(modelName("claude-3-5-sonnet-20241022")).toBe("3.5 sonnet");
    expect(modelName("anthropic/claude-haiku-4-5-latest")).toBe("haiku 4.5 (latest)");
  });
});
