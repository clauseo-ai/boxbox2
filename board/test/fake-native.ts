/* a stand-in for the native daemon, only as much as proves native.ts and
   run.ts carry its seams: it reads the config the harness wrote, waits for
   the board's socket, says hello, draws a frame once acked, logs in through
   the origin, and answers each key press with a readback, a meter start and
   stop, a mark-read act and a new frame. it pings so the watchdog stays
   quiet. the real daemon is board/daemon. */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const config = readFileSync(env("BOXBOX_BOARD_CONFIG"), "utf8");
const setting = (key: string) => /^(\w+) = "(.*)"$/m.exec(config.split("\n").find((l) => l.startsWith(`${key} =`)) ?? "")?.[2] ?? "";
const origin = setting("origin");
const password = readFileSync(setting("password_file"), "utf8").trim();
const say = setting("say_command");
const socketPath = env("BOXBOX_BOARD_HID").replace(/^unix:/, "");
const meterLog = `${env("BOXBOX_BOARD_METER").replace(/^script:/, "")}.log`;

const report = (op: number, ...payload: number[]) => {
  const bytes = new Uint8Array(32);
  bytes.set([op, ...payload]);
  return bytes;
};

while (!existsSync(socketPath)) await Bun.sleep(20);
let lit = 0x29;
let pending: number[] = [];
const socket = await Bun.connect({
  unix: socketPath,
  socket: {
    data(s, data) {
      pending.push(...data);
      while (pending.length >= 32) {
        const r = pending.slice(0, 32);
        pending = pending.slice(32);
        if (r[0] === 0x81) {
          s.write(report(0x03, ...Array<number>(17).fill(lit)));
          void fetch(`${origin}/api/login`, { method: "POST", body: JSON.stringify({ password }) });
        } else if (r[0] === 0x82 && r[2] === 1) {
          Bun.spawnSync([say, "alpha"]);
          appendFileSync(meterLog, "start\nstop\n");
          void fetch(`${origin}/api/board/act`, { method: "POST", body: JSON.stringify({ verb: "read", key: "h1:s" }) });
          lit += 1;
          s.write(report(0x03, ...Array<number>(17).fill(lit)));
        }
      }
    },
  },
});
socket.write(report(0x01, 1));
setInterval(() => socket.write(report(0x05)), 400);
