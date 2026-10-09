/* a11: ids from every send. /queue and /prompt_async answer {messageID}
   and publish the provisional message.updated {queued: true} that /prompt
   already does; an idle prompt_async's id is the message that runs. */

import { type Context, deltaOf, type Event, idleOf, type Probe, record, type Stream } from "./probe";

const queuedWith = (id: string) => (e: Event) => {
  const info = record(e.properties.info);
  return e.type === "message.updated" && info.id === id && (info.queued === true || e.properties.queued === true);
};

async function sendsAnId(ctx: Context, witness: Stream, session: string, route: string, text: string) {
  const from = witness.events.length;
  const reply = await ctx.api("POST", `/session/${session}/${route}`, { text });
  const id = record(reply.json).messageID;
  ctx.check(`POST /session/:id/${route} on a busy session answers {messageID}`, typeof id === "string", `answered ${reply.status} ${reply.text.slice(0, 100)}`);
  const published = await witness
    .waitFrom(from, queuedWith(id), `message.updated {queued: true} for ${id}`, { timeoutMs: 3000 })
    .then(() => true)
    .catch(() => false);
  ctx.check(`and publishes message.updated {queued: true} for that id`, published, `no message.updated {queued: true} with id ${id} within 3 s`);
}

export const a11: Probe = {
  ask: "a11",
  title: "ids from every send",
  async run(ctx: Context) {
    const witness = await ctx.watch();
    const busy = await ctx.session("busy");
    const streaming = witness.wait(deltaOf(busy), "the busy turn streams", { kind: "setup" });
    await ctx.prompt(busy, "[bench:words 100 20] a11 busy");
    await streaming;
    await sendsAnId(ctx, witness, busy, "queue", "[bench:words 3 5] a11 queued");
    await sendsAnId(ctx, witness, busy, "prompt_async", "[bench:words 3 5] a11 queued async");
    await ctx.api("POST", `/session/${busy}/abort`);

    const idle = await ctx.session("idle");
    const done = witness.wait(idleOf(idle), "the idle prompt_async turn ends", { timeoutMs: 20_000, kind: "setup" });
    const reply = await ctx.api("POST", `/session/${idle}/prompt_async`, { text: "[bench:words 3 5] a11 started async" });
    const id = record(reply.json).messageID;
    ctx.check("POST /session/:id/prompt_async on an idle session answers {messageID}", typeof id === "string", `answered ${reply.status} ${reply.text.slice(0, 100)}`);
    await done;
    const messages = await ctx.messages(idle);
    ctx.check(
      "that id is the user message the turn ran",
      messages.some((m) => record(record(m).info).id === id && record(record(m).info).role === "user"),
      `no user message ${id} in the transcript`,
    );
  },
};
