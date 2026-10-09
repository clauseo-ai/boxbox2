/* a23: thinking streams, and every streamed part is announced. over a
   `[bench:think N MS]` turn (two steps that think, then the second answers):
   each text and reasoning part is announced by a logged message.part.updated
   (empty text, streaming true, time.start) before its first delta; reasoning
   streams by message.part.delta exactly as text does, in contiguous utf-16
   offsets; the final parts carry time {start, end} with the start as
   announced; and a read taken while the model is still thinking returns the
   reasoning part typed, with its text so far. */

import { type Context, deltaOf, type Event, idleOf, list, type Probe, record, sequenced } from "./probe";

type Streamed = { id: string; type: string; announced: number | undefined; deltas: Event[]; final: Event | undefined };

const partOf = (e: Event) => record(e.properties.part);

/** the text and reasoning parts the session streamed, in the order they were announced or first spoke */
function streamedParts(events: Event[], session: string): Streamed[] {
  const parts = new Map<string, Streamed>();
  events.forEach((e, index) => {
    if (e.properties.sessionID !== session) return;
    if (e.type === "message.part.updated") {
      const part = partOf(e);
      const type = String(part.type);
      if (type !== "text" && type !== "reasoning") return;
      const id = String(part.id);
      const held = parts.get(id) ?? { id, type, announced: undefined, deltas: [], final: undefined };
      if (part.streaming === true && held.announced === undefined) held.announced = index;
      held.final = e;
      parts.set(id, held);
    } else if (e.type === "message.part.delta") {
      const id = String(e.properties.partID);
      const held = parts.get(id) ?? { id, type: "unannounced", announced: undefined, deltas: [], final: undefined };
      held.deltas.push(e);
      parts.set(id, held);
    }
  });
  return [...parts.values()].filter((p) => p.deltas.length > 0);
}

export const a23: Probe = {
  ask: "a23",
  title: "thinking streams; every streamed part is announced",
  async run(ctx: Context) {
    const witness = await ctx.watch();
    const session = await ctx.session("thinking");
    const from = witness.events.length;
    const idle = witness.wait(idleOf(session), "the thinking turn ends", { timeoutMs: 40_000, kind: "setup" });
    await ctx.prompt(session, "[bench:think 24 100] a23 thinking");

    // mid-thinking: the first reasoning part is announced and has spoken, and the model is still going
    const announce = await witness.waitFrom(
      from,
      (e) => e.type === "message.part.updated" && e.properties.sessionID === session && partOf(e).type === "reasoning",
      "the first reasoning part is announced",
      { timeoutMs: 20_000, kind: "setup" },
    );
    const thinkingID = String(partOf(announce).id);
    const messageID = String(partOf(announce).messageID);
    const early = await witness.collect(
      from,
      (e) => deltaOf(session)(e) && e.properties.partID === thinkingID,
      6,
      "six reasoning deltas",
      { kind: "setup" },
    );
    const spoken = early.map((e) => String(e.properties.delta)).join("");
    const read = await ctx.api("GET", `/session/${session}/message/${messageID}`);
    const inflight = list(record(read.json).parts)
      .map(record)
      .find((p) => p.id === thinkingID);
    ctx.check(
      "a read mid-thinking returns the reasoning part, typed, marked streaming, with time.start",
      read.status === 200 &&
        inflight?.type === "reasoning" &&
        inflight.streaming === true &&
        typeof record(inflight.time).start === "number",
      `answered ${read.status}: ${JSON.stringify(inflight ?? read.json).slice(0, 200)}`,
    );
    ctx.check(
      "its text so far holds what had streamed before the read",
      typeof inflight?.text === "string" && inflight.text.startsWith(spoken),
      `${String(inflight?.text ?? "").length} characters; ${spoken.length} had streamed`,
    );
    const listing = await ctx.api("GET", `/session/${session}/message`);
    const listed = list(listing.json)
      .map(record)
      .find((m) => record(m.info).id === messageID);
    ctx.check(
      "the listing carries the same reasoning part in the in-flight message",
      list(listed?.parts)
        .map(record)
        .some((p) => p.id === thinkingID && p.type === "reasoning"),
      `listing answered ${listing.status}`,
    );

    await idle;
    const parts = streamedParts(witness.events.slice(from), session);
    const types = parts.map((p) => p.type);
    ctx.check(
      "reasoning and text parts both stream: two thinking steps and one answer",
      types.filter((t) => t === "reasoning").length === 2 && types.filter((t) => t === "text").length === 1,
      `streamed parts: ${types.join(", ")}`,
    );

    const events = witness.events.slice(from);
    for (const part of parts) {
      const firstDelta = events.indexOf(part.deltas[0] as Event);
      const announced = part.announced === undefined ? undefined : events[part.announced];
      const label = `${part.type} part ${part.id.slice(-9)}`;
      ctx.check(
        `${label} is announced before its first delta, empty and streaming, with time.start`,
        part.announced !== undefined &&
          part.announced < firstDelta &&
          partOf(announced as Event).text === "" &&
          partOf(announced as Event).streaming === true &&
          typeof record(partOf(announced as Event).time).start === "number",
        part.announced === undefined ? "no announcement" : JSON.stringify(partOf(announced as Event)).slice(0, 200),
      );
      ctx.check(
        `${label}'s announcement is a logged event: it carries a seq`,
        announced !== undefined && sequenced(announced) && announced.frame.id !== undefined,
        `frame id ${String(announced?.frame.id)}`,
      );
      let expected = 0;
      let contiguous = true;
      for (const delta of part.deltas) {
        if (delta.properties.field !== "text" || delta.properties.offset !== expected) contiguous = false;
        expected += String(delta.properties.delta).length;
      }
      ctx.check(`${label} streams by deltas on field text at contiguous utf-16 offsets from 0`, contiguous, `${part.deltas.length} deltas, ${expected} units`);
      const final = partOf(part.final as Event);
      const time = record(final.time);
      ctx.check(
        `${label} ends with a whole part: its text is what streamed, time {start, end}, start as announced`,
        final.streaming !== true &&
          final.text === part.deltas.map((d) => String(d.properties.delta)).join("") &&
          time.start === record(partOf(announced as Event).time).start &&
          typeof time.end === "number" &&
          time.end >= Number(time.start),
        JSON.stringify(final).slice(0, 220),
      );
    }

    const answer = parts.find((p) => p.type === "text") as Streamed;
    const answerMessage = String(partOf(answer.final as Event).messageID);
    const thought = parts.find((p) => p.type === "reasoning" && partOf(p.final as Event).messageID === answerMessage) as Streamed;
    ctx.check(
      "in the answer's message the reasoning is announced before the text, as it is in content order",
      thought !== undefined && (thought.announced ?? Infinity) < (answer.announced ?? -1),
      `thought announced at ${thought?.announced}, text at ${answer.announced}`,
    );
    const after = await ctx.api("GET", `/session/${session}/message/${answerMessage}`);
    const finished = list(record(after.json).parts).map(record);
    ctx.check(
      "after the turn the message reads reasoning then text, each with time {start, end}",
      finished.map((p) => p.type).join(",") === "reasoning,text" &&
        finished.every((p) => typeof record(p.time).end === "number" && p.streaming !== true),
      `parts: ${finished.map((p) => `${p.type}${JSON.stringify(p.time)}`).join(" ")}`,
    );
  },
};
