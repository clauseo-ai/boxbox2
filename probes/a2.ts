/* a2: reads carry the seq they reflect. every listed read answers with
   x-cmx2-seq in the stream's epoch, and a read raced against a stream of
   renames shows exactly the title the events up to its seq produced. */

import { type Context, type Event, forSession, type Probe, record, sequenced } from "./probe";
import { parseCursor } from "./wire";

const RACE_WRITES = 40;

export const a2: Probe = {
  ask: "a2",
  title: "reads carry the seq they reflect",
  async run(ctx: Context) {
    const witness = await ctx.watch();
    const session = await ctx.session("reads");
    await ctx.turn(witness, session, "[bench:words 3 5] a2 reads");

    const reads = [
      "/session",
      "/api/session",
      "/session/:id",
      "/session/:id/message",
      "/session/status",
      "/permission",
      "/question",
      "/project",
      "/session/:id/agents",
      "/session/:id/procs",
    ];
    const streamed = witness.events.filter((e) => sequenced(e) && e.frame.id !== undefined);
    const last = parseCursor(streamed.at(-1)?.frame.id);
    for (const route of reads) {
      const reply = await ctx.api("GET", route.replace(":id", session));
      const header = reply.headers.get("x-cmx2-seq");
      const cursor = parseCursor(header ?? undefined);
      ctx.check(
        `GET ${route} answers x-cmx2-seq: <epoch>:<seq>`,
        reply.status === 200 && cursor !== undefined,
        header === null ? `answered ${reply.status} with no x-cmx2-seq` : `answered ${reply.status} with x-cmx2-seq: ${header}`,
      );
      ctx.check(
        `GET ${route}'s seq is in the stream's epoch and not behind what the stream delivered`,
        last !== undefined && cursor.epoch === last.epoch && cursor.seq >= last.seq,
        last === undefined ? "the stream carries no id: to compare with (a1)" : `x-cmx2-seq: ${header}; the stream had delivered ${last.epoch}:${last.seq}`,
      );
    }

    // a read raced against a publish: each title read must be the one the events up to its seq set
    const titles: { title: string; seq: number }[] = [];
    let writing = true;
    const writes = (async () => {
      for (let i = 0; i < RACE_WRITES; i++) await ctx.api("PATCH", `/session/${session}`, { title: `a2 race ${i}` });
      writing = false;
    })();
    while (writing) {
      const reply = await ctx.api("GET", `/session/${session}`);
      const cursor = parseCursor(reply.headers.get("x-cmx2-seq") ?? undefined);
      if (cursor) titles.push({ title: String(record(reply.json).title), seq: cursor.seq });
    }
    await writes;
    const renamed = (e: Event) => e.type === "session.updated" && forSession(session)(e);
    await witness.waitFrom(0, (e) => renamed(e) && record(e.properties.info).title === `a2 race ${RACE_WRITES - 1}`, "the last race rename", {
      kind: "setup",
    });
    const updates = witness.events.filter(renamed).map((e) => ({ title: String(record(e.properties.info).title), seq: parseCursor(e.frame.id)?.seq ?? -1 }));
    let torn: string | undefined;
    for (const read of titles) {
      const at = updates.findLastIndex((u) => u.title === read.title && u.seq <= read.seq);
      const next = updates[at + 1];
      if (at < 0 || (next && next.seq <= read.seq)) {
        torn = `a read at seq ${read.seq} showed "${read.title}", but the stream set ${at < 0 ? "that title only later" : `"${next?.title}" at seq ${next?.seq}`}`;
        break;
      }
    }
    ctx.note(`${titles.length} reads raced against ${RACE_WRITES} renames`);
    ctx.check(
      "a read raced against a publish shows exactly the state after its seq",
      titles.length > 0 && torn === undefined,
      titles.length === 0 ? "no read carried x-cmx2-seq to judge" : (torn ?? ""),
    );
  },
};
