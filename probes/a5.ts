/* a5: the streaming message is readable. mid-answer, the listing holds the
   in-flight assistant message with its partial text marked streaming, and
   one message is fetchable by id, during the stream and after it. */

import { type Context, deltaOf, type Probe, record, textOf } from "./probe";
import { parseCursor } from "./wire";

export const a5: Probe = {
  ask: "a5",
  title: "streaming message readable",
  async run(ctx: Context) {
    const witness = await ctx.watch();
    const session = await ctx.session("streaming");
    const from = witness.events.length;
    const idle = witness.wait((e) => e.type === "session.idle" && e.properties.sessionID === session, "the streaming turn ends", {
      timeoutMs: 30_000,
      kind: "setup",
    });
    await ctx.prompt(session, "[bench:words 150 20] a5 streaming");
    const early = await witness.collect(from, deltaOf(session), 20, "20 deltas", { kind: "setup" });
    const messageID = String(early[0]?.properties.messageID);
    const partID = String(early[0]?.properties.partID);
    const streamed = witness.events
      .slice(from)
      .filter((e) => deltaOf(session)(e) && e.properties.partID === partID)
      .map((e) => String(e.properties.delta))
      .join("");

    const listing = await ctx.api("GET", `/session/${session}/message`);
    const messages = Array.isArray(listing.json) ? listing.json : [];
    const inflight = messages.find((m) => record(record(m).info).id === messageID);
    ctx.check("GET /session/:id/message lists the in-flight assistant message", inflight !== undefined, `no message ${messageID} among the ${messages.length} listed`);
    const part = record(record(inflight).parts && (record(inflight).parts as unknown[]).map(record).find((p) => p.id === partID));
    ctx.check(
      "its text part is there, marked streaming: true",
      part.id === partID && part.streaming === true,
      part.id === partID ? `the part has streaming: ${JSON.stringify(part.streaming)}` : `no part ${partID} in the message`,
    );
    const partial = String(part.text ?? "");
    ctx.check("its partial text holds what had streamed before the read", partial.startsWith(streamed), `${partial.length} characters; ${streamed.length} had streamed`);
    ctx.check(
      "the listing carries x-cmx2-seq, so the deltas after it can be applied (a2)",
      parseCursor(listing.headers.get("x-cmx2-seq") ?? undefined) !== undefined,
      `x-cmx2-seq: ${listing.headers.get("x-cmx2-seq")}`,
    );

    const midway = await ctx.api("GET", `/session/${session}/message/${messageID}`);
    ctx.check(
      "GET /session/:id/message/:messageID answers one {info, parts} mid-stream",
      midway.status === 200 && record(record(midway.json).info).id === messageID && Array.isArray(record(midway.json).parts),
      `answered ${midway.status} ${midway.text.slice(0, 120)}`,
    );

    await idle;
    const after = await ctx.messages(session);
    const finished = after.find((m) => record(record(m).info).id === messageID);
    ctx.check("the partial text was a prefix of the finished text", textOf(finished).startsWith(partial), `finished text: ${textOf(finished).slice(0, 80)}`);
    const one = await ctx.api("GET", `/session/${session}/message/${messageID}`);
    ctx.check(
      "after the turn, one message by id equals its entry in the listing",
      one.status === 200 && JSON.stringify(one.json) === JSON.stringify(finished),
      `answered ${one.status} ${one.text.slice(0, 120)}`,
    );
    const unknown = await ctx.api("GET", `/session/${session}/message/msg_probe_unknown`);
    ctx.check(
      "an unknown message id answers 404 NotFoundError",
      unknown.status === 404 && record(unknown.json).name === "NotFoundError",
      `answered ${unknown.status} ${unknown.text.slice(0, 120)}`,
    );
  },
};
