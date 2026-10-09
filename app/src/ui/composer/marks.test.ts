import { describe, expect, test } from "bun:test";
import { MARK_ALIASES, providerKey, providerWords } from "./marks";
import { MARK_NAMES, markId, markOf, markSprite } from "./marks-data";

describe("providerKey", () => {
  test("takes the segment before the first slash", () => {
    expect(providerKey({ id: "anthropic/claude-opus-5-5", provider: "Anthropic" })).toBe("anthropic");
    expect(providerKey({ id: "openrouter/meta/llama-4", provider: "OpenRouter" })).toBe("openrouter");
  });
  test("without a slash, the display name lowercased and normalised", () => {
    expect(providerKey({ id: "gpt-5", provider: "OpenAI" })).toBe("openai");
    expect(providerKey({ id: "grok-4", provider: "xAI" })).toBe("xai");
    expect(providerKey({ id: "m", provider: "Mistral AI" })).toBe("mistral-ai");
    expect(providerKey({ id: "m", provider: "Amazon Bedrock" })).toBe("amazon-bedrock");
  });
  test("a leading slash is no segment", () => {
    expect(providerKey({ id: "/x", provider: "Hugging Face" })).toBe("hugging-face");
  });
});

describe("markOf", () => {
  const names: Array<[string, string]> = [
    ["anthropic", "anthropic"],
    ["OpenAI", "openai"],
    ["Mistral AI", "mistral"],
    ["mistral-ai", "mistral"],
    ["Google Vertex", "google"],
    ["google", "google"],
    ["xAI", "xai"],
    ["GitHub Copilot", "copilot"],
    ["Hugging Face", "huggingface"],
    ["LM Studio", "lmstudio"],
    ["Together AI", "together"],
    ["moonshotai", "moonshot"],
  ];
  for (const [given, name] of names) {
    test(`${given} is ${name}`, () => {
      expect(markOf(given)?.name).toBe(name);
    });
  }
  test("a provider with no mark is null", () => {
    for (const name of ["Acme Labs", "Amazon Bedrock", "", "  ", "local", "zzz"]) expect(markOf(name)).toBeNull();
  });
});

describe("every shipped mark", () => {
  test("is a 24 by 24 mark of clean path data", () => {
    expect(MARK_NAMES.length).toBeGreaterThan(20);
    for (const name of MARK_NAMES) {
      const mark = markOf(name)?.mark;
      expect(mark, name).toBeDefined();
      if (!mark) continue;
      expect(mark.viewBox, name).toBe("0 0 24 24");
      expect(mark.title.length, name).toBeGreaterThan(0);
      expect(mark.paths.length, name).toBeGreaterThan(0);
      for (const path of mark.paths) {
        expect(path.d.length, name).toBeGreaterThan(10);
        expect(path.d, name).not.toMatch(/[<>"'`]/);
        if (path.opacity !== undefined) expect(path.opacity > 0 && path.opacity <= 1, name).toBe(true);
      }
    }
  });
});

describe("providerWords", () => {
  test("says the provider plainly", () => {
    expect(providerWords("Anthropic")).toBe("anthropic");
    expect(providerWords("OpenAI")).toBe("openai");
    expect(providerWords("Mistral AI")).toBe("mistral");
    expect(providerWords("Google Vertex")).toBe("google");
    expect(providerWords("xAI")).toBe("xai");
    expect(providerWords("Amazon Bedrock")).toBe("bedrock");
    expect(providerWords("Hugging Face")).toBe("hugging face");
  });
  test("is lowercase with no em or en dashes", () => {
    for (const display of ["OpenAI", "Mistral AI", "Foo \u2014 Bar", "Foo \u2013 Bar", "Together AI", "LM Studio"]) {
      const words = providerWords(display);
      expect(words).toBe(words.toLowerCase());
      expect(words).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("the sprite in index.html", () => {
  test("holds every mark once, as a symbol with the mark's own id, and carries nothing but paths", () => {
    const sprite = markSprite();
    for (const name of MARK_NAMES) expect(sprite.split(`id="${markId(name)}"`).length - 1, name).toBe(1);
    expect(sprite.split("<symbol ").length - 1).toBe(MARK_NAMES.length);
    expect(sprite).not.toMatch(/<(script|style|a|image|foreignObject)\b/i);
    expect(sprite).not.toMatch(/\son[a-z]+=/i);
  });
  test("every provider alias names a mark that is shipped (the types no longer say so)", () => {
    for (const [alias, name] of Object.entries(MARK_ALIASES)) expect(MARK_NAMES, alias).toContain(name);
    for (const given of ["anthropic", "OpenAI", "Mistral AI", "Google Vertex", "xAI", "GitHub Copilot", "Hugging Face", "LM Studio", "Together AI", "moonshotai", "Azure OpenAI", "workers ai", "grok", "kimi", "qwen"]) {
      const name = markOf(given)?.name;
      expect(name, given).toBeDefined();
      expect(MARK_NAMES, given).toContain(name as string);
    }
  });
});
