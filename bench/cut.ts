/* a tcp relay that can cut every connection through it, for the
   exactly-once suite's "drop the browser's connection" case
   (docs/verification.md). the browser loads boxbox through the relay; on
   SIGUSR2 every open connection is destroyed on both sides at once, which
   is what a dropped wifi link looks like to the page and to the server.

     bun bench/cut.ts [--listen 3003] [--to 3001]

   it prints one line per cut with the number of connections it killed. */

import { connect, createServer, type Socket } from "node:net";

function flag(name: string, fallback: number): number {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} takes a port`);
  return value;
}

const LISTEN = flag("--listen", 3003);
const TARGET = flag("--to", Number(process.env.BOXBOX_PORT ?? 3001));
const pairs = new Set<[Socket, Socket]>();

const server = createServer((client) => {
  const upstream = connect({ host: "127.0.0.1", port: TARGET });
  const pair: [Socket, Socket] = [client, upstream];
  pairs.add(pair);
  const drop = () => {
    pairs.delete(pair);
    client.destroy();
    upstream.destroy();
  };
  client.pipe(upstream);
  upstream.pipe(client);
  client.once("close", drop);
  upstream.once("close", drop);
  client.once("error", drop);
  upstream.once("error", drop);
});

let cuts = 0;
process.on("SIGUSR2", () => {
  const killed = pairs.size;
  for (const [client, upstream] of [...pairs]) {
    client.destroy();
    upstream.destroy();
  }
  pairs.clear();
  console.log(`cut: #${++cuts} dropped ${killed} connection(s)`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const [client, upstream] of pairs) {
      client.destroy();
      upstream.destroy();
    }
    server.close(() => process.exit(0));
  });
}

server.listen(LISTEN, "127.0.0.1", () => console.log(`cut: relaying 127.0.0.1:${LISTEN} to ${TARGET} (pid ${process.pid}); SIGUSR2 cuts`));
