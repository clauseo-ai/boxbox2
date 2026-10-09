import { describe, expect, test } from "bun:test";
import { arrange, defaultView, flipFavorite, MAX_FAVORITES, starredOf, type ModelLike } from "./models";

const model = (id: string, name: string, provider: string): ModelLike => ({ id, name, provider, efforts: ["low", "high"] });
const LIST = [
  model("anthropic/claude-opus-5-5", "Opus 5.5", "Anthropic"),
  model("anthropic/claude-sonnet-5-5", "Sonnet 5.5", "Anthropic"),
  model("openai/gpt-5-codex", "GPT-5 Codex", "OpenAI"),
  model("openai/gpt-5-mini", "GPT-5 Mini", "OpenAI"),
  model("google/gemini-3-pro", "Gemini 3 Pro", "Google"),
];
const ids = (rows: readonly ModelLike[]) => rows.map((m) => m.id);

describe("starred models", () => {
  test("come back in the order the person put them, and an id the host does not list is left out", () => {
    const found = starredOf(LIST, ["google/gemini-3-pro", "gone/old-model", "anthropic/claude-opus-5-5", "google/gemini-3-pro"]);
    expect(ids(found)).toEqual(["google/gemini-3-pro", "anthropic/claude-opus-5-5"]);
  });

  test("the menu opens on the short list only when something on this host is starred", () => {
    expect(defaultView(LIST, [])).toBe("all");
    expect(defaultView(LIST, ["gone/old-model"])).toBe("all");
    expect(defaultView(LIST, ["openai/gpt-5-mini"])).toBe("favorites");
  });
});

describe("the short list", () => {
  const input = { models: LIST, favorites: ["openai/gpt-5-mini", "anthropic/claude-opus-5-5"], inUse: "anthropic/claude-opus-5-5", query: "", view: "favorites" as const };

  test("shows the starred models in the person's order with a switch to all of them", () => {
    const shown = arrange(input);
    expect(shown.of).toBe("favorites");
    expect(shown.shape).toBe("flat");
    expect(ids(shown.rows)).toEqual(["openai/gpt-5-mini", "anthropic/claude-opus-5-5"]);
    expect(shown.toggle).toEqual({ to: "all", words: "all models · 5" });
    expect(shown.hint).toBe(false);
  });

  test("keeps the model in use on the list after the starred ones when it is not starred", () => {
    const shown = arrange({ ...input, inUse: "google/gemini-3-pro" });
    expect(ids(shown.rows)).toEqual(["openai/gpt-5-mini", "anthropic/claude-opus-5-5", "google/gemini-3-pro"]);
  });

  test("does not offer the whole list when every model is already on the short list", () => {
    const every = arrange({ ...input, favorites: LIST.map((m) => m.id) });
    expect(every.toggle).toBeNull();
  });

  test("falls to the whole list when the view asks for favorites but none of this host's are starred", () => {
    const shown = arrange({ ...input, favorites: ["gone/old-model"] });
    expect(shown.of).toBe("all");
    expect(shown.hint).toBe(true);
  });
});

describe("the whole list", () => {
  test("is grouped under provider headers in the host's order, with a way back to the short list", () => {
    const shown = arrange({ models: LIST, favorites: ["openai/gpt-5-mini"], inUse: null, query: "", view: "all" });
    expect(shown.of).toBe("all");
    expect(shown.shape).toBe("grouped");
    expect(shown.groups.map((g) => [g.key, g.words, g.models.length])).toEqual([["anthropic", "anthropic", 2], ["openai", "openai", 2], ["google", "google", 1]]);
    expect(ids(shown.rows)).toEqual(ids(LIST));
    expect(shown.toggle).toEqual({ to: "favorites", words: "favorites · 1" });
    expect(shown.hint).toBe(false);
  });

  test("says starring keeps the menu short while nothing is starred, and has no switch to nowhere", () => {
    const shown = arrange({ models: LIST, favorites: [], inUse: null, query: "", view: "all" });
    expect(shown.hint).toBe(true);
    expect(shown.toggle).toBeNull();
  });

  test("a host that lists no models has nothing to star, so no hint either", () => {
    const shown = arrange({ models: [], favorites: [], inUse: null, query: "", view: "all" });
    expect(shown.rows).toEqual([]);
    expect(shown.hint).toBe(false);
  });

  test("a host with one provider has no headers to repeat", () => {
    const one = LIST.slice(0, 2);
    const shown = arrange({ models: one, favorites: [], inUse: null, query: "", view: "all" });
    expect(shown.shape).toBe("flat");
    expect(shown.groups).toEqual([]);
    expect(ids(shown.rows)).toEqual(ids(one));
  });
});

describe("a search", () => {
  test("spans every model whatever the view, the starred ones first", () => {
    const shown = arrange({ models: LIST, favorites: ["openai/gpt-5-mini"], inUse: null, query: "gpt", view: "favorites" });
    expect(shown.of).toBe("search");
    expect(shown.shape).toBe("flat");
    expect(ids(shown.rows)).toEqual(["openai/gpt-5-mini", "openai/gpt-5-codex"]);
    expect(shown.toggle).toBeNull();
    expect(shown.hint).toBe(false);
  });

  test("matches the provider's name too, and finds nothing for a word no model has", () => {
    expect(ids(arrange({ models: LIST, favorites: [], inUse: null, query: "google", view: "all" }).rows)).toEqual(["google/gemini-3-pro"]);
    expect(arrange({ models: LIST, favorites: [], inUse: null, query: "zzz", view: "all" }).rows).toEqual([]);
  });
});

describe("pressing a star", () => {
  test("adds the model at the end, and a second press takes it out", () => {
    expect(flipFavorite(["a/one"], "b/two")).toEqual({ next: ["a/one", "b/two"], on: true });
    expect(flipFavorite(["a/one", "b/two"], "a/one")).toEqual({ next: ["b/two"], on: false });
  });

  test("refuses a sixty-fifth, but always lets one go", () => {
    const full = Array.from({ length: MAX_FAVORITES }, (_, i) => `p/m${i}`);
    expect(flipFavorite(full, "p/new")).toBeNull();
    expect(flipFavorite(full, "p/m3")?.on).toBe(false);
  });
});
