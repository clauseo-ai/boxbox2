/* the floor audition: what color is "off"? (2026-07-27)

   the complaint: unlit keys are dead black, and under transparent caps
   with printed legends the board reads as a switched-off numpad. the
   proposal is a FLOOR — every dark key idles at a faint neutral glow.
   this bench renders a realistic drive scene (breath, machines, a call,
   an unread, a worker) over each floor candidate so the judgment is
   "do signals still pop above it", not an isolated swatch.

   stop the daemon first (launchd owns it):

     launchctl bootout gui/$(id -u)/com.boxbox.board
     bun bench/floor.ts

   TAP ANY KEY on the board to cycle candidates. ctrl-c blanks and
   exits; re-bootstrap the daemon after:

     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.boxbox.board.plist
*/

import HID from "node-hid";
import {
  BREATH_SLOT, cell, frameReport, helloReport, KEY_COUNT, LEVEL,
  LIVE_BREATH_SLOT, modeReport, paletteReport, parseBoardReport, pingReport,
  RESERVED_RGB, SLOT, WIRE, type Cell,
} from "../src/protocol";

const VID = 0x3a54;
const PID = 0x4f5d;
const USAGE_PAGE = 0xff60;

/* slot 9 (first livery slot, unused here) carries the floor candidate */
const FLOOR_SLOT = 9;

type Candidate = { name: string; rgb: [number, number, number]; level: number };

const CANDIDATES: Candidate[] = [
  { name: "black — what you have today", rgb: [0, 0, 0], level: 0 },
  { name: "neutral white, whisper (level 1)", rgb: [255, 255, 255], level: 1 },
  { name: "neutral white, low (level 2)", rgb: [255, 255, 255], level: 2 },
  { name: "neutral white, idle (level 3)", rgb: [255, 255, 255], level: 3 },
  { name: "cool white, low (level 2)", rgb: [190, 210, 255], level: 2 },
  { name: "warm white, low (level 2)", rgb: [255, 225, 185], level: 2 },
];

/* the drive scene, as deployed today: heartbeat on nl + the radio,
   machines green, one gold call, one rose unread, one lime worker */
function scene(floor: Cell): Cell[] {
  const cells = Array<Cell>(KEY_COUNT).fill(floor);
  cells[WIRE.nl] = cell(BREATH_SLOT, LEVEL.bright);
  cells[WIRE.k0] = cell(BREATH_SLOT, LEVEL.rest);
  cells[WIRE.div] = cell(SLOT.live, LEVEL.rest);
  cells[WIRE.mul] = cell(SLOT.live, LEVEL.rest);
  cells[WIRE.min] = cell(SLOT.live, LEVEL.rest);
  cells[WIRE.k7] = cell(SLOT.perm, LEVEL.rest);
  cells[WIRE.k8] = cell(SLOT.needs, LEVEL.rest);
  cells[WIRE.k9] = cell(LIVE_BREATH_SLOT, LEVEL.rest);
  return cells;
}

const devices = await HID.devicesAsync();
const board = devices.find(
  (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE,
);
if (!board?.path) {
  console.error("no board. is the daemon still holding it, or is it unplugged?");
  process.exit(1);
}
const dev = await HID.HIDAsync.open(board.path);

let idx = 0;

async function show() {
  const c = CANDIDATES[idx];
  await dev.write(paletteReport(FLOOR_SLOT, c.rgb));
  await dev.write(frameReport(scene(cell(FLOOR_SLOT, c.level))));
  console.log(`  [${idx + 1}/${CANDIDATES.length}] ${c.name}   rgb(${c.rgb.join(", ")})`);
}

dev.on("data", (buf: Buffer) => {
  const msg = parseBoardReport(new Uint8Array(buf));
  if (msg.kind === "key" && msg.down) {
    idx = (idx + 1) % CANDIDATES.length;
    void show();
  }
});

await dev.write(helloReport());
await dev.write(modeReport(false)); /* drive: keys report raw, type nothing */
for (const [slot, rgb] of Object.entries(RESERVED_RGB)) {
  await dev.write(paletteReport(Number(slot), rgb));
}

console.log("the floor audition. TAP ANY KEY on the board to cycle:\n");
await show();
console.log("\nctrl-c blanks the board when you have a verdict.");

/* the two animated slots breathe like the real loop, so the floor is
   judged against the living instrument, not a still */
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
