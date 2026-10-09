/* a1: durable event sequence and resume.

   a witness stream stays open from the start and records every frame; each
   resume is judged against it byte for byte. the order follows the ask:
   the id on frames, resume by Last-Event-ID, by ?after= and on /event, the
   same sequence after a sigkill and restart, stream.reset for a bad
   cursor, the delta offset, and a streaming part resent whole. */

import { type Context, type Event, forSession, idleOf, type Probe, record, type Stream, sequenced, textOf } from "./probe";
import { type Cursor, parseCursor } from "./wire";

const cursorOf = (e: Event): Cursor | undefined => parseCursor(e.frame.id);
const seqOf = (e: Event | undefined): number => (e ? (cursorOf(e)?.seq ?? -1) : -1);

/** the epoch and seq the body carries; the ask says "the same fields in the body" and not where, so
    the top of the frame and the payload both count */
function bodyCursor(e: Event): { epoch: unknown; seq: unknown } {
  const top = record(e.body);
  const payload = record(top.payload);
  return "seq" in top ? { epoch: top.epoch, seq: top.seq } : { epoch: payload.epoch, seq: payload.seq };
}

const describe = (e: Event | undefined) => (e ? `${e.frame.id ?? "(no id)"} ${e.type}` : "nothing");

/** the first place two event sequences differ, byte for byte, or undefined when they are the same */
function firstDifference(want: Event[], got: Event[]): string | undefined {
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    const w = want[i];
    const g = got[i];
    if (!w) return `an extra event after the ${want.length} expected: ${describe(g)}`;
    if (!g) return `the replay stopped after ${i} of ${want.length}; next expected ${describe(w)}`;
    if (w.frame.raw !== g.frame.raw) {
      return w.frame.id === g.frame.id
        ? `event ${i + 1} of ${want.length} (${describe(w)}) arrived with different bytes`
        : `event ${i + 1} of ${want.length}: expected ${describe(w)}, got ${describe(g)}`;
    }
  }
  return undefined;
}

const titled = (session: string, title: string) => (e: Event) =>
  e.type === "session.updated" && forSession(session)(e) && record(e.properties.info).title === title;

async function retitle(ctx: Context, stream: Stream, session: string, title: string) {
  const seen = stream.wait(titled(session, title), `session.updated for "${title}"`, { kind: "setup" });
  const reply = await ctx.api("PATCH", `/session/${session}`, { title });
  ctx.need("PATCH /session/:id renames it", reply.status === 200, `answered ${reply.status}`);
  await seen;
}

/** opens a resumed stream and reads as many sequenced events as the witness holds after the cursor */
async function resume(ctx: Context, witness: Stream, after: Event, path: string, headers: Record<string, string>) {
  const want = witness.events.filter((e) => sequenced(e) && seqOf(e) > seqOf(after));
  const stream = await ctx.watch(path, headers);
  const got = await stream.collect(0, sequenced, want.length, `the replay on ${stream.label}`, { timeoutMs: 5000 }).catch(() => stream.events.filter(sequenced));
  return { stream, want, got };
}

