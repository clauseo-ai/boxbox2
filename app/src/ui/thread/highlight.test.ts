import { describe, expect, test } from "bun:test";
import { highlight as paint, highlighterReady, infoWord, languageOf, loadHighlighter } from "./highlight";
import { HIGHLIGHT_MAX_CODE, HIGHLIGHT_STREAM_MAX, Lru, highlight, registry } from "./highlight-engine";
import { INFO_WORD_MAX, LANGUAGES, keepsClass } from "./languages";

await loadHighlighter();

describe("the language of a fence", () => {
  test("an alias reads as the language's real name", () => {
    expect(languageOf("ts")).toEqual({ label: "typescript", grammar: "typescript" });
    expect(languageOf("tsx")).toEqual({ label: "typescript", grammar: "typescript" });
    expect(languageOf("jsx")).toEqual({ label: "javascript", grammar: "javascript" });
    expect(languageOf("yml")).toEqual({ label: "yaml", grammar: "yaml" });
    expect(languageOf("rs")).toEqual({ label: "rust", grammar: "rust" });
  });
  test("every way to write a shell reads as bash", () => {
    for (const word of ["sh", "zsh", "bash", "shell", "console"]) expect(languageOf(word)).toEqual({ label: "bash", grammar: "bash" });
  });
  test("the two grammars named for a pair say the one the author wrote", () => {
    expect(languageOf("html").label).toBe("html");
    expect(languageOf("xml").label).toBe("xml");
    expect(languageOf("svg").label).toBe("svg");
    expect(languageOf("toml").label).toBe("toml");
    expect(languageOf("ini").label).toBe("ini");
    expect(languageOf("c++").label).toBe("c++");
  });
  test("an unknown language shows what the author wrote, lowercased, and is plain", () => {
    expect(languageOf("Elixir")).toEqual({ label: "elixir" });
  });
  test("plain text says the word it was written as and is plain", () => {
    expect(languageOf("txt")).toEqual({ label: "txt" });
    expect(languageOf("text")).toEqual({ label: "text" });
  });
  test("an unlabelled fence says nothing", () => {
    expect(languageOf("")).toEqual({});
    expect(languageOf(undefined)).toEqual({});
    expect(languageOf("   ")).toEqual({});
  });
  test("only the first word of the info string counts, and braces and dots around it do not", () => {
    expect(infoWord("ts title=\"a.ts\"")).toBe("ts");
    expect(infoWord("{.python}")).toBe("python");
    expect(languageOf("TypeScript linenos").label).toBe("typescript");
  });
});

describe("the language list", () => {
  test("it holds every grammar boxbox registers, and only aliases hljs knows", () => {
    const held = new Map(registry().map((r) => [r.key, r]));
    expect([...held.keys()].sort()).toEqual(Object.keys(LANGUAGES).sort());
    for (const [key, aliases] of Object.entries(LANGUAGES)) for (const alias of aliases.split(" ").filter(Boolean)) expect(held.get(key)?.aliases, `${alias} of ${key}`).toContain(alias);
  });
  test("a header says hljs's own name for the grammar, lowercased, except where hljs names a pair or plain text", () => {
    const held = new Map(registry().map((r) => [r.key, r]));
    for (const key of Object.keys(LANGUAGES)) {
      if (["xml", "ini", "plaintext"].includes(key)) continue;
      expect(languageOf(key).label, key).toBe(held.get(key)?.name.toLowerCase());
    }
    expect(held.get("xml")?.name).toBe("HTML, XML");
    expect(held.get("ini")?.name).toBe("TOML, also INI");
  });
});

describe("the highlighter's arrival", () => {
  test("once loaded it is ready, and asking again costs nothing", async () => {
    expect(highlighterReady()).toBe(true);
    await loadHighlighter();
    expect(highlighterReady()).toBe(true);
  });
});

