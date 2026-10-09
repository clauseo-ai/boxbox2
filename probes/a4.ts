/* a4: client ids. every send and every ask reply takes an optional
   clientID: the first request acts, a repeat returns the first result and
   does nothing, and every event the action causes echoes the clientID. each
   route is sent twice with one fresh uuid. */

import { type Context, deltaOf, type Event, idleOf, nthAsk, type Probe, type Reply, type Stream } from "./probe";
import { findValue } from "./wire";

/** the same status and, byte for byte, the same json text. a blocking send (/message, /command,
    /shell) writes a space before its body so the connection survives a long turn; that padding is
    json-insignificant whitespace and not part of the result, so it is trimmed from both sides */
function sameResult(first: Reply, repeat: Reply): boolean {
  return first.status === repeat.status && first.text.trim() === repeat.text.trim();
}

const shown = (r: Reply) => `${r.status} ${r.text.slice(0, 100)}`;

/** how many messages in the session's transcript contain `needle` */
async function occurrences(ctx: Context, session: string, needle: string): Promise<number> {
  return (await ctx.messages(session)).filter((m) => JSON.stringify(m).includes(needle)).length;
}

async function sendTwice(ctx: Context, route: string, path: string, body: Record<string, unknown>) {
  const clientID = crypto.randomUUID();
  const first = await ctx.api("POST", path, { ...body, clientID });
  const repeat = await ctx.api("POST", path, { ...body, clientID });
  ctx.check(`${route}: a repeat with the same clientID returns the first result`, sameResult(first, repeat), `first ${shown(first)}; repeat ${shown(repeat)}`);
  return { clientID, first };
}

async function echoed(ctx: Context, stream: Stream, from: number, route: string, clientID: string, caused: string) {
  const hit = await stream
    .waitFrom(from, (e: Event) => findValue(e.properties, clientID) !== undefined, `${route} echo`, { timeoutMs: 3000 })
    .catch(() => undefined);
  ctx.check(`${route}: the clientID is echoed on ${caused}`, hit !== undefined, `no event after the send carried ${clientID}`);
}

async function once(ctx: Context, session: string, route: string, needle: string) {
  const n = await occurrences(ctx, session, needle);
  ctx.check(`${route}: the repeat did nothing, the transcript holds it once`, n === 1, `${n} messages contain "${needle}"`);
}

export const a4: Probe = {
  ask: "a4",
  title: "client ids",
  async run(ctx: Context) {
    const witness = await ctx.watch();

    for (const route of ["prompt", "prompt_async"]) {
      const session = await ctx.session(route);
      const text = `[bench:words 3 5] a4 ${route} ${crypto.randomUUID()}`;
      const from = witness.events.length;
      const idle = witness.wait(idleOf(session), `the ${route} turn ends`, { timeoutMs: 20_000, kind: "setup" });
      const { clientID } = await sendTwice(ctx, `/${route}`, `/session/${session}/${route}`, { text });
      await idle;
      await echoed(ctx, witness, from, `/${route}`, clientID, "the user message's message.updated");
      await once(ctx, session, `/${route}`, text);
    }

    {
      const session = await ctx.session("message");
      const text = `[bench:words 3 5] a4 message ${crypto.randomUUID()}`;
      const from = witness.events.length;
      const { clientID } = await sendTwice(ctx, "/message", `/session/${session}/message`, { text });
      await echoed(ctx, witness, from, "/message", clientID, "the user message's message.updated");
      await once(ctx, session, "/message", text);
    }

    {
      const session = await ctx.session("queue and steer");
      const busy = witness.wait(deltaOf(session), "the busy turn streams", { kind: "setup" });
      const idle = witness.wait(idleOf(session), "the busy turn and its queue end", { timeoutMs: 30_000, kind: "setup" });
      await ctx.prompt(session, "[bench:words 80 20] a4 busy");
      await busy;
      const queued = `[bench:words 3 5] a4 queued ${crypto.randomUUID()}`;
      const steered = `a4 steered ${crypto.randomUUID()}`;
      const queueFrom = witness.events.length;
      const queue = await sendTwice(ctx, "/queue", `/session/${session}/queue`, { text: queued });
      await echoed(ctx, witness, queueFrom, "/queue", queue.clientID, "message.updated or session.queued");
      const steerFrom = witness.events.length;
      const steer = await sendTwice(ctx, "/steer", `/session/${session}/steer`, { text: steered });
      await echoed(ctx, witness, steerFrom, "/steer", steer.clientID, "session.steered");
      await idle;
      await once(ctx, session, "/queue", queued);
      await once(ctx, session, "/steer", steered);
    }

    {
      const session = await ctx.session("command");
      const from = witness.events.length;
      const { clientID } = await sendTwice(ctx, "/command", `/session/${session}/command`, { command: "probe" });
      await echoed(ctx, witness, from, "/command", clientID, "the prompt's message.updated");
      await once(ctx, session, "/command", "the probe command ran");
    }

    {
      const session = await ctx.session("shell");
      const command = `echo a4-${crypto.randomUUID()}`;
      const clientID = crypto.randomUUID();
      const from = witness.events.length;
      const first = await ctx.api("POST", `/session/${session}/shell`, { command, clientID });
      const after = await occurrences(ctx, session, command);
      const repeat = await ctx.api("POST", `/session/${session}/shell`, { command, clientID });
      ctx.check("/shell: a repeat with the same clientID returns the first result", sameResult(first, repeat), `first ${shown(first)}; repeat ${shown(repeat)}`);
      const again = await occurrences(ctx, session, command);
      ctx.check("/shell: the repeat did nothing to the transcript", after > 0 && again === after, `${after} messages held the command after the first, ${again} after the repeat`);
      await echoed(ctx, witness, from, "/shell", clientID, "the events the command caused");
    }

    {
      const session = await ctx.session("replies");
      // the turn raises its asks in order, each after the one before settles: two permissions, then two questions
      const start = witness.events.length;
      await ctx.prompt(session, "[bench:asks] a4 replies");
      const permission = await nthAsk(witness, start, session, "permission.asked", 1, "the turn raises its first permission");
      const permFrom = witness.events.length;
      const perm = await sendTwice(ctx, "permission reply", `/permission/${permission}/reply`, { reply: "once" });
      await echoed(ctx, witness, permFrom, "permission reply", perm.clientID, "permission.replied");
      const second = await nthAsk(witness, start, session, "permission.asked", 2, "the turn raises its second permission");
      await ctx.api("POST", `/permission/${second}/reply`, { reply: "once" });
      const question = await nthAsk(witness, start, session, "question.asked", 1, "the turn asks its first question");
      const questionFrom = witness.events.length;
      const answer = await sendTwice(ctx, "question reply", `/question/${question}/reply`, { answers: [["hi"]] });
      await echoed(ctx, witness, questionFrom, "question reply", answer.clientID, "question.replied");
      const replied = witness.events.filter(
        (e) => (e.type === "permission.replied" || e.type === "question.replied") && [permission, question].includes(String(e.properties.requestID)),
      );
      ctx.check("ask replies: the repeats settled nothing twice", replied.length === 2, `${replied.length} replied events for the two asks`);
      await ctx.api("POST", `/session/${session}/abort`);
    }
  },
};
