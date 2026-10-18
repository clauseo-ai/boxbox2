/* the recording reverse proxy between a native board daemon and its server.
   the daemon's `origin` points here. every request is recorded the way
   preload.ts's fetch wrapper recorded v1's calls (method, path with its
   query, the directory header, the json body), and its status when the
   answer's headers arrive. the answer is passed through as it comes: a
   stream's body is never buffered, and its `data:` frames are recorded on
   the side (the sse channel), so the normalizer can read the asks a reply
   names by index. */

import type { Server } from "bun";
import type { Record } from "./records";

export type Proxy = { origin: string; stop: () => Promise<void> };

/** the board's mac, as the world plays it: an address from the documentation range (rfc 5737). every call the
    daemon makes reaches the server through this proxy on loopback, with this address as its forwarded client, the way
    `tailscale serve` forwards a mac's calls (decision 81); the world's app window says the same address, so the
    server finds the window on the board's mac. the daemon's own `addrs` (this machine's real addresses) are passed
    through untouched and kept out of the records */
export const BOARD_MAC = "192.0.2.10";

/** a path as recorded: the board stream's `addrs` name this machine, so they never reach a record */
export function recordedPath(path: string): string {
  return path.replace(/([?&]addrs=)[^&]*/, "$1<addrs>");
}

/** request and response headers that belong to one hop, not the exchange */
const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding", "content-encoding"]);

function forwardable(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    if (!HOP.has(name.toLowerCase())) out.set(name, value);
  });
  return out;
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** the `data:` payloads of a text/event-stream, one call per frame */
export function sseFrames(onFrame: (data: unknown) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data !== "") onFrame(parseBody(data));
    }
  };
}

export function startProxy(upstream: string, onRecord: (record: Record) => void, now: () => number = Date.now): Proxy {
  let nextId = 0;
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    /* the board stream is long-lived; bun's default idle timeout would cut it */
    idleTimeout: 0,
    async fetch(req) {
      const id = ++nextId;
      const url = new URL(req.url);
      const path = `${url.pathname}${url.search}`;
      const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      onRecord({ ch: "http", t: now(), id, method: req.method, path: recordedPath(path), directory: req.headers.get("x-opencode-directory"), body: parseBody(text) });
      const headers = forwardable(req.headers);
      headers.set("x-forwarded-for", BOARD_MAC);
      let res: Response;
      try {
        res = await fetch(`${upstream}${path}`, {
          method: req.method,
          headers,
          ...(text === "" ? {} : { body: text }),
          redirect: "manual",
          signal: req.signal,
        });
      } catch (error) {
        onRecord({ ch: "http-done", t: now(), id, status: null });
        return new Response(`the trace proxy could not reach ${upstream}: ${error instanceof Error ? error.message : String(error)}\n`, { status: 502 });
      }
      onRecord({ ch: "http-done", t: now(), id, status: res.status });
      const answer = forwardable(res.headers);
      if (!res.body || !(res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
        return new Response(res.body, { status: res.status, headers: answer });
      }
      /* each chunk is read on its way through, never held: no tee, so nothing buffers behind a slow reader */
      const feed = sseFrames((data) => onRecord({ ch: "sse", t: now(), data }));
      const decoder = new TextDecoder();
      const through = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          feed(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
      });
      return new Response(res.body.pipeThrough(through), { status: res.status, headers: answer });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}