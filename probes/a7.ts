/* a7: status tells the whole story, as amended on 2026-09-30. a session
   parked on a background job is in GET /session/status with its parked
   detail when the client asks with ?parked=true, which v2 always does; the
   plain read leaves it out, because v1 reads any entry as busy. every
   status, parked or busy, carries since in ms. */

import { type Context, deltaOf, idleOf, type Probe, record } from "./probe";

export const a7: Probe = {
  ask: "a7",
  title: "status tells the whole story",
  async run(ctx: Context) {
    const startedAt = Date.now();
    const witness = await ctx.watch();
    const parked = await ctx.session("parked");
    await ctx.turn(witness, parked, "[bench:park] a7 parked");
    await Bun.sleep(300);
    const status = record((await ctx.api("GET", "/session/status?parked=true")).json);
    const entry = record(status[parked]);
    ctx.check("a parked session appears in GET /session/status?parked=true", parked in status, `the map lists ${Object.keys(status).length} other session(s) and not ${parked}`);
    ctx.check("with its parked detail", entry.type === "idle" && Number(record(entry.parked).jobs) >= 1, `its status is ${JSON.stringify(entry)}`);
    const plausible = (since: unknown) => typeof since === "number" && since >= startedAt - 1000 && since <= Date.now();
    ctx.check("a parked status carries since (ms)", plausible(entry.since), `since: ${JSON.stringify(entry.since)}`);
    const plain = record((await ctx.api("GET", "/session/status")).json);
    ctx.check("without ?parked=true the parked session stays out of the map", !(parked in plain), `the plain read lists it as ${JSON.stringify(plain[parked])}`);

    const busy = await ctx.session("busy");
    const streaming = witness.wait(deltaOf(busy), "the busy turn streams", { kind: "setup" });
    const idle = witness.wait(idleOf(busy), "the busy turn stops", { kind: "setup" });
    await ctx.prompt(busy, "[bench:words 100 20] a7 busy");
    await streaming;
    const busyEntry = record(record((await ctx.api("GET", "/session/status?parked=true")).json)[busy]);
    ctx.need("the busy session is in the status map", busyEntry.type === "busy", `its status is ${JSON.stringify(busyEntry)}`);
    ctx.check("a busy status carries since (ms)", plausible(busyEntry.since), `since: ${JSON.stringify(busyEntry.since)}`);
    await ctx.api("POST", `/session/${busy}/abort`);
    await idle;
    // archiving stops the parked session's background job
    await ctx.api("DELETE", `/session/${parked}`);
  },
};
