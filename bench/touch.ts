/* holds touch emulation on agent-browser's page for as long as it runs:
   agent-browser's device presets change the user agent but not touch, and
   a cdp override lasts only while the session that set it is open.

     bun bench/touch.ts <agent-browser session>

   prints "touch: on" once emulation is set. each "tap <x> <y>" line on
   stdin is a finger down and up at that point (css px), answered "tapped".
   stop it with sigterm and the page is a pointer device again. */

import { spawnSync } from "node:child_process";

const session = process.argv[2];
if (!session) throw new Error("usage: bun bench/touch.ts <agent-browser session>");
const cdp = spawnSync("agent-browser", ["--session", session, "get", "cdp-url"], { encoding: "utf8" }).stdout.trim();
const port = new URL(cdp).port;
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1"));
if (!page) throw new Error("no boxbox page in agent-browser's browser");
const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method: string, params: Record<string, unknown>) => socket.send(JSON.stringify({ id: ++id, method, params }));
socket.addEventListener("open", () => {
  send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  console.log("touch: on");
});
socket.addEventListener("close", () => process.exit(0));

let pending = "";
process.stdin.on("data", async (chunk: Buffer) => {
  pending += chunk.toString();
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    const [verb, x, y] = line.trim().split(/\s+/);
    if (verb !== "tap") continue;
    const point = [{ x: Number(x), y: Number(y), radiusX: 4, radiusY: 4, force: 1, id: 1 }];
    send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
    await Bun.sleep(60);
    send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(60);
    console.log("tapped");
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => socket.close());