export const a1: Probe = {
  ask: "a1",
  title: "durable event sequence and resume",
  async run(ctx: Context) {
    let witness = await ctx.watch();
    const connected = await witness.waitFrom(0, (e) => e.type === "server.connected", "server.connected opens the stream", { kind: "setup" });
    const created = witness.wait((e) => e.type === "session.created", "session.created", { kind: "setup" });
    const session = await ctx.session("resume");
    const directory = String(record((await created).properties.info).directory);
    await retitle(ctx, witness, session, "a1 one");
    await retitle(ctx, witness, session, "a1 two");

    // the id on frames
    ctx.check("server.connected carries no seq", connected.frame.id === undefined, `it arrived with id: ${connected.frame.id}`);
    const early = witness.events.filter(sequenced);
    const bare = early.find((e) => !cursorOf(e));
    ctx.check(
      "every state-changing frame carries id: <epoch>:<seq>",
      bare === undefined,
      bare?.frame.id === undefined ? `${bare?.type} arrived with no id: line` : `${bare.type} arrived with id: ${bare.frame.id}`,
    );
    const mismatch = early.find((e) => {
      const c = cursorOf(e);
      const b = bodyCursor(e);
      return b.epoch !== c?.epoch || b.seq !== c?.seq;
    });
    ctx.check(
      "the body carries the same epoch and seq as the id: line",
      mismatch === undefined,
      `${describe(mismatch)} has body {epoch: ${JSON.stringify(mismatch && bodyCursor(mismatch).epoch)}, seq: ${JSON.stringify(mismatch && bodyCursor(mismatch).seq)}}`,
    );
    const backwards = early.findIndex((e, i) => i > 0 && (seqOf(e) <= seqOf(early[i - 1]) || cursorOf(e)?.epoch !== cursorOf(early[0] as Event)?.epoch));
    ctx.check("seq strictly increases within one epoch", backwards < 0, `${describe(early[backwards - 1])} then ${describe(early[backwards])}`);
    const epoch = (cursorOf(early[0] as Event) as Cursor).epoch;

    // resume by Last-Event-ID, while events happened with nobody listening
    const cursor = early[1] as Event;
    const cursorId = cursor.frame.id as string;
    for (const n of [1, 2, 3]) await retitle(ctx, witness, session, `a1 gap ${n}`);
    const byHeader = await resume(ctx, witness, cursor, "/global/event", { "last-event-id": cursorId });
    ctx.check(
      "after Last-Event-ID the first event is the one after the cursor",
      byHeader.got[0]?.frame.raw === byHeader.want[0]?.frame.raw,
      `expected ${describe(byHeader.want[0])}, got ${describe(byHeader.got[0])}`,
    );
    const headerDiff = firstDifference(byHeader.want, byHeader.got);
    ctx.check("Last-Event-ID replays every event after the cursor, in order, byte for byte", headerDiff === undefined, headerDiff ?? "");
    await retitle(ctx, witness, session, "a1 live");
    await byHeader.stream.waitFrom(0, titled(session, "a1 live"), "the live event on the resumed stream", { timeoutMs: 3000 });
    const seam = firstDifference(
      witness.events.filter((e) => sequenced(e) && seqOf(e) > seqOf(cursor)),
      byHeader.stream.events.filter(sequenced),
    );
    ctx.check("the replay goes live with no gap and no duplicate at the seam", seam === undefined, seam ?? "");

    // resume by ?after= and on the scoped /event
    const byQuery = await resume(ctx, witness, cursor, `/global/event?after=${encodeURIComponent(cursorId)}`, {});
    const queryDiff = firstDifference(byQuery.want, byQuery.got);
    ctx.check("?after= replays the same events as Last-Event-ID", queryDiff === undefined, queryDiff ?? "");
    const scopedWant = witness.events.filter((e) => sequenced(e) && seqOf(e) > seqOf(cursor) && record(e.body).directory === directory);
    const scoped = await ctx.watch(`/event?directory=${encodeURIComponent(directory)}`, { "last-event-id": cursorId });
    const scopedGot = await scoped
      .collect(0, sequenced, scopedWant.length, "the replay on /event", { timeoutMs: 5000 })
      .catch(() => scoped.events.filter(sequenced));
    const scopedIds = (events: Event[]) => events.map((e) => `${e.frame.id} ${e.type}`).join(", ");
    ctx.check(
      "/event honours Last-Event-ID with the same ids for its directory",
      scopedIds(scopedGot) === scopedIds(scopedWant),
      `expected [${scopedIds(scopedWant)}], got [${scopedIds(scopedGot)}]`,
    );

    // the same sequence after a sigkill and a restart
    const before = witness.events.filter((e) => sequenced(e) && cursorOf(e));
    const first = before[0] as Event;
    const top = seqOf(before.at(-1));
    const oldPid = ctx.bench.pid;
    await ctx.bench.kill9AndRestart();
    ctx.note(`daemon pid ${oldPid} killed with sigkill; restarted as pid ${ctx.bench.pid} on the same data dir`);
    ctx.close();
    const restarted = await resume(ctx, witness, first, "/global/event", { "last-event-id": first.frame.id as string });
    const restartDiff = firstDifference(restarted.want, restarted.got);
    ctx.check(
      `the ${restarted.want.length} events after the cursor replay byte-identical after a sigkill and restart`,
      restartDiff === undefined,
      restartDiff ?? "",
    );
    witness = restarted.stream;
    await retitle(ctx, witness, session, "a1 restarted");
    const next = witness.events.find(titled(session, "a1 restarted"));
    ctx.check(
      "seq keeps rising past the restart in the same epoch",
      next !== undefined && cursorOf(next)?.epoch === epoch && seqOf(next) > top,
      `the first event after the restart has id: ${next?.frame.id}; before it the epoch was ${epoch} and the last seq ${top}`,
    );

    // stream.reset for a cursor the daemon cannot resume from
    const highest = seqOf(witness.events.filter(sequenced).at(-1));
    const resets: [string, string, string][] = [
      ["a cursor from another epoch", `${epoch}x:1`, "epoch"],
      ["a cursor from the future", `${epoch}:${highest + 1_000_000}`, "invalid"],
      ["a cursor that is not one", "not-a-cursor", "invalid"],
    ];
    for (const [label, id, reason] of resets) {
      const stream = await ctx.watch("/global/event", { "last-event-id": id });
      const firstFrame = await stream.waitFrom(0, () => true, `the first frame for ${label}`, { timeoutMs: 3000 });
      const props = firstFrame.properties;
      ctx.check(
        `${label} gets stream.reset {reason: "${reason}", seq} as the first frame`,
        firstFrame.type === "stream.reset" && props.reason === reason && Number.isSafeInteger(props.seq),
        `the first frame was ${firstFrame.type} ${JSON.stringify(props).slice(0, 120)}`,
      );
      stream.close();
    }
    ctx.note('reason "expired" is not probed: it needs a cursor older than 30 minutes and 50,000 events');

    // the delta offset, in utf-16 units: the glyphs make units, code points and bytes disagree
    const glyphsFrom = witness.events.length;
    await ctx.turn(witness, session, "[bench:glyphs 40 5] a1 offsets");
    const deltas = witness.events.slice(glyphsFrom).filter((e) => e.type === "message.part.delta" && forSession(session)(e));
    ctx.need("the glyph reply streamed 40 deltas", deltas.length >= 40, `${deltas.length} deltas`);
    const unmarked = deltas.find((d) => typeof d.properties.offset !== "number");
    ctx.check("message.part.delta carries offset", unmarked === undefined, `a delta for part ${String(unmarked?.properties.partID)} has no offset`);
    const sums = new Map<string, number>();
    let wrong: string | undefined;
    for (const [i, d] of deltas.entries()) {
      const part = String(d.properties.partID);
      const want = sums.get(part) ?? 0;
      if (d.properties.offset !== want && wrong === undefined) {
        wrong = `delta ${i + 1} (${JSON.stringify(d.properties.delta)}) has offset ${String(d.properties.offset)}; ${want} utf-16 units came before it`;
      }
      sums.set(part, want + String(d.properties.delta).length);
    }
    ctx.check("offset counts the utf-16 units of the part's text before the delta", wrong === undefined, wrong ?? "");

    // a part streaming at the resume point is resent whole, then live deltas continue from it
    const idle = witness.wait(idleOf(session), "the resend turn ends", { timeoutMs: 30_000, kind: "setup" });
    const reader = await ctx.watch();
    const isDelta = (e: Event) => e.type === "message.part.delta" && forSession(session)(e);
    await ctx.prompt(session, "[bench:words 150 20] a1 resend");
    const seen = await reader.collect(0, isDelta, 15, "15 deltas reach the reader", { kind: "setup" });
    reader.close();
    const partID = String(seen[0]?.properties.partID);
    const seenText = reader.events
      .filter((e) => isDelta(e) && e.properties.partID === partID)
      .map((e) => String(e.properties.delta))
      .join("");
    const dropped = [...reader.events].reverse().find((e) => sequenced(e) && cursorOf(e)) as Event;
    await Bun.sleep(300);
    const resumed = await ctx.watch("/global/event", { "last-event-id": dropped.frame.id as string });
    const ofPart = (e: Event) =>
      (e.type === "message.part.updated" && record(e.properties.part).id === partID) || (isDelta(e) && e.properties.partID === partID);
    const firstForPart = await resumed.waitFrom(0, ofPart, "the streaming part on the resumed stream", { timeoutMs: 5000 });
    ctx.check(
      "a part streaming at the resume point comes back as message.part.updated before any delta",
      firstForPart.type === "message.part.updated",
      `the first frame for part ${partID} after resuming was ${firstForPart.type}`,
    );
    const whole = String(record(firstForPart.properties.part).text ?? "");
    ctx.check(
      "it carries the part's full text so far",
      whole.startsWith(seenText) && whole.length > seenText.length,
      `${whole.length} characters; the reader had seen ${seenText.length} before it dropped`,
    );
    await idle;
    const at = resumed.events.indexOf(firstForPart);
    const nextDelta = resumed.events.findIndex((e, i) => i > at && isDelta(e) && e.properties.partID === partID);
    const resends = resumed.events
      .slice(0, nextDelta < 0 ? undefined : nextDelta)
      .filter((e) => e.type === "message.part.updated" && record(e.properties.part).id === partID).length;
    ctx.check("it is sent once", resends === 1, `${resends} message.part.updated for the part before live deltas resumed`);
    const rebuilt =
      whole +
      resumed.events
        .slice(at + 1)
        .filter((e) => isDelta(e) && e.properties.partID === partID)
        .map((e) => String(e.properties.delta))
        .join("");
    const finished = textOf((await ctx.messages(session)).find((m) => JSON.stringify(m).includes(partID)));
    ctx.check(
      "live deltas continue from it: its text plus the deltas after it is the finished part",
      rebuilt === finished,
      `rebuilt ${rebuilt.length} characters, the finished part has ${finished.length}`,
    );
  },
};
