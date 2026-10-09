/* records what the shell's stories play back (src/shell/stories/server.ts):
   the answers a real boxbox gives the machines, settings and the terminal
   when they mount, and a short terminal session through the relay. run it
   against the release binary on the pinned daemon (the windows world,
   bench/windows.ts, is the usual one):

     bun .ladle/record-shell.ts --url http://127.0.0.1:3101 --password-file <gate password file> [--host bench]   (from app/)

   the terminal is a bash with no profile and no rc in /tmp, so its prompt
   names no person and no machine; anything that still names this machine,
   its user or their home is replaced with placeholders, and the recording
   is refused if any survives (AGENTS.md rule 12). the terminal is killed
   when the recording is done. */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const BASE = flag("--url") ?? "http://127.0.0.1:3101";
const PASSWORD_FILE = flag("--password-file");
const HOST = flag("--host") ?? "bench";
const OUT = new URL("../src/shell/stories/fixtures/", import.meta.url).pathname;
/** how long the session's output is listened to after the last command */
const SETTLE_MS = 1500;

if (!PASSWORD_FILE) {
  console.error("record-shell: --password-file <the bench gate password> is needed");
  process.exit(2);
}

const SCRUB: Array<[string, string]> = [
  [homedir(), "/Users/dev"],
  [hostname().replace(/\.local$/, ""), "machine"],
  [userInfo().username, "dev"],
];
function scrub(text: string): string {
  let out = text;
  for (const [from, to] of SCRUB) if (from.length > 2) out = out.split(from).join(to);
  return out;
}
function refuseLeaks(name: string, text: string) {
  for (const [from] of SCRUB) {
    if (from.length > 2 && text.includes(from)) throw new Error(`${name} still names ${from}; refusing to write it`);
  }
}

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: readFileSync(PASSWORD_FILE, "utf8").trim() }),
});
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
if (!login.ok || !cookie) throw new Error(`the gate answered ${login.status}`);

const answers: Record<string, { status: number; body: unknown }> = {};
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await response.json().catch(() => null);
  answers[`${method} ${path}`] = { status: response.status, body: parsed };
  console.log(`${String(response.status).padEnd(4)} ${method} ${path}`);
  return parsed;
}

await call("GET", "/api/hosts");
await call("GET", "/api/prefs");
await call("GET", "/api/push");
await call("GET", `/api/hosts/${HOST}/pty/shells`);
await call("GET", `/api/hosts/${HOST}/models`);

const created = (await call("POST", `/api/hosts/${HOST}/pty`, { command: "/bin/bash", args: ["--noprofile", "--norc"], cwd: "/tmp", title: "bash" })) as { id?: string } | null;
const id = created?.id;
if (!id) throw new Error("the host did not open a terminal");
delete answers[`POST /api/hosts/${HOST}/pty`];
const frames: Array<{ text: string } | { bytes: number[] }> = [];
try {
  await call("PUT", `/api/hosts/${HOST}/pty/${id}`, { size: { rows: 24, cols: 44 } });
  await call("GET", `/api/hosts/${HOST}/pty`);

  const url = new URL(`/api/hosts/${HOST}/pty/${id}/connect`, BASE);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { cookie, origin: new URL(BASE).origin } } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    let live = false;
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === "string") frames.push({ text: event.data });
      else {
        const bytes = [...new Uint8Array(event.data)];
        // heartbeats are the relay's, not the session's
        if (bytes[0] === 0x02) return;
        frames.push({ bytes });
        if (bytes[0] === 0x00 && !live) {
          live = true;
          for (const line of ["echo the shell, as recorded", "printf '%s\\n' one two three", "stty size"]) socket.send(`${line}\r`);
          setTimeout(resolve, SETTLE_MS);
        }
      }
    };
    socket.onerror = () => reject(new Error("the terminal's socket failed"));
    setTimeout(() => reject(new Error("the terminal never went live")), 10_000);
  });
  socket.close(1000, "recorded");
} finally {
  await fetch(`${BASE}/api/hosts/${HOST}/pty/${id}`, { method: "DELETE", headers: { cookie } });
}

const api = scrub(`${JSON.stringify(answers, null, 1)}\n`);
const session = scrub(`${JSON.stringify({ terminal: { host: HOST, id }, frames }, null, 1)}\n`);
refuseLeaks("api.json", api);
refuseLeaks("terminal.json", session);
writeFileSync(`${OUT}api.json`, api);
writeFileSync(`${OUT}terminal.json`, session);
console.log(`wrote ${Object.keys(answers).length} answers and ${frames.length} terminal frames to ${OUT}`);
