import { describe, expect, test } from "bun:test";
import type { Thread } from "../../sync/protocol";
import { thread } from "../../sync/fixtures/neutral";
import { type AgentRow, type Kin, cachedShare, contextOf, factsOf, figure, filesChanged, kept, modelsOf, percentWords, ranOf, spend, spendOf, spentOf, summaryOf, switches, tokensIn } from "./details-model";
import type { Turn } from "./model";

/** a turn with only what the details read */
const turn = (id: string, at: number, extra: Partial<Turn> = {}): Turn =>
  ({ id, by: "you", prompt: id, at, end: at + 1, items: [], status: "done", cost: 0, files: new Map(), compacted: false, unknownParts: 0, ...extra }) as Turn;

/** cmx2's session tokens as the server's translate renames them (`cache.read`, `cache.write` are `cacheRead`, `cacheWrite`) */
type CmxTokens = { input: number; output: number; cache: { read: number; write: number } };
const neutralTokens = (t: CmxTokens) => ({ input: t.input, output: t.output, cacheRead: t.cache.read, cacheWrite: t.cache.write });

/** cmx2's session info, with what the details read, as the neutral thread the server makes of it */
const info = (extra: { cost?: number; tokens?: CmxTokens; context?: { used: number; limit: number; compactAt?: number } } = {}): Thread => {
  const raw = { cost: 0, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } }, ...extra };
  return thread("desk:s", { cost: raw.cost, tokens: neutralTokens(raw.tokens), ...(raw.context ? { context: raw.context } : {}) });
};

describe("figure", () => {
  test("keeps a count to a few characters", () => {
    expect(figure(940)).toBe("940");
    expect(figure(1234)).toBe("1.2k");
    expect(figure(12_400)).toBe("12k");
    expect(figure(999_700)).toBe("1m");
    expect(figure(1_300_000)).toBe("1.3m");
  });
});

describe("spend", () => {
  test("is dollars and cents", () => {
    expect(spend(1.84)).toBe("$1.84");
    expect(spend(0)).toBe("$0.00");
  });
});

describe("tokens", () => {
  const tokens = { input: 100, output: 50, cache: { read: 900, write: 20 } };
  test("count everything that moved", () => expect(tokensIn(neutralTokens(tokens))).toBe(1070));
  test("share the cache's part of what went in as a whole percent", () => expect(cachedShare(neutralTokens(tokens))).toBe(90));
  test("have no share before anything went in", () => expect(cachedShare(neutralTokens({ input: 0, output: 5, cache: { read: 0, write: 0 } }))).toBeNull());
});

describe("percentWords", () => {
  test("is a whole percent, and under 1% for a trace, never a zero for something there", () => {
    expect(percentWords(41, 100)).toBe("41%");
    expect(percentWords(3, 1000)).toBe("under 1%");
    expect(percentWords(0, 1000)).toBe("0%");
    expect(percentWords(5, 0)).toBe("0%");
  });
});

describe("contextOf", () => {
  test("is the window's fill and where it compacts, as percents", () => {
    expect(contextOf(info({ context: { used: 82_000, limit: 200_000, compactAt: 160_000 } }))).toEqual({ percent: 41, compactsAt: 80 });
    expect(contextOf(info({ context: { used: 5000, limit: 100_000 } }))).toEqual({ percent: 5 });
  });
  test("is unknown when the daemon has not said, or the window is empty", () => {
    expect(contextOf(info())).toBeUndefined();
    expect(contextOf(info({ context: { used: 1, limit: 0 } }))).toBeUndefined();
    expect(contextOf(undefined)).toBeUndefined();
  });
});

describe("filesChanged", () => {
  const a = turn("a", 1, { files: new Map([["src/one.ts", { add: 10, del: 1 }], ["src/two.ts", { add: 2, del: 0 }]]) });
  const b = turn("b", 2, { files: new Map([["src/one.ts", { add: 5, del: 4 }], ["README.md", { add: 1, del: 1 }]]) });
  test("sums a file's counts across turns and lists the one edited last first", () => {
    const { files, add, del } = filesChanged([a, b]);
    expect(files.map((f) => f.path)).toEqual(["README.md", "src/one.ts", "src/two.ts"]);
    expect(files[1]).toMatchObject({ dir: "src/", base: "one.ts", add: 15, del: 5 });
    expect([add, del]).toEqual([18, 6]);
  });
  test("is empty before a file is edited", () => expect(filesChanged([turn("x", 1)])).toEqual({ files: [], add: 0, del: 0 }));
});