describe("what the sanitiser lets stay of an agent's classes", () => {
  test("marked's language class on a fence's code, and nothing else", () => {
    expect(keepsClass("CODE", "language-ts")).toBe(true);
    expect(keepsClass("CODE", "language-c++")).toBe(true);
    expect(keepsClass("CODE", "language-c#")).toBe(true);
  });
  test("a class that would pass for one of ours, or for the thread, goes", () => {
    for (const cls of ["copy-btn", "cblock", "cblock-h", "thread", "turn", "row open", "hljs-keyword", "bed-wrap", "writing", "language-ts copy-btn", "language-", "language-" + "x".repeat(40)]) expect(keepsClass("CODE", cls), cls).toBe(false);
    for (const tag of ["DIV", "SPAN", "PRE", "BUTTON", "A", "P"]) expect(keepsClass(tag, "language-ts"), tag).toBe(false);
  });
});

describe("a fence's word", () => {
  test("is cut where it stops being a language, so a header stays one line", () => {
    expect(infoWord("x".repeat(100)).length).toBe(INFO_WORD_MAX);
    expect(languageOf("a-sentence-written-where-a-language-goes").label?.length).toBeLessThanOrEqual(INFO_WORD_MAX);
  });
});

describe("highlighting", () => {
  test("a known grammar comes back as escaped html with token classes", () => {
    const out = highlight("typescript", "const a = \"<b>\";", false);
    expect(out).toContain('class="hljs-keyword"');
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;");
  });
  test("no grammar, or code over the cap, is plain", () => {
    expect(paint(undefined, "x")).toBeUndefined();
    expect(highlight("bash", "x".repeat(HIGHLIGHT_MAX_CODE + 1), false)).toBeUndefined();
    expect(highlight("bash", "x".repeat(HIGHLIGHT_MAX_CODE), false)).toBeDefined();
  });
  test("the block a reply is still writing is held to a smaller size than a settled one", () => {
    const code = "x".repeat(HIGHLIGHT_STREAM_MAX + 1);
    expect(highlight("bash", code, true)).toBeUndefined();
    expect(highlight("bash", code, false)).toBeDefined();
    expect(highlight("bash", "x".repeat(HIGHLIGHT_STREAM_MAX), true)).toBeDefined();
  });
  test("the first load's entry point paints through the loaded engine", () => {
    expect(paint("bash", "echo hi", false)).toContain("hljs-");
  });
  test("the same code under another grammar is a different entry", () => {
    const cache = new Lru(1 << 20);
    expect(highlight("json", "[1, 2]", false, cache)).not.toBe(highlight("python", "[1, 2]", false, cache));
    expect(cache.size).toBe(2);
  });
  test("a repeat is served from the cache, not painted again", () => {
    const cache = new Lru(1 << 20);
    const first = highlight("bash", "echo hi", false, cache);
    expect(cache.size).toBe(1);
    expect(highlight("bash", "echo hi", false, cache)).toBe(first);
    expect(cache.size).toBe(1);
  });
});

describe("the cache's eviction", () => {
  test("the oldest entry leaves when the bytes pass the cap", () => {
    const cache = new Lru(12);
    cache.set("a", "11");
    cache.set("b", "22");
    cache.set("c", "33");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("22");
    expect(cache.get("c")).toBe("33");
    expect(cache.weight).toBeLessThanOrEqual(12);
  });
  test("a read makes an entry the newest", () => {
    const cache = new Lru(12);
    cache.set("a", "11");
    cache.set("b", "22");
    cache.get("a");
    cache.set("c", "33");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("11");
  });
  test("an entry bigger than the whole cap is not kept and evicts nothing", () => {
    const cache = new Lru(20);
    cache.set("a", "1");
    cache.set("big", "x".repeat(100));
    expect(cache.get("big")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
  });
  test("replacing a key does not count its old bytes twice", () => {
    const cache = new Lru(100);
    cache.set("k", "x".repeat(10));
    cache.set("k", "y".repeat(10));
    expect(cache.size).toBe(1);
    expect(cache.weight).toBe(2 * (1 + 10));
  });
});
