/* a3: bounded sse buffers. a subscriber that sends its request and never
   reads, while the daemon publishes a burst far past the 1 mb cap: the
   daemon must close that stream, having handed it no more than the cap
   plus what the loopback socket buffers hold. a witness reads normally to
   measure the burst and resumes from its last id if the daemon closes it
   too: a reader in javascript can fall 1 mib behind a loopback burst, and
   the contract is that such a reader is closed and resumes. the daemon's
   rss is printed as evidence. */

import { connect, type Socket } from "node:net";
import type { Context, Probe } from "./probe";

const MIB = 1024 * 1024;
/** 1 mib of cap plus up to 3 mib parked in the two loopback socket buffers */
const REACH_LIMIT = 4 * MIB;
const BURST = "[bench:bulk 24000 200] a3 burst";
const CLOSE_WAIT_MS = 10_000;

const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

function stalledSubscriber(port: number, auth: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(`GET /global/event HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${auth}\r\nAccept: text/event-stream\r\n\r\n`);
      socket.pause();
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export const a3: Probe = {
  ask: "a3",
  title: "bounded sse buffers",
  async run(ctx: Context) {
    const witness = await ctx.follow();
    const session = await ctx.session("stall");
    const stalled = await stalledSubscriber(ctx.bench.port, ctx.bench.auth);
    try {
      await Bun.sleep(300);
      const rssBefore = ctx.bench.rss();
      let rssPeak = rssBefore;
      const sampler = setInterval(() => {
        rssPeak = Math.max(rssPeak, ctx.bench.rss());
      }, 250);
      const bytesBefore = witness.bytes;
      try {
        await ctx.turn(witness, session, BURST, 120_000);
      } finally {
        clearInterval(sampler);
      }
      const burst = witness.bytes - bytesBefore;
      const rssAfter = ctx.bench.rss();
      ctx.note(`burst: ${mib(burst)} to the witness (closed and resumed ${witness.resumes} time(s)); daemon rss ${mib(rssBefore * 1024)} before, ${mib(rssPeak * 1024)} peak, ${mib(rssAfter * 1024)} after`);

      let reached = 0;
      const closed = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), CLOSE_WAIT_MS);
        stalled.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      stalled.on("data", (chunk: Buffer) => {
        reached += chunk.byteLength;
      });
      stalled.resume();
      const wasClosed = await closed;
      ctx.check(
        "the daemon closed the stalled subscriber's stream",
        wasClosed,
        `still open ${CLOSE_WAIT_MS / 1000} s after ${mib(burst)} was published past it; it was handed ${mib(reached)}`,
      );
      ctx.check(
        `it was cut at the cap: at most ${mib(REACH_LIMIT)} (1 MiB cap plus socket buffers) reached it`,
        reached <= REACH_LIMIT && reached < burst,
        `${mib(reached)} reached the stalled subscriber of the ${mib(burst)} burst`,
      );
      ctx.note(`daemon rss after the close: ${mib(ctx.bench.rss() * 1024)}`);
    } finally {
      stalled.destroy();
    }
  },
};