describe("modelsOf", () => {
  const turns = [
    turn("a", 1, { model: "claude-opus-5-5", effort: "high", cost: 1 }),
    turn("b", 2, { model: "claude-fable-5-1", cost: 0.25 }),
    turn("c", 3, { model: "claude-opus-5-5", effort: "high", cost: 0.5 }),
    turn("d", 4, { model: "claude-opus-5-5", effort: "low", cost: 0.1 }),
    turn("m", 5),
  ];
  test("is one row per model and effort, the newest first, with its turns and cost", () => {
    const rows = modelsOf(turns);
    expect(rows.map((r) => [r.name, r.effort, r.turns, r.cost])).toEqual([
      ["opus 5.5", "low", 1, 0.1],
      ["opus 5.5", "high", 2, 1.5],
      ["fable 5.1", undefined, 1, 0.25],
    ]);
  });
  test("marks the turn where the model or effort changed, and no other", () => {
    expect([...switches(turns)]).toEqual([["b", "fable 5.1"], ["c", "opus 5.5, high"], ["d", "opus 5.5, low"]]);
  });
});

describe("one account of the thread", () => {
  /* the session's own total and its turns' sums disagree (the daemon's total can lag, a notice carries no spend):
     everything on the panel must come from the turns, so the parts add up to the whole */
  const turns = [
    turn("a", 1, { model: "claude-opus-5-5", effort: "high", cost: 0.5 }),
    turn("n", 2, { by: "notice", model: "claude-opus-5-5", effort: "high", cost: 0.4 }),
    turn("b", 3, { model: "claude-sonnet-5-5", cost: 0.25 }),
  ];
  test("the spend is the turns' sum, not the session's total", () => {
    expect(spentOf(turns, info({ cost: 0 }))).toBeCloseTo(0.75);
    expect(spentOf(turns, info({ cost: 9 }))).toBeCloseTo(0.75);
  });
  test("the session's total stands in only while no turn carries a cost", () => {
    expect(spentOf([turn("x", 1)], info({ cost: 1.84 }))).toBe(1.84);
    expect(spentOf([], undefined)).toBe(0);
  });
  test("the models' costs add up to the spend, and a notice is in neither", () => {
    const rows = modelsOf(turns);
    expect(rows.reduce((n, r) => n + r.cost, 0)).toBeCloseTo(spentOf(turns, info()));
    expect(rows.reduce((n, r) => n + r.turns, 0)).toBe(ranOf(turns).length);
  });
  test("the facts line says the same spend the tile does", () => {
    expect(factsOf(turns, info({ cost: 0 }))?.text).toBe("sonnet 5.5 · $0.75");
  });
});

describe("factsOf", () => {
  const turns = [turn("a", 1, { model: "claude-opus-5-5", effort: "high" })];
  test("says the model, the context and the spend, and names them in full", () => {
    const facts = factsOf(turns, info({ cost: 1.84, context: { used: 41, limit: 100 } }));
    expect(facts?.text).toBe("opus 5.5, high · 41% of context · $1.84");
    expect(facts?.name).toBe("details: opus 5.5, high, 41% of context used, $1.84 spent");
  });
  test("leaves out what is not known", () => {
    expect(factsOf(turns, info())?.text).toBe("opus 5.5, high");
    expect(factsOf([], info({ cost: 0.5 }))?.text).toBe("$0.50");
  });
  test("leaves out a context nothing has filled and a spend of nothing", () => {
    expect(factsOf(turns, info({ cost: 0, context: { used: 0, limit: 100 } }))?.text).toBe("opus 5.5, high");
  });
  test("is no line when nothing is known", () => expect(factsOf([], undefined)).toBeNull());
});

describe("summaryOf", () => {
  test("counts the agents and files, or says there is nothing", () => {
    expect(summaryOf(2, 3)).toBe("2 agents, 3 files");
    expect(summaryOf(1, 0)).toBe("1 agent");
    expect(summaryOf(0, 0)).toBe("nothing yet");
  });
});

