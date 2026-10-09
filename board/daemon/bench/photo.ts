/* the photoshoot: dummy data so the board looks alive on camera.
   (2026-07-27, for the boxboxbox post. no fleet, no tokens — every
   frame here is staged, straight over usb.)

   four scenes, TAP ANY KEY on the board to cycle:

     1 race day    — a gold call shouting, a rose reply hot, the queue working
     2 all quiet   — nothing needs him, five workers breathing lime
     3 the pit     — a permission has the board: 1, 2, 3 armed, minus to skip
     4 the radio   — mid-dictation, the meter climbing, ent ready

   stop the daemon first (launchd owns the device):

     launchctl bootout gui/$(id -u)/com.boxbox.board
     bun bench/photo.ts

   ctrl-c blanks and exits; put the daemon back after:

     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.boxbox.board.plist
*/

import HID from "node-hid";
import {
  BREATH_SLOT, cell, FLOOR_CELL, frameReport, globalReport, helloReport,
  KEY_COUNT, LEVEL, LIVE_BREATH_SLOT, modeReport, paletteReport,
  parseBoardReport, pingReport, RESERVED_RGB, SLOT, WIRE, type Cell,
} from "../src/protocol";

const VID = 0x3a54;
const PID = 0x4f5d;
const USAGE_PAGE = 0xff60;

function floored(): Cell[] {
  return Array<Cell>(KEY_COUNT).fill(FLOOR_CELL);
}

/* 1 — race day: the busy frame. one gold shouting, one rose hot,
   fresh lime underneath, machines steady, heartbeat breathing. */
function raceDay(): Cell[] {
  const c = floored();
  c[WIRE.nl] = cell(BREATH_SLOT, LEVEL.bright);
  c[WIRE.div] = cell(SLOT.live, LEVEL.rest);
  c[WIRE.mul] = cell(SLOT.live, LEVEL.rest);
  c[WIRE.min] = cell(SLOT.live, LEVEL.rest);
  c[WIRE.k7] = cell(SLOT.permHot, LEVEL.bright);
  c[WIRE.k8] = cell(SLOT.needsHot, LEVEL.rest);
  c[WIRE.k9] = cell(SLOT.needs, LEVEL.rest);
  c[WIRE.k4] = cell(LIVE_BREATH_SLOT, LEVEL.rest);
  c[WIRE.k5] = cell(LIVE_BREATH_SLOT, LEVEL.dim);
  c[WIRE.k6] = cell(SLOT.live, LEVEL.dim);
  c[WIRE.k1] = cell(SLOT.live, LEVEL.dim);
  c[WIRE.k0] = cell(SLOT.you, LEVEL.rest);
  c[WIRE.ent] = cell(SLOT.you, LEVEL.dim);
  return c;
}

/* 2 — all quiet: the calm frame. nobody needs him, the fleet works. */
function allQuiet(): Cell[] {
  const c = floored();
  c[WIRE.nl] = cell(BREATH_SLOT, LEVEL.mid);
  c[WIRE.div] = cell(SLOT.live, LEVEL.rest);
  c[WIRE.mul] = cell(SLOT.live, LEVEL.rest);
  c[WIRE.min] = cell(SLOT.live, LEVEL.rest);
  c[WIRE.k7] = cell(LIVE_BREATH_SLOT, LEVEL.rest);
  c[WIRE.k8] = cell(LIVE_BREATH_SLOT, LEVEL.dim);
  c[WIRE.k9] = cell(SLOT.live, LEVEL.dim);
  c[WIRE.k4] = cell(SLOT.live, LEVEL.dim);
  c[WIRE.k5] = cell(SLOT.live, LEVEL.idle);
  c[WIRE.k0] = cell(SLOT.you, LEVEL.rest);
  c[WIRE.ent] = cell(SLOT.you, LEVEL.dim);
  return c;
}

/* 3 — the pit: a permission owns the board. */
function thePit(): Cell[] {
  const c = floored();
  c[WIRE.k5] = cell(SLOT.permHot, LEVEL.bright);
  c[WIRE.k1] = cell(SLOT.perm, LEVEL.bright);
  c[WIRE.k2] = cell(SLOT.perm, LEVEL.rest);
  c[WIRE.k3] = cell(SLOT.perm, LEVEL.dim);
  c[WIRE.min] = cell(SLOT.info, LEVEL.dim);
  c[WIRE.k0] = cell(SLOT.you, LEVEL.dim);
  return c;
}

