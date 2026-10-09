/* a9: progress for running tools. the bench's [bench:slow] turn runs a
   shell command that prints a 900 byte line a second for 6 seconds; while
   it runs the daemon sends throttled message.part.updated for the tool
   part (at most one a second) carrying the last 2 kb of output. */

import { type Context, type Event, forSession, type Probe, record } from "./probe";

/** timers are not exact; one update a second may arrive a little early */
const THROTTLE_SLACK_MS = 100;
const TAIL_BYTES = 2048;

/** the running output: the ask does not name the field, so both places opencode-shaped parts use count */
function outputOf(e: Event): string | undefined {
  const state = record(record(e.properties.part).state);
  const output = state.output ?? record(state.metadata).output;
  return typeof output === "string" && output.length > 0 ? output : undefined;
}

export const a9: Probe = {
  ask: "a9",
  title: "progress for running tools",
  async run(ctx: Context) {
    const witness = await ctx.watch();
    const session = await ctx.session("progress");
    const from = witness.events.length;
    await ctx.turn(witness, session, "[bench:slow] a9 progress", 30_000);
    const shell = witness.events
      .slice(from)
      .filter((e) => e.type === "message.part.updated" && forSession(session)(e) && record(e.properties.part).tool === "shell");
    ctx.need("the shell tool ran", shell.length > 0, "no message.part.updated for a shell part");
    const running = shell.filter((e) => record(record(e.properties.part).state).status === "running");
    const progress = running.filter((e) => outputOf(e) !== undefined);
    ctx.check(
      "a running shell tool sends progress while it runs",
      progress.length >= 3,
      `${running.length} running updates, ${progress.length} with output, over a 6 s command`,
    );
    const gaps = progress.slice(1).map((e, i) => e.at - (progress[i] as Event).at);
    const shortest = Math.min(...gaps);
    ctx.check("at most one progress update a second", shortest >= 1000 - THROTTLE_SLACK_MS, `two updates ${shortest.toFixed(0)} ms apart`);
    const sizes = progress.map((e) => Buffer.byteLength(outputOf(e) ?? ""));
    ctx.check(`each carries at most the last ${TAIL_BYTES} bytes of output`, Math.max(...sizes) <= TAIL_BYTES, `sizes: ${sizes.join(", ")}`);
    // three 910 byte lines pass 2 kb, so once tick 4 is in the output tick 1 must have scrolled off
    const head = progress.find((e) => (outputOf(e) ?? "").includes("tick 4") && (outputOf(e) ?? "").includes("tick 1 "));
    ctx.check("it is the tail of the output, not the head", head === undefined, "an update holding tick 4 still starts from tick 1");
  },
};