describe("spendOf", () => {
  const kin = (id: string, parent: string, cost: number | null, extra: Partial<Kin> = {}): Kin => ({ id, parent, title: `${id} (scout)`, at: 0, cost, gone: false, ...extra });
  const row = (id: string, label: string, type?: string): AgentRow =>
    ({ id, child: { steps: 0, ms: 0, items: [], held: true, state: "idle", since: 0, created: 0, title: "" }, name: label, ...(type ? { type } : {}), at: 0, reported: false, label }) as AgentRow;
  const turns = [turn("a", 1, { cost: 0.5 })];

  test("adds every agent under the thread, at any depth, to its own turns", () => {
    const s = spendOf(turns, info(), [kin("c1", "s", 0.25), kin("g1", "c1", 0.1), kin("c2", "s", 0.05)], []);
    expect(s.own).toBeCloseTo(0.5);
    expect(s.agents).toBeCloseTo(0.4);
    expect(s.total).toBeCloseTo(0.9);
    expect(s.unknown).toBe(0);
  });

  test("puts each agent under the one that started it, the dearest first among siblings", () => {
    const s = spendOf(turns, info(), [kin("c1", "s", 0.05, { at: 1 }), kin("g1", "c2", 0.01), kin("c2", "s", 0.25, { at: 2 }), kin("g2", "c2", 0.2)], []);
    expect(s.rows.map((r) => [r.id, r.depth])).toEqual([["c2", 0], ["g2", 1], ["g1", 1], ["c1", 0]]);
  });

  test("names the thread's own agents as the roster does, deeper ones by the daemon's title", () => {
    const s = spendOf(turns, info(), [kin("c1", "s", 0.1), kin("g1", "c1", 0.1, { title: "tester (tests)" })], [row("c1", "reviewer 1111", "review")]);
    expect(s.rows.map((r) => [r.name, r.type])).toEqual([["reviewer 1111", "review"], ["tester", "tests"]]);
  });

  test("counts an agent whose spend is not known apart, out of the total, and lists it last", () => {
    const s = spendOf(turns, info(), [kin("gone", "s", null, { gone: true }), kin("c1", "s", 0.2)], []);
    expect(s.total).toBeCloseTo(0.7);
    expect(s.unknown).toBe(1);
    expect(s.rows.map((r) => [r.id, r.cost, r.gone])).toEqual([["c1", 0.2, false], ["gone", null, true]]);
  });

  test("with no agents the spend is the thread's own", () => {
    const s = spendOf(turns, info({ cost: 9 }), [], []);
    expect(s).toEqual({ own: 0.5, agents: 0, total: 0.5, rows: [], unknown: 0 });
  });

  test("the facts line says the whole tree's spend", () => {
    expect(factsOf(turns, info(), 0.25)?.text).toBe("$0.75");
  });
});

describe("kept", () => {
  const key = (f: { path: string }) => f.path;
  test("gives back the list it had when every row says the same, so a keyed list keeps every node", () => {
    const turns = [turn("a", 1, { files: new Map([["src/a.ts", { add: 1, del: 0 }], ["src/b.ts", { add: 2, del: 1 }]]) })];
    const before = filesChanged(turns).files;
    const again = filesChanged(turns).files;
    expect(again).not.toBe(before);
    expect(kept(again, before, key)).toBe(before);
  });
  test("keeps the rows that did not change and takes the ones that did, in the new order, equal to the new list", () => {
    const before = [{ path: "a", add: 1 }, { path: "b", add: 2 }, { path: "c", add: 3 }];
    const next = [{ path: "c", add: 3 }, { path: "b", add: 5 }, { path: "d", add: 1 }];
    const out = kept(next, before, key);
    expect(out).toEqual(next);
    expect(out[0]).toBe(before[2]);
    expect(out[1]).toBe(next[1]);
    expect(out[2]).toBe(next[2]);
  });
  test("a row with a field more or less is a new row, and a first list is the list itself", () => {
    const before = [{ path: "a", add: 1 }];
    const next = [{ path: "a", add: 1, extra: true }];
    expect(kept(next, before, key)[0]).toBe(next[0]);
    expect(kept(before, undefined, key)).toBe(before);
  });
  test("a model list worked out again from the same turns is the same list", () => {
    const turns = [turn("a", 1, { model: "anthropic/claude", cost: 1 } as Partial<Turn>), turn("b", 2, { model: "openai/gpt", effort: "high", cost: 2 } as Partial<Turn>)];
    const k = (m: { model: string; effort?: string }) => `${m.model}\u0000${m.effort ?? ""}`;
    const before = modelsOf(turns);
    expect(kept(modelsOf(turns), before, k)).toBe(before);
    const more = modelsOf([...turns, turn("c", 3, { model: "openai/gpt", effort: "high", cost: 1 } as Partial<Turn>)]);
    const out = kept(more, before, k);
    expect(out).toEqual(more);
    expect(out[0]).not.toBe(before[0]);
    expect(out[1]).toBe(before[1]);
  });
});
