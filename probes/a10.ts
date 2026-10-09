/* a10: usage on the wire. after a turn, session.updated and the session
   list both carry cost, tokens, the context fill {used, limit} and the diff
   summary {files, additions, deletions}. */

import { type Context, forSession, type Json, type Probe, record } from "./probe";

const numbers = (value: unknown, keys: string[]) => keys.every((k) => typeof record(value)[k] === "number");

export const a10: Probe = {
  ask: "a10",
  title: "usage on the wire",
  async run(ctx: Context) {
    const witness = await ctx.watch();
    const session = await ctx.session("usage");
    await ctx.turn(witness, session, "[bench:words 3 5] a10 usage");
    const updated = witness.events.filter((e) => e.type === "session.updated" && forSession(session)(e)).at(-1);
    ctx.need("the turn published session.updated", updated !== undefined, "none for the session");
    const listed = (await ctx.api("GET", "/session")).json;
    const entry = (Array.isArray(listed) ? listed : []).map(record).find((s) => s.id === session);
    ctx.need("the session list holds the session", entry !== undefined, "not listed");
    const places: [string, Json][] = [
      ["session.updated", record(updated.properties.info)],
      ["the session list", entry],
    ];
    for (const [where, info] of places) {
      ctx.check(`${where} carries cost`, typeof info.cost === "number", `cost: ${JSON.stringify(info.cost)}`);
      ctx.check(`${where} carries tokens`, numbers(info.tokens, ["input", "output"]), `tokens: ${JSON.stringify(info.tokens)}`);
      ctx.check(`${where} carries the context fill {used, limit}`, numbers(info.context, ["used", "limit"]), `context: ${JSON.stringify(info.context)}`);
      ctx.check(
        `${where} carries the diff summary {files, additions, deletions}`,
        numbers(info.summary, ["files", "additions", "deletions"]),
        `summary: ${JSON.stringify(info.summary)}`,
      );
    }
  },
};
