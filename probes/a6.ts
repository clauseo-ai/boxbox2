/* a6: asks behave like a contract. an unknown id is a 404; a settled ask
   is a 409 saying how and when it was settled and by whom; reject settles
   one ask only; aborting a turn rejects its pending asks with an event for
   each.

   the daemon raises a turn's asks one at a time: pi gates a response's
   tool calls in order, so the next ask is raised only when the one before
   it settles (cmx2's ASKS.md, a6 as landed). two asks pending together
   therefore come from two sessions, each running the bench's [bench:asks]
   turn (a permission for one.env, one for two.env, then two questions).
   the cascade the contract forbids was per session, and within a session
   only one ask is ever pending, so "reject settles one" is observed across
   the two sessions' pending permissions. */

import { type Context, type Event, nthAsk, type Probe, record } from "./probe";

const present = (value: unknown) => value !== undefined && value !== null && value !== "";

async function pendingIds(ctx: Context): Promise<unknown[]> {
  const permissions = (await ctx.api("GET", "/permission")).json;
  const questions = (await ctx.api("GET", "/question")).json;
  return [...(Array.isArray(permissions) ? permissions : []), ...(Array.isArray(questions) ? questions : [])].map((a) => record(a).id);
}

export const a6: Probe = {
  ask: "a6",
  title: "asks behave like a contract",
  async run(ctx: Context) {
    const unknown: [string, unknown][] = [
      ["/permission/per_probe_unknown/reply", { reply: "once" }],
      ["/question/que_probe_unknown/reply", { answers: [["hi"]] }],
      ["/question/que_probe_unknown/reject", undefined],
    ];
    for (const [path, body] of unknown) {
      const reply = await ctx.api("POST", path, body);
      ctx.check(
        `POST ${path.replace(/[a-z]+_probe_unknown/, ":unknown")} answers 404 NotFoundError`,
        reply.status === 404 && record(reply.json).name === "NotFoundError",
        `answered ${reply.status} ${reply.text.slice(0, 100)}`,
      );
    }

    const witness = await ctx.watch();
    const a = await ctx.session("asks a");
    const b = await ctx.session("asks b");
    const start = witness.events.length;
    await ctx.prompt(a, "[bench:asks] a6 asks a");
    await ctx.prompt(b, "[bench:asks] a6 asks b");
    const pa1 = await nthAsk(witness, start, a, "permission.asked", 1, "session a raises its first permission");
    const pb1 = await nthAsk(witness, start, b, "permission.asked", 1, "session b raises its first permission");

    const rejected = await ctx.api("POST", `/permission/${pa1}/reply`, { reply: "reject" });
    ctx.need("rejecting a pending permission answers 200", rejected.status === 200, `answered ${rejected.status} ${rejected.text}`);
    // the next ask session a raises shows the reject has been applied, and b's ask has had every chance to be swept with it
    const pa2 = await nthAsk(witness, start, a, "permission.asked", 2, "session a raises its next permission after the reject");
    const stillPending = (await pendingIds(ctx)).includes(pb1);
    const cascaded = witness.events.some((e) => e.type === "permission.replied" && e.properties.requestID === pb1);
    ctx.check(
      "reject settles only the ask it names",
      stillPending && !cascaded,
      cascaded ? "the other pending permission was rejected with it (the cascade)" : "the other pending permission is no longer listed",
    );

    const againPermission = await ctx.api("POST", `/permission/${pa1}/reply`, { reply: "once" });
    const permissionData = record(record(againPermission.json).data);
    ctx.check(
      "a reply to a settled permission answers 409 ConflictError",
      againPermission.status === 409 && record(againPermission.json).name === "ConflictError",
      `answered ${againPermission.status} ${againPermission.text.slice(0, 100)}`,
    );
    ctx.check(
      "its data says how, when and by whom: {reply, settledAt, by}",
      permissionData.reply === "reject" && typeof permissionData.settledAt === "number" && present(permissionData.by),
      `data: ${JSON.stringify(permissionData)}`,
    );

    const allowed = await ctx.api("POST", `/permission/${pa2}/reply`, { reply: "once" });
    ctx.need("allowing a pending permission answers 200", allowed.status === 200, `answered ${allowed.status} ${allowed.text}`);
    const qa1 = await nthAsk(witness, start, a, "question.asked", 1, "session a asks its first question");

    const answered = await ctx.api("POST", `/question/${qa1}/reply`, { answers: [["hi"]] });
    ctx.need("answering a pending question answers 200", answered.status === 200, `answered ${answered.status} ${answered.text}`);
    const againQuestion = await ctx.api("POST", `/question/${qa1}/reply`, { answers: [["hello"]] });
    const questionData = record(record(againQuestion.json).data);
    ctx.check(
      "a reply to a settled question answers 409 ConflictError",
      againQuestion.status === 409 && record(againQuestion.json).name === "ConflictError",
      `answered ${againQuestion.status} ${againQuestion.text.slice(0, 100)}`,
    );
    ctx.check(
      "its data carries the first answers, settledAt and by",
      JSON.stringify(questionData.answers) === JSON.stringify([["hi"]]) && typeof questionData.settledAt === "number" && present(questionData.by),
      `data: ${JSON.stringify(questionData)}`,
    );
    const rejectSettled = await ctx.api("POST", `/question/${qa1}/reject`);
    ctx.check("rejecting a settled question answers 409 too", rejectSettled.status === 409, `answered ${rejectSettled.status} ${rejectSettled.text.slice(0, 100)}`);

    // session a now waits on its second question, session b still on its first permission
    const qa2 = await nthAsk(witness, start, a, "question.asked", 2, "session a asks its second question");
    const permissionRejected = witness.wait(
      (e) => e.type === "permission.replied" && e.properties.requestID === pb1 && e.properties.reply === "reject",
      "permission.replied reject",
      { timeoutMs: 5000 },
    );
    const questionRejected = witness.wait((e) => e.type === "question.rejected" && e.properties.requestID === qa2, "question.rejected", { timeoutMs: 5000 });
    const outcome = (p: Promise<Event>) => p.then(() => true).catch(() => false);
    for (const session of [a, b]) {
      const abort = await ctx.api("POST", `/session/${session}/abort`);
      ctx.need("POST /session/:id/abort answers 200", abort.status === 200, `answered ${abort.status}`);
    }
    const [permissionEvent, questionEvent] = await Promise.all([outcome(permissionRejected), outcome(questionRejected)]);
    ctx.check("aborting a turn rejects its pending permission with permission.replied", permissionEvent, `no permission.replied reject for ${pb1} within 5 s`);
    ctx.check("and its pending question with question.rejected", questionEvent, `no question.rejected for ${qa2} within 5 s`);
    const listed = await pendingIds(ctx);
    ctx.check("neither is listed as pending afterwards", !listed.includes(pb1) && !listed.includes(qa2), `still pending: ${listed.join(", ")}`);
  },
};
