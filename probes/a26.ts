/* a26: a part's final is published when its block ends, not when the step
   does. over a `[bench:think N MS]` turn (two steps that think, the second
   answers): the reasoning part's final (the whole text, time {start, end},
   no streaming) is a logged, numbered message.part.updated that arrives
   before the text part's announcement and first delta, its time.end no
   later than the text's time.start; a read taken while the reply streams
   serves the thought final; and the finals the step's end publishes agree
   with the early ones. */

import { type Context, deltaOf, type Event, idleOf, list, type Probe, record } from "./probe";
import { parseCursor } from "./wire";

const partOf = (e: Event) => record(e.properties.part);
const isFinal = (e: Event) => e.type === "message.part.updated" && partOf(e).streaming !== true && typeof record(partOf(e).time).end === "number";
const seqOf = (e: Event) => parseCursor(e.frame.id)?.seq;

export const a26: Probe = {
  ask: "a26",
  title: "a part's final is published when its block ends",
  async run(ctx: Context) {
    const witness = await ctx.watch();
    const session = await ctx.session("block ends");
    const from = witness.events.length;
    const idle = witness.wait(idleOf(session), "the thinking turn ends", { timeoutMs: 40_000, kind: "setup" });
    await ctx.prompt(session, "[bench:think 24 100] a26 block ends");

    // the answer's message: the first text part announced, and its reasoning part (the same message, index 0)
    const announce = await witness.waitFrom(
      from,
      (e) => e.type === "message.part.updated" && e.properties.sessionID === session && partOf(e).type === "text" && partOf(e).streaming === true,
      "the answer's text part is announced",
      { timeoutMs: 30_000, kind: "setup" },
    );
    const textID = String(partOf(announce).id);
    const messageID = String(partOf(announce).messageID);
    const early = await witness.collect(from, (e) => deltaOf(session)(e) && e.properties.partID === textID, 4, "four reply deltas", { kind: "setup" });
    const midReply = await ctx.api("GET", `/session/${session}/message/${messageID}`);
    const midParts = list(record(midReply.json).parts).map(record);

    await idle;
    const events = witness.events.slice(from).filter((e) => e.properties.sessionID === session);
    const textAnnounced = events.findIndex((e) => e === announce);
    const firstDelta = events.findIndex((e) => deltaOf(session)(e) && e.properties.partID === textID);
    const thought = midParts.find((p) => p.type === "reasoning");
    const thoughtID = String(thought?.id);
    ctx.need("the answer's message holds a reasoning part", thought !== undefined, `parts: ${midParts.map((p) => p.type).join(", ")}`);

    const finals = events.map((e, i) => ({ e, i })).filter(({ e }) => isFinal(e) && partOf(e).id === thoughtID);
    const earlyFinal = finals[0];
    ctx.check("the reasoning part's final is published during the turn, with time {start, end} and no streaming", earlyFinal !== undefined, `no final for ${thoughtID}`);
    const final = partOf((earlyFinal as { e: Event }).e);
    ctx.check(
      "it arrives before the text part's announcement and first delta",
      (earlyFinal as { i: number }).i < textAnnounced && (earlyFinal as { i: number }).i < firstDelta,
      `the final is event ${earlyFinal?.i}, the text is announced at ${textAnnounced} and speaks at ${firstDelta}`,
    );
    const finalSeq = seqOf((earlyFinal as { e: Event }).e);
    const announceSeq = seqOf(announce);
    ctx.check(
      "it is logged and numbered, ahead of the text's announcement in the log",
      finalSeq !== undefined && announceSeq !== undefined && finalSeq < announceSeq,
      `final seq ${finalSeq}, announcement seq ${announceSeq}`,
    );
    const end = Number(record(final.time).end);
    const textStart = Number(record(partOf(announce).time).start);
    ctx.check("its time.end is no later than the text's time.start", end <= textStart, `thought ended ${end}, text started ${textStart}`);
    ctx.check(
      "its text is everything the thought streamed",
      final.text === events.filter((e) => deltaOf(session)(e) && e.properties.partID === thoughtID).map((e) => String(e.properties.delta)).join(""),
      `${String(final.text).length} characters`,
    );

    const mid = midParts.find((p) => p.id === thoughtID);
    ctx.check(
      "a read taken while the reply streams serves the thought final, and the reply still streaming",
      early.length === 4 &&
        mid?.streaming !== true &&
        typeof record(mid?.time).end === "number" &&
        mid?.text === final.text &&
        midParts.find((p) => p.id === textID)?.streaming === true,
      `thought ${JSON.stringify(mid ?? null).slice(0, 160)}; reply streaming: ${String(midParts.find((p) => p.id === textID)?.streaming)}`,
    );

    const stepEnd = finals.slice(1).filter(({ i }) => i > firstDelta);
    ctx.check(
      "the step's end publishes the thought final again, with the same text and time",
      stepEnd.length > 0 &&
        stepEnd.every(({ e }) => partOf(e).text === final.text && record(partOf(e).time).start === record(final.time).start && record(partOf(e).time).end === record(final.time).end),
      stepEnd.length === 0 ? "no later final" : JSON.stringify(partOf((stepEnd[0] as { e: Event }).e)).slice(0, 200),
    );
    const settled = list(record((await ctx.api("GET", `/session/${session}/message/${messageID}`)).json).parts).map(record);
    const after = settled.find((p) => p.id === thoughtID);
    ctx.check(
      "after the turn the message reads the same thought, and the reply final with time {start, end}",
      after?.text === final.text &&
        record(after?.time).end === record(final.time).end &&
        settled.find((p) => p.id === textID)?.streaming !== true &&
        typeof record(settled.find((p) => p.id === textID)?.time).end === "number",
      `parts: ${settled.map((p) => `${p.type}${JSON.stringify(p.time)}`).join(" ")}`,
    );
  },
};