/* 4 — the radio: mid-sentence, the meter climbing. */
function theRadio(): Cell[] {
  const c = floored();
  c[WIRE.k0] = cell(SLOT.you, LEVEL.hot);
  /* four columns, heights 2/3, 3/3, 2/3, 1/2 — bottom rows dimmer */
  c[WIRE.k1] = cell(SLOT.you, LEVEL.dim);
  c[WIRE.k4] = cell(SLOT.you, LEVEL.mid);
  c[WIRE.k2] = cell(SLOT.you, LEVEL.dim);
  c[WIRE.k5] = cell(SLOT.you, LEVEL.mid);
  c[WIRE.k8] = cell(SLOT.you, LEVEL.bright);
  c[WIRE.k3] = cell(SLOT.you, LEVEL.dim);
  c[WIRE.k6] = cell(SLOT.you, LEVEL.mid);
  c[WIRE.ent] = cell(SLOT.you, LEVEL.rest);
  return c;
}

const SCENES: Array<{ name: string; frame: () => Cell[] }> = [
  { name: "race day — a call shouting, the queue working", frame: raceDay },
  { name: "all quiet — the fleet just working", frame: allQuiet },
  { name: "the pit — a permission owns the board", frame: thePit },
  { name: "the radio — the meter climbing", frame: theRadio },
];

const devices = await HID.devicesAsync();
const board = devices.find(
  (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE,
);
if (!board?.path) {
  console.error("no board. is the daemon still holding it, or is it unplugged?");
  console.error("stop the daemon first: launchctl bootout gui/$(id -u)/com.boxbox.board");
  process.exit(1);
}
const dev = await HID.HIDAsync.open(board.path);

let idx = 0;

async function show() {
  await dev.write(frameReport(SCENES[idx].frame()));
  console.log(`  [${idx + 1}/${SCENES.length}] ${SCENES[idx].name}`);
}

dev.on("data", (buf: Buffer) => {
  const msg = parseBoardReport(new Uint8Array(buf));
  if (msg.kind === "key" && msg.down) {
    idx = (idx + 1) % SCENES.length;
    void show();
  }
});

await dev.write(helloReport());
await dev.write(modeReport(false)); /* drive: keys report raw, type nothing */
for (const [slot, rgb] of Object.entries(RESERVED_RGB)) {
  await dev.write(paletteReport(Number(slot), rgb));
}
await dev.write(globalReport(255)); /* full send, daylight calibration */

console.log("the photoshoot. TAP ANY KEY on the board to change scenes:\n");
await show();
console.log("\nctrl-c blanks the board when you have the shot.");

/* the two animated slots breathe like the real loop, so video works
   as well as stills */
const BREATH_PERIOD_MS = 3400;
const LIVE_PERIOD_MS = 1800;
let lastBreath = "";
let lastLive = "";
const anim = setInterval(() => {
  const now = Date.now();
  const bp = (now % BREATH_PERIOD_MS) / BREATH_PERIOD_MS;
  const bsw = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * bp));
  const bs = bsw * bsw;
  const you = RESERVED_RGB[SLOT.you];
  const breath: [number, number, number] = [
    Math.round(you[0] * bs), Math.round(you[1] * bs), Math.round(you[2] * bs),
  ];
  if (breath.join() !== lastBreath) {
    lastBreath = breath.join();
    void dev.write(paletteReport(BREATH_SLOT, breath));
  }
  const lp = (now % LIVE_PERIOD_MS) / LIVE_PERIOD_MS;
  /* perceptual sweep squared into pwm, render.ts's exact curve */
  const lsw = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(2 * Math.PI * lp));
  const ls = lsw * lsw;
  const lime = RESERVED_RGB[SLOT.live];
  const live: [number, number, number] = [
    Math.round(lime[0] * ls), Math.round(lime[1] * ls), Math.round(lime[2] * ls),
  ];
  if (live.join() !== lastLive) {
    lastLive = live.join();
    void dev.write(paletteReport(LIVE_BREATH_SLOT, live));
  }
}, 40);

const keepalive = setInterval(() => void dev.write(pingReport()), 400);

process.on("SIGINT", async () => {
  clearInterval(anim);
  clearInterval(keepalive);
  await dev.write(frameReport(Array(KEY_COUNT).fill(0)));
  await dev.close();
  process.exit(0);
});
